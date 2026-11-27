// Browser port of the Python profiler: same sources, pivoting and confidence grading.
// Every request goes straight from the viewer's browser to the platform's public API.

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp"];
const SIMPLE = {
  "github.com": "github", "gitlab.com": "gitlab", "keybase.io": "keybase",
  "dev.to": "devto", "twitter.com": "twitter", "x.com": "twitter",
};
const RESERVED = new Set(["about", "explore", "features", "home", "i", "intent", "login", "orgs",
  "pricing", "search", "settings", "share", "sponsors", "topics", "users", "apps", "marketplace"]);
const NOT_FEDIVERSE = new Set(["medium.com", "youtube.com", "tiktok.com", "threads.net",
  "threads.com", "npmjs.com", "telegram.me", "substack.com"]);
export const CONFIDENCE = ["asserted", "confirmed", "likely", "possible", "unverified"];

// ------------------------------------------------------------------ links

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeHtml(text) {
  return (text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(text) {
  return unescapeHtml((text || "").replace(/<p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
}

export function publicHost(host) {
  host = (host || "").toLowerCase();
  return HOST_RE.test(host) && !PRIVATE_SUFFIXES.some((s) => host.endsWith(s));
}

export function cleanUrl(url) {
  url = (url || "").trim().replace(/[.,;]+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    return new URL(url).hostname.includes(".") ? url : "";
  } catch {
    return "";
  }
}

export function extractUrls(text) {
  // Search the raw markup too: rich-text fields often keep the full URL only in href.
  const found = (unescapeHtml(text).match(URL_RE) || []).map(cleanUrl).filter(Boolean);
  return [...new Set(found)];
}

export function classify(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const parts = parsed.pathname.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });

  if (SIMPLE[host] && parts.length === 1) {
    const handle = parts[0].replace(/^@/, "");
    return HANDLE.test(handle) && !RESERVED.has(handle.toLowerCase()) ? [SIMPLE[host], handle] : null;
  }
  if (host === "news.ycombinator.com" && parsed.pathname === "/user") {
    const id = parsed.searchParams.get("id");
    return id && HANDLE.test(id) ? ["hackernews", id] : null;
  }
  if (host === "bsky.app" && parts.length === 2 && parts[0] === "profile") {
    return publicHost(parts[1]) ? ["bluesky", parts[1]] : null;
  }
  if (host === "linkedin.com" && parts.length >= 2 && parts[0] === "in") return ["linkedin", parts[1]];
  if (host === "hub.docker.com" && parts.length === 2 && parts[0] === "u") return ["dockerhub", parts[1]];
  if (host === "npmjs.com" && parts.length === 1 && parts[0].startsWith("~")) return ["npm", parts[0].slice(1)];
  if (parts.length === 1 && parts[0].startsWith("@") && !NOT_FEDIVERSE.has(host)) {
    const user = parts[0].slice(1);
    if (/^[A-Za-z0-9_]{1,30}$/.test(user) && publicHost(host)) return ["mastodon", `${user}@${host}`];
  }
  return null;
}

// ---------------------------------------------------------------- sources

class Unavailable extends Error {}

async function get(fetch, url, missing = [404]) {
  const [status, data] = await fetch(url);
  if (missing.includes(status)) return null;
  if (status !== 200) {
    throw new Unavailable(status ? `HTTP ${status}` : "no response (the site may not allow browser requests)");
  }
  return data;
}

async function soft(fetch, url) {
  try { return await get(fetch, url); } catch { return null; }
}

function iso(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 1e11 ? value : value * 1000;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return String(value);
}

const q = encodeURIComponent;

function links(...values) {
  const seen = new Set(), out = [];
  for (const value of values) {
    const url = cleanUrl(value);
    if (url && !seen.has(url.toLowerCase())) { seen.add(url.toLowerCase()); out.push(url); }
  }
  return out;
}

function account(platform, handle, url, extra = {}) {
  return {
    platform, handle, url, name: "", bio: "", location: "", company: "", email: "", avatar: "",
    created: "", links: [], stats: {}, languages: {}, topics: [], highlights: [], activity: [],
    proofs: [], origin: "username", confidence: "unverified", evidence: [], ...extra,
  };
}

function countTop(items, n) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const SOURCES = {
  async github(handle, fetch) {
    const base = `https://api.github.com/users/${q(handle)}`;
    const user = await get(fetch, base);
    if (!user) return null;
    const [social, repoList, events, orgs] = await Promise.all([
      soft(fetch, `${base}/social_accounts`), soft(fetch, `${base}/repos?per_page=100&sort=pushed`),
      soft(fetch, `${base}/events/public?per_page=100`), soft(fetch, `${base}/orgs`)]);
    const tw = user.twitter_username;
    const a = account("github", user.login, user.html_url, {
      name: user.name || "", bio: user.bio || "", location: user.location || "",
      company: (user.company || "").replace(/^@/, ""), email: user.email || "",
      avatar: user.avatar_url || "", created: iso(user.created_at),
      links: links(user.blog, tw ? `https://twitter.com/${tw}` : "",
        ...(social || []).map((s) => s.url), ...extractUrls(user.bio || "")),
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
    return a;
  },

  async gitlab(handle, fetch) {
    const found = await get(fetch, `https://gitlab.com/api/v4/users?username=${q(handle)}`);
    if (!found || !found.length) return null;
    const user = (await soft(fetch, `https://gitlab.com/api/v4/users/${found[0].id}`)) || found[0];
    return account("gitlab", user.username, user.web_url, {
      name: user.name || "", bio: user.bio || "", location: user.location || "",
      company: user.organization || "", email: user.public_email || "",
      avatar: user.avatar_url || "", created: iso(user.created_at),
      links: links(user.website_url, user.twitter ? `https://twitter.com/${user.twitter.replace(/^@/, "")}` : "",
        user.linkedin ? `https://linkedin.com/in/${user.linkedin}` : "", ...extractUrls(user.bio || "")),
      stats: user.job_title ? { "job title": user.job_title } : {},
    });
  },

  async hackernews(handle, fetch) {
    const user = await get(fetch, `https://hacker-news.firebaseio.com/v0/user/${q(handle)}.json`);
    if (!user) return null;
    const about = user.about || "";
    const a = account("hackernews", user.id, `https://news.ycombinator.com/user?id=${q(user.id)}`, {
      bio: stripHtml(about), created: iso(user.created), links: links(...extractUrls(about)),
      stats: { karma: user.karma || 0 },
    });
    const search = await soft(fetch,
      `https://hn.algolia.com/api/v1/search_by_date?tags=author_${q(user.id)}&hitsPerPage=100`);
    const hits = (search && search.hits) || [];
    a.activity = hits.map((h) => h.created_at).filter(Boolean);
    a.highlights = hits.filter((h) => h.title).sort((x, y) => (y.points || 0) - (x.points || 0)).slice(0, 3)
      .map((h) => ({ title: h.title, note: `${h.points || 0} points`,
        url: `https://news.ycombinator.com/item?id=${h.objectID}` }));
    return a;
  },

  async bluesky(handle, fetch) {
    const actor = handle.includes(".") ? handle : `${handle}.bsky.social`;
    const api = "https://public.api.bsky.app/xrpc";
    const user = await get(fetch, `${api}/app.bsky.actor.getProfile?actor=${q(actor)}`, [400, 404]);
    if (!user) return null;
    const a = account("bluesky", user.handle, `https://bsky.app/profile/${user.handle}`, {
      name: user.displayName || "", bio: user.description || "", avatar: user.avatar || "",
      created: iso(user.createdAt), links: links(...extractUrls(user.description || "")),
      stats: { followers: user.followersCount || 0, posts: user.postsCount || 0 },
    });
    const feed = await soft(fetch, `${api}/app.bsky.feed.getAuthorFeed?actor=${q(actor)}&limit=100`);
    a.activity = ((feed && feed.feed) || [])
      .filter((i) => i.post?.author?.handle === user.handle && i.post?.record?.createdAt)
      .map((i) => i.post.record.createdAt);
    return a;
  },

  async mastodon(handle, fetch) {
    const [userPart, host] = handle.replace(/^@/, "").split("@");
    if (!userPart || !publicHost(host)) throw new Unavailable("needs user@instance");
    const user = await get(fetch, `https://${host}/api/v1/accounts/lookup?acct=${q(userPart)}`);
    if (!user) return null;
    const fields = user.fields || [];
    const a = account("mastodon", `${user.username}@${host}`, user.url || `https://${host}/@${userPart}`, {
      name: user.display_name || "", bio: stripHtml(user.note || ""), avatar: user.avatar || "",
      created: iso(user.created_at),
      links: links(...fields.flatMap((f) => extractUrls(f.value || "")), ...extractUrls(user.note || "")),
      stats: { followers: user.followers_count || 0, posts: user.statuses_count || 0 },
    });
    const statuses = await soft(fetch,
      `https://${host}/api/v1/accounts/${q(String(user.id))}/statuses?limit=40&exclude_reblogs=true`);
    a.activity = (statuses || []).map((s) => s.created_at).filter(Boolean);
    return a;
  },

  async keybase(handle, fetch) {
    if (!/^[A-Za-z0-9_]{2,16}$/.test(handle)) return null;
    const data = await get(fetch, `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${q(handle)}`);
    const them = ((data && data.them) || []).filter(Boolean);
    if (!them.length) return null;
    const user = them[0], profile = user.profile || {};
    const proofs = user.proofs_summary?.all || [];
    const name = user.basics.username;
    const a = account("keybase", name, `https://keybase.io/${name}`, {
      name: profile.full_name || "", bio: profile.bio || "", location: profile.location || "",
      avatar: user.pictures?.primary?.url || "", created: iso(user.basics.ctime),
      links: links(...proofs.map((p) => p.service_url)), stats: { "verified proofs": proofs.length },
    });
    const kinds = ["github", "twitter", "hackernews", "gitlab"];
    a.proofs = proofs.filter((p) => kinds.includes(p.proof_type) && p.nametag).map((p) => [p.proof_type, p.nametag]);
    return a;
  },

  async devto(handle, fetch) {
    const user = await get(fetch, `https://dev.to/api/users/by_username?url=${q(handle)}`);
    if (!user) return null;
    const gh = user.github_username, tw = user.twitter_username;
    return account("devto", user.username, `https://dev.to/${user.username}`, {
      name: user.name || "", bio: user.summary || "", location: user.location || "",
      avatar: user.profile_image || "",
      links: links(user.website_url, gh ? `https://github.com/${gh}` : "", tw ? `https://twitter.com/${tw}` : ""),
      stats: user.joined_at ? { joined: user.joined_at } : {},
    });
  },

  async npm(handle, fetch) {
    const data = await get(fetch, `https://registry.npmjs.org/-/v1/search?text=maintainer:${q(handle)}&size=20`);
    const objects = (data && data.objects) || [];
    if (!objects.length) return null;
    const a = account("npm", handle, `https://www.npmjs.com/~${q(handle)}`,
      { stats: { packages: data.total || objects.length } });
    a.highlights = objects.slice(0, 5).map(({ package: p }) => ({
      title: p.name, note: p.description || "no description", url: `https://www.npmjs.com/package/${p.name}` }));
    a.activity = objects.map((o) => o.package.date).filter(Boolean);
    return a;
  },

  async dockerhub(handle, fetch) {
    const user = await get(fetch, `https://hub.docker.com/v2/users/${q(handle)}/`);
    if (!user || !user.username) return null;
    return account("dockerhub", user.username, `https://hub.docker.com/u/${user.username}`, {
      name: user.full_name || "", location: user.location || "", company: user.company || "",
      avatar: user.gravatar_url || "", created: iso(user.date_joined), links: links(user.profile_url),
    });
  },

  async gravatar(email, fetch) {
    const bytes = new TextEncoder().encode(email.trim().toLowerCase());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const user = await get(fetch, `https://api.gravatar.com/v3/profiles/${digest}`);
    if (!user) return null;
    return account("gravatar", email, user.profile_url || "", {
      name: user.display_name || "", bio: user.description || "", location: user.location || "",
      company: user.company || "", avatar: user.avatar_url || "",
      links: links(...(user.verified_accounts || []).map((v) => v.url)),
      stats: user.job_title ? { "job title": user.job_title } : {},
    });
  },
};

export const BY_USERNAME = ["github", "gitlab", "hackernews", "bluesky", "keybase", "devto", "npm", "dockerhub"];
export const PLATFORMS = Object.keys(SOURCES);

// ----------------------------------------------------------------- engine

const MAX_PIVOTS_PER_ROUND = 10;

function normHandle(platform, handle) {
  handle = handle.toLowerCase().replace(/^@/, "");
  if (platform === "bluesky" && !handle.includes(".")) handle += ".bsky.social";
  return handle;
}
const keyOf = (platform, handle) => `${platform}:${normHandle(platform, handle)}`;
const norm = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function targets(a) {
  const found = a.links.map(classify).filter(Boolean).concat(a.proofs);
  const seen = new Set();
  return found.filter(([p, h]) => !seen.has(keyOf(p, h)) && seen.add(keyOf(p, h)));
}

function sites(a) {
  const hosts = new Set();
  for (const url of a.links) {
    if (classify(url)) continue;
    try { hosts.add(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); } catch { /* skip */ }
  }
  return hosts;
}

async function collect({ handle, explicit, email, fetch, only, pivot, onProgress }) {
  let queue = [];
  if (handle) queue.push(...BY_USERNAME.filter((p) => !(p in explicit)).map((p) => [p, handle, "username"]));
  queue.push(...Object.entries(explicit).map(([p, h]) => [p, h, "asserted"]));
  if (email) queue.push(["gravatar", email, "asserted"]);
  if (only) queue = queue.filter(([p]) => only.has(p));

  const seen = new Set(), accounts = [], attempts = [];
  for (let round = 0; round < 3; round++) {
    const batch = queue.filter(([p, h]) => !seen.has(keyOf(p, h)) && seen.add(keyOf(p, h)));
    if (!batch.length) break;
    onProgress?.(`Checking ${batch.map(([p]) => p).join(", ")}…`);
    const results = await Promise.all(batch.map(async ([platform, target, origin]) => {
      try {
        const a = await SOURCES[platform](target, fetch);
        if (a) a.origin = origin;
        return [platform, target, a, ""];
      } catch (error) {
        const detail = error instanceof Unavailable ? error.message : `unexpected response (${error.name})`;
        return [platform, target, null, detail];
      }
    }));
    const found = [];
    for (const [platform, target, a, error] of results) {
      if (a) {
        const key = keyOf(a.platform, a.handle);
        if (accounts.some((b) => keyOf(b.platform, b.handle) === key)) continue;
        seen.add(key);
        accounts.push(a);
        found.push(a);
        attempts.push({ platform, handle: a.handle, status: "found", detail: "" });
      } else {
        attempts.push({ platform, handle: target, status: error ? "unavailable" : "not found", detail: error });
      }
    }
    queue = [];
    if (pivot) {
      for (const a of found) {
        for (const [p, h] of targets(a)) {
          if (SOURCES[p] && (!only || only.has(p))) queue.push([p, h, `pivot:${a.platform}`]);
        }
      }
      queue = queue.slice(0, MAX_PIVOTS_PER_ROUND);
    }
  }
  return { accounts, attempts };
}

export function correlate(accounts) {
  const pointsTo = new Map(accounts.map((a) => [a, new Set(targets(a).map(([p, h]) => keyOf(p, h)))]));
  const proven = new Map(accounts.map((a) => [a, new Set(a.proofs.map(([p, h]) => keyOf(p, h)))]));
  const key = (a) => keyOf(a.platform, a.handle);

  for (const a of accounts) {
    let level = 4;
    const evidence = [];
    for (const b of accounts) {
      if (b === a) continue;
      const inbound = pointsTo.get(b).has(key(a)), outbound = pointsTo.get(a).has(key(b));
      if (proven.get(b).has(key(a)) || proven.get(a).has(key(b))) {
        level = Math.min(level, 1); evidence.push(`cryptographic proof shared with ${b.platform}`);
      } else if (inbound && outbound) {
        level = Math.min(level, 1); evidence.push(`links to and from the ${b.platform} profile`);
      } else if (inbound || outbound) {
        level = Math.min(level, 2); evidence.push(`linked ${inbound ? "from" : "to"} the ${b.platform} profile`);
      }
      const sameName = norm(a.name).length >= 5 && norm(a.name) === norm(b.name) && norm(a.name) !== norm(a.handle);
      const shared = [];
      const bSites = sites(b);
      if ([...sites(a)].some((s) => bSites.has(s))) shared.push("website");
      if (norm(a.location) && norm(a.location) === norm(b.location)) shared.push("location");
      if (norm(a.company) && norm(a.company) === norm(b.company)) shared.push("employer");
      if (sameName && shared.length) {
        level = Math.min(level, 2); evidence.push(`same name and ${shared.join(", ")} as ${b.platform}`);
      } else if (sameName || shared.includes("website")) {
        level = Math.min(level, 3); evidence.push(`same ${sameName ? "name" : "website"} as ${b.platform}`);
      }
    }
    if (a.origin === "asserted") { level = 0; evidence.unshift("identifier supplied by you"); }
    a.confidence = CONFIDENCE[level];
    a.evidence = evidence.length ? [...new Set(evidence)] : ["username match only — may be a different person"];
  }
  accounts.sort((x, y) => CONFIDENCE.indexOf(x.confidence) - CONFIDENCE.indexOf(y.confidence));
}

function facts(accounts, attr) {
  const grouped = new Map();
  for (const a of accounts) {
    const value = (a[attr] || "").trim();
    if (!value) continue;
    const k = norm(value) || value;
    if (!grouped.has(k)) grouped.set(k, { value, sources: [], verified: false });
    const fact = grouped.get(k);
    fact.sources.push(a.platform);
    fact.verified ||= a.confidence !== "unverified";
  }
  return [...grouped.values()].sort((x, y) => (x.verified === y.verified ? y.sources.length - x.sources.length : x.verified ? -1 : 1));
}

export function summarise(accounts) {
  const s = {};
  for (const [k, attr] of [["names", "name"], ["locations", "location"], ["employers", "company"], ["emails", "email"]]) {
    s[k] = facts(accounts, attr);
  }
  const known = new Set(accounts.map((a) => keyOf(a.platform, a.handle)));
  const linkMap = new Map();
  for (const a of accounts) {
    for (const url of a.links) {
      const t = classify(url);
      if (t && known.has(keyOf(...t))) continue;
      const k = url.toLowerCase().replace(/\/+$/, "");
      if (!linkMap.has(k)) linkMap.set(k, { url, kind: t ? t[0] : "website", sources: [] });
      linkMap.get(k).sources.push(a.platform);
    }
  }
  s.links = [...linkMap.values()];

  const langs = new Map(), stamps = [];
  for (const a of accounts) {
    for (const [l, n] of Object.entries(a.languages)) langs.set(l, (langs.get(l) || 0) + n);
    stamps.push(...a.activity);
  }
  s.languages = [...langs].sort((x, y) => y[1] - x[1]).slice(0, 8);
  s.interests = countTop(accounts.flatMap((a) => a.topics), 12).map(([t]) => t);

  const hours = Array(24).fill(0), days = Array(7).fill(0);
  for (const stamp of stamps) {
    const d = new Date(stamp);
    if (isNaN(d)) continue;
    hours[d.getUTCHours()]++;
    days[(d.getUTCDay() + 6) % 7]++;
  }
  s.activity = { hours, days, events: hours.reduce((x, y) => x + y, 0) };

  // The headline only states what corroborated accounts say.
  const trusted = accounts.filter((a) => a.confidence !== "unverified");
  const bits = [];
  const tl = new Map();
  for (const a of trusted) for (const [l, n] of Object.entries(a.languages)) tl.set(l, (tl.get(l) || 0) + n);
  if (tl.size) bits.push(`writes mostly ${[...tl].sort((x, y) => y[1] - x[1])[0][0]}`);
  const employer = trusted.find((a) => a.company)?.company;
  if (employer) bits.push(`lists ${employer} as employer`);
  const place = trusted.find((a) => a.location)?.location;
  if (place) bits.push(`based in ${place}`);
  const since = trusted.map((a) => a.created).filter(Boolean).sort();
  if (since.length) bits.push(`online since ${since[0].slice(0, 4)}`);
  s.first_seen = since.length ? since[0].slice(0, 10) : "";
  s.tagline = accounts.length && !trusted.length
    ? "no corroborated accounts — everything below matched on username alone" : bits.join("; ");
  s.display_name = trusted.find((a) => a.name)?.name || "";
  return s;
}

export function makeFetch(token = "") {
  return async (url) => {
    const headers = { Accept: "application/json" };
    if (token && new URL(url).hostname === "api.github.com") headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch(url, { headers, referrerPolicy: "no-referrer" });
      if (!response.ok) return [response.status, null];
      return [response.status, await response.json()];
    } catch {
      return [0, null];
    }
  };
}

export async function build({ handle = "", explicit = {}, email = "", fetch, only = null,
  pivot = true, strict = false, onProgress } = {}) {
  const cache = new Map();
  const cached = (url) => {
    if (!cache.has(url)) cache.set(url, fetch(url));
    return cache.get(url);
  };
  let { accounts, attempts } = await collect({ handle, explicit, email, fetch: cached, only, pivot, onProgress });
  correlate(accounts);
  if (strict) accounts = accounts.filter((a) => a.confidence !== "unverified");
  const subject = handle || email || Object.values(explicit)[0] || "";
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return { subject, generated, accounts, attempts, summary: summarise(accounts) };
}
