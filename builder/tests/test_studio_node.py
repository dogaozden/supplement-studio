"""Studio logic tests, run in the default (fast) suite.

Shells out to node for the pure-ESM modules behind the builder UI:

- search.test.mjs   citation-aware search (every query in the studio brief)
- model.test.mjs    selection operations, labels, browse units
- store.test.mjs    undo/redo history, options, state migration
- presets.test.mjs  every template references real provisions, stays coalesced

(The share-link codec has its own wrapper, test_share_codec.py.)
"""

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_DIR = REPO_ROOT / "builder" / "tests" / "node"

SUITES = ["search.test.mjs", "model.test.mjs", "store.test.mjs", "presets.test.mjs"]


@pytest.mark.parametrize("script", SUITES)
def test_node_suite(script):
    if shutil.which("node") is None:
        pytest.skip("node is not on PATH — the studio logic tests require Node.js")
    path = NODE_DIR / script
    if not path.exists():
        pytest.fail(f"missing node test {path}")

    result = subprocess.run(
        ["node", str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"{script} exited {result.returncode}\n"
        f"--- stdout ---\n{result.stdout}\n"
        f"--- stderr ---\n{result.stderr}"
    )
