import { build, makeFetch, PLATFORMS } from "./profiler.js";

const $ = (id) => document.getElementById(id);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MIN_EVENTS = 10;
let lastDossier = null;

function store(key, value) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* private mode */ }
}
function load(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

// Every value shown comes from someone else's profile, so it is only ever set as text.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const safeUrl = (url) => /^https:\/\//i.test(url || "") ? url : "";

function link(url, text) {
  const href = safeUrl(url) || (/^http:\/\//i.test(url || "") ? url : "");
  return href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, text || url) : (text || url);
}

function bars(values, labels) {
  const top = Math.max(...values) || 1;
  return [
    h("div", { class: "bars" }, values.map((v) => h("div", { style: `height:${Math.round((v / top) * 100)}%`, title: String(v) }))),
    h("div", { class: "axis" }, labels.map((l) => h("span", {}, l))),
  ];
}

function render(d) {
  const s = d.summary;
  const out = [];
  const title = s.display_name || d.subject;
  const avatar = safeUrl(d.accounts.find((a) => a.avatar)?.avatar);
  out.push(h("section", { class: "hud" },
    avatar && h("img", { src: avatar, alt: "", referrerpolicy: "no-referrer", loading: "lazy" }),
    h("div", {},
      h("h1", {}, title),
      s.tagline && h("p", {}, s.tagline),
      h("p", { class: "dim mono" }, `query: ${d.subject} · ${d.accounts.length} accounts · ${d.generated}`))));

  if (!d.accounts.length) out.push(h("p", {}, "No public accounts found for this identifier."));

  const rows = [];
  for (const [key, label] of [["names", "Name"], ["locations", "Location"], ["employers", "Employer"], ["emails", "Email"]]) {
    for (const f of s[key]) {
      rows.push(h("dt", {}, label), h("dd", {}, f.value, " ",
        h("span", { class: "dim mono" }, f.sources.join(", ") + (f.verified ? "" : " · unverified"))));
    }
  }
  if (s.first_seen) rows.push(h("dt", {}, "First seen"), h("dd", {}, s.first_seen));
  if (rows.length) out.push(h("h2", {}, "Identity (as self-published)"), h("dl", {}, rows));

  if (d.accounts.length) {
    out.push(h("h2", {}, "Accounts"), h("div", { class: "grid" }, d.accounts.map((a) => h("article", { class: "card" },
      h("h3", {}, a.platform, h("span", { class: `tag ${a.confidence}` }, a.confidence)),
      a.url ? link(a.url, a.handle) : a.handle,
      h("p", { class: "dim mono" }, a.evidence.join("; ")),
      a.bio && h("p", {}, a.bio.slice(0, 400)),
      Object.keys(a.stats).length > 0 && h("p", { class: "mono" },
        Object.entries(a.stats).map(([k, v]) => `${k}: ${v}`).join(" · ")),
      a.highlights.length > 0 && h("ul", {}, a.highlights.map((i) =>
        h("li", {}, link(i.url, i.title), " ", h("span", { class: "dim" }, i.note.slice(0, 120)))))))));
  }

  if (s.languages.length || s.interests.length) {
    out.push(h("h2", {}, "Skills & interests"), h("div", { class: "chips" },
      s.languages.map(([n, c]) => h("span", {}, `${n} · ${c}`)), s.interests.map((t) => h("span", {}, `#${t}`))));
  }

  if (s.links.length) {
    out.push(h("h2", {}, "Other links they publish"), h("dl", {}, s.links.flatMap((l) => [
      h("dt", {}, l.kind), h("dd", {}, link(l.url), " ", h("span", { class: "dim mono" }, l.sources.join(", ")))])));
  }

  if (s.activity.events >= MIN_EVENTS) {
    out.push(h("h2", {}, `Public activity · ${s.activity.events} recent events · UTC`),
      ...bars(s.activity.hours, ["00", "06", "12", "18", "23"]), h("div", { style: "height:18px" }), ...bars(s.activity.days, DAYS));
  }

  const missing = d.attempts.filter((a) => a.status === "unavailable");
  if (missing.length) {
    out.push(h("h2", {}, "Sources that could not be read"),
      h("dl", {}, missing.flatMap((a) => [h("dt", {}, a.platform), h("dd", { class: "dim" }, a.detail)])));
  }

  out.push(h("div", { class: "actions" },
    navigator.share && h("button", { type: "button", class: "ghost", id: "share" }, "Share link"),
    h("button", { type: "button", class: "ghost", id: "export" }, "Save JSON")));
  out.push(h("footer", {}, "Compiled only from information each account owner published on public profiles. " +
    "Accounts tagged unverified share a username and nothing else, and may belong to someone else entirely."));

  $("report").replaceChildren(...out.filter(Boolean));
  $("export").onclick = () => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `profile-${d.subject.replace(/[^\w.-]+/g, "_")}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if ($("share")) $("share").onclick = () => navigator.share({ title: `Profile: ${title}`, url: location.href }).catch(() => {});
}

function parseAccounts(text) {
  const explicit = {};
  for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    const [platform, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    if (!PLATFORMS.includes(platform.trim()) || !value) throw new Error(`Can't read "${line}" — use platform=handle`);
    explicit[platform.trim()] = value;
  }
  return explicit;
}

async function run() {
  const handle = $("handle").value.trim().replace(/^@/, "");
  const email = $("email").value.trim();
  let explicit;
  try {
    explicit = parseAccounts($("accounts").value);
  } catch (error) {
    $("status").className = "err";
    $("status").textContent = error.message;
    return;
  }
  if (!handle && !email && !Object.keys(explicit).length) {
    $("status").className = "err";
    $("status").textContent = "Enter a username, an account or an email.";
    return;
  }
  const token = $("token").value.trim();
  store("gh-token", token);
  const params = new URLSearchParams();
  if (handle) params.set("q", handle);
  history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);

  $("go").disabled = true;
  $("status").className = "";
  $("report").replaceChildren();
  $("handle").blur();
  try {
    lastDossier = await build({
      handle, explicit, email, fetch: makeFetch(token),
      strict: $("strict").checked, pivot: !$("nopivot").checked,
      onProgress: (msg) => { $("status").textContent = msg; },
    });
    $("status").textContent = "";
    render(lastDossier);
  } catch (error) {
    $("status").className = "err";
    $("status").textContent = `Something went wrong: ${error.message}`;
  } finally {
    $("go").disabled = false;
  }
}

$("platforms").textContent = PLATFORMS.join(", ");
$("token").value = load("gh-token");
$("search").addEventListener("submit", (e) => { e.preventDefault(); run(); });
const initial = new URLSearchParams(location.search).get("q");
if (initial) { $("handle").value = initial; run(); }

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
