// Report views shared by the web app and the command line: an HTML fragment and terminal text.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MIN_EVENTS = 10;
const LEVEL_LABEL = { high: "HIGH", medium: "MED", low: "LOW" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const safeUrl = (url) => (/^https?:\/\//i.test(url || "") ? url : "");

function a(url, text) {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text ?? url)}</a>` : esc(text ?? url);
}

function bars(values, labels) {
  const top = Math.max(...values) || 1;
  return `<div class="bars">${values.map((v) => `<div style="height:${Math.round((v / top) * 100)}%" title="${v}"></div>`).join("")}</div>` +
    `<div class="axis">${labels.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`;
}

export function renderHtml(d, { actions = true } = {}) {
  const s = d.summary;
  const out = [];
  const title = s.display_name || d.subject;
  const avatar = safeUrl(d.accounts.find((x) => x.confidence !== "unverified" && x.avatar)?.avatar
    || (d.accounts.length === 1 ? d.accounts[0].avatar : ""));
  out.push(`<section class="hud">${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ""}
    <div><h1>${esc(title)}</h1>${s.tagline ? `<p>${esc(s.tagline)}</p>` : ""}
    <p class="dim mono">query: ${esc(d.subject)} · ${d.accounts.length} accounts${s.presence ? ` · ${s.presence.found.length} more sites` : ""} · ${esc(d.generated)}</p></div></section>`);

  if (s.audit && s.audit.length) {
    out.push(`<h2>Footprint audit</h2><div class="audit">${s.audit.map((item) => `<div class="finding ${item.level}">
      <div class="lvl">${LEVEL_LABEL[item.level]}</div><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p>
      ${item.where.length ? `<p class="mono">Change it: ${item.where.map((w) => a(w.url, w.platform)).join(" · ")}</p>` : ""}</div></div>`).join("")}</div>`);
  } else if (s.audit) {
    out.push(`<h2>Footprint audit</h2><p class="dim">Nothing notable is exposed by the accounts found.</p>`);
  }

  if (!d.accounts.length) out.push(`<p>No public profiles found for this identifier.</p>`);

  const rows = [];
  for (const [key, label] of [["names", "Name"], ["locations", "Location"], ["employers", "Employer"], ["emails", "Email"]]) {
    for (const f of s[key]) {
      rows.push(`<dt>${label}</dt><dd>${esc(f.value)} <span class="dim mono">${esc(f.sources.join(", "))}${f.verified ? "" : " · unverified"}</span></dd>`);
    }
  }
  if (s.first_seen) rows.push(`<dt>First seen</dt><dd>${esc(s.first_seen)}</dd>`);
  if (rows.length) out.push(`<h2>Identity (as self-published)</h2><dl>${rows.join("")}</dl>`);

  if (d.accounts.length) {
    out.push(`<h2>Accounts</h2><div class="grid">${d.accounts.map((x) => `<article class="card">
      <h3>${esc(x.platform)}<span class="tag ${x.confidence}">${x.confidence}</span></h3>
      ${x.url ? a(x.url, x.handle) : esc(x.handle)}
      <p class="dim mono">${esc(x.evidence.join("; "))}</p>
      ${x.name ? `<p><strong>${esc(x.name)}</strong></p>` : ""}
      ${x.bio ? `<p>${esc(x.bio.slice(0, 400))}</p>` : ""}
      ${Object.keys(x.stats).length ? `<p class="mono">${esc(Object.entries(x.stats).map(([k, v]) => `${k}: ${v}`).join(" · "))}</p>` : ""}
      ${x.highlights.length ? `<ul>${x.highlights.map((i) => `<li>${a(i.url, i.title)} <span class="dim">${esc((i.note || "").slice(0, 120))}</span></li>`).join("")}</ul>` : ""}
    </article>`).join("")}</div>`);
  }

  if (s.presence) {
    const p = s.presence;
    const groups = new Map();
    for (const f of p.found) { if (!groups.has(f.cat)) groups.set(f.cat, []); groups.get(f.cat).push(f); }
    out.push(`<h2>Username also exists on · ${p.found.length} of ${p.checked} sites</h2>
      <p class="dim small">Existence only — nothing was read from these accounts, and any of them may belong to someone else.
      ${p.unknown ? `${p.unknown} sites gave no clear answer.` : ""} Site list: WhatsMyName (CC BY-SA 4.0).</p>
      ${p.found.length ? `<dl>${[...groups].map(([cat, list]) => `<dt>${esc(cat)}</dt><dd class="sites">${list.map((f) => a(f.url, f.name)).join("")}</dd>`).join("")}</dl>` : ""}`);
  }

  if (s.languages.length || s.interests.length) {
    out.push(`<h2>Skills &amp; interests</h2><div class="chips">${s.languages.map(([n, c]) => `<span>${esc(n)} · ${c}</span>`).join("")}${s.interests.map((t) => `<span>#${esc(t)}</span>`).join("")}</div>`);
  }

  if (s.links.length) {
    out.push(`<h2>Other links they publish</h2><dl>${s.links.map((l) => `<dt>${esc(l.kind)}</dt><dd>${a(l.url)} <span class="dim mono">${esc(l.sources.join(", "))}</span></dd>`).join("")}</dl>`);
  }

  if (s.activity.events >= MIN_EVENTS) {
    out.push(`<h2>Public activity · ${s.activity.events} recent events · UTC</h2>${bars(s.activity.hours, ["00", "06", "12", "18", "23"])}<div style="height:18px"></div>${bars(s.activity.days, DAYS)}`);
  }

  const missing = d.attempts.filter((x) => x.status === "unavailable");
  if (missing.length) {
    out.push(`<h2>Sources that could not be read</h2><dl>${missing.map((x) => `<dt>${esc(x.platform)}</dt><dd class="dim">${esc(x.detail)}</dd>`).join("")}</dl>`);
  }

  if (actions) {
    out.push(`<div class="actions"><button type="button" class="ghost" data-action="share">Share link</button><button type="button" class="ghost" data-action="json">Save JSON</button><button type="button" class="ghost" data-action="html">Save report</button></div>`);
  }
  out.push(`<footer>Compiled only from information account owners published on public profiles. Accounts tagged
    <em>unverified</em> share a username and nothing else, and may belong to someone else entirely.</footer>`);
  return out.join("\n");
}

// ---------------------------------------------------------------- terminal

const BARS = " ▁▂▃▄▅▆▇█";
const spark = (values) => { const top = Math.max(...values) || 1; return values.map((v) => BARS[Math.round((v / top) * 8)]).join(""); };

export function renderText(d, { color = true } = {}) {
  const c = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const tone = { asserted: "36", confirmed: "32", likely: "32", possible: "33", unverified: "2" };
  const s = d.summary;
  const out = [];
  const section = (title) => { out.push(""); out.push(c("36;1", `── ${title.toUpperCase()} ` + "─".repeat(Math.max(4, 58 - title.length)))); };

  out.push(c("36;1", "┌" + "─".repeat(62)));
  out.push(c("36;1", "│ ") + c("1", (s.display_name || d.subject).toUpperCase()) + c("2", `   query: ${d.subject}`));
  if (s.tagline) out.push(c("36;1", "│ ") + s.tagline);
  out.push(c("36;1", "│ ") + c("2", `${d.accounts.length} accounts${s.presence ? ` · ${s.presence.found.length} more sites` : ""} · generated ${d.generated}`));
  out.push(c("36;1", "└" + "─".repeat(62)));

  if (s.audit) {
    section("footprint audit");
    if (!s.audit.length) out.push("  Nothing notable is exposed by the accounts found.");
    for (const item of s.audit) {
      out.push(`  ${c(item.level === "high" ? "31;1" : item.level === "medium" ? "33" : "2", `[${LEVEL_LABEL[item.level]}]`)} ${c("1", item.title)}`);
      out.push(`        ${item.detail}`);
      if (item.where.length) out.push(c("2", `        change it: ${item.where.map((w) => w.url).join("  ")}`));
    }
  }

  if (!d.accounts.length) out.push("\nNo public profiles found for this identifier.");
  const labels = [["names", "Name"], ["locations", "Location"], ["employers", "Employer"], ["emails", "Email"]];
  if (labels.some(([k]) => s[k].length)) {
    section("identity (as self-published)");
    for (const [k, label] of labels) for (const f of s[k]) {
      out.push(`  ${label.padEnd(10)}${f.value}  [${f.sources.join(", ")}]${f.verified ? "" : c("2", " (unverified)")}`);
    }
    if (s.first_seen) out.push(`  ${"First seen".padEnd(10)}${s.first_seen}`);
  }

  if (d.accounts.length) {
    section("accounts");
    for (const x of d.accounts) {
      out.push(`  ${c("1", x.platform.padEnd(14))} ${x.handle}  ${c(tone[x.confidence], `[${x.confidence}]`)}`);
      out.push(c("2", `      ${x.url}`));
      out.push(c("2", `      evidence: ${x.evidence.join("; ")}`));
      if (x.name) out.push(`      name: ${x.name}`);
      if (x.bio) out.push(`      “${x.bio.split(/\s+/).join(" ").slice(0, 160)}”`);
      if (Object.keys(x.stats).length) out.push("      " + Object.entries(x.stats).map(([k, v]) => `${k}: ${v}`).join(" · "));
      for (const i of x.highlights.slice(0, 3)) out.push(`      • ${i.title} — ${(i.note || "").slice(0, 90)}`);
    }
  }

  if (s.presence) {
    section(`username also exists on (${s.presence.found.length} of ${s.presence.checked} sites)`);
    out.push(c("2", "  existence only; may belong to someone else · site list: WhatsMyName (CC BY-SA 4.0)"));
    for (const f of s.presence.found) out.push(`  ${f.cat.padEnd(10)} ${f.name.padEnd(22)} ${c("2", f.url)}`);
  }

  if (s.languages.length || s.interests.length) {
    section("skills & interests");
    if (s.languages.length) out.push("  Languages  " + s.languages.map(([n, k]) => `${n} (${k})`).join(", "));
    if (s.interests.length) out.push("  Topics     " + s.interests.join(", "));
  }
  if (s.links.length) {
    section("other links they publish");
    for (const l of s.links) out.push(`  ${l.kind.padEnd(10)} ${l.url}  ${c("2", `[${l.sources.join(", ")}]`)}`);
  }
  if (s.activity.events >= MIN_EVENTS) {
    section(`public activity (${s.activity.events} recent events, UTC)`);
    out.push(`  Hour 00→23  ${spark(s.activity.hours)}`);
    out.push(`  Mon→Sun     ${spark(s.activity.days)}`);
  }
  const missing = d.attempts.filter((x) => x.status === "unavailable");
  if (missing.length) {
    section("sources that could not be read");
    for (const x of missing) out.push(c("2", `  ${x.platform}: ${x.detail}`));
  }
  return out.join("\n") + "\n";
}
