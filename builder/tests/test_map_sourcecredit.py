import pytest
from builder.build.map_sourcecredit import parse_source_credit, original_for_section

CASES = [
    # Old-style, Securities Act § 1
    ("(May 27, 1933, ch. 38, title I, § 1, 48 Stat. 74.)",
     {"kind": "old", "orig_sec": "1", "chapter": "38", "title_roman": "I",
      "stat_vol": "48", "stat_page": "74"}),
    # Old-style without title
    ("(July 2, 1890, ch. 647, § 1, 26 Stat. 209.)",
     {"kind": "old", "orig_sec": "1", "chapter": "647", "title_roman": None,
      "stat_vol": "26", "stat_page": "209"}),
    # Multi-amendment — first citation wins
    ("(May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77; Mar. 15, 1940, ch. 65, § 2, 54 Stat. 56.)",
     {"kind": "old", "orig_sec": "5", "chapter": "38", "title_roman": "I",
      "stat_vol": "48", "stat_page": "77"}),
    # Pub. L. style
    ("(Pub. L. 112–106, title III, § 301, Apr. 5, 2012, 126 Stat. 315.)",
     {"kind": "publaw", "orig_sec": "301", "pub_law": "112–106", "title_roman": "III",
      "stat_vol": "126", "stat_page": "315"}),
    # Swap agreements — added by Gramm-Leach-Bliley (as added Pub. L. shape)
    (
        "(May 27, 1933, ch. 38, title I, § 2A, as added Pub. L. 106-554, § 1(a)(5) [title III, § 303(a)], Dec. 21, 2000, 114 Stat. 2763, 2763A-452.)",
        {"kind": "as_added", "orig_sec": "2A", "chapter": "38", "title_roman": "I", "pub_law": "106-554"},
    ),
    # Crowdfunding — added by JOBS Act (as added Pub. L. shape)
    (
        "(May 27, 1933, ch. 38, title I, § 4A, as added Pub. L. 112-106, title III, § 302(a), Apr. 5, 2012, 126 Stat. 315.)",
        {"kind": "as_added", "orig_sec": "4A", "chapter": "38", "title_roman": "I", "pub_law": "112-106"},
    ),
    # Trust Indenture Act sections — added by a later chapter act (no Pub. L.)
    (
        "(May 27, 1933, ch. 38, title III, § 301, as added Aug. 3, 1939, ch. 411, 53 Stat. 1149.)",
        {"kind": "as_added", "orig_sec": "301", "chapter": "38", "title_roman": "III"},
    ),
]


@pytest.mark.parametrize("sc,expected", CASES)
def test_parse_source_credit(sc, expected):
    got = parse_source_credit(sc)
    assert got is not None, f"no match for {sc!r}"
    for k, v in expected.items():
        assert got[k] == v, f"{k}: got {got[k]!r} expected {v!r}"


def test_parse_source_credit_returns_none_on_garbage():
    assert parse_source_credit("nonsense") is None


def test_original_for_section_securities_act():
    sc = "(May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77.)"
    assert original_for_section(sc, "15/2A") == {
        "num": "5",
        "cite": "Securities Act of 1933 § 5",
    }


def test_original_for_section_returns_none_on_unknown_chapter():
    sc = "(May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77.)"
    assert original_for_section(sc, "15/99Z") is None


SIPA = {"15/2B–1": "Securities Investor Protection Act of 1970"}


def test_first_citation_survives_subdivisions_with_parentheses():
    from builder.build.map_sourcecredit import first_citation
    assert first_citation("(Pub. L. 91–598, § 1(a), Dec. 30, 1970, 84 Stat. 1636.)") == \
        "Pub. L. 91–598, § 1(a), Dec. 30, 1970, 84 Stat. 1636"
    assert first_citation("(May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77; June 6, 1934, ch. 404, § 205, 48 Stat. 906.)") == \
        "May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77"


def test_sipa_subdivision_credit_maps():
    # § 78aaa: "§ 1(a)" used to be cut at the first ")" and fail to map
    sc = "(Pub. L. 91–598, § 1(a), Dec. 30, 1970, 84 Stat. 1636.)"
    assert original_for_section(sc, "15/2B–1", SIPA, pub_laws=["91-598"]) == {
        "num": "1", "cite": "Securities Investor Protection Act of 1970 § 1"}


def test_sipa_renumbered_section_uses_the_current_number():
    sc = "(Pub. L. 91–598, § 11, formerly § 7, Dec. 30, 1970, 84 Stat. 1652, 1653; renumbered § 11 and amended Pub. L. 95–283, §§ 9, 10, May 21, 1978, 92 Stat. 260.)"
    assert original_for_section(sc, "15/2B–1", SIPA, pub_laws=["91-598"]) == {
        "num": "11", "cite": "Securities Investor Protection Act of 1970 § 11"}


def test_as_added_and_amended_maps_exchange_act_21d():
    # § 78u–4 (PSLRA) = Exchange Act § 21D
    sc = "(June 6, 1934, ch. 404, title I, § 21D, as added and amended Pub. L. 104–67, title I, § 101(b), title II, § 201(a), Dec. 22, 1995, 109 Stat. 743, 758;)"
    got = original_for_section(sc, "15/2B", {"15/2B": "Securities Exchange Act of 1934"},
                               statute_chapters=["404"])
    assert got == {"num": "21D", "cite": "Securities Exchange Act of 1934 § 21D"}


def test_securities_act_schedules():
    # § 77aa holds Schedules A and B
    sc = "(May 27, 1933, ch. 38, title I, schedules A, B, 48 Stat. 88, 91; Pub. L. 105–353, title III, § 301(a)(6), Nov. 3, 1998, 112 Stat. 3235.)"
    assert original_for_section(sc, "15/2A", statute_chapters=["38"]) == {
        "num": "Schedules A, B", "cite": "Securities Act of 1933 Schedules A, B"}


def test_other_statutes_sections_are_not_given_this_acts_numbering():
    names = {"15/2B": "Securities Exchange Act of 1934"}
    # Dodd-Frank's free-standing § 961 is not "Exchange Act § 961"
    dodd = "(Pub. L. 111–203, title IX, § 961, July 21, 2010, 124 Stat. 1907.)"
    assert original_for_section(dodd, "15/2B", names, statute_chapters=["404"]) is None
    # a 1936 amendment act (ch. 462) is not "Exchange Act § 2"
    amend = "(May 27, 1936, ch. 462, § 2, 49 Stat. 1377.)"
    assert original_for_section(amend, "15/2B", names, statute_chapters=["404"]) is None
    # ...but the Exchange Act's own chapter is
    own = "(June 6, 1934, ch. 404, title I, § 12, 48 Stat. 892.)"
    assert original_for_section(own, "15/2B", names, statute_chapters=["404"])["num"] == "12"


def test_sox_sections_map_only_for_pub_l_107_204():
    names = {"15/98": "Sarbanes-Oxley Act of 2002"}
    ok = "(Pub. L. 107–204, title III, § 302, July 30, 2002, 116 Stat. 777.)"
    assert original_for_section(ok, "15/98", names, pub_laws=["107-204"]) == {
        "num": "302", "cite": "Sarbanes-Oxley Act of 2002 § 302"}
    sub = "(Pub. L. 107–204, § 2(a), July 30, 2002, 116 Stat. 746; Pub. L. 111–203, title IX, § 929F(g)(1), July 21, 2010, 124 Stat. 1855.)"
    assert original_for_section(sub, "15/98", names, pub_laws=["107-204"])["num"] == "2"
    added = "(Pub. L. 107–204, title I, § 110, as added Pub. L. 111–203, title IX, § 982(a)(1), July 21, 2010, 124 Stat. 1927.)"
    assert original_for_section(added, "15/98", names, pub_laws=["107-204"])["num"] == "110"
    later = "(Pub. L. 116–222, § 3, Dec. 18, 2020, 134 Stat. 1064.)"   # § 7214a: a later law
    assert original_for_section(later, "15/98", names, pub_laws=["107-204"]) is None


def test_original_for_added_section():
    sc = "(May 27, 1933, ch. 38, title I, § 2A, as added Pub. L. 106-554, § 1(a)(5) [title III, § 303(a)], Dec. 21, 2000, 114 Stat. 2763, 2763A-452.)"
    assert original_for_section(sc, "15/2A") == {
        "num": "2A",
        "cite": "Securities Act of 1933 § 2A",
    }
