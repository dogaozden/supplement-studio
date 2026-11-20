"""Shared HTTP session for the corpus build (OLRC + eCFR).

* eCFR's versioner API now REQUIRES `Accept-Encoding: gzip`; requests would
  send it by default, but it is set explicitly so no later header tweak can
  silently drop it.
* Transient 429/5xx responses are retried with backoff (both hosts flake
  occasionally, and a half-fetched corpus must never be built silently).
"""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

USER_AGENT = "supplement-studio-corpus-build/1.0"


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
    })
    retry = Retry(
        total=4,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s
