// Profiler relay: a Cloudflare Worker that fetches public pages for the profiler web app,
// because browsers block most cross-site requests. Deploy your own; see README.md.
//
// POST /relay   Authorization: Bearer <RELAY_TOKEN>
//   {"requests": [{"url", "method", "headers", "body", "redirect", "find": [..], "wantBody": bool}]}
// -> {"responses": [{"status", "found": [bool..], "body"?}]}

const MAX_REQUESTS = 45;          // Workers allow 50 outbound requests per invocation on the free plan
const MAX_BODY = 400_000;         // characters of each page returned when the body is wanted
const TIMEOUT_MS = 10_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const DROP_HEADERS = new Set(["host", "cookie", "connection", "content-length", "te", "x-forwarded-for", "cf-connecting-ip"]);

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
}

// Only public web hosts: no IP literals, localhost or internal names.
export function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid)$/.test(host)) return null;
  if (url.port && !["80", "443"].includes(url.port)) return null;
  return url;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function relayOne(req, fetchImpl) {
  const url = allowedUrl(req?.url);
  if (!url) return { status: 0, error: "url not allowed", found: [] };
  const method = ["GET", "POST", "HEAD"].includes(req.method) ? req.method : "GET";
  const headers = { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" };
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = k.toLowerCase();
    if (DROP_HEADERS.has(key) || typeof v !== "string") continue;
    // A GitHub token is only ever forwarded to GitHub's API.
    if (key === "authorization" && url.hostname !== "api.github.com") continue;
    headers[k] = v;
  }
  const body = method === "POST" && typeof req.body === "string" ? req.body.slice(0, 10_000) : undefined;
  try {
    const response = await fetchImpl(url.href, {
      method, headers, body, redirect: req.redirect === "manual" ? "manual" : "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = method === "HEAD" ? "" : await response.text();
    const find = Array.isArray(req.find) ? req.find.slice(0, 4).map(String) : [];
    const out = { status: response.status, found: find.map((s) => text.includes(s)) };
    if (req.wantBody) out.body = text.slice(0, MAX_BODY);
    return out;
  } catch (error) {
    return { status: 0, error: error.name === "TimeoutError" ? "timeout" : "fetch failed", found: [] };
  }
}

export default {
  async fetch(request, env, ctx, fetchImpl = globalThis.fetch) {
    const origin = request.headers.get("Origin");
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (pathname === "/" || pathname === "/health") {
      return json({ ok: true, configured: Boolean(env.RELAY_TOKEN) }, 200, origin);
    }
    if (pathname !== "/relay" || request.method !== "POST") return json({ error: "not found" }, 404, origin);
    if (!env.RELAY_TOKEN || env.RELAY_TOKEN.length < 16) {
      return json({ error: "set a RELAY_TOKEN secret of at least 16 characters" }, 503, origin);
    }
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(token, env.RELAY_TOKEN)) return json({ error: "unauthorized" }, 401, origin);

    let payload;
    try { payload = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, origin); }
    const requests = Array.isArray(payload?.requests) ? payload.requests : null;
    if (!requests || requests.length > MAX_REQUESTS) {
      return json({ error: `send 1-${MAX_REQUESTS} requests` }, 400, origin);
    }
    const responses = await Promise.all(requests.map((r) => relayOne(r, fetchImpl)));
    return json({ responses }, 200, origin);
  },
};
