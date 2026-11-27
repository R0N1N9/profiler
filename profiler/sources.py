"""One function per platform. Each uses the platform's public, unauthenticated API
and returns only what the account owner chose to publish."""
from __future__ import annotations

import hashlib
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import quote

from .links import clean_url, extract_urls, public_host, strip_html
from .models import Account

Fetch = Callable[[str], tuple[int, object]]


class Unavailable(Exception):
    """The source could not be read (rate limit, outage, blocked)."""


def _get(fetch: Fetch, url: str, missing: tuple[int, ...] = (404,)):
    status, data = fetch(url)
    if status in missing:
        return None
    if status != 200:
        raise Unavailable(f"HTTP {status}" if status else "no response")
    return data


def _soft(fetch: Fetch, url: str):
    """Optional extra detail: never fails the whole source."""
    try:
        return _get(fetch, url)
    except Unavailable:
        return None


def _iso(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e11 else value
        return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def _q(handle: str) -> str:
    return quote(handle, safe="")


def _links(*values: str | None) -> list[str]:
    seen, out = set(), []
    for value in values:
        url = clean_url(value or "")
        if url and url.lower() not in seen:
            seen.add(url.lower())
            out.append(url)
    return out


def github(handle: str, fetch: Fetch) -> Account | None:
    base = f"https://api.github.com/users/{_q(handle)}"
    user = _get(fetch, base)
    if not user:
        return None
    twitter = user.get("twitter_username")
    social = _soft(fetch, f"{base}/social_accounts") or []
    account = Account(
        "github", user["login"], user["html_url"],
        name=user.get("name") or "", bio=user.get("bio") or "",
        location=user.get("location") or "", company=(user.get("company") or "").lstrip("@"),
        email=user.get("email") or "", avatar=user.get("avatar_url") or "",
        created=_iso(user.get("created_at")),
        links=_links(user.get("blog"), f"https://twitter.com/{twitter}" if twitter else "",
                     *[s.get("url") for s in social], *extract_urls(user.get("bio") or "")),
        stats={"followers": user.get("followers", 0), "public repos": user.get("public_repos", 0)},
    )
    repos = [r for r in _soft(fetch, f"{base}/repos?per_page=100&sort=pushed") or [] if not r.get("fork")]
    account.languages = dict(Counter(r["language"] for r in repos if r.get("language")).most_common(8))
    account.topics = [t for t, _ in Counter(t for r in repos for t in r.get("topics") or []).most_common(12)]
    for repo in sorted(repos, key=lambda r: r.get("stargazers_count", 0), reverse=True)[:5]:
        account.highlights.append({
            "title": repo["name"], "url": repo["html_url"],
            "note": f"★ {repo.get('stargazers_count', 0)} · {repo.get('description') or 'no description'}",
        })
    events = _soft(fetch, f"{base}/events/public?per_page=100") or []
    account.activity = [e["created_at"] for e in events if e.get("created_at")]
    orgs = _soft(fetch, f"{base}/orgs") or []
    if orgs:
        account.stats["organisations"] = ", ".join(o["login"] for o in orgs[:8])
    return account


def gitlab(handle: str, fetch: Fetch) -> Account | None:
    found = _get(fetch, f"https://gitlab.com/api/v4/users?username={_q(handle)}")
    if not found:
        return None
    user = _soft(fetch, f"https://gitlab.com/api/v4/users/{found[0]['id']}") or found[0]
    twitter, linkedin = user.get("twitter"), user.get("linkedin")
    return Account(
        "gitlab", user["username"], user["web_url"],
        name=user.get("name") or "", bio=user.get("bio") or "",
        location=user.get("location") or "", company=user.get("organization") or "",
        email=user.get("public_email") or "", avatar=user.get("avatar_url") or "",
        created=_iso(user.get("created_at")),
        links=_links(user.get("website_url"),
                     f"https://twitter.com/{twitter.lstrip('@')}" if twitter else "",
                     f"https://linkedin.com/in/{linkedin}" if linkedin else "",
                     *extract_urls(user.get("bio") or "")),
        stats={"job title": user["job_title"]} if user.get("job_title") else {},
    )


def hackernews(handle: str, fetch: Fetch) -> Account | None:
    user = _get(fetch, f"https://hacker-news.firebaseio.com/v0/user/{_q(handle)}.json")
    if not user:
        return None
    about = user.get("about") or ""
    account = Account(
        "hackernews", user["id"], f"https://news.ycombinator.com/user?id={_q(user['id'])}",
        bio=strip_html(about), created=_iso(user.get("created")),
        links=_links(*extract_urls(about)), stats={"karma": user.get("karma", 0)},
    )
    hits = (_soft(fetch, "https://hn.algolia.com/api/v1/search_by_date"
                         f"?tags=author_{_q(user['id'])}&hitsPerPage=100") or {}).get("hits", [])
    account.activity = [h["created_at"] for h in hits if h.get("created_at")]
    stories = [h for h in hits if h.get("title")]
    for hit in sorted(stories, key=lambda h: h.get("points") or 0, reverse=True)[:3]:
        account.highlights.append({
            "title": hit["title"], "note": f"{hit.get('points') or 0} points",
            "url": f"https://news.ycombinator.com/item?id={hit['objectID']}",
        })
    return account


def bluesky(handle: str, fetch: Fetch) -> Account | None:
    actor = handle if "." in handle else f"{handle}.bsky.social"
    api = "https://public.api.bsky.app/xrpc"
    user = _get(fetch, f"{api}/app.bsky.actor.getProfile?actor={_q(actor)}", missing=(400, 404))
    if not user:
        return None
    account = Account(
        "bluesky", user["handle"], f"https://bsky.app/profile/{user['handle']}",
        name=user.get("displayName") or "", bio=user.get("description") or "",
        avatar=user.get("avatar") or "", created=_iso(user.get("createdAt")),
        links=_links(*extract_urls(user.get("description") or "")),
        stats={"followers": user.get("followersCount", 0), "posts": user.get("postsCount", 0)},
    )
    feed = (_soft(fetch, f"{api}/app.bsky.feed.getAuthorFeed?actor={_q(actor)}&limit=100") or {}).get("feed", [])
    account.activity = [i["post"]["record"]["createdAt"] for i in feed
                        if i.get("post", {}).get("author", {}).get("handle") == user["handle"]
                        and i["post"].get("record", {}).get("createdAt")]
    return account


def mastodon(handle: str, fetch: Fetch) -> Account | None:
    user_part, _, host = handle.lstrip("@").partition("@")
    if not user_part or not public_host(host):
        raise Unavailable("needs user@instance")
    user = _get(fetch, f"https://{host}/api/v1/accounts/lookup?acct={_q(user_part)}")
    if not user:
        return None
    fields = user.get("fields") or []
    account = Account(
        "mastodon", f"{user['username']}@{host}", user.get("url") or f"https://{host}/@{user_part}",
        name=user.get("display_name") or "", bio=strip_html(user.get("note") or ""),
        avatar=user.get("avatar") or "", created=_iso(user.get("created_at")),
        links=_links(*[u for f in fields for u in extract_urls(f.get("value") or "")],
                     *extract_urls(user.get("note") or "")),
        stats={"followers": user.get("followers_count", 0), "posts": user.get("statuses_count", 0)},
    )
    statuses = _soft(fetch, f"https://{host}/api/v1/accounts/{_q(str(user['id']))}/statuses"
                            "?limit=40&exclude_reblogs=true") or []
    account.activity = [s["created_at"] for s in statuses if s.get("created_at")]
    return account


KEYBASE_PROOFS = {"github": "github", "twitter": "twitter", "hackernews": "hackernews", "gitlab": "gitlab"}


def keybase(handle: str, fetch: Fetch) -> Account | None:
    if not re.fullmatch(r"[A-Za-z0-9_]{2,16}", handle):
        return None
    data = _get(fetch, f"https://keybase.io/_/api/1.0/user/lookup.json?usernames={_q(handle)}")
    them = [t for t in (data or {}).get("them") or [] if t]
    if not them:
        return None
    user = them[0]
    profile = user.get("profile") or {}
    proofs = (user.get("proofs_summary") or {}).get("all") or []
    name = user["basics"]["username"]
    account = Account(
        "keybase", name, f"https://keybase.io/{name}",
        name=profile.get("full_name") or "", bio=profile.get("bio") or "",
        location=profile.get("location") or "",
        avatar=((user.get("pictures") or {}).get("primary") or {}).get("url") or "",
        created=_iso((user["basics"]).get("ctime")),
        links=_links(*[p.get("service_url") for p in proofs]),
        stats={"verified proofs": len(proofs)},
    )
    account.proofs = [(KEYBASE_PROOFS[p["proof_type"]], p["nametag"]) for p in proofs
                      if p.get("proof_type") in KEYBASE_PROOFS and p.get("nametag")]
    return account


def devto(handle: str, fetch: Fetch) -> Account | None:
    user = _get(fetch, f"https://dev.to/api/users/by_username?url={_q(handle)}")
    if not user:
        return None
    gh, tw = user.get("github_username"), user.get("twitter_username")
    return Account(
        "devto", user["username"], f"https://dev.to/{user['username']}",
        name=user.get("name") or "", bio=user.get("summary") or "",
        location=user.get("location") or "", avatar=user.get("profile_image") or "",
        links=_links(user.get("website_url"), f"https://github.com/{gh}" if gh else "",
                     f"https://twitter.com/{tw}" if tw else ""),
        stats={"joined": user["joined_at"]} if user.get("joined_at") else {},
    )


def npm(handle: str, fetch: Fetch) -> Account | None:
    data = _get(fetch, f"https://registry.npmjs.org/-/v1/search?text=maintainer:{_q(handle)}&size=20")
    objects = (data or {}).get("objects") or []
    if not objects:
        return None
    account = Account("npm", handle, f"https://www.npmjs.com/~{_q(handle)}",
                      stats={"packages": data.get("total", len(objects))})
    for obj in objects[:5]:
        package = obj["package"]
        account.highlights.append({
            "title": package["name"], "note": package.get("description") or "no description",
            "url": f"https://www.npmjs.com/package/{package['name']}",
        })
    account.activity = [o["package"]["date"] for o in objects if o["package"].get("date")]
    return account


def dockerhub(handle: str, fetch: Fetch) -> Account | None:
    user = _get(fetch, f"https://hub.docker.com/v2/users/{_q(handle)}/")
    if not user or not user.get("username"):
        return None
    return Account(
        "dockerhub", user["username"], f"https://hub.docker.com/u/{user['username']}",
        name=user.get("full_name") or "", location=user.get("location") or "",
        company=user.get("company") or "", avatar=user.get("gravatar_url") or "",
        created=_iso(user.get("date_joined")), links=_links(user.get("profile_url")),
    )


def gravatar(email: str, fetch: Fetch) -> Account | None:
    digest = hashlib.sha256(email.strip().lower().encode()).hexdigest()
    user = _get(fetch, f"https://api.gravatar.com/v3/profiles/{digest}")
    if not user:
        return None
    return Account(
        "gravatar", email, user.get("profile_url") or "",
        name=user.get("display_name") or "", bio=user.get("description") or "",
        location=user.get("location") or "", company=user.get("company") or "",
        avatar=user.get("avatar_url") or "",
        links=_links(*[a.get("url") for a in user.get("verified_accounts") or []]),
        stats={"job title": user["job_title"]} if user.get("job_title") else {},
    )


# Looked up by plain username.
BY_USERNAME = {
    "github": github, "gitlab": gitlab, "hackernews": hackernews, "bluesky": bluesky,
    "keybase": keybase, "devto": devto, "npm": npm, "dockerhub": dockerhub,
}
# Need a more specific identifier, so only reached explicitly or through a profile link.
ALL = {**BY_USERNAME, "mastodon": mastodon, "gravatar": gravatar}
