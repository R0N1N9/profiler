"""Collect accounts, follow the links they publish, and score how well they corroborate."""
from __future__ import annotations

import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse

from . import sources
from .links import classify
from .models import Account, Attempt, Dossier

CONFIDENCE_ORDER = ["asserted", "confirmed", "likely", "possible", "unverified"]
MAX_PIVOTS_PER_ROUND = 10


def collect(handle, explicit, email, fetch, only=None, pivot=True):
    """Returns (accounts, attempts). `explicit` maps platform -> handle given by the operator."""
    queue: list[tuple[str, str, str]] = []
    if handle:
        queue += [(p, handle, "username") for p in sources.BY_USERNAME if p not in explicit]
    queue += [(p, h, "asserted") for p, h in explicit.items()]
    if email:
        queue.append(("gravatar", email, "asserted"))
    if only:
        queue = [item for item in queue if item[0] in only]

    seen: set[tuple[str, str]] = set()
    accounts: list[Account] = []
    attempts: list[Attempt] = []

    def run(item):
        platform, target, origin = item
        try:
            account = sources.ALL[platform](target, fetch)
        except sources.Unavailable as error:
            return item, None, str(error)
        except (KeyError, TypeError, IndexError, AttributeError) as error:
            return item, None, f"unexpected response ({type(error).__name__})"
        if account:
            account.origin = origin
        return item, account, ""

    for _ in range(3):  # the given handles, then two rounds of following links
        batch = []
        for item in queue:
            key = (item[0], _norm_handle(item[0], item[1]))
            if key not in seen:
                seen.add(key)
                batch.append(item)
        if not batch:
            break
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(run, batch))
        found = []
        for (platform, target, _origin), account, error in results:
            if account:
                if account.key in {a.key for a in accounts}:
                    continue
                seen.add(account.key)
                accounts.append(account)
                found.append(account)
                attempts.append(Attempt(platform, account.handle, "found"))
            else:
                attempts.append(Attempt(platform, target, "unavailable" if error else "not found", error))
        queue = []
        if pivot:
            for account in found:
                for target in _targets(account):
                    if target[0] in sources.ALL and (not only or target[0] in only):
                        queue.append((*target, f"pivot:{account.platform}"))
            queue = queue[:MAX_PIVOTS_PER_ROUND]
    return accounts, attempts


def _norm_handle(platform: str, handle: str) -> str:
    handle = handle.lower().lstrip("@")
    if platform == "bluesky" and "." not in handle:
        handle += ".bsky.social"
    return handle


def _targets(account: Account) -> list[tuple[str, str]]:
    found = [classify(url) for url in account.links]
    return list(dict.fromkeys([t for t in found if t] + account.proofs))


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _sites(account: Account) -> set[str]:
    """Personal sites the account links to (anything that is not a recognised profile)."""
    hosts = set()
    for url in account.links:
        if not classify(url):
            hosts.add((urlparse(url).hostname or "").lower().removeprefix("www."))
    return hosts - {""}


def correlate(accounts: list[Account]) -> None:
    """Grade each account by how the others corroborate it. A shared username alone proves nothing."""
    points_to = {a.key: {(p, _norm_handle(p, h)) for p, h in _targets(a)} for a in accounts}
    proven = {a.key: {(p, _norm_handle(p, h)) for p, h in a.proofs} for a in accounts}

    for a in accounts:
        level, evidence = 4, []
        for b in accounts:
            if b is a:
                continue
            inbound, outbound = a.key in points_to[b.key], b.key in points_to[a.key]
            if a.key in proven[b.key] or b.key in proven[a.key]:
                level = min(level, 1)
                evidence.append(f"cryptographic proof shared with {b.platform}")
            elif inbound and outbound:
                level = min(level, 1)
                evidence.append(f"links to and from the {b.platform} profile")
            elif inbound or outbound:
                level = min(level, 2)
                evidence.append(f"linked {'from' if inbound else 'to'} the {b.platform} profile")
            same_name = (len(_norm(a.name)) >= 5 and _norm(a.name) == _norm(b.name)
                         and _norm(a.name) != _norm(a.handle))
            shared = []
            if _sites(a) & _sites(b):
                shared.append("website")
            if _norm(a.location) and _norm(a.location) == _norm(b.location):
                shared.append("location")
            if _norm(a.company) and _norm(a.company) == _norm(b.company):
                shared.append("employer")
            if same_name and shared:
                level = min(level, 2)
                evidence.append(f"same name and {', '.join(shared)} as {b.platform}")
            elif same_name or "website" in shared:
                level = min(level, 3)
                evidence.append(f"same {'name' if same_name else 'website'} as {b.platform}")
        if a.origin == "asserted":
            level = 0
            evidence.insert(0, "identifier supplied by the operator")
        a.confidence = CONFIDENCE_ORDER[level]
        a.evidence = list(dict.fromkeys(evidence)) or ["username match only — may be a different person"]
    accounts.sort(key=lambda a: CONFIDENCE_ORDER.index(a.confidence))


def _facts(accounts: list[Account], attr: str) -> list[dict]:
    """Group a field across accounts, keeping track of where each value came from."""
    grouped: dict[str, dict] = {}
    for account in accounts:
        value = (getattr(account, attr) or "").strip()
        if not value:
            continue
        fact = grouped.setdefault(_norm(value) or value, {"value": value, "sources": [], "verified": False})
        fact["sources"].append(account.platform)
        fact["verified"] |= account.confidence != "unverified"
    return sorted(grouped.values(), key=lambda f: (not f["verified"], -len(f["sources"])))


def summarise(accounts: list[Account]) -> dict:
    summary: dict[str, object] = {key: _facts(accounts, attr) for key, attr in [
        ("names", "name"), ("locations", "location"), ("employers", "company"), ("emails", "email")]}

    known = {a.key for a in accounts}
    links: dict[str, dict] = {}
    for account in accounts:
        for url in account.links:
            target = classify(url)
            if target and (target[0], _norm_handle(*target)) in known:
                continue
            entry = links.setdefault(url.lower().rstrip("/"), {
                "url": url, "kind": target[0] if target else "website", "sources": []})
            entry["sources"].append(account.platform)
    summary["links"] = list(links.values())

    languages, topics, stamps = Counter(), Counter(), []
    for account in accounts:
        languages.update(account.languages)
        topics.update(account.topics)
        stamps += account.activity
    summary["languages"] = languages.most_common(8)
    summary["interests"] = [t for t, _ in topics.most_common(12)]

    hours, days = [0] * 24, [0] * 7
    for stamp in stamps:
        try:
            moment = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            continue
        hours[moment.hour] += 1
        days[moment.weekday()] += 1
    summary["activity"] = {"hours": hours, "days": days, "events": sum(hours)}

    # The headline only states what a corroborated account says; username-only matches
    # may be a different person and must not be presented as the subject.
    trusted = [a for a in accounts if a.confidence != "unverified"]
    name = next((a.name for a in trusted if a.name), "")
    bits = []
    top = Counter()
    for account in trusted:
        top.update(account.languages)
    if top:
        bits.append(f"writes mostly {top.most_common(1)[0][0]}")
    employer = next((a.company for a in trusted if a.company), "")
    if employer:
        bits.append(f"lists {employer} as employer")
    place = next((a.location for a in trusted if a.location), "")
    if place:
        bits.append(f"based in {place}")
    since = sorted(a.created for a in trusted if a.created)
    if since:
        bits.append(f"online since {since[0][:4]}")
    summary["first_seen"] = since[0][:10] if since else ""
    if accounts and not trusted:
        bits = ["no corroborated accounts — everything below matched on username alone"]
    summary["tagline"] = "; ".join(bits)
    summary["display_name"] = name
    return summary


def build(handle="", explicit=None, email="", fetch=None, only=None, pivot=True, strict=False) -> Dossier:
    from .http import fetch as default_fetch

    cache: dict[str, tuple[int, object]] = {}
    raw = fetch or default_fetch

    def cached(url):
        if url not in cache:
            cache[url] = raw(url)
        return cache[url]

    accounts, attempts = collect(handle, explicit or {}, email, cached, only, pivot)
    correlate(accounts)
    if strict:
        accounts = [a for a in accounts if a.confidence != "unverified"]
    subject = handle or email or next(iter((explicit or {}).values()), "")
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return Dossier(subject, generated, accounts, attempts, summarise(accounts))
