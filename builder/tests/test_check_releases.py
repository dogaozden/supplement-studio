import pytest
from pathlib import Path
from builder.build import check_releases as cr
from builder.build.check_releases import (
    parse_prior_release_points, parse_usc_download_page, parse_usc_release_label,
    resolve_usc_release, step_down_tokens, zip_url_for_token,
)

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "sample_download_shtml.html"          # legacy page, relative hrefs
NEW_PAGE = FIXTURES / "sample_download_page.html"          # download.html, "download/…" hrefs
PRIOR_PAGE = FIXTURES / "sample_prior_releasepoints.html"  # priorreleasepoints.html


def test_parse_download_page_with_chained_not_exclusions():
    html = FIXTURE.read_text()
    token, zip_url = parse_usc_download_page(html)
    assert token == "119-102not101"
    assert zip_url == (
        "https://uscode.house.gov/download/"
        "releasepoints/us/pl/119/102not101/xml_usc15@119-102not101.zip"
    )


def test_parse_download_page_with_clean_no_not_href():
    html = '<a href="releasepoints/us/pl/120/5/xml_usc15@120-5.zip" title="Title 15 XML">[XML]</a>'
    token, zip_url = parse_usc_download_page(html)
    assert token == "120-5"
    assert zip_url == (
        "https://uscode.house.gov/download/"
        "releasepoints/us/pl/120/5/xml_usc15@120-5.zip"
    )


def test_parse_download_page_conflicting_tokens_raises():
    html = (
        '<a href="releasepoints/us/pl/119/102not101/xml_usc15@119-102not101.zip">[XML]</a>'
        '<a href="releasepoints/us/pl/119/73/xml_usc15@119-73.zip">[XML]</a>'
    )
    with pytest.raises(RuntimeError):
        parse_usc_download_page(html)


def test_parse_download_page_no_match_raises():
    with pytest.raises(RuntimeError):
        parse_usc_download_page("<html><body>no download links here</body></html>")


# --- the current download.html (href starts "download/releasepoints/…") ---

def test_parse_current_download_page_download_prefixed_href():
    token, zip_url = parse_usc_download_page(NEW_PAGE.read_text())
    assert token == "119-136"
    assert zip_url == (
        "https://uscode.house.gov/download/"
        "releasepoints/us/pl/119/136/xml_usc15@119-136.zip"
    )


def test_parse_download_page_root_relative_href():
    html = '<a href="/download/releasepoints/us/pl/119/136/xml_usc15@119-136.zip">[XML]</a>'
    _, zip_url = parse_usc_download_page(html)
    assert zip_url == (
        "https://uscode.house.gov/download/"
        "releasepoints/us/pl/119/136/xml_usc15@119-136.zip"
    )


def test_both_href_forms_for_same_release_are_one_link():
    html = (
        '<a href="download/releasepoints/us/pl/119/134/xml_usc15@119-134.zip">[XML]</a>'
        '<a href="releasepoints/us/pl/119/134/xml_usc15@119-134.zip">[XML]</a>'
    )
    token, _ = parse_usc_download_page(html)
    assert token == "119-134"


def test_other_titles_and_formats_are_ignored():
    html = NEW_PAGE.read_text()
    assert "xml_usc14@119-136.zip" in html and "htm_usc15@119-136.zip" in html
    token, _ = parse_usc_download_page(html)
    assert token == "119-136"


def test_release_label_from_download_page():
    assert parse_usc_release_label(NEW_PAGE.read_text(), "119-136") == \
        "Public Law 119-136 (October 22, 2026)"


def test_release_label_falls_back_to_token():
    assert parse_usc_release_label("<html></html>", "119-5") == "Public Law 119-5"
    # a banner naming a different release point than the link is not trusted
    assert parse_usc_release_label(NEW_PAGE.read_text(), "119-134") == "Public Law 119-134"


# --- prior release points ---

def test_parse_prior_release_points_newest_first():
    rps = parse_prior_release_points(PRIOR_PAGE.read_text())
    assert [r["token"] for r in rps] == [
        "119-134", "119-124", "119-121", "119-102", "119-102not101", "119-73",
    ]
    assert rps[0]["label"] == "Public Law 119-134 (October 20, 2026)"
    assert rps[4]["label"] == "Public Law 119-102not101 (July 12, 2026)"


def test_zip_url_for_token():
    assert zip_url_for_token("119-134") == (
        "https://uscode.house.gov/download/releasepoints/us/pl/119/134/xml_usc15@119-134.zip"
    )
    assert zip_url_for_token("119-102not101") == (
        "https://uscode.house.gov/download/releasepoints/us/pl/119/102not101/"
        "xml_usc15@119-102not101.zip"
    )
    with pytest.raises(ValueError):
        zip_url_for_token("nonsense")


def test_step_down_tokens():
    assert step_down_tokens("119-136", max_steps=3) == ["119-135", "119-134", "119-133"]
    assert step_down_tokens("119-102not101", max_steps=2) == ["119-101", "119-100"]
    assert step_down_tokens("bad") == []


# --- resolve_usc_release (offline: fake session) ---

class _Resp:
    def __init__(self, status=200, text=""):
        self.status_code = status
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self):
        pass


class FakeSession:
    """GET serves pages by URL; HEAD serves statuses by URL (default 404)."""

    def __init__(self, pages, zips, head_status=None):
        self.pages, self.zips, self.head_status = pages, zips, head_status
        self.head_calls, self.get_calls = [], []

    def get(self, url, **kw):
        self.get_calls.append(url)
        if url in self.pages:
            return _Resp(200, self.pages[url])
        if url in self.zips:  # streamed GET fallback
            return _Resp(self.zips[url])
        return _Resp(404, "")

    def head(self, url, **kw):
        self.head_calls.append(url)
        if self.head_status is not None:
            return _Resp(self.head_status)
        return _Resp(self.zips.get(url, 404))


def _zip(token):
    return zip_url_for_token(token)


def test_resolve_uses_listed_release_when_zip_downloads():
    s = FakeSession({cr.DOWNLOAD_PAGE_URL: NEW_PAGE.read_text()}, {_zip("119-136"): 200})
    info = resolve_usc_release(s)
    assert info["usc_release_point"] == "119-136"
    assert info["usc_release_label"] == "Public Law 119-136 (October 22, 2026)"
    assert info["usc_release_note"] == ""
    assert info["usc_listed_release_point"] == "119-136"
    assert not s.get_calls[1:]  # never needed the prior-release-points page


def test_resolve_falls_back_to_newest_downloadable_prior_release():
    # the real situation on 2026-11-01: 119-136 listed but 404; 119-134 fine
    s = FakeSession(
        {cr.DOWNLOAD_PAGE_URL: NEW_PAGE.read_text(), cr.PRIOR_PAGE_URL: PRIOR_PAGE.read_text()},
        {_zip("119-134"): 200, _zip("119-124"): 200},
    )
    info = resolve_usc_release(s)
    assert info["usc_release_point"] == "119-134"
    assert info["usc_zip_url"] == _zip("119-134")
    assert info["usc_release_label"] == "Public Law 119-134 (October 20, 2026)"
    assert info["usc_listed_release_point"] == "119-136"
    note = info["usc_release_note"]
    assert "119-136" in note and "119-134" in note and "404" in note


def test_resolve_skips_unavailable_prior_points_and_records_them():
    s = FakeSession(
        {cr.DOWNLOAD_PAGE_URL: NEW_PAGE.read_text(), cr.PRIOR_PAGE_URL: PRIOR_PAGE.read_text()},
        {_zip("119-121"): 200},
    )
    info = resolve_usc_release(s)
    assert info["usc_release_point"] == "119-121"
    assert "119-134" in info["usc_release_note"] and "119-124" in info["usc_release_note"]


def test_resolve_steps_down_when_prior_page_is_unusable():
    s = FakeSession({cr.DOWNLOAD_PAGE_URL: NEW_PAGE.read_text()}, {_zip("119-134"): 200})
    info = resolve_usc_release(s)  # prior page 404s -> step the number down
    assert info["usc_release_point"] == "119-134"
    assert info["usc_release_label"] == "Public Law 119-134"
    assert "119-135" in info["usc_release_note"]


def test_resolve_raises_when_nothing_downloads():
    s = FakeSession(
        {cr.DOWNLOAD_PAGE_URL: NEW_PAGE.read_text(), cr.PRIOR_PAGE_URL: PRIOR_PAGE.read_text()},
        {},
    )
    with pytest.raises(RuntimeError, match="no downloadable"):
        resolve_usc_release(s)


def test_zip_status_falls_back_to_get_when_head_refused():
    s = FakeSession({}, {_zip("119-134"): 200}, head_status=405)
    assert cr.zip_exists(_zip("119-134"), s) is True
    assert cr.zip_exists(_zip("119-135"), s) is False
    assert s.get_calls  # fell back to a GET


def test_session_sends_gzip_accept_encoding():
    # eCFR's versioner API now REQUIRES Accept-Encoding: gzip
    from builder.build.net import make_session
    assert "gzip" in make_session().headers["Accept-Encoding"]
