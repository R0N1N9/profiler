// Collect accounts, follow the links they publish, grade how well they corroborate, summarise.

import { audit } from "./audit.js";
import { classify, hostOf, personalSite } from "./links.js";
import { WMN_URL, checkPresence, usableSites } from "./presence.js";
import { BY_USERNAME, SOURCES, Unavailable, countTop } from "./sources.js";

export const CONFIDENCE = ["asserted", "confirmed", "likely", "possible", "unverified"];
const MAX_PIVOTS_PER_ROUND = 14;
const MAX_VARIANTS = 6;
// Cheap, reliable sources used when trying username variations.
const VARIANT_SOURCES = ["github", "gitlab", "codeberg", "reddit", "hackernews", "bluesky", "keybase", "devto",
  "lobsters", "lichess", "chesscom", "medium"];

export function normHandle(platform, handle) {
  handle = String(handle).toLowerCase().replace(/^@/, "");
  if (platform === "bluesky" && !handle.includes(".")) handle += ".bsky.social";
  if (platform === "website") handle = handle.replace(/^www\./, "");
  return handle;
}
export const keyOf = (platform, handle) => `${platform}:${normHandle(platform, handle)}`;
const accountKey = (a) => keyOf(a.platform, a.handle);
const norm = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Profiles and personal sites an account points to, as [platform, handle]. */
function targets(a) {
  const out = [];
  for (const url of a.links) {
    const profile = classify(url);
    if (profile) out.push(profile);
    else if (personalSite(url)) out.push(["website", personalSite(url)]);
  }
  out.push(...a.proofs);
  const seen = new Set();
  return out.filter(([p, h]) => !seen.has(keyOf(p, h)) && seen.add(keyOf(p, h)));
}

function verifiedTargets(a) {
  return (a.verifiedLinks || []).map((u) => classify(u) || (personalSite(u) ? ["website", personalSite(u)] : null))
    .filter(Boolean).concat(a.proofs);
}

/** Plausible spellings of the same identity, e.g. ada_lovelace -> adalovelace, ada.lovelace, alovelace. */
export function usernameVariants(handle, names = []) {
  const out = new Set();
  const addParts = (parts) => {
    parts = parts.map((p) => p.toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    if (parts.length === 1) { out.add(parts[0]); return; }
    const [first, last] = [parts[0], parts[parts.length - 1]];
    for (const sep of ["", "_", ".", "-"]) out.add(parts.join(sep));
    out.add(first[0] + last);
  };
  if (handle) {
    const base = handle.replace(/^@/, "");
    addParts(base.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._-]+/));
    const noDigits = base.replace(/\d+$/, "");
    if (noDigits.length >= 3 && noDigits !== base) out.add(noDigits.toLowerCase());
  }
  for (const name of names) {
    const parts = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z\s-]/g, "").split(/[\s-]+/);
    if (parts.filter(Boolean).length >= 2) addParts(parts);
  }
  out.delete((handle || "").toLowerCase());
  return [...out].filter((v) => /^[a-z0-9][a-z0-9_.-]{2,38}$/.test(v)).slice(0, MAX_VARIANTS);
}

async function collect({ handle, explicit, email, net, only, pivot, variants, onProgress }) {
  let queue = [];
  if (handle) queue.push(...BY_USERNAME.filter((p) => !(p in explicit)).map((p) => [p, handle, "username"]));
  queue.push(...Object.entries(explicit).map(([p, h]) => [p, h, "asserted"]));
  if (email) queue.push(["gravatar", email, "asserted"]);
  const allowed = (p) => !only || only.has(p);
  queue = queue.filter(([p]) => allowed(p));

  const seen = new Set(), accounts = [], attempts = [];
  let variantsQueued = !variants;
  for (let round = 0; round < 6; round++) {
    let batch = queue.filter(([p, h]) => !seen.has(keyOf(p, h)) && seen.add(keyOf(p, h)));
    if (!batch.length && !variantsQueued) {
      variantsQueued = true;
      // Use names from accounts already tied to the subject: supplied, linked, or repeated across accounts.
      const counts = countTop(accounts.map((a) => a.name).filter(Boolean), 10);
      const names = accounts.filter((a) => a.name && (a.origin !== "username"
        || counts.some(([n, c]) => n === a.name && c > 1))).map((a) => a.name);
      const tried = usernameVariants(handle, [...new Set(names)]);
      batch = tried.flatMap((v) => VARIANT_SOURCES.filter(allowed).map((p) => [p, v, `variant:${v}`]))
        .filter(([p, h]) => !seen.has(keyOf(p, h)) && seen.add(keyOf(p, h)));
      if (tried.length) onProgress?.(`Trying variations: ${tried.join(", ")}…`);
    }
    if (!batch.length) break;
    if (!batch[0][2].startsWith("variant:")) onProgress?.(`Checking ${[...new Set(batch.map(([p]) => p))].join(", ")}…`);
    const results = await Promise.all(batch.map(async ([platform, target, origin]) => {
      try {
        const a = await SOURCES[platform](target, net);
        if (a) a.origin = origin;
        return [platform, target, origin, a, ""];
      } catch (error) {
        const detail = error instanceof Unavailable ? error.message : `unexpected response (${error.name})`;
        return [platform, target, origin, null, detail];
      }
    }));
    const found = [];
    for (const [platform, target, origin, a, error] of results) {
      const isVariant = origin.startsWith("variant:");
      if (a) {
        if (accounts.some((b) => accountKey(b) === accountKey(a))) continue;
        seen.add(accountKey(a));
        accounts.push(a);
        found.push(a);
        attempts.push({ platform, handle: a.handle, status: "found", detail: "" });
      } else if (!isVariant || error) {
        // Misses for guessed variants are expected and would only clutter the report.
        if (!isVariant) attempts.push({ platform, handle: target, status: error ? "unavailable" : "not found", detail: error });
      }
    }
    queue = [];
    if (pivot) {
      for (const a of found) {
        for (const [p, h] of targets(a)) if (SOURCES[p] && allowed(p)) queue.push([p, h, `pivot:${a.platform}`]);
      }
      queue = queue.filter(([p, h]) => !seen.has(keyOf(p, h))).slice(0, MAX_PIVOTS_PER_ROUND);
    }
  }
  return { accounts, attempts };
}

export function correlate(accounts) {
  const pointsTo = new Map(accounts.map((a) => [a, new Set(targets(a).map(([p, h]) => keyOf(p, h)))]));
  const proven = new Map(accounts.map((a) => [a, new Set(verifiedTargets(a).map(([p, h]) => keyOf(p, h)))]));
  const sitesOf = new Map(accounts.map((a) => [a, new Set(a.links.map(personalSite).filter(Boolean)
    .concat(a.platform === "website" ? [normHandle("website", a.handle)] : []))]));

  for (const a of accounts) {
    let level = 4;
    const evidence = [];
    for (const b of accounts) {
      if (b === a) continue;
      const inbound = pointsTo.get(b).has(accountKey(a)), outbound = pointsTo.get(a).has(accountKey(b));
      if (proven.get(b).has(accountKey(a)) || proven.get(a).has(accountKey(b))) {
        level = Math.min(level, 1); evidence.push(`verified link with ${b.platform}`);
      } else if (inbound && outbound) {
        level = Math.min(level, 1); evidence.push(`links to and from ${b.platform}`);
      } else if (inbound || outbound) {
        level = Math.min(level, 2); evidence.push(`linked ${inbound ? "from" : "to"} ${b.platform}`);
      }
      const sameName = norm(a.name).length >= 5 && norm(a.name) === norm(b.name) && norm(a.name) !== norm(a.handle);
      const shared = [];
      const bSites = sitesOf.get(b);
      if ([...sitesOf.get(a)].some((s) => bSites.has(s))) shared.push("website");
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
    if (!evidence.length) {
      evidence.push(a.origin.startsWith("variant:")
        ? `found by guessing the variation "${a.origin.slice(8)}" — probably someone else`
        : "username match only — may be a different person");
    }
    a.evidence = [...new Set(evidence)];
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
    if (!fact.sources.includes(a.platform)) fact.sources.push(a.platform);
    fact.verified ||= a.confidence !== "unverified";
  }
  return [...grouped.values()].sort((x, y) =>
    x.verified === y.verified ? y.sources.length - x.sources.length : x.verified ? -1 : 1);
}

export function summarise(accounts) {
  const s = {};
  for (const [k, attr] of [["names", "name"], ["locations", "location"], ["employers", "company"], ["emails", "email"]]) {
    s[k] = facts(accounts, attr);
  }
  const known = new Set(accounts.map(accountKey));
  const linkMap = new Map();
  for (const a of accounts) {
    for (const url of a.links) {
      const t = classify(url) || (personalSite(url) ? ["website", personalSite(url)] : null);
      if (t && known.has(keyOf(...t))) continue;
      const k = url.toLowerCase().replace(/\/+$/, "");
      if (!linkMap.has(k)) linkMap.set(k, { url, kind: t ? t[0] : "link", sources: [] });
      const entry = linkMap.get(k);
      if (!entry.sources.includes(a.platform)) entry.sources.push(a.platform);
    }
  }
  const rank = (l) => (l.kind === "link" ? 2 : l.kind === "website" ? 1 : 0);
  s.links = [...linkMap.values()].sort((x, y) => rank(x) - rank(y) || y.sources.length - x.sources.length).slice(0, 60);

  const trustedOrAll = accounts.some((a) => a.confidence !== "unverified")
    ? accounts.filter((a) => a.confidence !== "unverified") : [];
  const langs = new Map(), stamps = [];
  for (const a of accounts) {
    for (const [l, n] of Object.entries(a.languages)) langs.set(l, (langs.get(l) || 0) + n);
  }
  // Activity is only combined across accounts known to be the same person.
  for (const a of trustedOrAll.length ? trustedOrAll : accounts.slice(0, 1)) stamps.push(...a.activity);
  s.languages = [...langs].sort((x, y) => y[1] - x[1]).slice(0, 8);
  s.interests = countTop(accounts.flatMap((a) => a.topics), 16).map(([t]) => t);

  const hours = Array(24).fill(0), days = Array(7).fill(0);
  for (const stamp of stamps) {
    const d = new Date(stamp);
    if (isNaN(d)) continue;
    hours[d.getUTCHours()]++;
    days[(d.getUTCDay() + 6) % 7]++;
  }
  s.activity = { hours, days, events: hours.reduce((x, y) => x + y, 0) };

  // The headline only states what corroborated accounts say.
  const trusted = trustedOrAll;
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

export async function loadSiteList(net) {
  const [status, data] = await net.json(WMN_URL);
  if (status !== 200 || !data) throw new Unavailable(`could not load the site list (${status || "no response"})`);
  return usableSites(data);
}

/**
 * Options:
 *   handle, explicit {platform: handle}, email   what to look up
 *   net                                          from makeNet()
 *   only (Set), pivot, strict, variants          lookup behaviour
 *   presence: false | true                       also check the WhatsMyName site list
 *   siteList                                     preloaded site list (tests, caching)
 *   audit                                        include the footprint audit
 */
export async function build({ handle = "", explicit = {}, email = "", net, only = null, pivot = true,
  strict = false, variants = false, presence = false, siteList = null, audit: wantAudit = false, onProgress } = {}) {
  let { accounts, attempts } = await collect({ handle, explicit, email, net, only, pivot, variants, onProgress });
  correlate(accounts);
  if (strict) accounts = accounts.filter((a) => a.confidence !== "unverified");
  const summary = summarise(accounts);

  summary.presence = null;
  if (presence && handle) {
    try {
      const sites = siteList || await loadSiteList(net);
      onProgress?.(`Checking ${sites.length} more sites for "${handle}"…`);
      const skipHosts = new Set(accounts.map((a) => hostOf(a.url)).filter(Boolean));
      summary.presence = await checkPresence(handle, sites, net.raw, {
        skipHosts, onProgress: (done, total) => onProgress?.(`Checked ${done} of ${total} sites…`) });
    } catch (error) {
      attempts.push({ platform: "site list", handle, status: "unavailable", detail: error.message });
    }
  }

  const subject = handle || email || Object.values(explicit)[0] || "";
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const dossier = { subject, generated, accounts, attempts, summary };
  summary.audit = wantAudit ? audit(dossier) : null;
  return dossier;
}
