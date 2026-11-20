from pathlib import Path
from builder.build.parse_uslm import parse_title

FIXTURE = Path(__file__).parent / "fixtures" / "sample_section.xml"


def test_parse_title_returns_acts_key():
    result = parse_title(FIXTURE)
    assert "acts" in result
    assert isinstance(result["acts"], list)


def test_parse_title_extracts_section_77a_core_fields():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77a")
    assert sec["codified"] == {"num": "77a", "cite": "15 U.S.C. § 77a"}
    assert sec["heading"] == "Short title"


def test_parse_title_extracts_section_77e_has_subsection():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77e")
    assert sec["heading"] == "Prohibitions relating to interstate commerce and the mails"
    # Content block tree (tested deeper in 2.3)
    assert len(sec["content"]) >= 1


def test_parse_section_77a_simple_content():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77a")
    # One paragraph block, type=p
    assert sec["content"] == [
        {"type": "p", "text": 'This subchapter may be cited as the "Securities Act of 1933".'}
    ]


def test_parse_section_77e_nested_content():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77e")
    assert len(sec["content"]) == 1
    subs = sec["content"][0]
    assert subs["type"] == "subsection"
    assert subs["num"] == "a"
    assert subs["heading"] == "Sale or delivery after sale of unregistered securities"
    # Chapeau + 2 paragraphs
    kids = subs["children"]
    assert kids[0]["type"] == "chapeau"
    assert kids[0]["text"].startswith("Unless a registration statement")
    assert kids[1]["type"] == "paragraph"
    assert kids[1]["num"] == "1"
    assert kids[1]["text"].startswith("to make use of any means")
    assert kids[2]["num"] == "2"


def test_parse_section_77e_preserves_inline_ref_text():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77e")
    para = sec["content"][0]["children"][2]
    assert 'data-to="s-77j"' in para["text"]
    assert "section 77j of this title" in para["text"]


def test_parse_section_captures_source_credit():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec_a = next(s for s in act["sections"] if s["id"] == "s-77a")
    assert sec_a["source_credit"] == "(May 27, 1933, ch. 38, title I, \u00a7 1, 48 Stat. 74.)"
    sec_e = next(s for s in act["sections"] if s["id"] == "s-77e")
    assert sec_e["source_credit"] == "(May 27, 1933, ch. 38, title I, \u00a7 5, 48 Stat. 77.)"


def test_parse_section_captures_notes():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77a")
    assert len(sec["notes"]) == 2
    assert sec["notes"][0]["heading"] == "Statutory Notes and Related Subsidiaries"
    assert sec["notes"][0]["blocks"] == []
    assert sec["notes"][1]["heading"] == "Short Title of 2012 Amendment"
    assert sec["notes"][1]["blocks"][0]["type"] == "p"
    assert "Church Plan" in sec["notes"][1]["blocks"][0]["text"]


def test_parse_title_excludes_chapter_1():
    result = parse_title(FIXTURE)
    chapters = [a["usc_chapter"] for a in result["acts"]]
    assert "15/1" not in chapters
    # chapter 2A yields three acts (Securities Act + the split-off TIA and
    # Foreign Bondholders acts), all still from chapter 15/2A
    assert set(chapters) == {"15/2A"}


def test_parse_title_fills_original_cite_for_77e():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77e")
    assert sec["original"] == {"num": "5", "cite": "Securities Act of 1933 § 5"}


def test_parse_title_excludes_sections_nested_in_notes():
    result = parse_title(FIXTURE)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2A")
    # The nested fixture section has num=501 and a heading mentioning "PHONY"
    bogus = [s for s in act["sections"] if "PHONY" in s["heading"]]
    assert not bogus, f"nested note-section leaked into corpus: {bogus}"
    # Real sections still present
    ids = [s["id"] for s in act["sections"]]
    assert "s-77a" in ids
    assert "s-77e" in ids


# --- acts split out of a chapter by subchapter (config uslm.split_acts) -----

def test_trust_indenture_and_foreign_bondholders_are_their_own_acts():
    result = parse_title(FIXTURE)
    acts = {a["id"]: a for a in result["acts"]}
    # ordered by config `order` (1, 6, 8); the chapter's own act keeps its id
    assert [a["id"] for a in result["acts"]] == ["act-ch2A", "act-ch2A-schIII", "act-ch2A-schII"]
    main, tia, cfba = acts["act-ch2A"], acts["act-ch2A-schIII"], acts["act-ch2A-schII"]
    assert [s["id"] for s in main["sections"]] == ["s-77a", "s-77e"]
    assert [s["id"] for s in tia["sections"]] == ["s-77aaa"]
    assert tia["short_title"] == "Trust Indenture Act of 1939"
    assert tia["usc_chapter"] == "15/2A" and tia["usc_subchapter"] == "schIII"
    assert tia["sections"][0]["original"] == {"num": "301", "cite": "Trust Indenture Act of 1939 § 301"}
    assert cfba["sections"][0]["original"] == {
        "num": "212", "cite": "Corporation of Foreign Bondholders Act, 1933 § 212"}
    # the printed original cite no longer says "Securities Act of 1933 § 301"
    assert "Securities Act" not in tia["sections"][0]["original"]["cite"]


def test_act_metadata_order_short_name_and_usc_range():
    result = parse_title(FIXTURE)
    main = result["acts"][0]
    assert main["original_name_short"] == "Securities Act"
    assert main["order"] == 1
    assert main["usc_range"] == "15 U.S.C. §§ 77a–77e"
    tia = next(a for a in result["acts"] if a["id"] == "act-ch2A-schIII")
    assert tia["original_name_short"] == "Trust Indenture Act"
    assert tia["usc_range"] == "15 U.S.C. § 77aaa"  # a single section


def test_usc_range_uses_to_when_an_endpoint_has_a_dash():
    from builder.build.parse_uslm import _usc_range
    secs = [{"codified": {"num": "80b–1"}}, {"codified": {"num": "80b–21"}}]
    assert _usc_range("15 U.S.C.", secs) == "15 U.S.C. §§ 80b–1 to 80b–21"


def _cfg_without_splits():
    import copy
    from builder.build.corpus_config import load_config
    cfg = copy.deepcopy(load_config())
    cfg["uslm"]["split_acts"] = []
    return cfg


def test_divisions_partition_an_act_that_has_subchapters():
    # keep all three subchapters in one act
    result = parse_title(FIXTURE, _cfg_without_splits())
    act = next(a for a in result["acts"] if a["id"] == "act-ch2A")
    assert [d["id"] for d in act["divisions"]] == ["act-ch2A-schI", "act-ch2A-schII", "act-ch2A-schIII"]
    assert [d["label"] for d in act["divisions"]] == [
        "Subchapter I—Domestic Securities",
        "Subchapter II—Foreign Securities",
        "Subchapter III—Trust Indentures",
    ]
    assert [d["sections"] for d in act["divisions"]] == [["s-77a", "s-77e"], ["s-77mm"], ["s-77aaa"]]
    in_divisions = [sid for d in act["divisions"] for sid in d["sections"]]
    assert in_divisions == [s["id"] for s in act["sections"]]


def test_single_subchapter_act_has_no_divisions():
    result = parse_title(FIXTURE)
    assert "divisions" not in result["acts"][0]


def test_split_of_a_missing_subchapter_fails_loudly():
    import pytest
    cfg = _cfg_without_splits()
    cfg["uslm"]["split_acts"] = [{
        "id": "act-x", "usc_chapter": "15/2A", "subchapter": "schXX", "short_title": "X Act"}]
    with pytest.raises(ValueError, match="schXX"):
        parse_title(FIXTURE, cfg)
