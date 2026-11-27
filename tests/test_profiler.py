import unittest

from profiler import render
from profiler.engine import build
from profiler.links import classify, extract_urls

GH = "https://api.github.com/users/ada"
PAGES = {
    GH: {"login": "ada", "html_url": "https://github.com/ada", "name": "Ada Example",
         "bio": "<script>alert(1)</script> compilers", "location": "London", "company": "@acme",
         "blog": "ada.example", "twitter_username": "ada_tw", "created_at": "2012-03-04T05:06:07Z",
         "followers": 10, "public_repos": 2, "avatar_url": "javascript:alert(1)"},
    GH + "/social_accounts": [{"provider": "mastodon", "url": "https://fosstodon.org/@adae"}],
    GH + "/repos?per_page=100&sort=pushed": [
        {"name": "calc", "html_url": "https://github.com/ada/calc", "language": "Rust",
         "stargazers_count": 7, "topics": ["compilers"], "description": "a calculator"},
        {"name": "forked", "html_url": "https://github.com/ada/forked", "language": "Go", "fork": True}],
    GH + "/events/public?per_page=100": [{"created_at": f"2026-01-05T{h:02d}:00:00Z"} for h in range(12)],
    "https://fosstodon.org/api/v1/accounts/lookup?acct=adae": {
        "id": "7", "username": "adae", "url": "https://fosstodon.org/@adae", "display_name": "Ada Example",
        "note": "<p>hi</p>", "created_at": "2019-01-01T00:00:00Z",
        "fields": [{"name": "code", "value": '<a href="https://github.com/ada">github.com/ada</a>'}]},
    "https://hacker-news.firebaseio.com/v0/user/ada.json": {"id": "ada", "karma": 5, "created": 1300000000},
}


def fake_fetch(url):
    if url in PAGES:
        return 200, PAGES[url]
    if "dev.to" in url:
        return 429, None
    if "hn.algolia.com" in url or "registry.npmjs.org" in url:
        return 200, {}
    return 404, None


class LinkTests(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify("https://github.com/ada"), ("github", "ada"))
        self.assertEqual(classify("https://x.com/ada_tw"), ("twitter", "ada_tw"))
        self.assertEqual(classify("https://fosstodon.org/@adae"), ("mastodon", "adae@fosstodon.org"))
        self.assertEqual(classify("https://news.ycombinator.com/user?id=ada"), ("hackernews", "ada"))
        self.assertIsNone(classify("https://github.com/ada/calc"))
        self.assertIsNone(classify("https://github.com/settings"))
        self.assertIsNone(classify("https://medium.com/@ada"))
        self.assertIsNone(classify("https://localhost/@ada"))
        self.assertIsNone(classify("https://127.0.0.1/@ada"))
        self.assertIsNone(classify("https://box.internal/@ada"))

    def test_extract_urls(self):
        self.assertEqual(extract_urls('see <a href="x">https://a.example/x</a>.'), ["https://a.example/x"])


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.dossier = build("ada", fetch=fake_fetch)
        self.by_platform = {a.platform: a for a in self.dossier.accounts}

    def test_pivot_and_confidence(self):
        self.assertEqual(set(self.by_platform), {"github", "mastodon", "hackernews"})
        self.assertEqual(self.by_platform["mastodon"].origin, "pivot:github")
        self.assertEqual(self.by_platform["github"].confidence, "confirmed")  # mutual links
        self.assertEqual(self.by_platform["mastodon"].confidence, "confirmed")
        self.assertEqual(self.by_platform["hackernews"].confidence, "unverified")

    def test_summary(self):
        s = self.dossier.summary
        self.assertEqual(s["names"][0]["value"], "Ada Example")
        self.assertEqual(s["names"][0]["sources"], ["github", "mastodon"])
        self.assertEqual(s["languages"], [("Rust", 1)])
        self.assertEqual(s["first_seen"], "2012-03-04")
        self.assertEqual(s["activity"]["events"], 12)
        self.assertIn("based in London", s["tagline"])
        self.assertIn("online since 2012", s["tagline"])  # the unverified 2011 account is excluded
        kinds = {link["kind"] for link in s["links"]}
        self.assertEqual(kinds, {"website", "twitter"})  # known accounts are not repeated as links

    def test_attempts_and_strict(self):
        statuses = {a.platform: a.status for a in self.dossier.attempts}
        self.assertEqual(statuses["devto"], "unavailable")
        self.assertEqual(statuses["gitlab"], "not found")
        strict = build("ada", fetch=fake_fetch, strict=True)
        self.assertNotIn("hackernews", {a.platform for a in strict.accounts})

    def test_no_pivot(self):
        dossier = build("ada", fetch=fake_fetch, pivot=False)
        self.assertNotIn("mastodon", {a.platform for a in dossier.accounts})

    def test_rendering_escapes_untrusted_content(self):
        page = render.to_html(self.dossier)
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("javascript:", page)
        self.assertIn("Ada Example", render.to_text(self.dossier, color=False))
        self.assertIn('"platform": "github"', render.to_json(self.dossier))

    def test_username_only_matches_do_not_reach_the_headline(self):
        dossier = build("ada", fetch=fake_fetch, only={"hackernews"})
        self.assertIn("no corroborated accounts", dossier.summary["tagline"])
        self.assertEqual(dossier.summary["display_name"], "")

    def test_nothing_found(self):
        dossier = build("nobody", fetch=lambda url: (404, None))
        self.assertEqual(dossier.accounts, [])
        self.assertIn("No public accounts", render.to_text(dossier, color=False))


if __name__ == "__main__":
    unittest.main()
