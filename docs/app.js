import { build } from "./lib/engine.js";
import { browserTransport, makeNet, relayTransport } from "./lib/http.js";
import { renderHtml } from "./lib/render.js";
import { PLATFORMS } from "./lib/sources.js";

const $ = (id) => document.getElementById(id);
const SETTINGS = ["token", "relay", "relaytoken"];
const TOGGLES = ["presence", "audit", "variants", "strict", "nopivot"];

function save(key, value) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* private mode */ }
}
function load(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function setStatus(text, error = false) {
  $("status").className = error ? "err" : "";
  $("status").textContent = text;
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

function download(name, type, content) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

async function standalone(dossier) {
  const css = await fetch("style.css").then((r) => r.text()).catch(() => "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>Profile: ${dossier.subject.replace(/[<>&"]/g, "")}</title><style>${css}</style></head>` +
    `<body><main>${renderHtml(dossier, { actions: false })}</main></body></html>`;
}

function showReport(dossier) {
  $("report").innerHTML = renderHtml(dossier, { actions: true });
  const fileBase = `profile-${dossier.subject.replace(/[^\w.-]+/g, "_")}`;
  const share = $("report").querySelector('[data-action="share"]');
  if (navigator.share) {
    share.onclick = () => navigator.share({ title: `Profile: ${dossier.subject}`, url: location.href }).catch(() => {});
  } else share.remove();
  $("report").querySelector('[data-action="json"]').onclick = () =>
    download(`${fileBase}.json`, "application/json", JSON.stringify(dossier, null, 2));
  $("report").querySelector('[data-action="html"]').onclick = async () =>
    download(`${fileBase}.html`, "text/html", await standalone(dossier));
}

function relayConfig() {
  const url = $("relay").value.trim(), token = $("relaytoken").value.trim();
  return url && token && /^https:\/\//.test(url) ? { url, token } : null;
}

async function run() {
  const handle = $("handle").value.trim().replace(/^@/, "");
  const email = $("email").value.trim();
  let explicit;
  try { explicit = parseAccounts($("accounts").value); } catch (error) { return setStatus(error.message, true); }
  if (!handle && !email && !Object.keys(explicit).length) return setStatus("Enter a username, an account or an email.", true);

  for (const key of SETTINGS) save(`profiler-${key}`, $(key).value.trim());
  for (const key of TOGGLES) save(`profiler-${key}`, $(key).checked ? "1" : "0");
  const params = new URLSearchParams();
  if (handle) params.set("q", handle);
  history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);

  const relay = relayConfig();
  const net = makeNet(browserTransport({ relay: relay ? relayTransport(relay) : null }),
    { githubToken: $("token").value.trim() });
  const wantPresence = $("presence").checked;

  $("go").disabled = true;
  $("report").replaceChildren();
  $("handle").blur();
  try {
    const dossier = await build({
      handle, explicit, email, net,
      strict: $("strict").checked, pivot: !$("nopivot").checked, variants: $("variants").checked,
      presence: wantPresence && Boolean(relay), audit: $("audit").checked,
      onProgress: (msg) => setStatus(msg),
    });
    setStatus(wantPresence && !relay && handle
      ? "Skipped the 600+ site check: it needs your relay (More options → Relay)." : "");
    showReport(dossier);
  } catch (error) {
    setStatus(`Something went wrong: ${error.message}`, true);
  } finally {
    $("go").disabled = false;
  }
}

$("platforms").textContent = PLATFORMS.join(", ");
for (const key of SETTINGS) $(key).value = load(`profiler-${key}`);
for (const key of TOGGLES) { const v = load(`profiler-${key}`); if (v) $(key).checked = v === "1"; }
$("search").addEventListener("submit", (e) => { e.preventDefault(); run(); });
const initial = new URLSearchParams(location.search).get("q");
if (initial) { $("handle").value = initial; run(); }

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
