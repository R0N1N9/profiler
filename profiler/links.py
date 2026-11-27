"""Recognise links to other profiles, so one account can lead to the next."""
from __future__ import annotations

import html
import re
from urllib.parse import parse_qs, urlparse

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
HANDLE = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}"
HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")
PRIVATE_SUFFIXES = (".local", ".internal", ".localhost", ".lan", ".home", ".corp")

# First path segment is a profile handle on these hosts.
SIMPLE = {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "keybase.io": "keybase",
    "dev.to": "devto",
    "twitter.com": "twitter",
    "x.com": "twitter",
}
RESERVED = {
    "about", "explore", "features", "home", "i", "intent", "login", "orgs", "pricing",
    "search", "settings", "share", "sponsors", "topics", "users", "apps", "marketplace",
}
# Hosts that use /@name paths but are not Mastodon-compatible.
NOT_FEDIVERSE = {
    "medium.com", "youtube.com", "tiktok.com", "threads.net", "threads.com",
    "npmjs.com", "telegram.me", "substack.com",
}
FETCHABLE = {"github", "gitlab", "hackernews", "bluesky", "mastodon", "keybase", "devto", "npm", "dockerhub"}


def public_host(host: str) -> bool:
    host = host.lower()
    return bool(HOST_RE.match(host)) and not host.endswith(PRIVATE_SUFFIXES)


def clean_url(url: str) -> str:
    url = url.strip().rstrip(".,;")
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    return url if parsed.hostname and "." in parsed.hostname else ""


def extract_urls(text: str) -> list[str]:
    # Search the raw markup too: rich-text fields often keep the full URL only in href.
    found = (clean_url(m) for m in URL_RE.findall(html.unescape(text or "")))
    return list(dict.fromkeys(u for u in found if u))


def strip_html(text: str) -> str:
    text = re.sub(r"<p>|<br\s*/?>", "\n", text or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def classify(url: str) -> tuple[str, str] | None:
    """Map a URL to (platform, handle) when it is a recognisable profile link."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    parts = [p for p in parsed.path.split("/") if p]

    if host in SIMPLE and len(parts) == 1:
        handle = parts[0].lstrip("@")
        if re.fullmatch(HANDLE, handle) and handle.lower() not in RESERVED:
            return SIMPLE[host], handle
        return None
    if host == "news.ycombinator.com" and parsed.path == "/user":
        ids = parse_qs(parsed.query).get("id")
        return ("hackernews", ids[0]) if ids and re.fullmatch(HANDLE, ids[0]) else None
    if host == "bsky.app" and len(parts) == 2 and parts[0] == "profile":
        return ("bluesky", parts[1]) if public_host(parts[1]) else None
    if host == "linkedin.com" and len(parts) >= 2 and parts[0] == "in":
        return "linkedin", parts[1]
    if host == "hub.docker.com" and len(parts) == 2 and parts[0] == "u":
        return "dockerhub", parts[1]
    if host == "npmjs.com" and len(parts) == 1 and parts[0].startswith("~"):
        return "npm", parts[0][1:]
    if len(parts) == 1 and parts[0].startswith("@") and host not in NOT_FEDIVERSE:
        user = parts[0][1:]
        if re.fullmatch(r"[A-Za-z0-9_]{1,30}", user) and public_host(host):
            return "mastodon", f"{user}@{host}"
    return None
