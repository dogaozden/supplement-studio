"""Validate overall corpus.json shape against the spec."""
from pathlib import Path
import json
from builder.build.build_corpus import build

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_USC = Path(__file__).parent / "fixtures" / "sample_section.xml"


def test_corpus_shape(tmp_path):
    out = tmp_path / "corpus.json"
    manifest = tmp_path / "manifest.json"
    build(
        usc_path=FIXTURE_USC,
        ecfr_date="2026-04-10",
        out_path=out,
        manifest_path=manifest,
        skip_ecfr=True,
    )
    data = json.loads(out.read_text())
    assert data["version"] == "1"
    assert set(data) >= {"version", "generated_at", "source", "acts", "regulations", "presets"}
    assert {"usc_release_point", "usc_generated", "ecfr_date"} <= set(data["source"])
    assert isinstance(data["acts"], list) and len(data["acts"]) >= 1
    act = data["acts"][0]
    assert {"id", "short_title", "usc_chapter", "sections"} <= set(act)
    sec = act["sections"][0]
    assert {"id", "codified", "heading", "content", "source_credit", "notes", "original"} <= set(sec)
    assert sec["codified"]["cite"].startswith("15 U.S.C.")
