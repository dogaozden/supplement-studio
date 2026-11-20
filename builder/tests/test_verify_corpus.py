"""verify_corpus: the independent word-for-word check of corpus.json against the
source XML, plus the committed report that proves the shipped corpus passed it."""
import copy
import json
import shutil
from pathlib import Path

import pytest

from builder.build import verify_corpus as vc
from builder.build.build_corpus import build
from builder.build.corpus_config import load_config
from builder.build.fetch_ecfr import cache_path, parse_part_xml

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"
USC_FIXTURE = FIXTURES / "sample_footnotes.xml"
ECFR_FIXTURE = FIXTURES / "sample_ecfr_notes.xml"


def _cfg():
    cfg = copy.deepcopy(load_config())
    cfg["uslm"]["split_acts"] = []
    return cfg


def _usc_corpus(tmp_path):
    out = tmp_path / "corpus.json"
    build(usc_path=USC_FIXTURE, ecfr_date="2026-10-29", out_path=out,
          manifest_path=tmp_path / "m.json", skip_ecfr=True, config=_cfg())
    return json.loads(out.read_text())


def _walk(nodes):
    for n in nodes:
        yield n
        yield from _walk(n.get("children") or [])


# ---------------------------------------------------------------- statutes
def test_statute_fixture_verifies_exactly(tmp_path):
    corpus = _usc_corpus(tmp_path)
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert report["mismatches"] == []
    assert report["checked"] == report["exact"] == 2
    assert report["usc_release_point"] == "119-134"


def test_dropped_text_is_caught(tmp_path):
    corpus = _usc_corpus(tmp_path)
    sec = corpus["acts"][0]["sections"][0]
    victim = next(n for n in _walk(sec["content"]) if n.get("num") == "81")
    victim["text"] = victim["text"].replace("Determined in accordance with ", "")
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert [m["id"] for m in report["mismatches"]] == ["s-78c"]
    assert report["mismatches"][0]["ratio"] < 1
    assert "Determined" in report["mismatches"][0]["first_diff"]["source"]


def test_dropped_footnote_and_corrupted_heading_are_caught(tmp_path):
    corpus = _usc_corpus(tmp_path)
    sec = corpus["acts"][0]["sections"][0]
    for n in _walk(sec["content"]):
        n["children"] = [c for c in n.get("children", []) if c.get("role") != "footnote"] \
            if n.get("children") else n.get("children")
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert [m["id"] for m in report["mismatches"]] == ["s-78c"]
    assert "footnotes" in report["mismatches"][0]["first_diff"]["corpus"]

    corpus = _usc_corpus(tmp_path)
    corpus["acts"][0]["sections"][0]["heading"] = "7 So in original. Definitions"
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert [m["id"] for m in report["mismatches"]] == ["s-78c"]


def test_missing_and_extra_sections_are_caught(tmp_path):
    corpus = _usc_corpus(tmp_path)
    removed = corpus["acts"][0]["sections"].pop()          # s-78d vanishes from the corpus
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert [m["id"] for m in report["mismatches"]] == [removed["id"]]
    corpus = _usc_corpus(tmp_path)
    ghost = copy.deepcopy(corpus["acts"][0]["sections"][0])
    ghost["id"] = "s-99999"
    corpus["acts"][0]["sections"].append(ghost)
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())
    assert "s-99999" in [m["id"] for m in report["mismatches"]]


def test_release_point_must_match_the_xml(tmp_path):
    corpus = _usc_corpus(tmp_path)
    corpus["source"]["usc_release_point"] = "119-102"
    with pytest.raises(SystemExit, match="release point"):
        vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=tmp_path, config=_cfg())


# ------------------------------------------------------------------- eCFR
def _ecfr_corpus(tmp_path):
    cache = tmp_path / "cache"
    cfg = load_config()
    cpath = cache_path(cache, cfg["ecfr"]["title"], cfg["ecfr"]["chapter"], "2026-10-29", 230)
    cpath.parent.mkdir(parents=True)
    shutil.copy(ECFR_FIXTURE, cpath)
    part = parse_part_xml(ECFR_FIXTURE.read_bytes(), 230)
    corpus = {"source": {"usc_release_point": "119-134", "ecfr_date": "2026-10-29"},
              "acts": [], "regulations": [part], "generated_at": "x"}
    cfg = copy.deepcopy(cfg)
    cfg["uslm"]["target_chapters"] = []                   # no statutes in this check
    return corpus, cache, cfg


def test_ecfr_part_with_notes_tables_and_footnotes_verifies_exactly(tmp_path):
    corpus, cache, cfg = _ecfr_corpus(tmp_path)
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    assert report["mismatches"] == []
    assert report["checked"] == len(corpus["regulations"][0]["rules"])
    # the one residual: "(g)-(h) [Reserved]" reads "(g) -(h)" because a marker is
    # always followed by a space when rendered; same characters, different spacing
    assert [(w["id"]) for w in report["whitespace_only_detail"]] == ["r-230-144A"]
    assert "(g) -(h)" in report["whitespace_only_detail"][0]["first_diff"]["corpus"]
    assert report["exact"] == report["checked"] - 1
    assert report["image_placeholders_in"] == ["r-230-144A"]


def test_old_parser_behaviour_would_have_been_caught(tmp_path):
    # simulate the old eCFR parser: no notes, no tables
    corpus, cache, cfg = _ecfr_corpus(tmp_path)
    rule = next(r for r in corpus["regulations"][0]["rules"] if r["id"] == "r-230-144A")
    def strip(nodes):
        keep = [n for n in nodes if n.get("role") not in ("note", "note-heading") and n.get("type") != "table"]
        for n in keep:
            if n.get("children"):
                n["children"] = strip(n["children"])
        return keep
    rule["content"] = strip(rule["content"])
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    assert [m["id"] for m in report["mismatches"]] == ["r-230-144A"]
    assert report["mismatches"][0]["ratio"] < 1


def test_stray_suffix_letter_in_heading_is_caught(tmp_path):
    corpus, cache, cfg = _ecfr_corpus(tmp_path)
    rule = next(r for r in corpus["regulations"][0]["rules"] if r["id"] == "r-230-144A")
    rule["heading"] = "A " + rule["heading"]          # the audit's "§ 230.144A A Private resales"
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    assert [m["id"] for m in report["mismatches"]] == ["r-230-144A"]
    assert "heading" in report["mismatches"][0]["first_diff"]["corpus"]


def test_whitespace_only_difference_is_reported_but_not_a_failure(tmp_path):
    corpus, cache, cfg = _ecfr_corpus(tmp_path)
    rule = next(r for r in corpus["regulations"][0]["rules"] if r["id"] == "r-230-145")
    node = rule["content"][0]
    node["text"] = node["text"].replace("Text.", "Te xt.")
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    # "Te xt." vs "Text." has identical characters once spaces go -> whitespace-only
    assert report["mismatches"] == []
    # r-230-144A's "(g)-(h)" spacing residual is already there; r-230-145 joins it
    assert [w["id"] for w in report["whitespace_only_detail"]] == ["r-230-144A", "r-230-145"]


def _levels_corpus(tmp_path):
    cache = tmp_path / "cache"
    cfg = load_config()
    cpath = cache_path(cache, cfg["ecfr"]["title"], cfg["ecfr"]["chapter"], "2026-10-29", 230)
    cpath.parent.mkdir(parents=True)
    levels = FIXTURES / "sample_ecfr_levels.xml"
    shutil.copy(levels, cpath)
    corpus = {"source": {"usc_release_point": "119-134", "ecfr_date": "2026-10-29"},
              "acts": [], "regulations": [parse_part_xml(levels.read_bytes(), 230)],
              "generated_at": "x"}
    cfg = copy.deepcopy(cfg)
    cfg["uslm"]["target_chapters"] = []
    return corpus, cache, cfg


def test_heading_ended_by_a_dash_verifies_and_is_counted(tmp_path):
    # "(c) <I>Margin requirements</I>—(1) <I>Dealers</I>—(i) …" is stored as heading +
    # nested child; the em dash reads as the heading's period, and only there:
    # the "Conditions—(1)" lead-in and the unmarked "Trading facility—(1)" paragraph
    # keep their dashes and must still match character for character.
    corpus, cache, cfg = _levels_corpus(tmp_path)
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    assert report["mismatches"] == []
    # (c)—(1), (1)—(i), (d)—(1), (e) …General—(1); the bare dash joining two
    # italic runs ("Smaller reporting companies—General") is not a terminator
    assert report["heading_dash"] == 4


def test_a_dash_the_parser_did_not_turn_into_a_heading_is_caught(tmp_path):
    corpus, cache, cfg = _levels_corpus(tmp_path)
    rule = next(r for r in corpus["regulations"][0]["rules"] if r["id"] == "r-230-137")
    rule["content"][1]["text"] = rule["content"][1]["text"].replace("—", ". ")   # "Trading facility. (1) …"
    report = vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)
    assert [m["id"] for m in report["mismatches"]] == ["r-230-137"]


def test_missing_cache_without_fetch_fails_clearly(tmp_path):
    corpus, cache, cfg = _ecfr_corpus(tmp_path)
    shutil.rmtree(cache)
    with pytest.raises(FileNotFoundError, match="not cached"):
        vc.verify(corpus, usc_path=USC_FIXTURE, cache_dir=cache, config=cfg, fetch_missing=False)


# ------------------------------------------------------------ pure helpers
def test_flatten_matches_what_a_reader_sees():
    nodes = [
        {"type": "subsection", "num": "a", "heading": "Definitions",
         "text": 'See <a class="xref" data-to="s-77d">section 77d</a>¹ now.',
         "children": [
             {"type": "p", "role": "footnote", "text": "¹ Note body."},
             {"type": "p", "role": "omitted", "text": "[Image omitted.]"},
             {"type": "table", "html": "<table><tbody><tr><td>A &amp; B²</td><td>C</td></tr></tbody></table>"},
         ]},
    ]
    assert vc.flatten(nodes, "usc") == ["(a)", "Definitions", "See", "section", "77d", "now.", "A", "&", "B", "C"]
    # CFR: the heading regains the period the parser moved out; footnotes count
    assert vc.flatten(nodes, "cfr") == [
        "(a)", "Definitions.", "See", "section", "77d", "now.", "Note", "body.", "A", "&", "B", "C"]


def test_compare_categories():
    assert vc._compare(["a", "b"], ["a", "b"]) == ("exact", None)
    status, info = vc._compare(["a", "bc"], ["a", "b", "c"])
    assert status == "whitespace_only" and info["ratio"] == 1.0
    status, info = vc._compare(["a", "b"], ["a", "c"])
    assert status == "mismatch" and info["first_diff"]["corpus"] and 0 < info["ratio"] < 1


def test_canon_splits_marker_chains():
    assert vc._canon("(a)(1)(i) text") == ["(a)", "(1)", "(i)", "text"]


def test_heading_problem():
    head = ["§", "230.144A", "Private", "resales."]
    assert vc.heading_problem("Private resales.", head) == ""
    assert vc.heading_problem("A Private resales.", head) != ""
    assert vc.heading_problem("[Reserved]", ["§§", "230.445-230.447", "[Reserved]"]) == ""


# --------------------------------------------------- the committed proof
def test_committed_verify_report_matches_the_committed_corpus():
    """builder/verify_report.json must be the report of exactly this corpus:
    same release point, same eCFR date, same build, every provision checked,
    nothing mismatched. Regenerate with `python -m builder.build.verify_corpus`
    after any corpus rebuild."""
    corpus = json.loads((ROOT / "builder" / "corpus.json").read_text(encoding="utf-8"))
    report = json.loads((ROOT / "builder" / "verify_report.json").read_text(encoding="utf-8"))
    assert report["usc_release_point"] == corpus["source"]["usc_release_point"]
    assert report["ecfr_date"] == corpus["source"]["ecfr_date"]
    assert report["corpus_generated_at"] == corpus["generated_at"]
    provisions = (sum(len(a["sections"]) for a in corpus["acts"])
                  + sum(len(r["rules"]) for r in corpus["regulations"]))
    assert report["checked"] == provisions
    assert report["mismatches"] == []
    assert report["exact"] + report["whitespace_only"] == report["checked"]
    # whitespace-only residuals are allowed but must each be explained by a diff
    assert all(w.get("first_diff") for w in report["whitespace_only_detail"])
    assert report["method"]
