"""What an eCFR rule keeps (notes, instructions, headings, footnotes, tables),
how it nests, how rules are grouped and named. Fixture shapes are hand-trimmed
from live eCFR XML (see fixtures/sample_ecfr_notes.xml)."""
from pathlib import Path

import pytest

from builder.build import fetch_ecfr as fe
from builder.build.fetch_ecfr import parse_part_xml

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ecfr_notes.xml"


@pytest.fixture(scope="module")
def part():
    return parse_part_xml(FIXTURE.read_bytes(), 230)


@pytest.fixture(scope="module")
def r144a(part):
    return next(r for r in part["rules"] if r["id"] == "r-230-144A")


def _walk(nodes):
    for n in nodes:
        yield n
        yield from _walk(n.get("children") or [])


def _find(nodes, **kw):
    return next(n for n in _walk(nodes) if all(n.get(k) == v for k, v in kw.items()))


def _shape(nodes):
    """(type, num, role) tree, for nesting assertions."""
    return [(n["type"], n.get("num"), n.get("role"), _shape(n.get("children") or [])) for n in nodes]


# ---------------------------------------------------------------- notes
def test_preliminary_notes_come_first_at_root_level(r144a):
    first = r144a["content"][:3]
    assert [(n["role"], n["text"][:20]) for n in first] == [
        ("note-heading", "Preliminary Notes:"),
        ("note", "1. This section rela"),
        ("note", "2. Attempted complia"),
    ]


def test_plain_note_attaches_to_the_paragraph_it_follows(r144a):
    sub_a = _find(r144a["content"], type="subparagraph", num="A")
    assert [n["role"] for n in sub_a["children"]] == ["note-heading", "note"]
    assert sub_a["children"][0]["text"] == "Note:"
    assert sub_a["children"][1]["text"].startswith("A purchase by an insurance company")


def test_targeted_note_attaches_to_the_paragraph_it_names(r144a):
    # "Note 1 to paragraph (a)(1)(i):" sits after (B) but belongs to clause (i)
    clause_i = _find(r144a["content"], type="clause", num="i")
    kids = [(c["type"], c.get("num")) for c in clause_i["children"]]
    assert kids == [("subparagraph", "A"), ("subparagraph", "B"), ("p", None), ("p", None)]
    assert clause_i["children"][2]["text"] == "Note 1 to paragraph (a)(1)(i):"
    # "Note to paragraph (d)(1):" after (d)(1)(i) belongs to (d)(1), not to (i)
    d1 = _find(r144a["content"], type="paragraph", num="1", text="First.")
    assert [c.get("role") for c in d1["children"]] == [None, "note-heading", "note"]
    assert d1["children"][1]["text"] == "Note to paragraph (d)(1):"


def test_a_note_never_resets_the_nesting_stack(r144a):
    # (2) after the (d)(1) note is still a paragraph under (d); (ii) after the
    # (A) note is still a clause under (a)(1) (it would be a lowercase-letter
    # "subsection" if the note had cleared the stack)
    sub_d = _find(r144a["content"], type="subsection", num="d")
    assert [c.get("num") for c in sub_d["children"]] == ["1", "2"]
    para1 = _find(r144a["content"], type="paragraph", num="1", heading="")
    clauses = [c for c in para1["children"] if c["type"] == "clause"]
    assert [c["num"] for c in clauses] == ["i", "ii"]


def test_whole_rule_note_goes_to_root_level(r144a):
    tail = r144a["content"][-2:]
    assert [n["role"] for n in tail] == ["note-heading", "note"]
    assert "Note to" in tail[0]["text"]
    assert tail[1]["text"] == "A note to the whole rule goes to root level."


def test_extract_with_a_targeted_lead_attaches_to_that_paragraph(r144a):
    para1 = _find(r144a["content"], type="paragraph", num="1", heading="")
    tail = [(c["type"], c.get("role"), c.get("num")) for c in para1["children"]][-2:]
    assert tail == [("p", "note", None), ("paragraph", None, "1")]  # local nest: its own (1)
    # the extract's own (1) did not get nested under the rule's (a)(1)(ii) etc.
    assert para1["children"][-1]["text"] == "Inside the extract, markers nest locally."


def test_editorial_note_and_source_citation_are_not_rule_text(r144a):
    flat = " ".join(n.get("text") or "" for n in _walk(r144a["content"]))
    assert "List of CFR Sections Affected" not in flat
    assert "55 FR 17933" not in flat


# ----------------------------------------------------- headings & run-ins
def test_italic_run_in_heading_moves_to_the_heading_field(r144a):
    a = _find(r144a["content"], type="subsection", num="a")
    assert a["heading"] == "Definitions"             # no trailing period, like USC
    assert a.get("text", "") == ""                    # nothing left on the (a) line itself
    para1 = _find(r144a["content"], type="paragraph", num="1", heading="")
    # "(a) <I>Definitions.</I> (1) For purposes of ..." -> (a) heading, then (1) nested
    assert para1["text"] == "For purposes of this section, qualified institutional buyer shall mean:"


def test_repeated_heading_and_term_in_one_italic_run_splits():
    # eCFR italicizes "Accredited investor. Accredited investor" as one run
    para2 = None
    r = parse_part_xml(FIXTURE.read_bytes(), 230)
    for rule in r["rules"]:
        for n in _walk(rule["content"]):
            if n.get("num") == "2" and n.get("heading") == "Accredited investor":
                para2 = n
    assert para2 is not None
    assert para2["text"] == "Accredited investor shall mean any person."


def test_italic_defined_term_is_not_taken_for_a_heading(r144a):
    b = _find(r144a["content"], type="subsection", num="b")
    assert b["heading"] == ""
    assert b["text"] == "Accountant, as used in this section, means a CPA."


def test_unmarked_paragraph_keeps_its_italic_lead_words(r144a):
    # readers render `heading` only for numbered containers, so an unnumbered
    # paragraph keeps "Exemption." inside its text (no word is lost)
    p = next(n for n in r144a["content"] if n["type"] == "p" and n.get("text", "").startswith("Exemption."))
    assert p["text"] == "Exemption. An unnumbered paragraph keeps its italic lead."
    assert "role" not in p


def test_parenthesized_text_is_not_a_marker(r144a):
    p = next(n for n in r144a["content"] if n.get("text") == "(Name of Issuer)")
    assert p["type"] == "p" and "num" not in p


def test_hd_subheading_is_a_heading_node_and_starts_a_new_region(r144a):
    kinds = [(n["type"], n.get("role"), n.get("num")) for n in r144a["content"]]
    i = kinds.index(("p", "heading", None))
    assert r144a["content"][i]["text"] == "Successful Efforts Method"
    assert kinds[i + 1] == ("subsection", None, "e")


# ------------------------------------------------------------- footnotes
def test_footnote_marker_and_body(r144a):
    c = _find(r144a["content"], type="subsection", num="c")
    assert c["heading"] == "Conditions"
    assert c["text"] == "¹ The following conditions apply."
    assert c["children"] == [{
        "type": "p", "role": "footnote",
        "text": "¹ Paragraph (c) reflects proposals made in Release No. 6334.",
    }]


# ---------------------------------------------------------------- tables
def test_table_is_sanitized_with_spans_caption_and_escaping(r144a):
    g = _find(r144a["content"], type="subsection", num="g")
    caption, table = g["children"][0], g["children"][1]
    assert caption == {"type": "p", "text": "Fee Table", "role": "heading"}
    assert table["type"] == "table"
    assert table["html"] == (
        '<table><thead><tr><th rowspan="2">Name (#)</th>'
        '<th colspan="2">Amount &amp; rate¹</th></tr></thead>'
        '<tbody><tr><td>A &lt; B</td><td></td><td>3%</td></tr>'
        '<tr><td colspan="3">Total</td></tr></tbody></table>'
    )


def test_images_leave_a_visible_placeholder_not_a_silent_gap(r144a):
    g = _find(r144a["content"], type="subsection", num="g")
    assert g["children"][2] == {
        "type": "p", "role": "omitted", "text": "[Image omitted. See the official text at ecfr.gov.]"}


def test_unknown_tags_are_kept_as_paragraphs_and_reported():
    xml = (b'<DIV5 N="230" TYPE="PART"><HEAD>PART 230\xe2\x80\x94X</HEAD>'
           b'<DIV8 N="230.1" TYPE="SECTION"><HEAD>\xc2\xa7 230.1 T.</HEAD>'
           b'<WEIRD>kept anyway</WEIRD></DIV8></DIV5>')
    fe.UNKNOWN_TAGS.clear()
    rule = parse_part_xml(xml, 230)["rules"][0]
    assert rule["content"] == [{"type": "p", "text": "kept anyway"}]
    assert "WEIRD" in fe.UNKNOWN_TAGS


# ------------------------------------------------ headings of rules/stray letter
def test_rule_heading_keeps_its_suffix_letter_out_of_the_subject(part):
    # "§ 230.144A Private resales…" used to become "A Private resales…"
    r = next(r for r in part["rules"] if r["id"] == "r-230-144A")
    assert r["heading"] == "Private resales of securities to institutions."
    assert r["cite"] == "17 C.F.R. § 230.144A"


def test_reserved_range_heading(part):
    r = next(r for r in part["rules"] if r["id"] == "r-230-300-230.346")
    assert r["heading"] == "[Reserved]"          # not ".346 [Reserved]"
    assert (r["common_name"], r["short_name"]) == ("", "")


# ---------------------------------------------------------------- groups
def test_groups_flat_regulation_headings_nested_groups_and_empty_parent(part):
    by_id = {g["id"]: g for g in part["groups"]}
    assert by_id["cfr-17-p230-general"]["rules"] == ["r-230-144A", "r-230-145", "r-230-300-230.346"]
    assert by_id["cfr-17-p230-rega"]["short"] == "Regulation A"
    # HED1 "Regulation C—Registration" owns the direct section 230.400 and
    # folds in the "general requirements" DIV7 that follows it as a sub-group
    regc = by_id["cfr-17-p230-regc"]
    assert regc["label"] == "Regulation C—Registration" and regc["short"] == "Regulation C"
    assert regc["rules"] == ["r-230-400", "r-230-401"] and regc["parent"] == ""
    sub = by_id["cfr-17-p230-regc-general-requirements"]
    assert sub["label"] == "General Requirements"       # title-cased from "general requirements"
    assert sub["parent"] == "cfr-17-p230-regc" and sub["rules"] == ["r-230-401"]
    assert by_id["cfr-17-p230-regd"]["short"] == "Regulation D"
    assert by_id["cfr-17-p230-regd"]["rules"] == ["r-230-501", "r-230-506"]
    # an empty DIV7 heading owns the sibling sections that follow it
    assert by_id["cfr-17-p230-regs"]["rules"] == ["r-230-901"]


def test_rule_group_is_the_most_specific_group(part):
    group = {r["id"]: r["group"] for r in part["rules"]}
    assert group["r-230-400"] == "cfr-17-p230-regc"
    assert group["r-230-401"] == "cfr-17-p230-regc-general-requirements"
    assert group["r-230-506"] == "cfr-17-p230-regd"
    assert group["r-230-144A"] == "cfr-17-p230-general"


def test_every_grouped_rule_is_listed_by_its_group_and_its_parent(part):
    by_id = {g["id"]: g for g in part["groups"]}
    for r in part["rules"]:
        if not r["group"]:
            continue
        g = by_id[r["group"]]
        while True:
            assert r["id"] in g["rules"]
            if not g["parent"]:
                break
            g = by_id[g["parent"]]


def test_part_display_title_and_number(part):
    assert part["part"] == 230
    assert part["display_title"] == "General Rules and Regulations, Securities Act of 1933"
    assert part["heading"].startswith("PART 230")        # `heading` is unchanged
    # the curated short title (config ecfr.part_short_titles) is the default part title
    assert part["short_title"] == "Rules under the Securities Act of 1933"


def test_short_title_falls_back_to_display_title_for_an_unlisted_part():
    xml = b'<DIV5 N="999" TYPE="PART"><HEAD>PART 999\xe2\x80\x94SOME NEW RULES</HEAD></DIV5>'
    part = parse_part_xml(xml, 999)
    assert part["display_title"] == "Some New Rules"
    assert part["short_title"] == "Some New Rules"


def test_group_ids_are_stable_slugs_without_share_hash_characters(part):
    for g in part["groups"]:
        assert g["id"].startswith("cfr-17-p230-")
        assert not set(",:;~") & set(g["id"])
    from builder.build.fetch_ecfr import _slug
    assert _slug("Investment Companies; Business Development Companies") == "investment-companies-business"
    assert _slug("Short") == "short"


# ----------------------------------------- Part 240-style flattened regulations
_P240 = b"""<DIV5 N="240" TYPE="PART"><HEAD>PART 240&#x2014;GENERAL RULES AND REGULATIONS, SECURITIES EXCHANGE ACT OF 1934</HEAD>
<DIV6 N="A" TYPE="SUBPART"><HEAD>Subpart A&#x2014;Rules and Regulations Under the Securities Exchange Act of 1934</HEAD>
<DIV7 N="E1" TYPE="SUBJGRP"><HEAD>Manipulative and Deceptive Devices and Contrivances</HEAD>
<DIV8 N="240.10b-5" TYPE="SECTION"><HEAD>&#xA7; 240.10b-5 Employment of manipulative and deceptive devices.</HEAD><P>Text.</P></DIV8></DIV7>
<DIV7 N="E2" TYPE="SUBJGRP"><HEAD>Regulation 12B: Registration and Reporting</HEAD></DIV7></DIV6>
<DIV7 N="E3" TYPE="SUBJGRP"><HEAD>General</HEAD>
<DIV8 N="240.12b-1" TYPE="SECTION"><HEAD>&#xA7; 240.12b-1 Scope.</HEAD><P>Text.</P></DIV8></DIV7>
<DIV7 N="E4" TYPE="SUBJGRP"><HEAD>Exhibits</HEAD>
<DIV8 N="240.12b-30" TYPE="SECTION"><HEAD>&#xA7; 240.12b-30 Additional information.</HEAD><P>Text.</P></DIV8></DIV7>
<DIV7 N="E5" TYPE="SUBJGRP"><HEAD>Certification by Exchanges</HEAD>
<DIV8 N="240.12d1-1" TYPE="SECTION"><HEAD>&#xA7; 240.12d1-1 Registration effective.</HEAD><P>Text.</P></DIV8></DIV7>
<HED1>Regulation 13A: Reports of Issuers</HED1>
<DIV7 N="E6" TYPE="SUBJGRP"><HEAD>Annual Reports</HEAD>
<DIV8 N="240.13a-1" TYPE="SECTION"><HEAD>&#xA7; 240.13a-1 Requirements of annual reports.</HEAD><P>Text.</P></DIV8></DIV7>
<DIV7 N="E7" TYPE="SUBJGRP"><HEAD>Regulation 14A: Solicitation of Proxies</HEAD>
<DIV8 N="240.14a-101" TYPE="SECTION"><HEAD>&#xA7; 240.14a-101 Schedule 14A. Information required in proxy statement.</HEAD><P>Text.</P></DIV8>
</DIV7></DIV5>"""


@pytest.fixture(scope="module")
def p240():
    return parse_part_xml(_P240, 240)


def test_empty_regulation_heading_folds_in_only_its_own_family(p240):
    by_id = {g["id"]: g for g in p240["groups"]}
    reg12b = by_id["cfr-17-p240-reg12b"]
    assert reg12b["rules"] == ["r-240-12b-1", "r-240-12b-30"]
    assert {g["label"] for g in p240["groups"] if g["parent"] == reg12b["id"]} == {"General", "Exhibits"}
    # 12d1-1 is a different family: its own top-level group, not part of Regulation 12B
    cert = next(g for g in p240["groups"] if g["label"] == "Certification by Exchanges")
    assert cert["parent"] == "" and cert["rules"] == ["r-240-12d1-1"]
    reg13a = by_id["cfr-17-p240-reg13a"]
    assert reg13a["rules"] == ["r-240-13a-1"]
    assert by_id["cfr-17-p240-reg14a"]["short"] == "Regulation 14A"


def test_single_subpart_is_not_a_group(p240):
    # Subpart A is the whole part, so it isn't a useful one-click group
    assert not [g for g in p240["groups"] if g["label"].startswith("Subpart")]


def test_names_for_rules_and_schedules(p240):
    names = {r["id"]: (r["common_name"], r["short_name"]) for r in p240["rules"]}
    assert names["r-240-10b-5"] == ("Rule 10b-5", "Rule 10b-5")
    assert names["r-240-12b-1"] == ("Rule 12b-1", "Rule 12b-1")
    assert names["r-240-14a-101"] == ("Schedule 14A", "Schedule 14A")


def test_names_per_part_style():
    from builder.build.corpus_config import load_config
    cfg = load_config()["ecfr"]
    n = fe._rule_names
    assert n("229.404", "(Item 404) Transactions with related persons.", 229, "Subpart 229.400—Management", cfg) == \
        ("Item 404 of Regulation S-K", "Item 404")
    assert n("229.1101", "(Item 1101) Definitions.", 229, "Regulation AB", cfg) == \
        ("Item 1101 of Regulation AB", "Item 1101")
    assert n("210.4-01", "Form, order, and terminology.", 210, "", cfg) == \
        ("Rule 4-01 of Regulation S-X", "Rule 4-01")
    assert n("232.405", "Interactive Data File submissions.", 232, "", cfg) == \
        ("Rule 405 of Regulation S-T", "Rule 405")
    assert n("242.200", "Definition of “short sale”.", 242, "Regulation SHO", cfg) == \
        ("Rule 200 of Regulation SHO", "Rule 200")
    assert n("242.404", "Type, form and use of margin.", 242, "", cfg) == ("Rule 404", "Rule 404")
    assert n("243.100", "General rule regarding selective disclosure.", 243, "", cfg) == \
        ("Rule 100 of Regulation FD", "Rule 100")
    assert n("244.100", "General rules regarding disclosure.", 244, "", cfg) == \
        ("Rule 100 of Regulation G", "Rule 100")
    assert n("227.100", "Crowdfunding exemption and requirements.", 227, "", cfg) == \
        ("Rule 100 of Regulation Crowdfunding", "Rule 100")
    assert n("239.11", "Form S-1, registration statement under the Securities Act of 1933.", 239, "", cfg) == \
        ("Form S-1", "Form S-1")
    assert n("249.310", "Form 10-K, for annual and transition reports.", 249, "", cfg) == \
        ("Form 10-K", "Form 10-K")
    assert n("270.2a-7", "Money market funds.", 270, "", cfg) == ("Rule 2a-7", "Rule 2a-7")
    assert n("275.206(4)-8", "Pooled investment vehicles.", 275, "", cfg) == \
        ("Rule 206(4)-8", "Rule 206(4)-8")
    assert n("230.506", "Exemption for limited offers.", 230, "Regulation D", cfg) == ("Rule 506", "Rule 506")


def test_aliases_carry_the_old_curated_nicknames():
    from builder.build.corpus_config import load_config
    import copy
    cfg = load_config()
    cfg = copy.deepcopy(cfg)
    xml = (b'<DIV5 N="230" TYPE="PART"><HEAD>PART 230\xe2\x80\x94X</HEAD>'
           b'<DIV8 N="230.506" TYPE="SECTION"><HEAD>\xc2\xa7 230.506 Exemption.</HEAD><P>t</P></DIV8></DIV5>')
    rule = parse_part_xml(xml, 230, config=cfg)["rules"][0]
    assert rule["common_name"] == "Rule 506"          # was "Rule 506 (Reg D)"
    assert rule["aliases"] == ["Reg D"]


# ------------------------------------------------------------- fetch/caching
class _Resp:
    def __init__(self, content=b"<DIV5 N='1' TYPE='PART'></DIV5>"):
        self.content = content

    def raise_for_status(self):
        pass


class _Session:
    def __init__(self):
        self.calls = 0

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        return _Resp()


def test_fetch_part_caches_raw_xml_and_rereads_it(tmp_path):
    s = _Session()
    a = fe.fetch_part(1, "2026-10-29", session=s, cache_dir=tmp_path)
    b = fe.fetch_part(1, "2026-10-29", session=s, cache_dir=tmp_path)
    assert s.calls == 1 and not a.from_cache and b.from_cache and a.xml == b.xml
    assert fe.cache_path(tmp_path, 17, "II", "2026-10-29", 1).exists()
    # the cache dir ignores itself, so nothing in it can ever be committed
    assert (tmp_path / ".gitignore").read_text().strip() == "*"


def test_fetch_all_is_fatal_when_a_part_cannot_be_fetched(monkeypatch):
    import requests

    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(fe, "fetch_part", boom)
    with pytest.raises(RuntimeError, match="part 1 fetch failed"):
        fe.fetch_all("2026-10-29", parts=[1])
