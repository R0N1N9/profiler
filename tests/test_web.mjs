// Run with: node --test tests/test_web.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build, classify, extractUrls } from "../docs/profiler.js";

const GH = "https://api.github.com/users/ada";
const PAGES = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
PAGES[`${GH}/events/public?per_page=100`] = Array.from({ length: 12 }, (_, h) =>
  ({ created_at: `2026-01-05T${String(h).padStart(2, "0")}:00:00Z` }));

async function fakeFetch(url) {
  if (url in PAGES) return [200, PAGES[url]];
  if (url.includes("dev.to")) return [429, null];
  if (url.includes("hn.algolia.com") || url.includes("registry.npmjs.org")) return [200, {}];
  return [404, null];
}
const byPlatform = (d) => Object.fromEntries(d.accounts.map((a) => [a.platform, a]));

test("classify", () => {
  assert.deepEqual(classify("https://github.com/ada"), ["github", "ada"]);
  assert.deepEqual(classify("https://x.com/ada_tw"), ["twitter", "ada_tw"]);
  assert.deepEqual(classify("https://fosstodon.org/@adae"), ["mastodon", "adae@fosstodon.org"]);
  assert.deepEqual(classify("https://news.ycombinator.com/user?id=ada"), ["hackernews", "ada"]);
  for (const url of ["https://github.com/ada/calc", "https://github.com/settings", "https://medium.com/@ada",
    "https://localhost/@ada", "https://127.0.0.1/@ada", "https://box.internal/@ada"]) {
    assert.equal(classify(url), null, url);
  }
});

test("extractUrls", () => {
  assert.deepEqual(extractUrls('see <a href="x">https://a.example/x</a>.'), ["https://a.example/x"]);
});

test("pivots and grades confidence", async () => {
  const d = await build({ handle: "ada", fetch: fakeFetch });
  const p = byPlatform(d);
  assert.deepEqual(new Set(Object.keys(p)), new Set(["github", "mastodon", "hackernews"]));
  assert.equal(p.mastodon.origin, "pivot:github");
  assert.equal(p.github.confidence, "confirmed");
  assert.equal(p.mastodon.confidence, "confirmed");
  assert.equal(p.hackernews.confidence, "unverified");
});

test("summary", async () => {
  const s = (await build({ handle: "ada", fetch: fakeFetch })).summary;
  assert.equal(s.names[0].value, "Ada Example");
  assert.deepEqual(s.names[0].sources, ["github", "mastodon"]);
  assert.deepEqual(s.languages, [["Rust", 1]]);
  assert.equal(s.first_seen, "2012-03-04");
  assert.equal(s.activity.events, 12);
  assert.match(s.tagline, /based in London/);
  assert.deepEqual(new Set(s.links.map((l) => l.kind)), new Set(["website", "twitter"]));
});

test("attempts, strict and no-pivot", async () => {
  const d = await build({ handle: "ada", fetch: fakeFetch });
  const status = Object.fromEntries(d.attempts.map((a) => [a.platform, a.status]));
  assert.equal(status.devto, "unavailable");
  assert.equal(status.gitlab, "not found");
  assert.ok(!("hackernews" in byPlatform(await build({ handle: "ada", fetch: fakeFetch, strict: true }))));
  assert.ok(!("mastodon" in byPlatform(await build({ handle: "ada", fetch: fakeFetch, pivot: false }))));
});

test("username-only matches stay out of the headline", async () => {
  const d = await build({ handle: "ada", fetch: fakeFetch, only: new Set(["hackernews"]) });
  assert.match(d.summary.tagline, /no corroborated accounts/);
  assert.equal(d.summary.display_name, "");
});

test("nothing found", async () => {
  const d = await build({ handle: "nobody", fetch: async () => [404, null] });
  assert.deepEqual(d.accounts, []);
});
