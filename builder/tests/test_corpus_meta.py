"""Lane 2C: corpus registry resolution + the meta fallback shim
(docs/contracts.md § 8). Runs builder/corpus.js in Node — same pattern as
test_pdf_template_render.py."""
import json
import subprocess
import textwrap
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_meta_shim_and_registry_resolution():
    script = textwrap.dedent(
        """
        import { applyMetaShim, resolveCorpusEntry } from './builder/corpus.js';

        // Meta-less corpus (predates the meta block) gets the securities shim.
        const bare = applyMetaShim({ acts: [], regulations: [] });
        // A corpus that already carries meta is left untouched.
        const meta = { id: 'other', label: 'Other Laws' };
        const keeps = applyMetaShim({ meta, acts: [], regulations: [] });
        // The shim id follows the registry entry id when given.
        const withId = applyMetaShim({ acts: [], regulations: [] }, 'tax');

        const registry = {
          version: 1,
          default: 'securities',
          corpora: [{ id: 'securities', label: 'Federal Securities Laws', path: './corpus.json' }],
        };

        console.log(JSON.stringify({
          shim: bare.meta,
          keepsOwnMeta: keeps.meta === meta,
          shimIdOverride: withId.meta.id,
          byId: resolveCorpusEntry(registry, 'securities'),
          bogusFallsBack: resolveCorpusEntry(registry, 'bogus'),
          noRequest: resolveCorpusEntry(registry, null),
          emptyRegistry: resolveCorpusEntry({ corpora: [] }, 'anything'),
        }));
        """
    )

    out = run_node(script)

    shim = out["shim"]
    assert shim["id"] == "securities"
    assert shim["label"] == "Federal Securities Laws"
    assert shim["defaultTitle"] == "Federal Securities Laws — Statutory Supplement"
    assert shim["uscCitePrefix"] == "15 U.S.C."
    assert shim["cfrCitePrefix"] == "17 C.F.R."
    assert shim["modes"] == {"codified": "Codified (U.S.C.)", "original": "Original acts"}

    assert out["keepsOwnMeta"] is True
    assert out["shimIdOverride"] == "tax"

    assert out["byId"]["id"] == "securities"
    assert out["bogusFallsBack"]["id"] == "securities"
    assert out["noRequest"]["id"] == "securities"
    assert out["emptyRegistry"] is None


def test_registry_file_matches_contract():
    registry = json.loads((REPO_ROOT / "builder" / "corpora.json").read_text())
    assert registry["version"] == 1
    ids = [c["id"] for c in registry["corpora"]]
    assert registry["default"] in ids
    for entry in registry["corpora"]:
        assert entry.keys() >= {"id", "label", "path"}
