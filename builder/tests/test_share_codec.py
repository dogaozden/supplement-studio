"""Share-URL codec tests (docs/contracts.md § 5).

Shells out to node to run builder/tests/node/share_roundtrip.mjs, which
exercises builder/share.js: full-corpus roundtrip, seeded 250-item shuffle
with unicode metadata, en-dash ids, malformed-hash rejection, empty-metadata
omission, and the compaction size bound.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_SCRIPT = REPO_ROOT / "builder" / "tests" / "node" / "share_roundtrip.mjs"


def test_share_codec_roundtrip():
    if shutil.which("node") is None:
        pytest.skip("node is not on PATH — the share codec tests require Node.js")

    result = subprocess.run(
        ["node", str(NODE_SCRIPT)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"share_roundtrip.mjs exited {result.returncode}\n"
        f"--- stdout ---\n{result.stdout}\n"
        f"--- stderr ---\n{result.stderr}"
    )
