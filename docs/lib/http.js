// Network layer. Every source talks to a `Net` object, so the same code runs in a
// browser (direct, falling back to the relay) and in Node (direct).

const TIMEOUT_MS = 15000;

/** Run at most `limit` tasks at a time. */
export function limiter(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active++;
    const { task, resolve, reject } = waiting.shift();
    task().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
}

/**
 * A raw transport: (url, {method, headers, body, find}) -> {status, text, found}
 * status 0 means no usable response (network error, timeout, or the browser blocked it).
 * `find` asks for a list of substrings to be tested; `found` reports which occur in the body.
 */
export function directTransport({ userAgent = "", concurrency = 12, fetchImpl = globalThis.fetch } = {}) {
  const run = limiter(concurrency);
  return (url, opts = {}) => run(async () => {
    const headers = { ...(opts.headers || {}) };
    if (userAgent) headers["User-Agent"] = userAgent;
    try {
      const response = await fetchImpl(url, {
        method: opts.method || "GET", headers, body: opts.body, redirect: opts.redirect || "follow",
        referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      return { status: response.status, text, found: (opts.find || []).map((s) => text.includes(s)) };
    } catch {
      return { status: 0, text: "", found: [] };
    }
  });
}

/** Sends requests through the profiler relay (relay/worker.js), batching them to save quota. */
export function relayTransport({ url, token, batchSize = 40, fetchImpl = globalThis.fetch }) {
  const endpoint = url.replace(/\/+$/, "") + "/relay";
  let queue = [];
  let timer = null;

  async function flush() {
    timer = null;
    const batch = queue.splice(0, batchSize);
    if (queue.length) timer = setTimeout(flush, 0);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requests: batch.map((item) => item.request) }),
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      const data = response.ok ? await response.json() : null;
      batch.forEach((item, i) => {
        const r = data?.responses?.[i];
        item.resolve(r ? { status: r.status || 0, text: r.body || "", found: r.found || [] }
          : { status: 0, text: "", found: [], relayError: response.status });
      });
    } catch {
      batch.forEach((item) => item.resolve({ status: 0, text: "", found: [] }));
    }
  }

  return (target, opts = {}) => new Promise((resolve) => {
    queue.push({
      request: { url: target, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body,
        redirect: opts.redirect || "follow",
        find: opts.find || [], wantBody: !opts.find || opts.wantBody === true },
      resolve,
    });
    if (queue.length >= batchSize) { clearTimeout(timer); flush(); }
    else if (!timer) timer = setTimeout(flush, 25);
  });
}

/** Browser strategy: go direct, and remember hosts the browser refuses so they use the relay. */
export function browserTransport({ relay = null } = {}) {
  const direct = directTransport({ concurrency: 10 });
  const blocked = new Set();
  return async (url, opts = {}) => {
    const host = new URL(url).host;
    if (relay && (blocked.has(host) || opts.preferRelay)) return relay(url, opts);
    const result = await direct(url, opts);
    if (result.status === 0 && relay) {
      blocked.add(host);
      return relay(url, opts);
    }
    if (result.status === 0) result.needsRelay = true;
    return result;
  };
}

/** What sources use: JSON/text helpers with an optional GitHub token. Results are cached per URL. */
export function makeNet(transport, { githubToken = "" } = {}) {
  const cache = new Map();
  const raw = (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (githubToken && new URL(url).hostname === "api.github.com") headers.Authorization = `Bearer ${githubToken}`;
    const key = JSON.stringify([url, opts.method || "GET", opts.body || "", opts.find || []]);
    if (!cache.has(key)) cache.set(key, transport(url, { ...opts, headers }));
    return cache.get(key);
  };
  return {
    raw,
    async text(url, opts) {
      const r = await raw(url, opts);
      return [r.status, r.status ? r.text : null, r];
    },
    async json(url, opts = {}) {
      const r = await raw(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
      if (!r.status || r.status >= 400) return [r.status, null, r];
      try { return [r.status, JSON.parse(r.text), r]; } catch { return [-1, null, r]; }
    },
  };
}
