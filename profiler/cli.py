from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__, render, sources
from .engine import build


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="profiler",
        description="Build a dossier from what a person publishes on their public accounts.",
        epilog="Example: profiler octocat -a mastodon=someone@mastodon.social --html out/octocat.html",
    )
    parser.add_argument("handle", nargs="?", default="", help="username to look up on every supported platform")
    parser.add_argument("-a", "--account", action="append", default=[], metavar="PLATFORM=HANDLE",
                        help=f"a known account (repeatable). Platforms: {', '.join(sources.ALL)}")
    parser.add_argument("--email", default="", help="look up the public Gravatar profile for this address")
    parser.add_argument("--only", default="", metavar="A,B", help="restrict to these platforms")
    parser.add_argument("--no-pivot", action="store_true", help="do not follow links found on profiles")
    parser.add_argument("--strict", action="store_true",
                        help="drop accounts that match on username alone")
    parser.add_argument("--html", metavar="FILE", help="write an HTML report")
    parser.add_argument("--json", metavar="FILE", help="write JSON ('-' for stdout)")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)

    explicit = {}
    for item in args.account:
        platform, sep, value = item.partition("=")
        if not sep or not value or platform not in sources.ALL:
            parser.error(f"--account expects PLATFORM=HANDLE with a supported platform, got {item!r}")
        explicit[platform] = value
    only = {p for p in args.only.split(",") if p}
    if only - set(sources.ALL):
        parser.error(f"unknown platform in --only: {', '.join(sorted(only - set(sources.ALL)))}")
    if not (args.handle or explicit or args.email):
        parser.error("give a handle, --account or --email")

    dossier = build(args.handle, explicit, args.email, only=only or None,
                    pivot=not args.no_pivot, strict=args.strict)

    if args.json == "-":
        print(render.to_json(dossier))
    else:
        color = not args.no_color and sys.stdout.isatty()
        sys.stdout.write(render.to_text(dossier, color=color))
        if args.json:
            _write(args.json, render.to_json(dossier))
    if args.html:
        _write(args.html, render.to_html(dossier))
    return 0 if dossier.accounts else 1


def _write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    print(f"wrote {target}", file=sys.stderr)
