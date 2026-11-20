"""Per-corpus build config: loading, validation, and that the build
scripts actually honor config parameters (lane 1F)."""
from __future__ import annotations
import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from builder.build.corpus_config import (
    DEFAULT_CONFIG_PATH, load_config, validate_config,
)
from builder.build.build_corpus import build
from builder.build.fetch_ecfr import FetchResult, fetch_all, fetch_part, parse_part_xml
from builder.build.map_sourcecredit import original_for_section
from builder.build.parse_uslm import parse_title

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_USC = FIXTURES / "sample_section.xml"
FIXTURE_ECFR = FIXTURES / "sample_ecfr_part230.xml"


# ---------- config loading + validation ----------

def test_default_config_loads_and_validates():
    cfg = load_config()
    assert cfg["id"] == "securities"
    assert set(cfg) >= {"id", "uslm", "ecfr", "meta"}
    assert cfg["uslm"]["title"] == 15
    assert cfg["uslm"]["target_chapters"] == ["2A", "2B", "2B–1", "2D", "98"]
    assert cfg["ecfr"]["title"] == 17
    assert cfg["ecfr"]["chapter"] == "II"
    assert cfg["ecfr"]["parts"] == [210, 227, 229, 230, 232, 239, 240, 242, 243, 244, 249, 270, 275]
    # every configured part says which act it belongs to or is knowingly unmapped,
    # and every split-off act hangs off a target chapter
    assert set(cfg["ecfr"]["part_short_titles"]) == {str(p) for p in cfg["ecfr"]["parts"]}
    chapters = {f"15/{c}" for c in cfg["uslm"]["target_chapters"]}
    assert all(sp["usc_chapter"] in chapters for sp in cfg["uslm"]["split_acts"])
    act_ids = {f"act-ch{c}" for c in cfg["uslm"]["target_chapters"]} | {
        sp["id"] for sp in cfg["uslm"]["split_acts"]}
    assert set(cfg["ecfr"]["authority_map"].values()) <= act_ids
    # act order is a total order over all acts
    orders = [m["order"] for m in cfg["uslm"]["act_meta"].values()] + [
        sp["order"] for sp in cfg["uslm"]["split_acts"]]
    assert len(orders) == len(set(orders)) == len(act_ids)


def test_meta_matches_contract():
    """docs/contracts.md § 8 — exact meta object for the securities corpus."""
    assert load_config()["meta"] == {
        "id": "securities",
        "label": "Federal Securities Laws",
        "defaultTitle": "Federal Securities Laws — Statutory Supplement",
        "uscCitePrefix": "15 U.S.C.",
        "cfrCitePrefix": "17 C.F.R.",
        "modes": {"codified": "Codified (U.S.C.)", "original": "Original acts"},
    }


def test_validate_rejects_missing_group():
    cfg = copy.deepcopy(load_config())
    del cfg["ecfr"]
    with pytest.raises(ValueError, match="ecfr"):
        validate_config(cfg)


def test_validate_rejects_missing_key():
    cfg = copy.deepcopy(load_config())
    del cfg["uslm"]["target_chapters"]
    with pytest.raises(ValueError, match="target_chapters"):
        validate_config(cfg)


def test_validate_rejects_meta_id_mismatch():
    cfg = copy.deepcopy(load_config())
    cfg["meta"]["id"] = "other"
    with pytest.raises(ValueError, match="meta.id"):
        validate_config(cfg)


def test_validate_rejects_incomplete_modes():
    cfg = copy.deepcopy(load_config())
    del cfg["meta"]["modes"]["original"]
    with pytest.raises(ValueError, match="modes"):
        validate_config(cfg)


# ---------- runtime registry ----------

def test_corpora_registry_shape():
    reg = json.loads((ROOT / "builder" / "corpora.json").read_text())
    assert reg["version"] == 1
    assert reg["default"] == "securities"
    [entry] = reg["corpora"]
    assert entry == {
        "id": "securities",
        "label": "Federal Securities Laws",
        "path": "./corpus.json",
    }
    # path resolves relative to builder/
    assert (ROOT / "builder" / "corpus.json").exists()


# ---------- build_corpus emits meta ----------

def test_build_emits_meta_after_source(tmp_path):
    out = tmp_path / "corpus.json"
    build(
        usc_path=FIXTURE_USC,
        ecfr_date="2026-04-10",
        out_path=out,
        manifest_path=tmp_path / "manifest.json",
        skip_ecfr=True,
    )
    data = json.loads(out.read_text())
    assert data["meta"] == load_config()["meta"]
    assert list(data) == [
        "version", "generated_at", "source", "meta", "acts", "regulations", "presets",
    ]


def test_build_accepts_config_path(tmp_path):
    out = tmp_path / "corpus.json"
    corpus = build(
        usc_path=FIXTURE_USC,
        ecfr_date="2026-04-10",
        out_path=out,
        manifest_path=tmp_path / "manifest.json",
        skip_ecfr=True,
        config=DEFAULT_CONFIG_PATH,
    )
    assert corpus["meta"]["id"] == "securities"


def test_shipped_corpus_meta_matches_config():
    """builder/corpus.json (the shipped artifact) carries the config's meta."""
    shipped = json.loads((ROOT / "builder" / "corpus.json").read_text())
    assert shipped["meta"] == load_config()["meta"]


# ---------- parse_uslm honors config ----------

def test_parse_title_honors_config_params():
    cfg = copy.deepcopy(load_config())
    cfg["uslm"]["title"] = 98
    cfg["uslm"]["target_chapters"] = ["1"]
    cfg["uslm"]["cite_prefix"] = "98 U.S.C."
    cfg["uslm"]["act_names"] = {"98/1": "Sherman Act"}
    result = parse_title(FIXTURE_USC, config=cfg)
    assert [a["usc_chapter"] for a in result["acts"]] == ["98/1"]
    sec = result["acts"][0]["sections"][0]
    assert sec["id"] == "s-1"
    assert sec["codified"]["cite"] == "98 U.S.C. § 1"
    assert sec["original"] == {"num": "1", "cite": "Sherman Act § 1"}


def test_parse_title_default_matches_securities():
    """No config arg → securities behavior (back-compat)."""
    result = parse_title(FIXTURE_USC)
    assert {a["usc_chapter"] for a in result["acts"]} == {"15/2A"}
    sec = next(s for a in result["acts"] for s in a["sections"] if s["id"] == "s-77a")
    assert sec["codified"]["cite"] == "15 U.S.C. § 77a"


# ---------- fetch_ecfr honors config ----------

def test_parse_part_xml_honors_config_params():
    cfg = copy.deepcopy(load_config())
    cfg["ecfr"]["title"] = 99
    cfg["ecfr"]["cite_prefix"] = "99 C.F.R."
    cfg["ecfr"]["common_names"] = {"230.144": "Custom Rule 144"}
    cfg["ecfr"]["authority_map"] = {"230": "act-custom"}
    result = parse_part_xml(FIXTURE_ECFR.read_bytes(), 230, config=cfg)
    assert result["id"] == "cfr-99-p230"
    assert result["title"] == "99 CFR Part 230"
    assert result["authority_act"] == "act-custom"
    rule144 = next(r for r in result["rules"] if r["id"] == "r-230-144")
    assert rule144["cite"] == "99 C.F.R. § 230.144"
    assert rule144["common_name"] == "Custom Rule 144"


class _StubResponse:
    content = b"<DIV5 TYPE='PART'></DIV5>"

    def raise_for_status(self):
        pass


class _StubSession:
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return _StubResponse()


def test_fetch_part_builds_url_from_config():
    cfg = copy.deepcopy(load_config())
    cfg["ecfr"]["title"] = 12
    cfg["ecfr"]["chapter"] = "I"
    session = _StubSession()
    result = fetch_part(3, "2026-01-01", session=session, config=cfg)
    assert result.part_number == 3
    [(url, params)] = session.calls
    assert url.endswith("/2026-01-01/title-12.xml")
    assert params == {"chapter": "I", "part": "3"}


def test_fetch_all_uses_config_parts(monkeypatch):
    import builder.build.fetch_ecfr as fe
    fetched = []

    def fake_fetch_part(part, date, *, session=None, config=None):
        fetched.append(part)
        return FetchResult(part_number=part, xml=b"<DIV5 TYPE='PART'></DIV5>")

    monkeypatch.setattr(fe, "fetch_part", fake_fetch_part)
    cfg = copy.deepcopy(load_config())
    cfg["ecfr"]["parts"] = [111, 222]
    out = fe.fetch_all("2026-01-01", config=cfg)
    assert fetched == [111, 222]
    assert [r["id"] for r in out] == ["cfr-17-p111", "cfr-17-p222"]


# ---------- map_sourcecredit honors config ----------

def test_original_for_section_honors_custom_act_names():
    sc = "(July 2, 1890, ch. 647, § 1, 26 Stat. 209.)"
    got = original_for_section(sc, "98/1", act_names={"98/1": "Sherman Act"})
    assert got == {"num": "1", "cite": "Sherman Act § 1"}


def test_original_for_section_defaults_to_securities_config():
    sc = "(May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77.)"
    got = original_for_section(sc, "15/2A")
    assert got == {"num": "5", "cite": "Securities Act of 1933 § 5"}


# ---------- CLI back-compat ----------

def test_cli_help_shows_config_with_securities_default():
    proc = subprocess.run(
        [sys.executable, str(ROOT / "builder" / "build" / "build_corpus.py"), "--help"],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert proc.returncode == 0, proc.stderr
    assert "--config" in proc.stdout
    assert "securities.json" in proc.stdout
