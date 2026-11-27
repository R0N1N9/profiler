# profiler

Builds a dossier on a person from what they have published on their own public
accounts, then shows it as a terminal card, an HTML report, or JSON.

Give it a username. It looks that name up on each supported platform, follows the
links those profiles publish to find the person's other accounts, and grades every
account by how well the others corroborate it.

```
$ python -m profiler ada --html out/ada.html

┌──────────────────────────────────────────────────────────────
│ ADA EXAMPLE   query: ada
│ writes mostly Rust; lists acme as employer; based in London; online since 2012
│ 3 accounts · generated 2026-11-27 13:19 UTC
└──────────────────────────────────────────────────────────────

── ACCOUNTS ──────────────────────────────────────────────────
  github         ada  [confirmed]
      evidence: links to and from the mastodon profile; same name as mastodon
  mastodon       adae@fosstodon.org  [confirmed]
  hackernews     ada  [unverified]
      evidence: username match only — may be a different person
```

## On your phone

`docs/` is the same tool as a web app that runs entirely in the browser: no server, no
install, and lookups go straight from your phone to each platform's public API.

1. Merge this branch into `main`.
2. On GitHub, open **Settings → Pages**, set **Source** to *Deploy from a branch*, and pick
   `main` and the `/docs` folder. (Pages on a private repository needs a paid GitHub plan;
   otherwise make the repository public or host `docs/` on any static host such as Netlify
   or Cloudflare Pages.)
3. Open `https://<your-user>.github.io/profiler/` on your phone, then
   **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android). It opens
   full-screen like a native app.

`…/profiler/?q=HANDLE` runs a lookup straight from a link. Each report can be shared or
saved as JSON. Under *More options* you can add known accounts, an email, a GitHub token
(stored only in that browser), and the strict / no-pivot switches.

Browsers only allow a request when the site permits it (CORS). GitHub, GitLab, Hacker News,
Bluesky, Mastodon and Gravatar do; if a source refuses, the report lists it under
*Sources that could not be read*, and the command-line version can still reach it.

To try it locally: `python -m http.server -d docs` and open http://localhost:8000.

## Command line

Python 3.11+, no dependencies.

```
python -m profiler HANDLE                       # or: pip install -e . && profiler HANDLE
python -m profiler HANDLE --html report.html --json report.json
python -m profiler -a github=someone -a mastodon=someone@mastodon.social
python -m profiler --email someone@example.com  # public Gravatar profile
python -m profiler HANDLE --strict              # drop username-only matches
python -m profiler HANDLE --only github,gitlab --no-pivot
```

Set `GITHUB_TOKEN` to raise GitHub's limit from 60 requests an hour (a lookup uses five).

## Sources

| Platform | Looked up by | What is read |
| --- | --- | --- |
| GitHub | username | profile, own repositories (languages, topics, most starred), recent public events, organisations |
| GitLab | username | profile |
| Hacker News | username | profile, recent submissions and comments (timestamps, top stories) |
| Bluesky | handle | profile, recent post timestamps |
| Keybase | username | profile and its cryptographically verified identity proofs |
| DEV | username | profile |
| npm | username | maintained packages |
| Docker Hub | username | profile |
| Mastodon | `user@instance`, or a link from another profile | profile, recent post timestamps |
| Gravatar | `--email` | profile and verified accounts |

Every source is the platform's public, unauthenticated API. Adding one is a function in
`profiler/sources.py` that returns an `Account`, plus a URL pattern in `profiler/links.py`
if profiles elsewhere link to it.

## Confidence

The same username on two sites is often two different people, so every account carries a
grade and the evidence for it:

| Grade | Meaning |
| --- | --- |
| asserted | you supplied this exact account with `--account` or `--email` |
| confirmed | a Keybase proof, or the two profiles link to each other |
| likely | one profile links to the other, or same name plus a shared website, location or employer |
| possible | same name, or same personal website |
| unverified | username match only |

The headline is written only from corroborated accounts. Facts from unverified accounts
are listed but flagged, and `--strict` removes them.

## Scope

The tool reports what account owners chose to publish on public profiles. It does not
use people-search sites, data brokers, breach data or logged-in scraping; it does not
look for home addresses, phone numbers or relatives; and it does not guess at traits a
person has not stated. Use it for things like auditing your own footprint, checking who
is behind a contributor or vendor account, or authorised security assessments, and
follow the privacy law that applies to you (compiling data on EU residents is covered by
GDPR even when the data is public).

## Tests

```
python -m unittest discover -s tests   # Python version
node --test tests/test_web.mjs         # web version (same fixtures)
```
