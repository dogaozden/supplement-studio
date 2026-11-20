"""Act section numbers are what the book leads with ("Securities Act § 12"),
so they must be right. Two independent checks on the shipped corpus:

1. every Act section number agrees with the first citation in the section's
   statutory source credit ("(May 27, 1933, ch. 38, title I, § 12, …)"), the
   enacting law as the Office of the Law Revision Counsel records it;
2. the correspondences every securities lawyer knows by heart hold.
"""
import json
import re
from pathlib import Path

CORPUS = json.loads((Path(__file__).resolve().parents[1] / "corpus.json").read_text(encoding="utf-8"))
SECTIONS = {s["codified"]["num"]: (act, s) for act in CORPUS["acts"] for s in act["sections"]}


def test_act_numbers_match_the_source_credit():
    wrong = []
    for act in CORPUS["acts"]:
        for sec in act["sections"]:
            num = (sec.get("original") or {}).get("num")
            if not num:
                continue
            first = (sec.get("source_credit") or "").split(";")[0]
            if num.startswith("Schedules"):
                assert "schedules A, B" in first, first
                continue
            m = re.search(r"§\s*([0-9A-Za-z]+)", first)
            if not m or m.group(1) != num:
                wrong.append((sec["codified"]["num"], num, first[:100]))
    assert wrong == []


KNOWN = {
    "SecuritiesAct": {"2": "77b", "3": "77c", "4": "77d", "4A": "77d–1", "5": "77e", "7": "77g", "10": "77j",
                      "11": "77k", "12": "77l", "13": "77m", "15": "77o", "17": "77q", "18": "77r",
                      "27": "77z–1", "27A": "77z–2", "28": "77z–3"},
    "ExchangeAct": {"3": "78c", "9": "78i", "10": "78j", "10A": "78j–1", "12": "78l", "13": "78m", "14": "78n",
                    "15": "78o", "15A": "78o–3", "16": "78p", "18": "78r", "20": "78t", "20A": "78t–1",
                    "21": "78u", "21D": "78u–4", "21E": "78u–5", "21F": "78u–6", "27": "78aa", "28": "78bb",
                    "29": "78cc", "30A": "78dd–1"},
    "InvestmentCompanyAct": {"2": "80a–2", "3": "80a–3", "17": "80a–17", "30": "80a–29", "36": "80a–35"},
    "InvestmentAdvisersAct": {"202": "80b–2", "203": "80b–3", "206": "80b–6"},
    "SOX": {"302": "7241", "304": "7243", "404": "7262"},
    "TrustIndentureAct": {"310": "77jjj", "315": "77ooo"},
}


def test_known_correspondences():
    for key, table in KNOWN.items():
        for act_num, code_num in table.items():
            act, sec = SECTIONS[code_num]
            assert act["share_key"] == key, (code_num, act["share_key"])
            assert sec["original"]["num"] == act_num, (key, act_num, code_num, sec["original"])
