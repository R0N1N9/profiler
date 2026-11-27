# profiler

Builds a dossier on a person from what they publish on their own public accounts, as a
phone-friendly web app and a command-line tool that share one engine.

Give it a username. It:

1. **looks the name up on 17 platforms** and reads each public profile in detail;
2. **follows the links people publish** (bios, profile READMEs, link-in-bio pages, personal
   websites, Keybase proofs) to find their accounts under other names;
3. **grades every account** by how well the others corroborate it, so a stranger with the
   same username isn't presented as the same person;
4. **checks 600+ more sites** for an account with that username (existence only);
5. optionally **tries username variations** and runs a **footprint audit** of what is exposed.

## On your phone

`docs/` is a static web app: nothing to install, no server of yours involved.

1. GitHub → **Settings → Pages** → *Deploy from a branch* → `main`, folder **`/docs`**.
2. Open `https://<user>.github.io/profiler/` and **Add to Home Screen** (iPhone: Share menu;
   Android: ⋮ → Install app).
3. Set up the relay below. Without it, only sites that allow browser requests can be read.

`…/profiler/?q=HANDLE` runs a lookup straight from a link. Reports can be shared, or saved
as JSON or a standalone HTML page.

### The relay (needed for full results on a phone)

Browsers refuse to read most websites from another site (CORS). The relay is a tiny
Cloudflare Worker you own that fetches public pages for the app. It's free (100,000
requests a day; a full scan uses about 20).

**From the dashboard (no tools needed):**
1. Sign up at dash.cloudflare.com → **Workers & Pages → Create → Create Worker**, name it
   `profiler-relay`, **Deploy**, then **Edit code**.
2. Replace the code with the contents of [`relay/worker.js`](relay/worker.js) and **Deploy**.
3. In the worker's **Settings → Variables and Secrets**, add a **Secret** named
   `RELAY_TOKEN` with a long random value (a password manager can generate one).
4. In the app, open **More options** and fill in **Relay URL**
   (`https://profiler-relay.<you>.workers.dev`) and **Relay token**.

**Or with Wrangler:** `cd relay && npx wrangler deploy && npx wrangler secret put RELAY_TOKEN`.

The relay only fetches public `http(s)` addresses (no IPs, localhost or internal names),
refuses requests without your token, drops cookies, and only forwards a GitHub token to
GitHub. The app first tries each site directly and uses the relay only for sites that
block the browser.

## Command line

Node 20 or later, no dependencies. The command line reaches every site directly, so it
needs no relay.

```
node cli/profiler.mjs HANDLE                       # or: npm link && profiler HANDLE
node cli/profiler.mjs HANDLE --audit --variants --html report.html
node cli/profiler.mjs -a mastodon=someone@mastodon.social -a stackoverflow=1234567
node cli/profiler.mjs --email someone@example.com  # public Gravatar profile
node cli/profiler.mjs HANDLE --strict --no-sites   # corroborated accounts only, skip the 600+ check
node cli/profiler.mjs --help
```

`GITHUB_TOKEN` raises GitHub's limit from 60 requests an hour to 5,000. The site list is
cached in `~/.cache/profiler` for a week.

## Sources

| Platform | Looked up by | What is read |
| --- | --- | --- |
| GitHub | username | profile, repositories (languages, topics, top projects), activity, organisations, profile README links |
| GitLab, Codeberg | username | profile, website, linked accounts; Codeberg repositories |
| npm, PyPI, crates.io | username | published packages |
| Docker Hub | username | profile |
| Hacker News | username | profile, karma, recent posts and comments, top stories |
| Reddit | username | profile, karma, communities they post in, activity, top posts |
| Lobsters, DEV | username | profile, homepage, linked GitHub/Twitter/Mastodon |
| Keybase | username | profile and cryptographically verified identity proofs |
| Bluesky | handle | profile, post activity; a custom-domain handle counts as their website |
| Lichess, Chess.com | username | profile, games played, account age |
| Medium | username | name, recent stories and tags |
| Substack | handle | profile and publications |
| Mastodon | `user@instance` or a link | profile, link fields (with Mastodon's own link verification), activity |
| Stack Overflow | numeric id or a link | reputation, top tags, location, website |
| Personal websites | links from profiles, or `website=domain` | `rel="me"` links, h-card and schema.org Person details |
| Linktree, bio.link, about.me, Beacons | links from profiles | every link listed |
| Gravatar | `--email` | profile and verified accounts |
| 615 more sites | username | existence only, via [WhatsMyName](https://github.com/WebBreacher/WhatsMyName) (CC BY-SA 4.0) |

Adding a source is one function in `docs/lib/sources.js`, plus a URL pattern in
`docs/lib/links.js` if other profiles link to it.

## Confidence

| Grade | Meaning |
| --- | --- |
| asserted | you supplied this exact account |
| confirmed | a Keybase proof or Mastodon-verified link, or the two profiles link to each other |
| likely | one profile links to the other, or same name plus a shared website, location or employer |
| possible | same name, or same personal website |
| unverified | username match only, or found by guessing a variation |

The headline, avatar and activity chart use only corroborated accounts. Facts from
unverified accounts are listed but flagged, and *Hide username-only matches* / `--strict`
removes them.

## Footprint audit

For scanning yourself: flags a public email, your name tied to your username, a stated
location or employer, accounts that link to each other, posting times that reveal your
sleep hours, a username reused on many sites, and dormant accounts. Each finding links to
the settings page where you can change it.

## Scope

The tool reads what account owners chose to publish on public profiles. It does not use
people-search sites, data brokers, breach data or logged-in scraping; it does not look for
home addresses, phone numbers or relatives; it does not guess at traits a person hasn't
stated; and the 600+ site check skips adult, dating, political and health sites, where
finding someone's account would itself reveal something sensitive. Use it to audit your
own footprint, check who is behind a contributor or vendor account, or for authorised
security work, and follow the privacy law that applies to you (compiling data on EU
residents is covered by GDPR even when the data is public).

## Development

```
npm test                      # engine, sources, presence check, audit, relay
npm run serve                 # app at http://localhost:8000
```

`docs/lib/` holds the engine (`engine.js`), sources (`sources.js`), link recognition
(`links.js`), the 600+ site check (`presence.js`), the audit (`audit.js`), report rendering
(`render.js`) and the network layer (`http.js`). `docs/app.js` is the web UI,
`cli/profiler.mjs` the command line, `relay/worker.js` the relay.
