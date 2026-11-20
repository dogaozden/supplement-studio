from pathlib import Path
from builder.build.fetch_ecfr import parse_part_xml, _act_shorthands, _linkify_act_refs

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ecfr_part230.xml"


def test_parse_part230_includes_rule_144():
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230)
    assert result["id"] == "cfr-17-p230"
    assert result["title"] == "17 CFR Part 230"
    assert result["authority_act"] == "act-ch2A"
    assert any(r["cite"].endswith("§ 230.144") for r in result["rules"])
    rule144 = next(r for r in result["rules"] if r["cite"].endswith("§ 230.144"))
    assert rule144["common_name"] == "Rule 144"
    assert rule144["content"], "Rule 144 should have at least one content block"


def test_parse_part230_nests_marked_paragraphs():
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230)
    rule100 = next(r for r in result["rules"] if r["cite"].endswith("§ 230.100"))
    assert rule100["content"][0]["type"] == "subsection"
    assert rule100["content"][0]["num"] == "a"
    assert rule100["content"][0]["text"].startswith("As used in the rules")
    children = rule100["content"][0]["children"]
    assert children[0]["type"] == "paragraph"
    assert children[0]["num"] == "1"
    assert "Commission" in children[0]["text"]


def test_parse_part230_handles_deeper_nested_markers():
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230)
    rule135 = next(r for r in result["rules"] if r["cite"].endswith("§ 230.135"))
    subsection_a = rule135["content"][0]
    paragraph_two = subsection_a["children"][1]
    clause_viii = paragraph_two["children"][-1]
    assert clause_viii["num"] == "viii"
    assert clause_viii["children"][0]["type"] == "subparagraph"
    assert clause_viii["children"][0]["num"] == "A"


def _rule_content_text(result, cite_suffix):
    """Flatten a rule's content tree (skipping table html) into one string,
    for substring assertions without hardcoding nesting depth/indices."""
    rule = next(r for r in result["rules"] if r["cite"].endswith(cite_suffix))
    texts: list[str] = []

    def walk(node):
        if node.get("type") == "table":
            return
        if isinstance(node.get("text"), str):
            texts.append(node["text"])
        for child in node.get("children") or []:
            walk(child)

    for node in rule["content"]:
        walk(node)
    return " ".join(texts)


def test_parse_part230_linkifies_known_cfr_ref():
    # Rule 144(a)(4)(i) cross-references § 230.405, which is a fetched part.
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230)
    text = _rule_content_text(result, "§ 230.144")
    assert '<a class="xref" data-to="r-230-405">§ 230.405</a>' in text


def test_parse_part230_leaves_unfetched_part_ref_plain():
    # Rule 144(c)(1)(ii) cross-references § 232.11. When part 232 isn't among
    # the fetched parts, the reference must stay plain text.
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230, fetched_parts={210, 229, 230, 240})
    text = _rule_content_text(result, "§ 230.144")
    assert "(§ 232.11 of this chapter)" in text
    assert 'data-to="r-232-11"' not in text
    # ...and it links once part 232 is in the corpus (the securities config has it now)
    linked = _rule_content_text(parse_part_xml(xml, 230), "§ 230.144")
    assert '<a class="xref" data-to="r-232-11">§ 232.11</a>' in linked


def test_parse_part230_translates_bare_act_ref_via_synthetic_table():
    # "section 4 of the Act" / "section 4(4) of the Act" both appear in the
    # Rule 144 fixture text; part 230's authority_map act is act-ch2A.
    xml = FIXTURE.read_bytes()
    act_translation = {
        "act-ch2A": {"name": "Securities Act of 1933", "sections": {"4": "s-77d"}},
    }
    result = parse_part_xml(xml, 230, act_translation=act_translation)
    text = _rule_content_text(result, "§ 230.144")
    assert '<a class="xref" data-to="s-77d">4</a> of the Act' in text
    # A chained subsection paren rides along as a /-separated path segment,
    # matching the statute-side xref convention (href stays keyed on the base id).
    assert '<a class="xref" data-to="s-77d/4">4(4)</a> of the Act' in text


def test_parse_part230_act_ref_stays_plain_without_translation_table():
    xml = FIXTURE.read_bytes()
    result = parse_part_xml(xml, 230)  # no act_translation supplied
    text = _rule_content_text(result, "§ 230.144")
    assert "section 4 of the Act" in text
    assert 'data-to="s-77d"' not in text


# --- act-name shorthands ("the Exchange Act" etc.) -----------------------

def test_act_shorthands_derives_last_two_words_and_full_minus_year():
    assert _act_shorthands("Securities Act of 1933") == {"Securities Act"}
    assert _act_shorthands("Securities Exchange Act of 1934") == {
        "Securities Exchange Act", "Exchange Act",
    }
    assert _act_shorthands("Investment Advisers Act of 1940") == {
        "Investment Advisers Act", "Advisers Act",
    }


def test_shorthand_act_ref_resolves():
    act_translation = {
        "act-ch2B": {"name": "Securities Exchange Act of 1934", "sections": {"10": "s-78j"}},
    }
    text = _linkify_act_refs("as required by section 10 of the Exchange Act.", act_translation, "")
    assert text == (
        'as required by section <a class="xref" data-to="s-78j">10</a> of the Exchange Act.'
    )


def test_shorthand_act_ref_ambiguous_across_acts_stays_plain():
    # Two different acts both derive "Exchange Act" as a shorthand -- a
    # missed link is fine, a wrong one is not, so neither wins.
    act_translation = {
        "act-a": {"name": "Alpha Exchange Act of 1990", "sections": {"10": "s-a10"}},
        "act-b": {"name": "Beta Exchange Act of 1995", "sections": {"10": "s-b10"}},
    }
    text = _linkify_act_refs("as required by section 10 of the Exchange Act.", act_translation, "")
    assert text == "as required by section 10 of the Exchange Act."


def test_act_ref_lowercase_the_act_never_matches():
    # Bare "the act" and shorthand "the exchange act" (lowercase) must
    # never match -- only exact capitalization is a defined-term signal;
    # lowercase "act" is common English and would false-positive constantly.
    act_translation = {
        "act-ch2B": {"name": "Securities Exchange Act of 1934", "sections": {"10": "s-78j"}},
    }
    text = _linkify_act_refs(
        "the parties agreed to act in good faith. section 10 of the act "
        "and section 10 of the exchange act shall not apply.",
        act_translation, "act-ch2B",
    )
    assert '<a class="xref"' not in text


def test_parse_part230_shorthand_act_ref_links_each_enumerated_token():
    # Real Rule 144 text: "...subject to the reporting requirements of
    # section 13 or 15(d) of the Exchange Act..." -- "Exchange Act" is a
    # shorthand for "Securities Exchange Act of 1934", not the bare "Act"
    # (part 230's own authority act is act-ch2A) nor the full name. Proves
    # the shorthand path composes with the multi-target token-wise wrap.
    xml = FIXTURE.read_bytes()
    act_translation = {
        "act-ch2B": {
            "name": "Securities Exchange Act of 1934",
            "sections": {"13": "s-78m", "15": "s-78o"},
        },
    }
    result = parse_part_xml(xml, 230, act_translation=act_translation)
    text = _rule_content_text(result, "§ 230.144")
    assert (
        'section <a class="xref" data-to="s-78m">13</a> or '
        '<a class="xref" data-to="s-78o/d">15(d)</a> of the Exchange Act'
    ) in text


def test_end_groups_cuts_a_flat_regulation_at_its_last_section():
    from builder.build.fetch_ecfr import _end_groups
    groups = [{"id": "g-e", "short": "Regulation E", "rules": ["r-230-609", "r-230-610a", "r-230-701"]}]
    group_of = {"230.609": "g-e", "230.610a": "g-e", "230.701": "g-e"}
    _end_groups(groups, group_of, {"Regulation E": "230.610a"}, 230)
    assert groups[0]["rules"] == ["r-230-609", "r-230-610a"]
    assert group_of == {"230.609": "g-e", "230.610a": "g-e"}
    import pytest
    with pytest.raises(ValueError):
        _end_groups(groups, group_of, {"Regulation E": "230.999"}, 230)
