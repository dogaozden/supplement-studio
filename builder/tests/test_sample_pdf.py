"""The committed landing-page sample (site/samples/sample-supplement.pdf) passes
the same book checks as every generated PDF (pdf_checks.check_book): a stale
or broken sample can't sit on the landing page while the suite is green."""
from pathlib import Path

from builder.tests.pdf_checks import check_book

SAMPLE = Path(__file__).resolve().parents[2] / "site" / "samples" / "sample-supplement.pdf"


def test_committed_landing_sample_passes_the_book_checks():
    stats = check_book(SAMPLE)
    assert stats["pages"] > 300 and stats["openers"] >= 8
