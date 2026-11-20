"""Unit tests for build_corpus._enforce_resolvable_xrefs — the final pass
that guarantees every xref anchor in a built corpus resolves within it."""
from builder.build.build_corpus import _enforce_resolvable_xrefs


def _corpus_with_section_text(text: str) -> dict:
    return {
        "acts": [{"sections": [{"id": "s-77e", "content": [{"type": "p", "text": text}]}]}],
        "regulations": [],
    }


def test_unwraps_out_of_corpus_anchor():
    # Mimics parse_uslm minting a title-15-shaped id for a ref into another
    # USC title (e.g. "section 501(a) of title 26" -> bogus data-to="s-501").
    corpus = _corpus_with_section_text(
        'See <a class="xref" data-to="s-501">section 501 of title 26</a>.'
    )
    _enforce_resolvable_xrefs(corpus)
    text = corpus["acts"][0]["sections"][0]["content"][0]["text"]
    assert text == "See section 501 of title 26."


def test_keeps_resolvable_anchor():
    corpus = _corpus_with_section_text(
        'See <a class="xref" data-to="s-77e">this section</a>.'
    )
    _enforce_resolvable_xrefs(corpus)
    text = corpus["acts"][0]["sections"][0]["content"][0]["text"]
    assert text == 'See <a class="xref" data-to="s-77e">this section</a>.'


def test_resolves_subpath_anchor_by_base_id():
    corpus = _corpus_with_section_text(
        'See <a class="xref" data-to="s-77e/c">subsection (c)</a>.'
    )
    _enforce_resolvable_xrefs(corpus)
    text = corpus["acts"][0]["sections"][0]["content"][0]["text"]
    assert text == 'See <a class="xref" data-to="s-77e/c">subsection (c)</a>.'


def test_unwraps_unresolvable_subpath_anchor():
    corpus = _corpus_with_section_text(
        'See <a class="xref" data-to="s-501/a/2">section 501(a)(2) of title 26</a>.'
    )
    _enforce_resolvable_xrefs(corpus)
    text = corpus["acts"][0]["sections"][0]["content"][0]["text"]
    assert text == "See section 501(a)(2) of title 26."


def test_resolves_rule_id_anchor_from_regulations():
    # Act-side text can point at a regulation rule id, and vice versa —
    # known ids are the union of section ids and rule ids.
    corpus = {
        "acts": [{"sections": [{"id": "s-77e", "content": [
            {"type": "p", "text": 'See <a class="xref" data-to="r-230-144">Rule 144</a>.'}
        ]}]}],
        "regulations": [{"rules": [{"id": "r-230-144", "content": [{"type": "p", "text": "..."}]}]}],
    }
    _enforce_resolvable_xrefs(corpus)
    text = corpus["acts"][0]["sections"][0]["content"][0]["text"]
    assert text == 'See <a class="xref" data-to="r-230-144">Rule 144</a>.'


def test_unwraps_within_nested_children_and_table_html():
    corpus = {
        "acts": [{"sections": [{"id": "s-77e", "content": [
            {
                "type": "subsection",
                "num": "a",
                "children": [
                    {"type": "p", "text": 'x <a class="xref" data-to="s-999">bogus</a> y'},
                    {"type": "table", "html": '<table><td><a class="xref" data-to="s-999">z</a></td></table>'},
                ],
            }
        ]}]}],
        "regulations": [],
    }
    _enforce_resolvable_xrefs(corpus)
    sec = corpus["acts"][0]["sections"][0]["content"][0]
    assert sec["children"][0]["text"] == "x bogus y"
    assert sec["children"][1]["html"] == "<table><td>z</td></table>"
