// Footprint audit: what a scan of yourself shows a stranger, and where to change it.

import { settingsUrl } from "./sources.js";

const where = (accounts) => accounts.map((a) => ({ platform: a.platform, url: settingsUrl(a) }));

function quietHours(hours) {
  // Longest run of hours with no activity, wrapping around midnight.
  let best = [0, -1], start = -1;
  for (let i = 0; i < 48; i++) {
    if (hours[i % 24] === 0) {
      if (start < 0) start = i;
      if (i - start > best[1] - best[0]) best = [start, i];
    } else start = -1;
  }
  const length = best[1] - best[0] + 1;
  return length >= 4 && length < 24 ? [best[0] % 24, (best[1] + 1) % 24, length] : null;
}

export function audit(dossier) {
  const { accounts, summary } = dossier;
  const items = [];
  const add = (level, title, detail, list = []) => items.push({ level, title, detail, where: where(list) });
  const own = accounts.filter((a) => a.confidence !== "unverified");
  const scope = own.length ? own : accounts;

  const withEmail = scope.filter((a) => a.email && a.platform !== "gravatar");
  if (withEmail.length) {
    add("high", "Email address is public",
      `${[...new Set(withEmail.map((a) => a.email))].join(", ")} is shown on ${withEmail.length} profile(s). ` +
      "It invites spam and phishing and lets anyone search breach and people-search sites for you.", withEmail);
  }
  const named = scope.filter((a) => a.name && a.name.toLowerCase() !== a.handle.toLowerCase());
  if (named.length && scope.length > 1) {
    add("medium", "Your name is tied to your username",
      `"${named[0].name}" appears on ${named.length} profile(s), so searching your name finds these accounts and vice versa.`, named);
  }
  const located = scope.filter((a) => a.location);
  if (located.length) {
    add("medium", "Location is public",
      `${[...new Set(located.map((a) => a.location))].join(", ")}. Consider a broader region (a country instead of a city).`, located);
  }
  const employed = scope.filter((a) => a.company);
  if (employed.length) add("low", "Employer is public", `${[...new Set(employed.map((a) => a.company))].join(", ")}.`, employed);

  const linked = accounts.filter((a) => ["confirmed", "likely"].includes(a.confidence));
  if (linked.length >= 2) {
    add("medium", `${linked.length} accounts are linked to each other`,
      "Each one leads to the others, so whatever you share on one can be combined with the rest. " +
      "Remove cross-links from accounts you want kept separate.", linked);
  }

  const act = summary.activity;
  const quiet = act.events >= 30 ? quietHours(act.hours) : null;
  if (quiet) {
    const pad = (h) => String(h).padStart(2, "0");
    add("medium", "Your posting times reveal a daily routine",
      `Across ${act.events} recent public posts you are never active between ${pad(quiet[0])}:00 and ${pad(quiet[1])}:00 UTC, ` +
      "which suggests your sleep hours and therefore your time zone.");
  }

  const presence = summary.presence;
  if (presence && presence.found.length >= 10) {
    add("low", `This username exists on ${presence.found.length} other sites`,
      "Reusing one username everywhere makes every account easy to find. Delete accounts you no longer use, " +
      "or use different names for things you want kept apart.");
  }

  const yearAgo = Date.now() - 2 * 365 * 24 * 3600 * 1000;
  const stale = scope.filter((a) => a.activity.length && Math.max(...a.activity.map((t) => Date.parse(t) || 0)) < yearAgo);
  if (stale.length) {
    add("low", "Dormant accounts", "No public activity for over two years. Old accounts keep old details visible; consider deleting them.", stale);
  }

  const order = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => order[a.level] - order[b.level]);
}
