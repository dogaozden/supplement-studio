"""Find the newest *downloadable* USC Title-15 release point and the newest
eCFR Title-17 date, and say whether either differs from what's recorded in
builder/build_manifest.json.

Prints one JSON object on stdout (exit 0):

    {"changed": bool,
     "usc_release_point": "119-134",      # the one to download/build from
     "usc_zip_url": "https://uscode.house.gov/download/releasepoints/...zip",
     "usc_release_label": "Public Law 119-134 (October 20, 2026)",
     "usc_release_note": "",              # non-empty when we fell back (and why)
     "usc_listed_release_point": "119-136",   # what OLRC's download page lists
     "ecfr_date": "2026-10-29",
     "current_release_point": ..., "current_ecfr_date": ...}

Why the fallback exists: OLRC's download page can list a release point whose
zip 404s (119-136 did, while 119-134 downloaded fine). The page is
https://uscode.house.gov/download.html; older release points are listed on
https://uscode.house.gov/priorreleasepoints.html. We HEAD-check the listed zip
and, when it isn't downloadable, walk the prior release points newest-first
(falling back to stepping the release number down if that page is unusable)
and take the first title-15 zip that exists. WHICH was chosen and WHY goes in
the output (and, via build_corpus, into build_manifest.json).
"""
from __future__ import annotations
import html as _html
import json
import re
import sys
from pathlib import Path

from builder.build.net import make_session

MANIFEST = Path(__file__).resolve().parents[1] / "build_manifest.json"
SITE_BASE = "https://uscode.house.gov/"
DOWNLOAD_PAGE_URL = SITE_BASE + "download.html"
PRIOR_PAGE_URL = SITE_BASE + "priorreleasepoints.html"
DOWNLOAD_BASE_URL = SITE_BASE + "download/"
ECFR_TITLES = "https://www.ecfr.gov/api/versioner/v1/titles.json"
ECFR_TITLE = 17

# Matches the Title-15 USLM XML zip link. Two href forms exist on the site:
#   current page (download.html):  href="download/releasepoints/us/pl/119/136/xml_usc15@119-136.zip"
#   old / per-release pages:       href="releasepoints/us/pl/119/102not101/xml_usc15@119-102not101.zip"
# Group 1 is the href as written (always starts "releasepoints/" after an
# optional "download/" or "/download/" prefix, captured separately in the
# normaliser below); group 2 is the release-point token, which may chain one
# or more "notNN" exclusion suffixes ("119-102not101", "119-73not1not2") or
# carry none ("120-5").
USC15_HREF_RE = re.compile(
    r'href="((?:/?download/)?releasepoints/us/pl/\d+/\d+(?:not\d+)*/xml_usc15@(\d+-\d+(?:not\d+)*)\.zip)"'
)
_RP_TOKEN_RE = re.compile(r"^(\d+)-(\d+(?:not\d+)*)$")
_CURRENT_THROUGH_RE = re.compile(r"current through (Public Law [\w\-]+ \([^)]*\))", re.I)
_PRIOR_ITEM_RE = re.compile(
    r'<a[^>]*class="releasepoint"[^>]*href="(?:download/)?([^"/]+)\.html"[^>]*>(.*?)</a>', re.S
)
_PRIOR_LABEL_RE = re.compile(r"^(Public Law [^(),]+\([^)]*\))")


def absolute_zip_url(href: str) -> str:
    """Normalise either href form to an absolute zip URL."""
    if href.startswith(("http://", "https://")):
        return href
    href = href.lstrip("/")
    if href.startswith("download/"):
        return SITE_BASE + href
    return DOWNLOAD_BASE_URL + href


def zip_url_for_token(token: str) -> str:
    m = _RP_TOKEN_RE.match(token)
    if not m:
        raise ValueError(f"unrecognised release-point token {token!r}")
    congress, rest = m.groups()
    return f"{DOWNLOAD_BASE_URL}releasepoints/us/pl/{congress}/{rest}/xml_usc15@{token}.zip"


def parse_usc_download_page(html: str) -> tuple[str, str]:
    """Extract the Title-15 USLM XML release point and its zip URL from
    OLRC's download page HTML. Returns (release_point_token, zip_url).

    Tolerates both href forms (see USC15_HREF_RE). Raises RuntimeError if zero
    or more-than-one distinct (token, url) pairs are found: loud failure beats
    silently picking the wrong one.
    """
    pairs = {(token, absolute_zip_url(href)) for href, token in USC15_HREF_RE.findall(html)}
    if not pairs:
        raise RuntimeError(
            "couldn't find a Title-15 USLM XML zip link at " + DOWNLOAD_PAGE_URL
        )
    if len(pairs) > 1:
        raise RuntimeError(
            "found multiple distinct Title-15 USLM XML zip links at "
            + DOWNLOAD_PAGE_URL + ": " + repr(sorted(pairs))
        )
    token, url = next(iter(pairs))
    return token, url


def parse_usc_release_label(html: str, token: str = "") -> str:
    """'Public Law 119-136 (October 22, 2026)' from the download page's
    'current through …' banner/description; falls back to 'Public Law <token>'."""
    m = _CURRENT_THROUGH_RE.search(_html.unescape(re.sub(r"<[^>]+>", " ", html)))
    label = " ".join(m.group(1).split()) if m else ""
    if label and token and f"Public Law {token}" not in label:
        label = ""  # banner names a different release point than the link
    return label or (f"Public Law {token}" if token else "")


def parse_prior_release_points(html: str) -> list[dict[str, str]]:
    """Release points from priorreleasepoints.html, newest first (page order):
    [{"token": "119-134", "label": "Public Law 119-134 (October 20, 2026)"}, …]."""
    out: list[dict[str, str]] = []
    for token, inner in _PRIOR_ITEM_RE.findall(html):
        if not _RP_TOKEN_RE.match(token):
            continue
        text = " ".join(_html.unescape(re.sub(r"<[^>]+>", " ", inner)).split())
        m = _PRIOR_LABEL_RE.match(text)
        out.append({"token": token, "label": m.group(1) if m else f"Public Law {token}"})
    return out


def step_down_tokens(token: str, max_steps: int = 60) -> list[str]:
    """Last-resort candidates when the prior-release-points page is unusable:
    the same congress with the release number stepped down one at a time."""
    m = _RP_TOKEN_RE.match(token)
    if not m:
        return []
    congress, rest = m.groups()
    n = int(re.match(r"\d+", rest).group(0))
    return [f"{congress}-{k}" for k in range(n - 1, max(n - 1 - max_steps, 0), -1)]


def zip_status(url: str, session) -> int:
    """HTTP status of `url`. HEAD first; if the server refuses HEAD
    (405/403/501) fall back to a streamed GET we close without reading."""
    r = session.head(url, timeout=30, allow_redirects=True)
    if r.status_code in (403, 405, 501):
        r = session.get(url, timeout=30, stream=True, allow_redirects=True)
        try:
            return r.status_code
        finally:
            r.close()
    return r.status_code


def zip_exists(url: str, session) -> bool:
    """True iff `url` is downloadable (HTTP 200)."""
    return zip_status(url, session) == 200


def resolve_usc_release(session=None) -> dict[str, str]:
    """Pick the release point to build from (see module docstring)."""
    s = session or make_session()
    r = s.get(DOWNLOAD_PAGE_URL, timeout=30)
    r.raise_for_status()
    listed_token, listed_url = parse_usc_download_page(r.text)
    listed_label = parse_usc_release_label(r.text, listed_token)
    base = {
        "usc_listed_release_point": listed_token,
        "usc_listed_zip_url": listed_url,
    }
    listed_status = zip_status(listed_url, s)
    if listed_status == 200:
        return {**base, "usc_release_point": listed_token, "usc_zip_url": listed_url,
                "usc_release_label": listed_label, "usc_release_note": ""}

    # The listed zip isn't downloadable. Walk older release points.
    candidates: list[dict[str, str]] = []
    try:
        pr = s.get(PRIOR_PAGE_URL, timeout=30)
        pr.raise_for_status()
        candidates = [c for c in parse_prior_release_points(pr.text)
                      if c["token"] != listed_token]
    except Exception as e:  # network or markup trouble: step the number down instead
        print(f"WARN: prior release points page unusable ({e}); stepping down", file=sys.stderr)
    if not candidates:
        candidates = [{"token": t, "label": f"Public Law {t}"} for t in step_down_tokens(listed_token)]
    tried: list[str] = []
    for c in candidates:
        url = zip_url_for_token(c["token"])
        if zip_exists(url, s):
            note = (
                f"OLRC lists release point {listed_token} but its Title 15 XML zip is not "
                f"downloadable (HTTP {listed_status}); built from {c['token']}, the newest prior release "
                f"point whose Title 15 zip is downloadable"
                + (f" (checked and unavailable: {', '.join(tried)})" if tried else "")
                + "."
            )
            return {**base, "usc_release_point": c["token"], "usc_zip_url": url,
                    "usc_release_label": c["label"], "usc_release_note": note}
        tried.append(c["token"])
    raise RuntimeError(
        f"no downloadable Title 15 XML zip: {listed_token} (listed) and "
        f"{len(tried)} older release points all failed"
    )


def latest_usc_release_point() -> tuple[str, str]:
    """(token, zip_url) of the newest downloadable Title-15 release point."""
    info = resolve_usc_release()
    return info["usc_release_point"], info["usc_zip_url"]


def latest_ecfr_title17_date(session=None) -> str:
    """The date to request from the eCFR versioner API: the title's
    `up_to_date_as_of` (falling back to `latest_issue_date`)."""
    s = session or make_session()
    r = s.get(ECFR_TITLES, timeout=30)
    r.raise_for_status()
    t17 = next(t for t in r.json()["titles"] if t["number"] == ECFR_TITLE)
    return t17.get("up_to_date_as_of") or t17["latest_issue_date"]


def main() -> None:
    current = {}
    if MANIFEST.exists():
        current = json.loads(MANIFEST.read_text())
    session = make_session()
    info = resolve_usc_release(session)
    latest_ecfr = latest_ecfr_title17_date(session)
    changed = (info["usc_release_point"] != current.get("usc_release_point")) or \
              (latest_ecfr != current.get("ecfr_date"))
    print(json.dumps({
        "changed": changed,
        "usc_release_point": info["usc_release_point"],
        "usc_zip_url": info["usc_zip_url"],
        "usc_release_label": info["usc_release_label"],
        "usc_release_note": info["usc_release_note"],
        "usc_listed_release_point": info["usc_listed_release_point"],
        "ecfr_date": latest_ecfr,
        "current_release_point": current.get("usc_release_point"),
        "current_ecfr_date": current.get("ecfr_date"),
    }))


if __name__ == "__main__":
    main()
