from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlparse

USER_AGENT = "profiler-cli/0.1"


def fetch(url: str, timeout: float = 12.0) -> tuple[int, object]:
    """GET a JSON document. Returns (status, data); status 0 means no response."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and urlparse(url).hostname == "api.github.com":
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        return error.code, None
    except (OSError, ValueError):
        return 0, None
