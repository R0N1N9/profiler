"""Terminal, HTML and JSON views of a dossier."""
from __future__ import annotations

import json
from dataclasses import asdict
from html import escape
from urllib.parse import urlparse

from .models import Dossier

BARS = " ▁▂▃▄▅▆▇█"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MIN_EVENTS = 10


def to_json(dossier: Dossier) -> str:
    return json.dumps(asdict(dossier), indent=2, ensure_ascii=False)


def _spark(values: list[int]) -> str:
    top = max(values) or 1
    return "".join(BARS[round(v / top * 8)] for v in values)


def _fact_text(fact: dict) -> str:
    mark = "" if fact["verified"] else " (unverified)"
    return f"{fact['value']}  [{', '.join(fact['sources'])}]{mark}"


# ---------------------------------------------------------------- terminal

def to_text(dossier: Dossier, color: bool = True) -> str:
    def c(code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if color else text

    tone = {"asserted": "36", "confirmed": "32", "likely": "32", "possible": "33", "unverified": "2"}
    s = dossier.summary
    out: list[str] = []

    def section(title: str) -> None:
        out.append("")
        out.append(c("36;1", f"── {title.upper()} " + "─" * max(4, 58 - len(title))))

    title = s["display_name"] or dossier.subject
    out.append(c("36;1", "┌" + "─" * 62))
    out.append(c("36;1", "│ ") + c("1", title.upper()) + c("2", f"   query: {dossier.subject}"))
    if s["tagline"]:
        out.append(c("36;1", "│ ") + s["tagline"])
    out.append(c("36;1", "│ ") + c("2", f"{len(dossier.accounts)} accounts · generated {dossier.generated}"))
    out.append(c("36;1", "└" + "─" * 62))

    if not dossier.accounts:
        out.append("\nNo public accounts found for this identifier.")

    labels = [("names", "Name"), ("locations", "Location"), ("employers", "Employer"), ("emails", "Email")]
    if any(s[key] for key, _ in labels):
        section("identity (as self-published)")
        for key, label in labels:
            for fact in s[key]:
                out.append(f"  {label:<9} {_fact_text(fact)}")
        if s["first_seen"]:
            out.append(f"  {'First seen':<9} {s['first_seen']}")

    if dossier.accounts:
        section("accounts")
        for a in dossier.accounts:
            out.append(f"  {c('1', a.platform):<{22 if color else 14}} {a.handle}  "
                       + c(tone[a.confidence], f"[{a.confidence}]"))
            out.append(c("2", f"      {a.url}"))
            out.append(c("2", f"      evidence: {'; '.join(a.evidence)}"))
            if a.bio:
                out.append(f"      “{' '.join(a.bio.split())[:160]}”")
            if a.stats:
                out.append("      " + " · ".join(f"{k}: {v}" for k, v in a.stats.items()))
            for item in a.highlights[:3]:
                out.append(f"      • {item['title']} — {item['note'][:90]}")

    if s["languages"] or s["interests"]:
        section("skills & interests")
        if s["languages"]:
            out.append("  Languages  " + ", ".join(f"{name} ({n})" for name, n in s["languages"]))
        if s["interests"]:
            out.append("  Topics     " + ", ".join(s["interests"]))

    if s["links"]:
        section("other links they publish")
        for link in s["links"]:
            out.append(f"  {link['kind']:<10} {link['url']}  " + c("2", f"[{', '.join(link['sources'])}]"))

    activity = s["activity"]
    if activity["events"] >= MIN_EVENTS:
        section(f"public activity pattern ({activity['events']} recent events, UTC)")
        out.append(f"  Hour 00→23  {_spark(activity['hours'])}")
        out.append(f"  Mon→Sun     {_spark(activity['days'])}")

    missing = [a for a in dossier.attempts if a.status == "unavailable"]
    if missing:
        section("sources that could not be read")
        for a in missing:
            out.append(c("2", f"  {a.platform}: {a.detail}"))
    return "\n".join(out) + "\n"


# -------------------------------------------------------------------- HTML

CSS = """
:root{--bg:#070b10;--panel:#0d141c;--line:#1d2c3a;--ink:#d7e3ee;--dim:#7d92a6;--accent:#36d6e7;
--ok:#4ade80;--warn:#f5b942;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#f3f6f9;--panel:#fff;--line:#d5dee7;--ink:#14212d;
--dim:#5b6f82;--accent:#04798a;--ok:#15803d;--warn:#a16207}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}
a{color:var(--accent);text-decoration:none;overflow-wrap:anywhere}a:hover{text-decoration:underline}
.hud{display:flex;gap:20px;align-items:center;border:1px solid var(--accent);padding:20px;
background:var(--panel);position:relative;flex-wrap:wrap}
.hud::before{content:"PROFILE";position:absolute;top:-9px;left:16px;background:var(--bg);
padding:0 8px;font:11px var(--mono);letter-spacing:.2em;color:var(--accent)}
.hud img{width:96px;height:96px;object-fit:cover;border:1px solid var(--line)}
.hud h1{margin:0;font:600 26px var(--mono);letter-spacing:.04em;text-transform:uppercase}
.hud p{margin:4px 0 0}.dim{color:var(--dim)}.mono{font-family:var(--mono);font-size:12px}
h2{font:600 12px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--accent);
margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
dl{display:grid;grid-template-columns:110px 1fr;gap:6px 16px;margin:0}
dt{color:var(--dim);font:12px var(--mono);text-transform:uppercase;padding-top:3px}dd{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);padding:14px}
.card h3{margin:0 0 2px;font:600 14px var(--mono);text-transform:uppercase;display:flex;
justify-content:space-between;gap:8px;align-items:center}
.card p{margin:6px 0 0}.card ul{margin:8px 0 0;padding-left:18px}
.tag{font:11px var(--mono);padding:1px 7px;border:1px solid currentColor;white-space:nowrap}
.asserted{color:var(--accent)}.confirmed,.likely{color:var(--ok)}.possible{color:var(--warn)}
.unverified{color:var(--dim)}
.chips span{display:inline-block;border:1px solid var(--line);background:var(--panel);
padding:2px 9px;margin:0 6px 6px 0;font:12px var(--mono)}
.bars{display:flex;align-items:flex-end;gap:3px;height:70px}
.bars div{flex:1;background:var(--accent);min-height:2px;opacity:.85}
.axis{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--dim);margin-top:4px}
footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
"""


def _href(url: str) -> str:
    return escape(url, quote=True) if urlparse(url).scheme in ("http", "https") else "#"


def _a(url: str, text: str | None = None) -> str:
    return f'<a href="{_href(url)}" rel="noopener noreferrer nofollow">{escape(text or url)}</a>'


def _bars(values: list[int], labels: list[str]) -> str:
    top = max(values) or 1
    bars = "".join(f'<div style="height:{round(v / top * 100)}%" title="{v}"></div>' for v in values)
    axis = "".join(f"<span>{escape(label)}</span>" for label in labels)
    return f'<div class="bars">{bars}</div><div class="axis">{axis}</div>'


def to_html(dossier: Dossier) -> str:
    s = dossier.summary
    title = s["display_name"] or dossier.subject
    avatar = next((a.avatar for a in dossier.accounts if a.avatar), "")
    parts = [f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
             f'<meta name="viewport" content="width=device-width,initial-scale=1">'
             f'<meta name="referrer" content="no-referrer">'
             f"<title>Profile: {escape(title)}</title><style>{CSS}</style></head><body><main>"]

    parts.append('<section class="hud">')
    if avatar and _href(avatar) != "#":
        parts.append(f'<img src="{_href(avatar)}" alt="" referrerpolicy="no-referrer">')
    parts.append(f"<div><h1>{escape(title)}</h1>")
    if s["tagline"]:
        parts.append(f"<p>{escape(s['tagline'])}</p>")
    parts.append(f'<p class="dim mono">query: {escape(dossier.subject)} · {len(dossier.accounts)} accounts'
                 f" · generated {escape(dossier.generated)}</p></div></section>")

    if not dossier.accounts:
        parts.append("<p>No public accounts found for this identifier.</p>")

    rows = []
    for key, label in [("names", "Name"), ("locations", "Location"), ("employers", "Employer"), ("emails", "Email")]:
        for fact in s[key]:
            note = "" if fact["verified"] else " · unverified"
            rows.append(f"<dt>{label}</dt><dd>{escape(fact['value'])} "
                        f'<span class="dim mono">{escape(", ".join(fact["sources"]))}{note}</span></dd>')
    if s["first_seen"]:
        rows.append(f"<dt>First seen</dt><dd>{escape(s['first_seen'])}</dd>")
    if rows:
        parts.append(f"<h2>Identity (as self-published)</h2><dl>{''.join(rows)}</dl>")

    if dossier.accounts:
        parts.append('<h2>Accounts</h2><div class="grid">')
        for a in dossier.accounts:
            parts.append(f'<article class="card"><h3>{escape(a.platform)}'
                         f'<span class="tag {a.confidence}">{a.confidence}</span></h3>')
            parts.append(_a(a.url, a.handle) if a.url else escape(a.handle))
            parts.append(f'<p class="dim mono">{escape("; ".join(a.evidence))}</p>')
            if a.bio:
                parts.append(f"<p>{escape(a.bio[:400])}</p>")
            if a.stats:
                parts.append('<p class="mono">' + " · ".join(
                    f"{escape(str(k))}: {escape(str(v))}" for k, v in a.stats.items()) + "</p>")
            if a.highlights:
                items = "".join(f"<li>{_a(i['url'], i['title'])} <span class=\"dim\">{escape(i['note'][:120])}</span></li>"
                                for i in a.highlights)
                parts.append(f"<ul>{items}</ul>")
            parts.append("</article>")
        parts.append("</div>")

    if s["languages"] or s["interests"]:
        parts.append('<h2>Skills &amp; interests</h2><div class="chips">')
        parts += [f"<span>{escape(name)} · {n}</span>" for name, n in s["languages"]]
        parts += [f"<span>#{escape(topic)}</span>" for topic in s["interests"]]
        parts.append("</div>")

    if s["links"]:
        rows = "".join(f"<dt>{escape(link['kind'])}</dt><dd>{_a(link['url'])} "
                       f'<span class="dim mono">{escape(", ".join(link["sources"]))}</span></dd>'
                       for link in s["links"])
        parts.append(f"<h2>Other links they publish</h2><dl>{rows}</dl>")

    activity = s["activity"]
    if activity["events"] >= MIN_EVENTS:
        parts.append(f"<h2>Public activity pattern · {activity['events']} recent events · UTC</h2>")
        parts.append(_bars(activity["hours"], ["00", "06", "12", "18", "23"]))
        parts.append('<div style="height:20px"></div>')
        parts.append(_bars(activity["days"], DAYS))

    missing = [a for a in dossier.attempts if a.status == "unavailable"]
    if missing:
        rows = "".join(f"<dt>{escape(a.platform)}</dt><dd>{escape(a.detail)}</dd>" for a in missing)
        parts.append(f"<h2>Sources that could not be read</h2><dl>{rows}</dl>")

    parts.append("<footer>Compiled only from information each account owner published on public profiles. "
                 "Accounts tagged <em>unverified</em> share a username and nothing else, and may belong to "
                 "someone else entirely.</footer></main></body></html>")
    return "".join(parts)
