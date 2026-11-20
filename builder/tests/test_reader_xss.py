"""Regression: a supplement title containing </script> must not break out
of the reader's embedded JSON <script> islands (stored XSS + broken boot).

The JS exporter (builder/reader/reader-export.js) and the Python pipeline
(pipeline/build_reader.py) both serialize doc metadata / TOC into
<script type="application/json"> blocks. A literal "</" in any string
would terminate the element early; both sides escape it to "<\\/", which
JSON.parse restores byte-for-byte. This test pins the Python side; the JS
side is covered by builder/tests/e2e/test_reader_export.py.
"""
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_READER = REPO_ROOT / "pipeline" / "build_reader.py"
CORPUS = REPO_ROOT / "builder" / "corpus.json"

EVIL = "</script><script>window.__XSS=1</script>"


def test_pipeline_reader_escapes_script_islands(tmp_path):
    manifest = {
        "name": "xss-probe",
        "title": EVIL,
        "subtitle": EVIL,
        "groups": [
            {"label": EVIL, "sublabel": "", "kind": "usc",
             "items": [{"corpus_id": "s-77b", "old_id": "", "display": "§ 2"}]},
        ],
        "unmapped_legacy_ids": [],
    }
    mpath = tmp_path / "manifest.json"
    mpath.write_text(json.dumps(manifest, ensure_ascii=False))
    out = tmp_path / "reader.html"
    subprocess.run(
        [sys.executable, str(BUILD_READER),
         "--corpus", str(CORPUS), "--manifest", str(mpath), "--out", str(out)],
        cwd=REPO_ROOT, check=True, capture_output=True, text=True)

    html = out.read_text()
    # no UNescaped </script> may appear inside an application/json island:
    # find each island and assert it contains no literal closing tag from data
    for marker in ('id="docMeta"', 'id="tocData"'):
        i = html.find(marker)
        assert i != -1, f"missing {marker} island"
        body_start = html.index(">", i) + 1
        body_end = html.index("</script>", body_start)  # the REAL close
        island = html[body_start:body_end]
        assert "</script>" not in island, f"unescaped </script> inside {marker}"
        assert "<\\/script>" in island, f"escape not applied in {marker}"
        # and the data round-trips: the escaped island parses back to the title
        parsed = json.loads(island.replace("<\\/", "</"))
        if marker == 'id="docMeta"':
            assert parsed["title"] == EVIL
