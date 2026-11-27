// One function per platform. Each reads the platform's public, unauthenticated endpoints and
// returns only what the account owner chose to publish, or null when there is no such account.

import { LINK_HUBS, classify, cleanUrl, extractUrls, hostOf, publicHost, stripHtml, unescapeHtml } from "./links.js";

export class Unavailable extends Error {}

function describe(status, r) {
  if (status === -1) return "unreadable response (probably a block or login page)";
  if (status === 0) return r?.needsRelay ? "blocked by the browser — set up the relay to reach it" : "no response";
  if (status === 429) return "rate limited — try again later";
  if (status === 403) return "HTTP 403 (refused or rate limited)";
  return `HTTP ${status}`;
}

async function get(net, url, { missing = [404], opts } = {}) {
  const [status, data, r] = await net.json(url, opts);
  if (missing.includes(status)) return null;
  if (status !== 200) throw new Unavailable(describe(status, r));
  return data;
}

async function getText(net, url, { missing = [404], opts } = {}) {
  const [status, text, r] = await net.text(url, opts);
  if (missing.includes(status)) return null;
  if (status !== 200) throw new Unavailable(describe(status, r));
  return text;
}

async function soft(fn) {
  try { return await fn(); } catch { return null; }
}

function iso(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 1e11 ? value : value * 1000;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const d = new Date(value);
  return isNaN(d) ? String(value) : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const q = encodeURIComponent;

export function links(...values) {
  const seen = new Set(), out = [];
  for (const value of values.flat()) {
    const url = cleanUrl(value);
    if (url && !seen.has(url.toLowerCase())) { seen.add(url.toLowerCase()); out.push(url); }
  }
  return out;
}

export function account(platform, handle, url, extra = {}) {
  return {
    platform, handle, url, name: "", bio: "", location: "", company: "", email: "", avatar: "",
    created: "", links: [], stats: {}, languages: {}, topics: [], highlights: [], activity: [],
    proofs: [], origin: "username", confidence: "unverified", evidence: [], ...extra,
  };
}

export function countTop(items, n) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const handleOk = (h) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(h);

// ------------------------------------------------------------------ code hosting

async function github(handle, net) {
  if (!handleOk(handle)) return null;
  const base = `https://api.github.com/users/${q(handle)}`;
  const user = await get(net, base);
  if (!user) return null;
  const login = user.login;
  const [social, repoList, events, orgs, readme] = await Promise.all([
    soft(() => get(net, `${base}/social_accounts`)),
    soft(() => get(net, `${base}/repos?per_page=100&sort=pushed`)),
    soft(() => get(net, `${base}/events/public?per_page=100`)),
    soft(() => get(net, `${base}/orgs`)),
    // A profile README often lists the person's other accounts.
    soft(() => getText(net, `https://raw.githubusercontent.com/${q(login)}/${q(login)}/HEAD/README.md`)),
  ]);
  const tw = user.twitter_username;
  const a = account("github", login, user.html_url, {
    name: user.name || "", bio: user.bio || "", location: user.location || "",
    company: (user.company || "").replace(/^@/, ""), email: user.email || "",
    avatar: user.avatar_url || "", created: iso(user.created_at),
    links: links(user.blog, tw ? `https://twitter.com/${tw}` : "", (social || []).map((s) => s.url),
      extractUrls(user.bio || ""), readmeProfileLinks(readme || "")),
    stats: { followers: user.followers || 0, "public repos": user.public_repos || 0 },
  });
  const repos = (repoList || []).filter((r) => !r.fork);
  a.languages = Object.fromEntries(countTop(repos.filter((r) => r.language).map((r) => r.language), 8));
  a.topics = countTop(repos.flatMap((r) => r.topics || []), 12).map(([t]) => t);
  a.highlights = [...repos].sort((x, y) => (y.stargazers_count || 0) - (x.stargazers_count || 0))
    .slice(0, 5).map((r) => ({ title: r.name, url: r.html_url,
      note: `★ ${r.stargazers_count || 0} · ${r.description || "no description"}` }));
  a.activity = (events || []).map((e) => e.created_at).filter(Boolean);
  if (orgs && orgs.length) a.stats.organisations = orgs.slice(0, 8).map((o) => o.login).join(", ");
  if (readme) a.stats["profile README"] = "yes";
  return a;
}

// Profile READMEs are full of badge and image links; keep only links to profiles or sites.
function readmeProfileLinks(text) {
  return extractUrls(text).filter((u) => {
    if (/\.(svg|png|jpe?g|gif|webp)(\?|$)/i.test(u)) return false;
    if (/shields\.io|badge|readme-stats|vercel\.app\/api|komarev|github-profile-trophy|skillicons|devicon|socialify/i.test(u)) return false;
    return Boolean(classify(u)) || !/github(usercontent)?\.com/.test(hostOf(u));
  }).slice(0, 25);
}

async function gitlab(handle, net) {
  if (!handleOk(handle)) return null;
  const found = await get(net, `https://gitlab.com/api/v4/users?username=${q(handle)}`);
  if (!found || !found.length) return null;
  const user = (await soft(() => get(net, `https://gitlab.com/api/v4/users/${found[0].id}`))) || found[0];
  return account("gitlab", user.username, user.web_url, {
    name: user.name || "", bio: user.bio || "", location: user.location || "",
    company: user.organization || "", email: user.public_email || "",
    avatar: user.avatar_url || "", created: iso(user.created_at),
    links: links(user.website_url, user.twitter ? `https://twitter.com/${user.twitter.replace(/^@/, "")}` : "",
      user.linkedin ? `https://linkedin.com/in/${user.linkedin}` : "", extractUrls(user.bio || "")),
    stats: user.job_title ? { "job title": user.job_title } : {},
  });
}

async function codeberg(handle, net) {
  if (!handleOk(handle)) return null;
  const base = `https://codeberg.org/api/v1/users/${q(handle)}`;
  const user = await get(net, base);
  if (!user) return null;
  const repos = ((await soft(() => get(net, `${base}/repos?limit=50`))) || []).filter((r) => !r.fork);
  return account("codeberg", user.login, `https://codeberg.org/${user.login}`, {
    name: user.full_name || "", bio: user.description || "", location: user.location || "",
    email: user.email && !user.email.endsWith("@noreply.codeberg.org") ? user.email : "",
    avatar: user.avatar_url || "", created: iso(user.created),
    links: links(user.website, extractUrls(user.description || "")),
    stats: { followers: user.followers_count || 0, repos: repos.length },
    languages: Object.fromEntries(countTop(repos.filter((r) => r.language).map((r) => r.language), 8)),
    highlights: repos.sort((x, y) => (y.stars_count || 0) - (x.stars_count || 0)).slice(0, 3).map((r) => ({
      title: r.name, url: r.html_url, note: `★ ${r.stars_count || 0} · ${r.description || "no description"}` })),
  });
}

// ------------------------------------------------------------------ packages

async function npm(handle, net) {
  if (!handleOk(handle)) return null;
  const data = await get(net, `https://registry.npmjs.org/-/v1/search?text=maintainer:${q(handle)}&size=20`);
  const objects = (data && data.objects) || [];
  if (!objects.length) return null;
  const a = account("npm", handle, `https://www.npmjs.com/~${q(handle)}`, { stats: { packages: data.total || objects.length } });
  a.highlights = objects.slice(0, 5).map(({ package: p }) => ({
    title: p.name, note: p.description || "no description", url: `https://www.npmjs.com/package/${p.name}` }));
  a.activity = objects.map((o) => o.package.date).filter(Boolean);
  const pub = objects.map((o) => o.package.publisher).find((p) => p?.username === handle);
  if (pub?.email) a.email = pub.email;
  return a;
}

async function pypi(handle, net) {
  if (!handleOk(handle)) return null;
  const page = await getText(net, `https://pypi.org/user/${q(handle)}/`);
  if (!page) return null;
  const names = [...page.matchAll(/class="package-snippet__title"[^>]*>([^<]+)</g)].map((m) => unescapeHtml(m[1]).trim());
  const name = (page.match(/<h1 class="author-profile__name">([^<]+)</) || [])[1];
  const joined = (page.match(/Joined[\s\S]{0,200}?datetime="([^"]+)"/) || [])[1];
  if (!names.length && !name) throw new Unavailable("unreadable response (probably a block page)");
  return account("pypi", handle, `https://pypi.org/user/${q(handle)}/`, {
    name: name ? unescapeHtml(name).trim() : "", created: iso(joined || ""),
    stats: { projects: names.length },
    highlights: names.slice(0, 5).map((n) => ({ title: n, note: "PyPI project", url: `https://pypi.org/project/${q(n)}/` })),
  });
}

async function crates(handle, net) {
  if (!handleOk(handle)) return null;
  const data = await get(net, `https://crates.io/api/v1/users/${q(handle)}`);
  const user = data?.user;
  if (!user) return null;
  const list = await soft(() => get(net, `https://crates.io/api/v1/crates?user_id=${user.id}&per_page=10&sort=downloads`));
  const items = list?.crates || [];
  return account("crates", user.login, `https://crates.io/users/${q(user.login)}`, {
    name: user.name || "", avatar: user.avatar || "", links: links(user.url),
    stats: { crates: list?.meta?.total ?? items.length },
    highlights: items.slice(0, 5).map((c) => ({ title: c.name, url: `https://crates.io/crates/${q(c.name)}`,
      note: `${(c.downloads || 0).toLocaleString("en")} downloads · ${c.description || "no description"}` })),
  });
}

async function dockerhub(handle, net) {
  if (!handleOk(handle)) return null;
  const user = await get(net, `https://hub.docker.com/v2/users/${q(handle)}/`);
  if (!user || !user.username) return null;
  return account("dockerhub", user.username, `https://hub.docker.com/u/${user.username}`, {
    name: user.full_name || "", location: user.location || "", company: user.company || "",
    avatar: user.gravatar_url || "", created: iso(user.date_joined), links: links(user.profile_url),
  });
}

// ------------------------------------------------------------------ communities

async function hackernews(handle, net) {
  if (!handleOk(handle)) return null;
  const user = await get(net, `https://hacker-news.firebaseio.com/v0/user/${q(handle)}.json`);
  if (!user) return null;
  const about = user.about || "";
  const a = account("hackernews", user.id, `https://news.ycombinator.com/user?id=${q(user.id)}`, {
    bio: stripHtml(about), created: iso(user.created), links: links(extractUrls(about)),
    stats: { karma: user.karma || 0 },
  });
  const search = await soft(() => get(net,
    `https://hn.algolia.com/api/v1/search_by_date?tags=author_${q(user.id)}&hitsPerPage=100`));
  const hits = (search && search.hits) || [];
  a.activity = hits.map((h) => h.created_at).filter(Boolean);
  a.highlights = hits.filter((h) => h.title).sort((x, y) => (y.points || 0) - (x.points || 0)).slice(0, 3)
    .map((h) => ({ title: h.title, note: `${h.points || 0} points`, url: `https://news.ycombinator.com/item?id=${h.objectID}` }));
  return a;
}

async function reddit(handle, net) {
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(handle)) return null;
  const base = `https://www.reddit.com/user/${q(handle)}`;
  const about = await get(net, `${base}/about.json?raw_json=1`);
  const user = about?.data;
  if (!user || user.is_suspended) return null;
  const [posts, comments] = await Promise.all([
    soft(() => get(net, `${base}/submitted.json?limit=100&raw_json=1`)),
    soft(() => get(net, `${base}/comments.json?limit=100&raw_json=1`)),
  ]);
  const items = [...(posts?.data?.children || []), ...(comments?.data?.children || [])].map((c) => c.data).filter(Boolean);
  const sub = user.subreddit || {};
  const bio = sub.public_description || "";
  const a = account("reddit", user.name, `https://www.reddit.com/user/${q(user.name)}`, {
    name: sub.title && sub.title !== user.name ? sub.title : "", bio,
    avatar: (user.icon_img || sub.icon_img || "").split("?")[0], created: iso(user.created_utc),
    links: links(extractUrls(bio)),
    stats: { "post karma": user.link_karma || 0, "comment karma": user.comment_karma || 0 },
  });
  a.activity = items.map((i) => i.created_utc).filter(Boolean).map(iso);
  // Communities they take part in, as "interests".
  a.topics = countTop(items.map((i) => i.subreddit).filter(Boolean), 12).map(([s]) => `r/${s}`);
  a.highlights = (posts?.data?.children || []).map((c) => c.data).filter((p) => p?.title)
    .sort((x, y) => (y.score || 0) - (x.score || 0)).slice(0, 3)
    .map((p) => ({ title: p.title, note: `${p.score || 0} points · r/${p.subreddit}`, url: `https://www.reddit.com${p.permalink}` }));
  return a;
}

async function stackoverflow(id, net) {
  if (!/^\d+$/.test(id)) throw new Unavailable("needs the numeric user id from the profile URL");
  const api = "https://api.stackexchange.com/2.3";
  const data = await get(net, `${api}/users/${id}?site=stackoverflow`);
  const user = data?.items?.[0];
  if (!user) return null;
  const tags = await soft(() => get(net, `${api}/users/${id}/top-tags?site=stackoverflow&pagesize=10`));
  return account("stackoverflow", String(user.user_id), user.link, {
    name: unescapeHtml(user.display_name || ""), location: unescapeHtml(user.location || ""),
    avatar: user.profile_image || "", created: iso(user.creation_date), links: links(user.website_url),
    stats: { reputation: user.reputation || 0, "gold badges": user.badge_counts?.gold || 0 },
    topics: (tags?.items || []).map((t) => t.tag_name),
  });
}

async function lobsters(handle, net) {
  if (!handleOk(handle)) return null;
  const user = await get(net, `https://lobste.rs/~${q(handle)}.json`);
  if (!user || !user.username) return null;
  return account("lobsters", user.username, `https://lobste.rs/~${user.username}`, {
    bio: user.about || "", created: iso(user.created_at),
    avatar: user.avatar_url ? new URL(user.avatar_url, "https://lobste.rs").href : "",
    links: links(user.homepage, user.github_username ? `https://github.com/${user.github_username}` : "",
      user.twitter_username ? `https://twitter.com/${user.twitter_username}` : "",
      user.mastodon_username && user.mastodon_instance ? `https://${user.mastodon_instance}/@${user.mastodon_username}` : "",
      extractUrls(user.about || "")),
    stats: { karma: user.karma || 0 },
  });
}

async function devto(handle, net) {
  if (!handleOk(handle)) return null;
  const user = await get(net, `https://dev.to/api/users/by_username?url=${q(handle)}`);
  if (!user) return null;
  const gh = user.github_username, tw = user.twitter_username;
  return account("devto", user.username, `https://dev.to/${user.username}`, {
    name: user.name || "", bio: user.summary || "", location: user.location || "", avatar: user.profile_image || "",
    links: links(user.website_url, gh ? `https://github.com/${gh}` : "", tw ? `https://twitter.com/${tw}` : ""),
    stats: user.joined_at ? { joined: user.joined_at } : {},
  });
}

async function keybase(handle, net) {
  if (!/^[A-Za-z0-9_]{2,16}$/.test(handle)) return null;
  const data = await get(net, `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${q(handle)}`);
  const them = ((data && data.them) || []).filter(Boolean);
  if (!them.length) return null;
  const user = them[0], profile = user.profile || {};
  const proofs = user.proofs_summary?.all || [];
  const name = user.basics.username;
  const a = account("keybase", name, `https://keybase.io/${name}`, {
    name: profile.full_name || "", bio: profile.bio || "", location: profile.location || "",
    avatar: user.pictures?.primary?.url || "", created: iso(user.basics.ctime),
    links: links(proofs.map((p) => p.service_url)), stats: { "verified proofs": proofs.length },
  });
  const kinds = { github: "github", twitter: "twitter", hackernews: "hackernews", gitlab: "gitlab", reddit: "reddit" };
  a.proofs = proofs.filter((p) => kinds[p.proof_type] && p.nametag).map((p) => [kinds[p.proof_type], p.nametag]);
  return a;
}

// ------------------------------------------------------------------ social

async function bluesky(handle, net) {
  const actor = handle.includes(".") ? handle : `${handle}.bsky.social`;
  if (!publicHost(actor)) return null;
  const api = "https://public.api.bsky.app/xrpc";
  const user = await get(net, `${api}/app.bsky.actor.getProfile?actor=${q(actor)}`, { missing: [400, 404] });
  if (!user) return null;
  const a = account("bluesky", user.handle, `https://bsky.app/profile/${user.handle}`, {
    name: user.displayName || "", bio: user.description || "", avatar: user.avatar || "",
    created: iso(user.createdAt), links: links(extractUrls(user.description || "")),
    stats: { followers: user.followersCount || 0, posts: user.postsCount || 0 },
  });
  // A custom-domain handle is itself a personal site the owner proved they control.
  if (!user.handle.endsWith(".bsky.social")) a.links.push(`https://${user.handle}/`);
  const feed = await soft(() => get(net, `${api}/app.bsky.feed.getAuthorFeed?actor=${q(actor)}&limit=100`));
  a.activity = ((feed && feed.feed) || [])
    .filter((i) => i.post?.author?.handle === user.handle && i.post?.record?.createdAt)
    .map((i) => i.post.record.createdAt);
  return a;
}

async function mastodon(handle, net) {
  const [userPart, host] = handle.replace(/^@/, "").split("@");
  if (!userPart || !publicHost(host)) throw new Unavailable("needs user@instance");
  const user = await get(net, `https://${host}/api/v1/accounts/lookup?acct=${q(userPart)}`);
  if (!user) return null;
  const fields = user.fields || [];
  const a = account("mastodon", `${user.username}@${host}`, user.url || `https://${host}/@${userPart}`, {
    name: user.display_name || "", bio: stripHtml(user.note || ""), avatar: user.avatar || "",
    created: iso(user.created_at),
    links: links(fields.flatMap((f) => extractUrls(f.value || "")), extractUrls(user.note || "")),
    stats: { followers: user.followers_count || 0, posts: user.statuses_count || 0 },
  });
  // Mastodon marks fields whose link points back to this profile (rel="me") as verified.
  a.verifiedLinks = links(fields.filter((f) => f.verified_at).flatMap((f) => extractUrls(f.value || "")));
  const statuses = await soft(() => get(net,
    `https://${host}/api/v1/accounts/${q(String(user.id))}/statuses?limit=40&exclude_reblogs=true`));
  a.activity = (statuses || []).map((s) => s.created_at).filter(Boolean);
  return a;
}

// ------------------------------------------------------------------ games & writing

async function lichess(handle, net) {
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(handle)) return null;
  const user = await get(net, `https://lichess.org/api/user/${q(handle)}`);
  if (!user || user.disabled || user.closed) return null;
  const p = user.profile || {};
  return account("lichess", user.username, `https://lichess.org/@/${user.username}`, {
    name: p.realName || [p.firstName, p.lastName].filter(Boolean).join(" "), bio: p.bio || "",
    location: p.location || "", created: iso(user.createdAt),
    links: links((p.links || "").split(/\s+/), extractUrls(p.bio || "")),
    stats: { games: user.count?.all || 0, "hours played": Math.round((user.playTime?.total || 0) / 3600),
      ...(user.seenAt ? { "last seen": iso(user.seenAt).slice(0, 10) } : {}) },
  });
}

async function chesscom(handle, net) {
  if (!/^[A-Za-z0-9_-]{3,25}$/.test(handle)) return null;
  const user = await get(net, `https://api.chess.com/pub/player/${q(handle.toLowerCase())}`, { missing: [404, 410] });
  if (!user || !user.username) return null;
  return account("chesscom", user.username, user.url || `https://www.chess.com/member/${user.username}`, {
    name: user.name || "", location: user.location || "", avatar: user.avatar || "", created: iso(user.joined),
    stats: { followers: user.followers || 0, ...(user.title ? { title: user.title } : {}),
      ...(user.last_online ? { "last online": iso(user.last_online).slice(0, 10) } : {}) },
  });
}

function rssItems(xml) {
  return [...(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const tag = (name) => {
      const m = item.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
      return m ? unescapeHtml(m[1]).trim() : "";
    };
    const categories = [...item.matchAll(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g)].map((m) => m[1].trim());
    return { title: tag("title"), link: tag("link"), date: tag("pubDate"), categories };
  });
}

async function medium(handle, net) {
  if (!handleOk(handle)) return null;
  const xml = await getText(net, `https://medium.com/feed/@${q(handle)}`);
  if (!xml || !xml.includes("<rss")) return null;
  const channel = (xml.match(/<channel>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
  const name = unescapeHtml(channel).replace(/^Stories by /, "").replace(/ on Medium$/, "").trim();
  const items = rssItems(xml);
  return account("medium", handle, `https://medium.com/@${q(handle)}`, {
    name, stats: { "recent stories": items.length },
    activity: items.map((i) => iso(i.date)).filter(Boolean),
    topics: countTop(items.flatMap((i) => i.categories), 12).map(([t]) => t),
    highlights: items.slice(0, 3).map((i) => ({ title: i.title, url: i.link, note: i.date.slice(0, 16) })),
  });
}

async function substack(handle, net) {
  if (!handleOk(handle)) return null;
  const user = await get(net, `https://substack.com/api/v1/user/${q(handle)}/public_profile`);
  if (!user || !(user.handle || user.name)) return null;
  const pubs = (user.publicationUsers || []).map((p) => p.publication).filter(Boolean);
  return account("substack", user.handle || handle, `https://substack.com/@${q(user.handle || handle)}`, {
    name: user.name || "", bio: user.bio || "", avatar: user.photo_url || "",
    links: links(pubs.map((p) => p.custom_domain ? `https://${p.custom_domain}` : `https://${p.subdomain}.substack.com`),
      (user.userLinks || []).map((l) => l.url), extractUrls(user.bio || "")),
    stats: { publications: pubs.length },
    highlights: pubs.slice(0, 3).map((p) => ({ title: p.name, note: "publication",
      url: p.custom_domain ? `https://${p.custom_domain}` : `https://${p.subdomain}.substack.com` })),
  });
}

async function substackPublication(subdomain, net) {
  return substack(subdomain, net);  // a writer's handle usually matches their publication's subdomain
}

// ------------------------------------------------------------------ email

async function gravatar(email, net) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const user = await get(net, `https://api.gravatar.com/v3/profiles/${digest}`);
  if (!user) return null;
  return account("gravatar", email, user.profile_url || "", {
    name: user.display_name || "", bio: user.description || "", location: user.location || "",
    company: user.company || "", avatar: user.avatar_url || "",
    links: links((user.verified_accounts || []).map((v) => v.url), (user.links || []).map((l) => l.url)),
    stats: user.job_title ? { "job title": user.job_title } : {},
  });
}

// ------------------------------------------------------------------ personal websites

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? unescapeHtml(m[2] ?? m[3] ?? m[4] ?? "") : "";
}

function microformat(html, cls) {
  const re = new RegExp(`<([a-z0-9]+)[^>]*class\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, "i");
  const m = html.match(re);
  if (!m) return "";
  const open = m[0].slice(0, m[0].indexOf(">") + 1);
  // u-* properties are URLs (u-email, u-url); the rest are text.
  const value = cls.startsWith("u-") ? attr(open, "href") || attr(open, "src") : attr(open, "title") || attr(open, "content");
  return (value || stripHtml(m[2])).trim().slice(0, 200);
}

function jsonLdPeople(html) {
  const people = [];
  for (const [, body] of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(body); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      const type = [].concat(node["@type"] || []);
      if (type.includes("Person")) people.push(node);
      for (const key of ["@graph", "author", "mainEntity", "founder", "creator"]) if (node[key]) stack.push(node[key]);
    }
  }
  return people;
}

/** Reads someone's own website: rel="me" links, h-card and schema.org Person data. */
export function parseSite(html, url) {
  const page = html.slice(0, 600000);
  const host = hostOf(url);
  const meta = (prop) => {
    for (const tag of page.match(/<meta\b[^>]*>/gi) || []) {
      if ([attr(tag, "property"), attr(tag, "name")].some((v) => v.toLowerCase() === prop)) return attr(tag, "content");
    }
    return "";
  };
  const tags = page.match(/<(a|link)\b[^>]*>/gi) || [];
  const relMe = [], outbound = [];
  for (const tag of tags) {
    const href = attr(tag, "href");
    if (!href || href.startsWith("#")) continue;
    let abs;
    try { abs = new URL(href, url).href; } catch { continue; }
    if (/(^|\s)me(\s|$)/i.test(attr(tag, "rel"))) relMe.push(abs);
    else if (/^<a/i.test(tag) && hostOf(abs) !== host) outbound.push(abs);
  }
  const person = jsonLdPeople(page)[0] || {};
  const address = typeof person.address === "object" ? person.address : {};
  const worksFor = [].concat(person.worksFor || [])[0];
  const hcardEmail = microformat(page, "u-email").replace(/^mailto:/i, "");
  return {
    title: unescapeHtml((page.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim().slice(0, 200),
    description: meta("description") || meta("og:description"),
    name: microformat(page, "p-name") || (typeof person.name === "string" ? person.name : "") || meta("author"),
    location: microformat(page, "p-locality") || microformat(page, "p-adr") || address.addressLocality || "",
    company: microformat(page, "p-org") || (typeof worksFor === "object" ? worksFor?.name : worksFor) || "",
    email: hcardEmail.includes("@") ? hcardEmail : (typeof person.email === "string" ? person.email.replace(/^mailto:/i, "") : ""),
    relMe: links(relMe, [].concat(person.sameAs || [])),
    outbound: links(outbound),
    jobTitle: typeof person.jobTitle === "string" ? person.jobTitle : "",
  };
}

async function website(target, net) {
  const url = /^https?:\/\//.test(target) ? target : `https://${target}/`;
  const host = hostOf(url);
  if (!publicHost(host)) return null;
  const html = await getText(net, url, { missing: [404, 410] });
  if (!html) return null;
  const site = parseSite(html, url);
  const a = account("website", host, url, {
    name: site.name, bio: site.description || site.title, location: site.location, company: site.company,
    email: site.email, links: site.relMe,
    stats: { "rel=me links": site.relMe.length, ...(site.jobTitle ? { "job title": site.jobTitle } : {}) },
  });
  // rel="me" links are the owner's claim; they confirm an account only when it links back.
  return a;
}

async function linkhub(platform, handle, net) {
  const base = { linktree: "https://linktr.ee/", biolink: "https://bio.link/", aboutme: "https://about.me/", beacons: "https://beacons.ai/" }[platform];
  const html = await getText(net, base + q(handle));
  if (!html) return null;
  const site = parseSite(html, base + handle);
  const ownHosts = new Set([hostOf(base), "linktr.ee", "assets.production.linktr.ee"]);
  const out = site.outbound.filter((u) => !ownHosts.has(hostOf(u)) && !/(privacy|terms|cookie|signup|login|report)/i.test(u));
  return account(platform, handle, base + handle, {
    name: site.name || site.title.replace(/\s*[|-].*$/, "").replace(/^@/, ""), bio: site.description,
    links: out.slice(0, 40), stats: { links: out.length },
  });
}

// ------------------------------------------------------------------ registry

export const SOURCES = {
  github, gitlab, codeberg, npm, pypi, crates, dockerhub, hackernews, reddit, stackoverflow, lobsters, devto,
  keybase, bluesky, mastodon, lichess, chesscom, medium, substack, "substack-publication": substackPublication,
  gravatar, website,
  ...Object.fromEntries([...LINK_HUBS].map((p) => [p, (h, net) => linkhub(p, h, net)])),
};

// Tried for a plain username. The rest need a specific identifier or are reached through links.
export const BY_USERNAME = ["github", "gitlab", "codeberg", "npm", "pypi", "crates", "dockerhub", "hackernews",
  "reddit", "lobsters", "devto", "keybase", "bluesky", "lichess", "chesscom", "medium", "substack"];

export const PLATFORMS = Object.keys(SOURCES);

// Where an account owner can change what they publish (used by the footprint audit).
export function settingsUrl(a) {
  const host = a.platform === "mastodon" ? a.handle.split("@")[1] : "";
  return {
    github: "https://github.com/settings/profile", gitlab: "https://gitlab.com/-/user_settings/profile",
    codeberg: "https://codeberg.org/user/settings", npm: `https://www.npmjs.com/settings/${a.handle}/profile`,
    pypi: "https://pypi.org/manage/account/", crates: "https://crates.io/settings/profile",
    dockerhub: "https://hub.docker.com/settings/general", hackernews: a.url, reddit: "https://www.reddit.com/settings/profile",
    stackoverflow: `https://stackoverflow.com/users/edit/${a.handle}`, lobsters: "https://lobste.rs/settings",
    devto: "https://dev.to/settings", keybase: a.url, bluesky: "https://bsky.app/settings",
    mastodon: host ? `https://${host}/settings/profile` : a.url, lichess: "https://lichess.org/account/profile",
    chesscom: "https://www.chess.com/settings", medium: "https://medium.com/me/settings",
    substack: "https://substack.com/settings", gravatar: "https://gravatar.com/profile", website: a.url,
  }[a.platform] || a.url;
}
