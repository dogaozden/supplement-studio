"""Facts about the shipped builder/corpus.json (the build output the app and
the PDF read). Complements verify_report.json: the report proves the text is the
official text; these pin the structure the other lanes rely on."""
import json
import re
from pathlib import Path

import pytest

from builder.build.corpus_config import load_config

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def corpus():
    return json.loads((ROOT / "builder" / "corpus.json").read_text(encoding="utf-8"))


def _walk(nodes):
    for n in nodes:
        yield n
        yield from _walk(n.get("children") or [])


def _words(rule):
    n = 0
    for node in _walk(rule["content"]):
        if node.get("type") == "table":
            continue
        for k in ("num", "heading", "text"):
            v = node.get(k)
            if v:
                n += len(re.sub(r"<[^>]+>", "", v).split())
    return n


def test_currency_fields(corpus):
    src = corpus["source"]
    assert src["usc_release_label"].startswith("Public Law ")
    assert src["usc_release_point"] in src["usc_release_label"]
    manifest = json.loads((ROOT / "builder" / "build_manifest.json").read_text())
    assert manifest["usc_release_point"] == src["usc_release_point"]
    assert manifest["ecfr_date"] == src["ecfr_date"]
    assert "usc_release_note" in manifest


def test_regulations_have_curated_short_titles_and_groups(corpus):
    cfg = load_config()["ecfr"]
    for reg in corpus["regulations"]:
        assert reg["short_title"] == cfg["part_short_titles"][str(reg["part"])]
        assert reg["display_title"] and reg["part"]
        assert {g["id"] for g in reg["groups"]} >= {r["group"] for r in reg["rules"] if r["group"]}
        assert not [r for r in reg["rules"] if r["common_name"] == "" and "[Reserved]" not in r["heading"]
                    and reg["part"] not in (239, 249)]
    by_part = {r["part"]: r for r in corpus["regulations"]}
    assert by_part[229]["short_title"] == "Regulation S-K"
    assert by_part[275]["short_title"] == "Rules under the Investment Advisers Act of 1940"


def test_rules_keep_their_notes_and_tables(corpus):
    rules = {r["id"]: r for reg in corpus["regulations"] for r in reg["rules"]}
    # official word counts (P/FP text plus note headings): 6,149 / 2,702 / 2,315 before the
    # note loss was fixed; the corpus count also includes the "(a)" markers and headings
    assert 6100 <= _words(rules["r-230-144"]) <= 6300
    assert 2650 <= _words(rules["r-230-501"]) <= 2800
    assert 2300 <= _words(rules["r-230-506"]) <= 2400
    note_roles = {n.get("role") for n in _walk(rules["r-230-144"]["content"])}
    assert {"note-heading", "note"} <= note_roles
    item402 = [n for n in _walk(rules["r-229-402"]["content"]) if n.get("type") == "table"]
    assert len(item402) >= 10 and any("Summary Compensation" in n["html"] or "Salary" in n["html"] for n in item402)
    assert sum(1 for reg in corpus["regulations"] for r in reg["rules"]
               for n in _walk(r["content"]) if n.get("type") == "table") > 100


def test_table_html_only_uses_the_allowed_tags(corpus):
    allowed = {"table", "thead", "tbody", "tr", "th", "td"}
    attr_ok = re.compile(r'^<(th|td)( (colspan|rowspan)="\d+")*>$')
    for act in corpus["acts"]:
        for s in act["sections"]:
            for n in _walk(s["content"]):
                if n.get("type") == "table":
                    for tag in re.findall(r"</?[^>]+>", n["html"]):
                        name = re.match(r"</?(\w+)", tag).group(1)
                        assert name in allowed, tag
                        if name in ("th", "td") and not tag.startswith("</"):
                            assert attr_ok.match(tag), tag
    for reg in corpus["regulations"]:
        for r in reg["rules"]:
            for n in _walk(r["content"]):
                if n.get("type") == "table":
                    for tag in re.findall(r"</?[^>]+>", n["html"]):
                        name = re.match(r"</?(\w+)", tag).group(1)
                        assert name in allowed, (r["id"], tag)
                        if name in ("th", "td") and not tag.startswith("</"):
                            assert attr_ok.match(tag), (r["id"], tag)


def test_no_corrupted_headings(corpus):
    marker = re.compile("[⁰¹²³⁴-⁹]")
    for act in corpus["acts"]:
        for s in act["sections"]:
            for n in _walk(s["content"]):
                h = n.get("heading") or ""
                assert not re.search(r"So in original|See References", h), (s["id"], h)
                assert not marker.search(h), (s["id"], h)
    for reg in corpus["regulations"]:
        for r in reg["rules"]:
            n = r["cite"].split("§ ")[1]
            if re.search(r"[A-Za-z]$", n):                  # "§ 230.144A A Private resales…"
                assert not r["heading"].startswith(n[-1] + " "), r["id"]


def test_acts_split_ordered_and_attributed(corpus):
    acts = {a["id"]: a for a in corpus["acts"]}
    assert [a["order"] for a in corpus["acts"]] == sorted(a["order"] for a in corpus["acts"])
    assert acts["act-ch2A-schIII"]["short_title"] == "Trust Indenture Act of 1939"
    assert acts["act-ch2D-schII"]["short_title"] == "Investment Advisers Act of 1940"
    assert acts["act-ch2A-schII"]["short_title"] == "Corporation of Foreign Bondholders Act, 1933"
    assert acts["act-ch98"]["short_title"] == "Sarbanes-Oxley Act of 2002"
    secs = {s["id"]: s for a in corpus["acts"] for s in a["sections"]}
    assert secs["s-77aaa"]["original"]["cite"] == "Trust Indenture Act of 1939 § 301"
    assert secs["s-80b–6"]["original"]["cite"] == "Investment Advisers Act of 1940 § 206"
    assert secs["s-78u–4"]["original"]["cite"] == "Securities Exchange Act of 1934 § 21D"
    assert secs["s-7241"]["original"]["cite"] == "Sarbanes-Oxley Act of 2002 § 302"
    # no act's original numbering collides with itself
    for act in corpus["acts"]:
        nums = [s["original"]["num"] for s in act["sections"] if s["original"]]
        assert len(nums) == len(set(nums)), act["id"]


@pytest.mark.parametrize("sid", ["s-78o–1", "s-78o–2", "s-78l–1", "s-78hh–1", "s-78d–6"])
def test_sections_enacted_by_other_statutes_have_no_original_number(corpus, sid):
    # s-78o–1 is § 10 of the 1936 amending act (ch. 462), not Exchange Act § 10
    secs = {s["id"]: s for a in corpus["acts"] for s in a["sections"]}
    assert secs[sid]["original"] is None
    assert secs["s-78j"]["original"]["num"] == "10"       # the real Exchange Act § 10


def test_ids_are_unique_and_share_hash_safe(corpus):
    ids = [a["id"] for a in corpus["acts"]]
    ids += [s["id"] for a in corpus["acts"] for s in a["sections"]]
    ids += [r["id"] for r in corpus["regulations"]]
    ids += [x["id"] for r in corpus["regulations"] for x in r["rules"]]
    assert len(ids) == len(set(ids))
    assert not [i for i in ids if set(",:;~") & set(i)]


def test_curated_group_ends(corpus):
    """The eCFR never closes a flat 'Regulation' heading; the config ends
    Regulation E at § 230.610a and Regulation 13D-G at § 240.13d-102."""
    rules = {r["id"]: r for reg in corpus["regulations"] for r in reg["rules"]}
    assert rules["r-230-610a"]["group"] == "cfr-17-p230-rege"
    assert rules["r-230-701"]["group"] == ""                 # not Regulation E
    assert rules["r-240-13d-102"]["group"] == "cfr-17-p240-reg13d-g"
    for rid in ("r-240-13e-3", "r-240-13e-4", "r-240-13q-1"):
        assert rules[rid]["group"] == "", rid                # not Regulation 13D-G
    groups = {g["id"]: g for reg in corpus["regulations"] for g in reg["groups"]}
    assert "r-230-701" not in groups["cfr-17-p230-rege"]["rules"]
    assert groups["cfr-17-p240-reg13d-g"]["rules"][-1] == "r-240-13d-102"
