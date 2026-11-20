"""PDF engine (Typst template + document builder) compiled with the Typst CLI.

The browser compiles the same template with the same Typst version (0.14.x,
typst.ts); this test runs it natively so the default suite can check the PDF
structure without a browser. Skips when no Typst 0.14.x binary is available
($TYPST_BIN or `typst` on PATH); CI installs one.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from builder.tests.pdf_checks import check_pdf

ROOT = Path(__file__).resolve().parents[2]


def _typst():
    cand = os.environ.get("TYPST_BIN") or shutil.which("typst")
    if not cand:
        return None
    try:
        out = subprocess.run([cand, "--version"], capture_output=True, text=True, timeout=20).stdout
    except OSError:
        return None
    return cand if out.startswith("typst 0.14.") else None


TYPST = _typst()
needs_typst = pytest.mark.skipif(TYPST is None, reason="needs Typst 0.14.x ($TYPST_BIN or typst on PATH)")


def build(tmp_path, *args):
    pdf, doc, pages = tmp_path / "s.pdf", tmp_path / "doc.json", tmp_path / "pages.json"
    subprocess.run(["node", "scripts/pdf/build_pdf.mjs", "--typst", TYPST, "--out", str(pdf), "--json", str(doc),
                    "--pages", str(pages), *args], cwd=ROOT, check=True, capture_output=True, text=True)
    return pdf, json.loads(doc.read_text()), json.loads(pages.read_text())


@needs_typst
def test_standard_template_letter(tmp_path):
    pdf, doc, pages = build(tmp_path, "--preset", "builder/presets/secreg-standard.json",
                            "--course", "Securities Regulation", "--term", "Fall 2027")
    stats = check_pdf(pdf, doc, pages)
    assert doc["parts"][0]["items"][0]["num"] == "§ 1"     # a new book names Act sections
    assert stats["pages"] > 60
    assert stats["contents_links"] >= len(pages)
    assert stats["external_links"] > 20


@needs_typst
def test_book_trim_code_numbering(tmp_path):
    pdf, doc, pages = build(tmp_path, "--preset", "builder/presets/secreg-standard.json",
                            "--trim", "6x9", "--numbering", "codified")
    stats = check_pdf(pdf, doc, pages)
    first = doc["parts"][0]["items"][0]
    assert first["num"] == "§ 77a", first["num"]
    assert stats["pages"] > 60
