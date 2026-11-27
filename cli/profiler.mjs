#!/usr/bin/env node
// Command-line front end for the same engine the web app uses. Node 20+, no dependencies.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, loadSiteList } from "../docs/lib/engine.js";
import { directTransport, makeNet } from "../docs/lib/http.js";
import { renderHtml, renderText } from "../docs/lib/render.js";
import { PLATFORMS } from "../docs/lib/sources.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.3.0";
const CACHE_FILE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "profiler", "wmn-data.json");
const CACHE_DAYS = 7;

const HELP = `profiler ${VERSION} — build a dossier from what a person publishes on their public accounts

usage: profiler [HANDLE] [options]

  -a, --account PLATFORM=HANDLE  a known account (repeatable)
      --email ADDRESS            look up the public Gravatar profile
      --only A,B                 restrict to these platforms
      --no-pivot                 don't follow links found on profiles
      --no-sites                 skip the 600+ site existence check
      --variants                 also try username variations
      --strict                   drop accounts that match on username alone
      --audit                    add a footprint audit (for scanning yourself)
      --html FILE                write an HTML report
      --json FILE                write JSON ('-' for stdout)
      --no-color
  -h, --help / -v, --version

platforms: ${PLATFORMS.join(", ")}
env: GITHUB_TOKEN raises GitHub's rate limit.`;

function fail(message) {
  process.stderr.write(`profiler: ${message}\n`);
  process.exit(2);
}

async function siteList(net) {
  try {
    const info = await stat(CACHE_FILE);
    if (Date.now() - info.mtimeMs < CACHE_DAYS * 864e5) {
      const { usableSites } = await import("../docs/lib/presence.js");
      return usableSites(JSON.parse(await readFile(CACHE_FILE, "utf8")));
    }
  } catch { /* no cache yet */ }
  const [status, data] = await net.json("https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json");
  if (status === 200 && data) {
    await mkdir(dirname(CACHE_FILE), { recursive: true }).catch(() => {});
    await writeFile(CACHE_FILE, JSON.stringify(data)).catch(() => {});
  }
  return loadSiteList({ json: async () => [status, data] });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        account: { type: "string", short: "a", multiple: true, default: [] },
        email: { type: "string", default: "" }, only: { type: "string", default: "" },
        "no-pivot": { type: "boolean" }, "no-sites": { type: "boolean" }, variants: { type: "boolean" },
        strict: { type: "boolean" }, audit: { type: "boolean" }, html: { type: "string" }, json: { type: "string" },
        "no-color": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    fail(error.message);
  }
  const { values: o, positionals } = parsed;
  if (o.help) return console.log(HELP);
  if (o.version) return console.log(VERSION);
  const handle = (positionals[0] || "").replace(/^@/, "");

  const explicit = {};
  for (const item of o.account) {
    const [platform, ...rest] = item.split("=");
    if (!PLATFORMS.includes(platform) || !rest.join("=")) fail(`--account expects PLATFORM=HANDLE, got "${item}"`);
    explicit[platform] = rest.join("=");
  }
  const only = o.only ? new Set(o.only.split(",").filter(Boolean)) : null;
  const unknown = only ? [...only].filter((p) => !PLATFORMS.includes(p)) : [];
  if (unknown.length) fail(`unknown platform in --only: ${unknown.join(", ")}`);
  if (!handle && !o.email && !Object.keys(explicit).length) fail("give a handle, --account or --email (see --help)");

  const net = makeNet(directTransport({ userAgent: `profiler-cli/${VERSION}`, concurrency: 16 }),
    { githubToken: process.env.GITHUB_TOKEN || "" });
  const presence = Boolean(handle) && !o["no-sites"];
  const interactive = process.stderr.isTTY;
  const progress = (msg) => { if (interactive) process.stderr.write(`\r\x1b[2K${msg}`); };

  const dossier = await build({
    handle, explicit, email: o.email, net, only, pivot: !o["no-pivot"], strict: o.strict, variants: o.variants,
    presence, siteList: presence ? await siteList(net).catch(() => null) : null, audit: o.audit, onProgress: progress,
  });
  if (interactive) process.stderr.write("\r\x1b[2K");

  if (o.json === "-") {
    console.log(JSON.stringify(dossier, null, 2));
  } else {
    process.stdout.write(renderText(dossier, { color: !o["no-color"] && process.stdout.isTTY }));
    if (o.json) await writeOut(o.json, JSON.stringify(dossier, null, 2));
  }
  if (o.html) {
    const css = await readFile(join(HERE, "../docs/style.css"), "utf8");
    await writeOut(o.html, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ` +
      `content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Profile</title>` +
      `<style>${css}</style></head><body><main>${renderHtml(dossier, { actions: false })}</main></body></html>`);
  }
  process.exitCode = dossier.accounts.length || dossier.summary.presence?.found.length ? 0 : 1;
}

async function writeOut(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  process.stderr.write(`wrote ${path}\n`);
}

main();
