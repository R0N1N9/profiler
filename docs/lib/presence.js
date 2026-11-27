// Checks whether a username exists on several hundred sites, using the WhatsMyName
// project's detection rules (CC BY-SA 4.0, https://github.com/WebBreacher/WhatsMyName).
// This only says "an account with this name exists"; it reads nothing from the account.

export const WMN_URL = "https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json";

// Finding someone's profile on these would reveal sensitive things about them, so they are never checked.
export const EXCLUDED_CATEGORIES = new Set(["xx NSFW xx", "dating", "political", "health"]);

export function usableSites(data) {
  return ((data && data.sites) || []).filter((s) =>
    s && s.valid !== false && s.uri_check && !EXCLUDED_CATEGORIES.has(s.cat) && s.e_string !== undefined);
}

function fill(template, account) {
  return template.split("{account}").join(account);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * raw: transport-style function (url, {method, headers, body, find, preferRelay}) -> {status, found}
 * skipHosts: hosts already covered by a full source, so they are not double-reported.
 */
export async function checkPresence(username, sites, raw, { skipHosts = new Set(), onProgress } = {}) {
  let done = 0;
  const results = await Promise.all(sites.map(async (site) => {
    let account = username;
    if (site.strip_bad_char) for (const ch of site.strip_bad_char) account = account.split(ch).join("");
    const pretty = fill(site.uri_pretty || site.uri_check, encodeURIComponent(account));
    const base = { name: site.name, cat: site.cat, url: pretty };
    if (skipHosts.has(hostOf(pretty))) return { ...base, status: "skipped" };
    const check = fill(site.uri_check, encodeURIComponent(account));
    const r = await raw(check, {
      method: site.post_body ? "POST" : "GET",
      headers: site.headers || {},
      body: site.post_body ? fill(site.post_body, account) : undefined,
      find: [site.e_string, site.m_string].map((s) => String(s ?? "")),
      redirect: "manual",  // the rules expect to see redirects (301/302) as they are
      preferRelay: true,
    });
    done++;
    if (onProgress && done % 25 === 0) onProgress(done, sites.length);
    const [hasE, hasM] = r.found || [];
    let status = "unknown";
    if (r.status === site.e_code && hasE && !(r.status === site.m_code && hasM)) status = "found";
    else if (r.status === site.m_code && (hasM || site.m_string === "")) status = "missing";
    else if (r.status && r.status !== site.e_code) status = "missing";
    return { ...base, status };
  }));
  const found = results.filter((r) => r.status === "found").sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
  return {
    username,
    checked: results.filter((r) => r.status !== "skipped").length,
    found,
    unknown: results.filter((r) => r.status === "unknown").length,
  };
}
