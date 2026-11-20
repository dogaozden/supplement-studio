"""Footnotes, headings and the USLM shapes the parser used to drop silently
(provisos, levels, subitems, mixed text + nested <p>, tables). Fixture shapes
come from the real Title 15 XML."""
import copy
from pathlib import Path

from builder.build.corpus_config import load_config
from builder.build.parse_uslm import parse_title

FIXTURE = Path(__file__).parent / "fixtures" / "sample_footnotes.xml"


def _sections():
    cfg = copy.deepcopy(load_config())
    cfg["uslm"]["split_acts"] = []
    result = parse_title(FIXTURE, cfg)
    act = next(a for a in result["acts"] if a["usc_chapter"] == "15/2B")
    return {s["id"]: s for s in act["sections"]}


def _node(nodes, num):
    return next(n for n in nodes if n.get("num") == num)


def test_footnote_text_stays_out_of_headings_and_becomes_a_footnote_node():
    sec = _sections()["s-78c"]
    para80 = _node(_node(sec["content"], "a")["children"], "80")
    # the audit's case: the heading used to read
    # "77 So in original. Two pars. (80) have been enacted. Emerging growth company.—"
    assert para80["heading"] == "Emerging growth company.—"
    assert para80["children"] == [{
        "type": "p", "role": "footnote",
        "text": "⁷ So in original. Two pars. (80) have been enacted.",
    }]
    # the paragraph's own text is untouched and carries no marker (the ref sat in the heading)
    assert para80["text"].startswith("The term means")


def test_marker_hugs_its_word_and_repeat_refs_get_no_second_body():
    sec = _sections()["s-78c"]
    para81 = _node(_node(sec["content"], "a")["children"], "81")
    assert para81["text"] == (
        "Determined in accordance with section 4605(j)¹ of title 50, "
        "and again under section 4605(j)¹ of title 50."
    )
    assert para81["children"] == [
        {"type": "p", "role": "footnote", "text": "¹ See References in Text note below."}
    ]


def test_footnote_in_subsection_heading_and_in_chapeau_keep_reading_order():
    sec = _sections()["s-78c"]
    sub_b = _node(sec["content"], "b")
    assert sub_b["heading"] == "Funding portal"            # clean, no marker
    kids = sub_b["children"]
    assert kids[0]["role"] == "footnote" and kids[0]["text"].startswith("⁹ So in original")
    assert kids[1] == {"type": "chapeau", "text": "Lead-in text with a footnote.³"}
    # footnote bodies can carry xrefs
    assert kids[2]["role"] == "footnote"
    assert kids[2]["text"] == (
        '³ Words of <a class="xref" data-to="s-78j">section 78j of this title</a> follow.'
    )


def test_mixed_content_text_before_a_nested_p_is_kept():
    # real shape: § 77aa(32), § 78u(h)(4)(C): <content>text<p>more</p></content>
    sec = _sections()["s-78c"]
    para1 = _node(_node(sec["content"], "b")["children"], "1")
    assert [c["text"] for c in para1["children"]] == [
        "a copy of the underlying agreements.",
        "In case of certificates of deposit, the Commission shall establish rules.",
    ]


def test_level_proviso_and_subitem_are_kept():
    sec = _sections()["s-78c"]
    sub_b = _node(sec["content"], "b")
    para2 = _node(sub_b["children"], "2")
    types = [(c["type"], c.get("num")) for c in para2["children"]]
    assert types == [("chapeau", None), ("clause", "1"), ("clause", "2"), ("p", None)]
    assert para2["children"][3]["text"].startswith("Provided, That the indenture")
    para3 = _node(sub_b["children"], "3")
    item_a = next(c for c in para3["children"] if c.get("num") == "A")
    assert [(c["type"], c["num"], c["text"]) for c in item_a["children"] if c.get("num")] == [
        ("item", "AA", "electing executive officers;"),
        ("item", "BB", "approving the budget."),
    ]


def test_table_cells_are_escaped_keep_spans_and_separate_paragraphs():
    content = _sections()["s-78d"]["content"]
    assert content[0] == {"type": "p", "text": "Fees:"}
    assert content[1] == {"type": "table", "html": (
        "<table><thead><tr><th>Fiscal year</th><th colspan=\"2\">Amount &amp; rate</th></tr></thead>"
        "<tbody><tr><td>2024 (est.)</td><td>$1.5 &lt; $2¹</td><td>3%</td></tr></tbody></table>"
    )}
