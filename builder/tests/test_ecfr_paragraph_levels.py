"""The six C.F.R. paragraph levels: (a) / (1) / (i) / (A) / italic (1) / italic (i).

eCFR marks the last two with italics ("(<I>1</I>)", "<I>(1)</I>"), and that is the
only thing that tells a fifth-level "(1)" from a second-level one. A parser that
drops the italics before reading markers loses the nesting after every (A): the
items fall to root level as unmarked paragraphs and the next (B) lands there too
(1,025 such paragraphs in 108 rules before the fix; § 230.135 is the small case).

Fixture: fixtures/sample_ecfr_levels.xml, trimmed from live eCFR XML."""
from pathlib import Path

import pytest

from builder.build.fetch_ecfr import parse_part_xml

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ecfr_levels.xml"


@pytest.fixture(scope="module")
def rules():
    part = parse_part_xml(FIXTURE.read_bytes(), 230)
    return {r["id"]: r["content"] for r in part["rules"]}


def _outline(nodes):
    """[(num, [children outline])] — nesting only."""
    return [(n.get("num"), _outline(n.get("children") or [])) for n in nodes]


def _find(nodes, *path):
    """The node at a path of nums, e.g. _find(content, "d", "2", "i", "A")."""
    node = None
    for num in path:
        node = next(n for n in nodes if n.get("num") == num)
        nodes = node.get("children") or []
    return node


def test_italic_items_nest_under_their_subparagraph(rules):
    # § 230.135: (a)(2)(viii)(A) "Rights offering" is followed by italic items
    # (1), (2); then (B) is a sibling of (A) — not a root-level subparagraph
    assert _outline(rules["r-230-135"]) == [
        ("a", [("2", [("vii", []), ("viii", [
            ("A", [("1", []), ("2", [])]),
            ("B", [("1", []), ("2", [])]),
        ])])]),
        ("b", []),
    ]
    a = _find(rules["r-230-135"], "a", "2", "viii", "A")
    assert a["heading"] == "Rights offering"
    assert _find(rules["r-230-135"], "a", "2", "viii", "A", "1")["text"] == \
        "The class of security holders eligible to subscribe;"


def test_no_marker_paragraph_is_left_at_root_level(rules):
    for rid in ("r-230-135", "r-230-136"):
        for n in rules[rid]:
            assert n["type"] != "p", f"{rid}: root-level paragraph {n['text'][:40]!r}"


def test_all_three_italic_spellings_make_the_same_levels(rules):
    c = rules["r-230-136"]
    # "(A)(<I>1</I>)": two markers on one line, the second italic
    a = _find(c, "c", "1", "ii", "A")
    assert a.get("text", "") == ""
    assert [(n["num"], n["type"]) for n in a["children"]] == [("1", "item"), ("2", "item")]
    # "(<I>2)</I>": the source slipped the closing paren into the italics
    assert _find(c, "c", "1", "ii", "A", "2")["text"] == "Deliver collateral equal to the current exposure."
    # "<I>(1)</I>": the whole marker is italic
    assert _find(c, "d", "2", "i", "A", "1")["text"] == "An entity under audit, or"


def test_sixth_and_seventh_levels_nest_by_italic_enumerators(rules):
    c = rules["r-230-136"]
    two = _find(c, "d", "2", "i", "A", "2")
    assert [(n["num"], n["type"]) for n in two["children"]] == [("i", "item"), ("ii", "item")]
    assert [n["num"] for n in _find(c, "d", "2", "i", "A", "2", "ii")["children"]] == ["A", "B"]


def test_plain_digit_after_italic_items_returns_to_the_second_level(rules):
    # "(B)" pops back to (A)'s level, and "(3)" — the number after the open
    # second-level "(2)" — is that list's next paragraph, not an item of (B)
    d = _find(rules["r-230-136"], "d")
    assert [n["num"] for n in d["children"]] == ["1", "2", "3"]
    assert [n["num"] for n in _find(rules["r-230-136"], "d", "2", "i")["children"]] == ["A", "B"]


def test_heading_ended_by_a_dash_splits_into_heading_and_child(rules):
    # "(c) <I>Margin requirements</I>—(1) <I>Dealers</I>—(i) <I>Calculation required.</I> …"
    c = _find(rules["r-230-136"], "c")
    assert (c["heading"], c.get("text", "")) == ("Margin requirements", "")
    one = _find(rules["r-230-136"], "c", "1")
    assert (one["heading"], one.get("text", "")) == ("Dealers", "")
    i = _find(rules["r-230-136"], "c", "1", "i")
    assert (i["heading"], i["text"]) == ("Calculation required", "A dealer must calculate:")
    # the dash is the heading's terminator: it is gone from the text
    flat = repr(rules["r-230-136"])
    assert "—(" not in flat
    d1 = _find(rules["r-230-136"], "d", "1")
    assert (d1["heading"], d1["text"]) == ("General", "The servicer shall comply.")


def test_italic_runs_joined_by_a_dash_are_one_heading(rules):
    e = _find(rules["r-230-136"], "e")
    assert e["heading"] == "Smaller reporting companies—General"
    assert _find(rules["r-230-136"], "e", "1")["heading"] == "All compensation covered"


def test_marker_and_heading_in_one_italic_run(rules):
    # "<I>(g) Layout.</I> text": the italic run is a heading, the marker is plain
    g = _find(rules["r-230-136"], "g")
    assert (g["type"], g["heading"], g["text"]) == ("subsection", "Layout", "The layout is as follows.")
    f = _find(rules["r-230-136"], "f")
    assert f["heading"] == "Format—Schedules—Generally"   # dashes inside a heading stay


def test_dash_after_plain_text_or_an_unmarked_paragraph_is_left_alone(rules):
    r = rules["r-230-137"]
    # a plain lead-in is the sentence the list continues, not a heading
    assert (r[0]["num"], r[0]["heading"]) == ("a", "")
    assert r[0]["text"].startswith("Conditions—(1) Fees. ")
    # an unmarked paragraph keeps its dash and its italic words
    assert r[1] == {"type": "p", "text": "Trading facility—(1) In general. An unmarked paragraph is kept whole."}
    # a reserved range "(8)—(10)" keeps its dash too
    assert r[3]["num"] == "8" and r[3]["text"] == "—(10) [Reserved]"


# ------------------------------------------- letters vs. numerals that look alike
def test_i_v_x_after_h_u_w_are_the_next_letter_not_a_numeral(rules):
    # § 227.201-style lists run (h) (i) (j): "(i)" is a letter there, not a clause of (h)
    c = rules["r-230-138"]
    assert [n["num"] for n in c] == ["g", "h", "i", "j", "k", "l", "u", "v", "w", "x", "hh", "ii", "jj"]
    assert all(n["type"] == "subsection" for n in c)


def test_i_after_a_numbered_leadin_is_the_first_numeral(rules):
    # (h)(1) "…leads into numerals:" then (i) (ii): numerals under (1); the next
    # "(i)" (after the (ii)) is the letter after (h), because "(1)" follows it
    h = _find(rules["r-230-138"], "h")
    assert _outline(h["children"]) == [("1", [("i", []), ("ii", [])])]
    assert _find(rules["r-230-138"], "i")["heading"] == "The next letter"
    assert [n["num"] for n in _find(rules["r-230-138"], "i")["children"]] == ["1"]


def test_roman_numerals_run_past_xx(rules):
    # § 232.101 and § 229.1125 have lists to (xxxviii); beyond (xx) they used to
    # be read as lowercase letters, i.e. as new root-level subsections
    one = _find(rules["r-230-139"], "a", "1")
    assert [(n["num"], n["type"]) for n in one["children"]] == [
        ("xix", "clause"), ("xx", "clause"), ("xxi", "clause"), ("xxxviii", "clause")]
    assert [n["num"] for n in _find(rules["r-230-139"], "a")["children"]] == ["1", "2"]
