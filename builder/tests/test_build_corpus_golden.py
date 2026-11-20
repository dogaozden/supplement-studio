"""Golden-file test: fixture USLM → corpus.json matches checked-in expected."""
from pathlib import Path
import json
from builder.build.build_corpus import build

FIXTURES = Path(__file__).parent / "fixtures"


def test_golden_corpus_from_fixture(tmp_path):
    out = tmp_path / "corpus.json"
    manifest = tmp_path / "manifest.json"
    build(
        usc_path=FIXTURES / "sample_section.xml",
        ecfr_date="2026-04-10",
        out_path=out,
        manifest_path=manifest,
        skip_ecfr=True,
    )
    got = json.loads(out.read_text())
    got["generated_at"] = "2026-04-14T00:00:00Z"  # stabilize
    expected = json.loads((FIXTURES / "expected_corpus.json").read_text())
    assert got == expected, "fixture → corpus.json drift — update expected_corpus.json if intentional"
