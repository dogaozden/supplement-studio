"""Runs the node:test suite for builder/pdf/document.js (cross-reference
linking, numbering modes, parts, Table of Sections) in the default suite."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_document_builder_node_suite():
    r = subprocess.run(["node", "--test", "builder/tests/node/document.test.mjs"], cwd=ROOT,
                       capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
