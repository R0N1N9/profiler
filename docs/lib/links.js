// Recognise links to profiles, so one account can lead to the next.

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".test", ".example", ".invalid"];

// Hosts whose first path segment is a profile handle (a leading @ is dropped).
const SIMPLE = {
  "github.com": "github", "gitlab.com": "gitlab", "keybase.io": "keybase", "dev.to": "devto",
  "twitter.com": "twitter", "x.com": "twitter", "codeberg.org": "codeberg", "instagram.com": "instagram",
  "tiktok.com": "tiktok", "facebook.com": "facebook", "twitch.tv": "twitch", "threads.net": "threads",
  "threads.com": "threads", "youtube.com": "youtube", "medium.com": "medium", "t.me": "telegram",
  "patreon.com": "patreon", "ko-fi.com": "kofi", "buymeacoffee.com": "buymeacoffee", "soundcloud.com": "soundcloud",
  "behance.net": "behance", "dribbble.com": "dribbble", "kaggle.com": "kaggle", "hashnode.com": "hashnode",
  "huggingface.co": "huggingface", "leetcode.com": "leetcode", "replit.com": "replit", "itch.io": "itch",
  "pinterest.com": "pinterest", "flickr.com": "flickr", "vimeo.com": "vimeo", "linktr.ee": "linktree",
  "bio.link": "biolink", "about.me": "aboutme", "beacons.ai": "beacons",
};
// Only these accept a handle without "@" in the first segment.
const AT_ONLY = new Set(["youtube", "medium", "threads", "tiktok"]);
const RESERVED = new Set(["about", "explore", "features", "home", "i", "intent", "login", "orgs", "pricing",
  "search", "settings", "share", "sponsors", "topics", "users", "apps", "marketplace", "watch", "p", "reel",
  "channel", "c", "user", "groups", "pages", "hashtag", "tag", "tags", "blog", "docs", "help", "jobs",
  "notifications", "new", "signup", "join", "privacy", "terms", "policies", "events", "collections"]);
const NOT_FEDIVERSE = new Set(["medium.com", "youtube.com", "tiktok.com", "threads.net", "threads.com",
  "npmjs.com", "telegram.me", "substack.com", "lichess.org"]);
// Services that only aggregate someone's links: their outbound links are the person's own.
export const LINK_HUBS = new Set(["linktree", "biolink", "aboutme", "beacons"]);
// Hosts that are platforms, not personal sites, even when a link to them is not a profile.
const PLATFORM_HOSTS = /(^|\.)(google|apple|microsoft|amazon|wikipedia|github|gitlab|youtube|youtu|twitter|x|facebook|instagram|linkedin|reddit|medium|stackoverflow|stackexchange|bsky|mastodon\.social|npmjs|pypi|docker|discord|slack|t|zoom|notion|ycombinator|substack|patreon|paypal|cash|venmo|spotify|apple|twitch|tiktok|lichess|chess|codeberg|crates|gravatar|keybase|dev|bit|tinyurl|goo|amzn|lnkd|wa)\.[a-z.]+$/;

const PERSONAL_HOSTING = /\.(github\.io|gitlab\.io|codeberg\.page|netlify\.app|vercel\.app|pages\.dev|neocities\.org|carrd\.co|bearblog\.dev|micro\.blog)$/;

export function publicHost(host) {
  host = (host || "").toLowerCase();
  return HOST_RE.test(host) && !PRIVATE_SUFFIXES.some((s) => host.endsWith(s));
}

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
  return unescapeHtml((text || "").replace(/<p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export function cleanUrl(url) {
  url = (url || "").trim().replace(/[.,;:!?]+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z]+:/i.test(url) && !/^[^/:]+:\d/.test(url)) return "";  // mailto:, javascript: ...
    url = "https://" + url.replace(/^\/+/, "");
  }
  try {
    const parsed = new URL(url);
    return publicHost(parsed.hostname) ? parsed.href : "";
  } catch {
    return "";
  }
}

export function extractUrls(text) {
  // Search the raw markup too: rich-text fields often keep the full URL only in href.
  const found = (unescapeHtml(text).match(URL_RE) || []).map(cleanUrl).filter(Boolean);
  return [...new Set(found)];
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function segments(parsed) {
  return parsed.pathname.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
}

/** Map a URL to [platform, handle] when it is a recognisable profile link. */
export function classify(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile|old|new)\./, "");
  const parts = segments(parsed);

  if (SIMPLE[host] && parts.length >= 1) {
    const platform = SIMPLE[host];
    // A profile is one segment, plus a few harmless trailing ones on some sites.
    if (parts.length > 1 && !(platform === "youtube" && ["videos", "featured", "about"].includes(parts[1]))) return null;
    const raw = parts[0];
    if (AT_ONLY.has(platform) && !raw.startsWith("@")) return null;
    const handle = raw.replace(/^@/, "");
    return HANDLE.test(handle) && !RESERVED.has(handle.toLowerCase()) ? [platform, handle] : null;
  }
  if (host === "news.ycombinator.com" && parsed.pathname === "/user") {
    const id = parsed.searchParams.get("id");
    return id && HANDLE.test(id) ? ["hackernews", id] : null;
  }
  if (host === "bsky.app" && parts.length === 2 && parts[0] === "profile") {
    return publicHost(parts[1]) ? ["bluesky", parts[1]] : null;
  }
  if (host === "linkedin.com" && parts.length >= 2 && parts[0] === "in") return ["linkedin", parts[1]];
  if (host === "hub.docker.com" && parts.length === 2 && ["u", "r"].includes(parts[0])) return ["dockerhub", parts[1]];
  if (host === "npmjs.com" && parts.length === 1 && parts[0].startsWith("~")) return ["npm", parts[0].slice(1)];
  if (host === "reddit.com" && parts.length >= 2 && ["user", "u"].includes(parts[0]) && HANDLE.test(parts[1])) {
    return ["reddit", parts[1]];
  }
  if (host === "stackoverflow.com" && parts.length >= 2 && parts[0] === "users" && /^\d+$/.test(parts[1])) {
    return ["stackoverflow", parts[1]];
  }
  if (host === "lobste.rs" && parts.length === 1 && parts[0].startsWith("~")) return ["lobsters", parts[0].slice(1)];
  if (host === "lobste.rs" && parts.length === 2 && parts[0] === "u") return ["lobsters", parts[1]];
  if (host === "crates.io" && parts.length === 2 && parts[0] === "users") return ["crates", parts[1]];
  if (host === "pypi.org" && parts.length === 2 && parts[0] === "user") return ["pypi", parts[1]];
  if (host === "lichess.org" && parts.length === 2 && parts[0] === "@") return ["lichess", parts[1]];
  if (host === "chess.com" && parts.length === 2 && parts[0] === "member") return ["chesscom", parts[1]];
  if (host.endsWith(".substack.com") && parts.length === 0) {
    const sub = host.slice(0, -".substack.com".length);
    return HANDLE.test(sub) && sub !== "www" ? ["substack-publication", sub] : null;
  }
  if (host === "substack.com" && parts.length === 1 && parts[0].startsWith("@")) return ["substack", parts[0].slice(1)];
  if (parts.length === 1 && parts[0].startsWith("@") && !NOT_FEDIVERSE.has(host)) {
    const user = parts[0].slice(1);
    if (/^[A-Za-z0-9_]{1,30}$/.test(user) && publicHost(host)) return ["mastodon", `${user}@${host}`];
  }
  return null;
}

/** A link that looks like someone's own website rather than a profile or a big platform. */
export function personalSite(url) {
  if (classify(url)) return "";
  const host = hostOf(url);
  if (!host) return "";
  if (PERSONAL_HOSTING.test(host)) return host;
  if (PLATFORM_HOSTS.test(host)) return "";
  return host;
}
