// Run with: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build, usernameVariants } from "../docs/lib/engine.js";
import { makeNet } from "../docs/lib/http.js";
import { classify, cleanUrl, extractUrls, personalSite } from "../docs/lib/links.js";
import { checkPresence, usableSites } from "../docs/lib/presence.js";
import { renderHtml, renderText } from "../docs/lib/render.js";
import { parseSite } from "../docs/lib/sources.js";
import worker, { allowedUrl } from "../relay/worker.js";

const PAGES = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
PAGES["https://api.github.com/users/ada/events/public?per_page=100"] = Array.from({ length: 40 }, (_, i) =>
  ({ created_at: `2026-01-0${(i % 7) + 1}T${String(9 + (i % 10)).padStart(2, "0")}:00:00Z` }));

function fakeTransport(pages = PAGES) {
  return async (url, opts = {}) => {
    let status = 404, text = "null";
    if (url in pages) { status = 200; text = typeof pages[url] === "string" ? pages[url] : JSON.stringify(pages[url]); }
    else if (url.includes("dev.to")) status = 429;
    else if (/hn\.algolia|registry\.npmjs/.test(url)) { status = 200; text = "{}"; }
    return { status, text, found: (opts.find || []).map((s) => text.includes(s)) };
  };
}
const net = () => makeNet(fakeTransport());
const byPlatform = (d) => Object.fromEntries(d.accounts.map((a) => [a.platform, a]));

test("classify recognises profiles on many platforms", () => {
  const cases = {
    "https://github.com/ada": ["github", "ada"], "https://x.com/ada_tw": ["twitter", "ada_tw"],
    "https://fosstodon.org/@adae": ["mastodon", "adae@fosstodon.org"], "https://news.ycombinator.com/user?id=ada": ["hackernews", "ada"],
    "https://old.reddit.com/u/ada": ["reddit", "ada"], "https://stackoverflow.com/users/42/ada": ["stackoverflow", "42"],
    "https://lichess.org/@/ada": ["lichess", "ada"], "https://www.chess.com/member/ada": ["chesscom", "ada"],
    "https://lobste.rs/~ada": ["lobsters", "ada"], "https://medium.com/@ada": ["medium", "ada"],
    "https://www.youtube.com/@ada": ["youtube", "ada"], "https://linktr.ee/ada": ["linktree", "ada"],
    "https://ada.substack.com": ["substack-publication", "ada"], "https://pypi.org/user/ada/": ["pypi", "ada"],
  };
  for (const [url, expected] of Object.entries(cases)) assert.deepEqual(classify(url), expected, url);
  for (const url of ["https://github.com/ada/calc", "https://github.com/settings", "https://youtube.com/watch",
    "https://tiktok.com/ada", "https://localhost/@ada", "https://127.0.0.1/@ada", "https://box.internal/@ada"]) {
    assert.equal(classify(url), null, url);
  }
});

test("link helpers", () => {
  assert.deepEqual(extractUrls('see <a href="x">https://a.example.org/x</a>.'), ["https://a.example.org/x"]);
  assert.equal(cleanUrl("mailto:a@b.org"), "");
  assert.equal(cleanUrl("javascript:alert(1)"), "");
  assert.equal(personalSite("https://ada.dev/blog"), "ada.dev");
  assert.equal(personalSite("https://ada.github.io/"), "ada.github.io");
  assert.equal(personalSite("https://docs.google.com/x"), "");
});

test("parseSite reads rel=me, h-card and JSON-LD", () => {
  const site = parseSite(PAGES["https://ada.dev/"], "https://ada.dev/");
  assert.equal(site.name, "Ada Example");
  assert.equal(site.location, "London");
  assert.equal(site.email, "ada@ada.dev");
  assert.deepEqual(site.relMe, ["https://github.com/ada", "https://bsky.app/profile/ada.dev"]);
  const ld = parseSite(`<script type="application/ld+json">{"@type":"Person","name":"Bo","sameAs":["https://github.com/bo"],
    "worksFor":{"name":"Initech"},"address":{"addressLocality":"Oslo"}}</script>`, "https://bo.dev/");
  assert.deepEqual([ld.name, ld.company, ld.location, ld.relMe[0]], ["Bo", "Initech", "Oslo", "https://github.com/bo"]);
});

test("pivots through links, READMEs and personal sites, and grades confidence", async () => {
  const d = await build({ handle: "ada", net: net() });
  const p = byPlatform(d);
  assert.deepEqual(new Set(Object.keys(p)), new Set(["github", "mastodon", "hackernews", "website", "reddit", "lichess"]));
  assert.equal(p.mastodon.origin, "pivot:github");
  assert.equal(p.website.origin, "pivot:github");
  assert.equal(p.reddit.handle, "ada_r");
  assert.equal(p.github.confidence, "confirmed");     // verified Mastodon link; mutual link with the site
  assert.equal(p.mastodon.confidence, "confirmed");
  assert.equal(p.website.confidence, "confirmed");
  assert.equal(p.reddit.confidence, "likely");         // linked from the README and links to the site, but not back
  assert.ok(p.website.evidence.includes("links to and from github"));
  assert.equal(p.lichess.confidence, "likely");        // only linked from the README
  assert.equal(p.hackernews.confidence, "unverified");
  assert.deepEqual(p.reddit.topics, ["r/rust", "r/compilers"]);
});

test("summary", async () => {
  const s = (await build({ handle: "ada", net: net() })).summary;
  assert.equal(s.names[0].value, "Ada Example");
  assert.deepEqual(new Set(s.names[0].sources), new Set(["github", "mastodon", "website"]));
  assert.deepEqual(s.languages, [["Rust", 1]]);
  assert.equal(s.first_seen, "2012-03-04");
  assert.match(s.tagline, /based in London/);
  assert.ok(s.links.some((l) => l.kind === "twitter"));
  assert.ok(!s.links.some((l) => l.url.includes("github.com/ada")));  // known accounts are not repeated
  assert.ok(s.interests.includes("r/rust"));
});

test("attempts, strict and no-pivot", async () => {
  const d = await build({ handle: "ada", net: net() });
  const status = Object.fromEntries(d.attempts.map((a) => [a.platform, a.status]));
  assert.equal(status.devto, "unavailable");
  assert.equal(status.gitlab, "not found");
  assert.ok(!("hackernews" in byPlatform(await build({ handle: "ada", net: net(), strict: true }))));
  assert.ok(!("mastodon" in byPlatform(await build({ handle: "ada", net: net(), pivot: false }))));
});

test("username variations", async () => {
  assert.deepEqual(usernameVariants("ada_lovelace").slice(0, 4), ["adalovelace", "ada.lovelace", "ada-lovelace", "alovelace"]);
  assert.ok(usernameVariants("bob", ["Ada Lovelace"]).includes("ada.lovelace"));
  const pages = { ...PAGES, "https://hacker-news.firebaseio.com/v0/user/adalovelace.json": { id: "adalovelace", karma: 1 } };
  const d = await build({ handle: "ada_lovelace", net: makeNet(fakeTransport(pages)), variants: true, only: new Set(["hackernews"]) });
  assert.equal(d.accounts[0]?.origin, "variant:adalovelace");
  assert.match(d.accounts[0].evidence[0], /guessing the variation/);
  assert.ok(!d.attempts.some((a) => a.handle === "ada.lovelace"));  // variant misses are not listed
});

test("username-only matches stay out of the headline", async () => {
  const d = await build({ handle: "ada", net: net(), only: new Set(["hackernews"]) });
  assert.match(d.summary.tagline, /no corroborated accounts/);
  assert.equal(d.summary.display_name, "");
});

test("presence check follows WhatsMyName rules and skips sensitive categories", async () => {
  const sites = usableSites({ sites: [
    { name: "Found", uri_check: "https://found.example.org/u/{account}", e_code: 200, e_string: "profile-of", m_code: 404, m_string: "", cat: "social" },
    { name: "Missing", uri_check: "https://missing.example.org/{account}", e_code: 200, e_string: "x", m_code: 404, m_string: "", cat: "tech" },
    { name: "Soft404", uri_check: "https://soft.example.org/{account}", e_code: 200, e_string: "user-card", m_code: 200, m_string: "No such user", cat: "tech" },
    { name: "Post", uri_check: "https://api.example.org/q", post_body: '{"u":"{account}"}', uri_pretty: "https://post.example.org/{account}",
      e_code: 200, e_string: '"id":', m_code: 200, m_string: "null", cat: "coding" },
    { name: "Adult", uri_check: "https://adult.example.org/{account}", e_code: 200, e_string: "", m_code: 404, m_string: "", cat: "xx NSFW xx" },
    { name: "Dating", uri_check: "https://date.example.org/{account}", e_code: 200, e_string: "", m_code: 404, m_string: "", cat: "dating" },
    { name: "Skip", uri_check: "https://github.com/{account}", e_code: 200, e_string: "", m_code: 404, m_string: "", cat: "coding" },
  ] });
  assert.equal(sites.length, 5);
  const calls = [];
  const raw = async (url, opts) => {
    calls.push([url, opts]);
    const text = { "https://found.example.org/u/ada": "<div>profile-of ada</div>", "https://soft.example.org/ada": "No such user",
      "https://api.example.org/q": '{"id": 3}' }[url];
    return { status: text ? 200 : 404, found: opts.find.map((s) => (text || "").includes(s)) };
  };
  const result = await checkPresence("ada", sites, raw, { skipHosts: new Set(["github.com"]) });
  assert.deepEqual(result.found.map((f) => f.name), ["Post", "Found"]);
  assert.equal(result.found[0].url, "https://post.example.org/ada");
  assert.equal(result.checked, 4);
  const post = calls.find(([u]) => u === "https://api.example.org/q")[1];
  assert.equal(post.method, "POST");
  assert.equal(post.body, '{"u":"ada"}');
  assert.equal(post.redirect, "manual");
});

test("footprint audit", async () => {
  const d = await build({ handle: "ada", net: net(), audit: true });
  const titles = d.summary.audit.map((i) => i.title);
  assert.equal(d.summary.audit[0].level, "high");
  assert.match(titles[0], /Email address is public/);
  assert.ok(titles.some((t) => /Location is public/.test(t)));
  assert.ok(titles.some((t) => /accounts are linked/.test(t)));
  assert.ok(titles.some((t) => /daily routine/.test(t)));
  assert.ok(d.summary.audit[0].where.some((w) => w.url === "https://github.com/settings/profile"));
});

test("rendering escapes everything taken from profiles", async () => {
  const d = await build({ handle: "ada", net: net(), audit: true });
  const html = renderHtml(d);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(renderText(d, { color: false }), /ADA EXAMPLE/);
  const empty = await build({ handle: "nobody", net: makeNet(async () => ({ status: 404, text: "", found: [] })) });
  assert.deepEqual(empty.accounts, []);
  assert.match(renderText(empty, { color: false }), /No public profiles/);
});

test("relay: auth, validation, batching, header filtering", async () => {
  const env = { RELAY_TOKEN: "0123456789abcdef-secret" };
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push([url, init]);
    return new Response(url.includes("missing") ? "nope" : "<b>profile-of</b>", { status: url.includes("missing") ? 404 : 200 });
  };
  const call = (body, token = env.RELAY_TOKEN) => worker.fetch(new Request("https://relay.example.org/relay", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://r0n1n9.github.io" }, body: JSON.stringify(body),
  }), env, null, fakeFetch);

  assert.equal((await call({ requests: [] }, "wrong")).status, 401);
  assert.equal((await worker.fetch(new Request("https://relay.example.org/relay", { method: "POST" }), {}, null, fakeFetch)).status, 503);
  assert.equal((await call({ requests: Array(46).fill({ url: "https://a.org" }) })).status, 400);

  const response = await call({ requests: [
    { url: "https://site.org/u/ada", find: ["profile-of", "nope"], headers: { Cookie: "x", Authorization: "Bearer gh", "X-Ok": "1" } },
    { url: "https://api.github.com/users/ada", headers: { Authorization: "Bearer gh" }, wantBody: true },
    { url: "https://missing.org/ada", find: ["profile-of"], redirect: "manual" },
    { url: "http://127.0.0.1/admin" }, { url: "https://localhost/x" }, { url: "file:///etc/passwd" },
  ] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://r0n1n9.github.io");
  const { responses } = await response.json();
  assert.deepEqual(responses[0], { status: 200, found: [true, false] });
  assert.equal(responses[1].body, "<b>profile-of</b>");
  assert.deepEqual(responses[2], { status: 404, found: [false] });
  for (const r of responses.slice(3)) assert.equal(r.error, "url not allowed");
  assert.equal(seen.length, 3);
  assert.equal(seen[0][1].headers.Cookie, undefined);
  assert.equal(seen[0][1].headers.Authorization, undefined);   // tokens only go to api.github.com
  assert.equal(seen[0][1].headers["X-Ok"], "1");
  assert.equal(seen[1][1].headers.Authorization, "Bearer gh");
  assert.equal(seen[2][1].redirect, "manual");
  assert.equal(allowedUrl("https://user:pw@a.org/"), null);
  assert.equal(allowedUrl("https://a.org:8080/"), null);
});
