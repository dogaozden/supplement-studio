"""Landing page packaging (scripts/build_site.py) and the page's own rules.

Fast, no browser: the placeholder fill, the "no raw colors / no GitHub link /
no stray placeholder" guarantees, and the assets the page points at.
"""
import importlib.util
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE = REPO_ROOT / "site"

sys.dont_write_bytecode = True  # keep scripts/__pycache__ out of the tree
spec = importlib.util.spec_from_file_location("build_site", REPO_ROOT / "scripts" / "build_site.py")
build_site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_site)

CORPUS = {
    "source": {"usc_release_point": "119-102", "usc_generated": "2026-07-23", "ecfr_date": "2026-08-06"},
    "acts": [{"sections": [{}, {}, {}]}, {"sections": [{}]}],
    "regulations": [{"rules": [{}] * 1200}],
}


def test_landing_facts_from_corpus_source():
    facts = build_site.landing_facts(CORPUS)
    assert facts["USC_RELEASE"] == "119-102"
    assert facts["ECFR_DATE"] == "August 6, 2026"
    assert facts["PROVISION_COUNT"] == "1,204"
    # same phrase as the PDF cover (builder/pdf/document.js currencyLine);
    # month and day are glued so a date never breaks across lines
    assert facts["CURRENCY"] == ("Statutes current through Public Law 119-102; "
                                 "regulations current as of August\u00a06, 2026.")
    assert "<li>" in facts["STATUTE_LIST"] and "<li>" in facts["REGULATION_LIST"]


@pytest.mark.parametrize("source", [{}, {"usc_release_point": "119-102"}, {"ecfr_date": "2026-08-06"}])
def test_landing_facts_refuses_a_corpus_without_a_currency_stamp(source):
    with pytest.raises(SystemExit):
        build_site.landing_facts({"source": source, "acts": [], "regulations": []})


def test_fill_landing_replaces_every_placeholder(tmp_path, monkeypatch):
    monkeypatch.setattr(build_site, "DEPLOY", tmp_path)
    (tmp_path / "index.html").write_text("<p>{{CURRENCY}}</p><p>{{PROVISION_COUNT}} in all</p>")
    build_site.fill_landing(build_site.landing_facts(CORPUS))
    page = (tmp_path / "index.html").read_text()
    assert "{{" not in page
    assert "Public Law 119-102" in page and "1,204 in all" in page


def test_fill_landing_rejects_an_unknown_placeholder(tmp_path, monkeypatch):
    monkeypatch.setattr(build_site, "DEPLOY", tmp_path)
    (tmp_path / "index.html").write_text("<p>{{NOT_A_THING}}</p>")
    with pytest.raises(SystemExit):
        build_site.fill_landing(build_site.landing_facts(CORPUS))


def test_every_placeholder_in_the_page_is_one_the_build_fills():
    page = (SITE / "index.html").read_text()
    used = set(re.findall(r"\{\{([A-Z_]+)\}\}", page))
    assert used, "the page should state its currency from the corpus"
    assert used <= set(build_site.landing_facts(CORPUS))


def test_page_has_no_github_link_and_no_script():
    page = (SITE / "index.html").read_text()
    assert "github.com" not in page.lower()
    assert "<script" not in page.lower()  # the landing page works, and is fast, without JS


def test_site_css_uses_tokens_not_raw_colors():
    css = (SITE / "site.css").read_text()
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert not re.findall(r"#[0-9a-fA-F]{3,8}\b", css)
    assert not re.findall(r"\b(?:rgb|rgba|hsl|hsla)\(", css)
    assert "gradient" not in css


def test_local_references_in_the_page_resolve():
    page = (SITE / "index.html").read_text()
    for ref in re.findall(r'(?:href|src)="(\./[^"#?]+)', page):
        if ref in ("./", "./app/"):
            continue
        assert (SITE / ref[2:]).exists(), f"site/index.html points at missing {ref}"


def test_hero_detail_keeps_its_stable_filename():
    # scripts/gen_samples.py renders it from the sample PDF (the top of § 77d, 2x)
    assert (SITE / "assets" / "hero-detail.png").stat().st_size > 1000
    assert "./assets/hero-detail.png" in (SITE / "index.html").read_text()


def test_only_vendored_garamond_faces_are_declared():
    fonts = SITE / "assets" / "fonts"
    css = (fonts / "fonts.css").read_text()
    files = re.findall(r'url\("\./([^"]+)"\)', css)
    assert files and all((fonts / f).exists() for f in files)
    assert set(re.findall(r'font-family:\s*"([^"]+)"', css)) == {"EB Garamond"}
