"""Renderer parity: the JS port (builder/reader/render-section.js) must
produce BYTE-IDENTICAL output to pipeline/build_reader.py for every
provision — section HTML and the texts array (annotation anchor text).
See docs/contracts.md §7. Default scope: the secreg manifest.
PARITY_FULL=1 additionally runs every provision in the corpus.
"""
import difflib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS = REPO_ROOT / "builder" / "corpus.json"
SECREG_MANIFEST = REPO_ROOT / "pipeline" / "manifest_secreg.json"
BUILD_READER = REPO_ROOT / "pipeline" / "build_reader.py"
DUMP_RENDER_MJS = REPO_ROOT / "builder" / "tests" / "node" / "dump_render.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node not on PATH")


def dump_python(manifest_path: Path, tmp_path: Path) -> dict:
    """Run the Python renderer with --dump-render; return its sections map.
    --out points into tmp_path so dist/ artifacts are never touched."""
    out_json = tmp_path / "py.json"
    subprocess.run(
        [sys.executable, str(BUILD_READER),
         "--corpus", str(CORPUS),
         "--manifest", str(manifest_path),
         "--out", str(tmp_path / "reader.html"),
         "--dump-render", str(out_json)],
        cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    return json.loads(out_json.read_text())["sections"]


def dump_node(manifest_path: Path, tmp_path: Path) -> dict:
    out_json = tmp_path / "js.json"
    subprocess.run(
        ["node", str(DUMP_RENDER_MJS),
         str(CORPUS), str(manifest_path), str(out_json)],
        cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    return json.loads(out_json.read_text())["sections"]


def assert_parity(py: dict, js: dict):
    assert set(py) == set(js), (
        "section id sets differ; "
        f"py-only={sorted(set(py) - set(js))[:5]} "
        f"js-only={sorted(set(js) - set(py))[:5]}")
    mismatched = [
        cid for cid in py
        if py[cid]["html"] != js[cid]["html"]
        or py[cid]["texts"] != js[cid]["texts"]
    ]
    if mismatched:
        report = [f"{len(mismatched)} of {len(py)} sections differ "
                  f"(showing first 3): {mismatched[:3]}"]
        for cid in mismatched[:3]:
            report.append(f"=== {cid}: html (python vs js) ===")
            report.extend(difflib.unified_diff(
                py[cid]["html"].splitlines(), js[cid]["html"].splitlines(),
                "python", "js", lineterm=""))
            report.append(f"=== {cid}: texts (python vs js) ===")
            report.extend(difflib.unified_diff(
                py[cid]["texts"], js[cid]["texts"],
                "python", "js", lineterm=""))
        pytest.fail("\n".join(report))


def test_parity_secreg_manifest(tmp_path):
    py = dump_python(SECREG_MANIFEST, tmp_path)
    js = dump_node(SECREG_MANIFEST, tmp_path)
    assert len(py) > 300  # secreg ships ~376 provisions
    assert_parity(py, js)


@pytest.mark.skipif(os.environ.get("PARITY_FULL") != "1",
                    reason="set PARITY_FULL=1 to run full-corpus parity")
def test_parity_full_corpus(tmp_path):
    """Synthetic manifest covering EVERY provision id in the corpus."""
    corpus = json.loads(CORPUS.read_text())

    usc_items = []
    for act in corpus.get("acts", []):
        for s in act.get("sections", []):
            num = (s.get("codified") or {}).get("num") or ""
            usc_items.append({
                "corpus_id": s["id"],
                "old_id": "",
                "display": f"§ {num}" if num else s["id"],
            })
    cfr_items = []
    for reg in corpus.get("regulations", []):
        for rule in reg.get("rules", []):
            cfr_items.append({
                "corpus_id": rule["id"],
                "old_id": "",
                "display": rule.get("cite") or rule["id"],
            })

    manifest = {
        "name": "parity-full",
        "title": "Full-corpus parity check",
        "groups": [
            {"label": "All USC provisions", "kind": "usc",
             "items": usc_items},
            {"label": "All CFR provisions", "kind": "cfr",
             "items": cfr_items},
        ],
        "unmapped_legacy_ids": [],
    }
    manifest_path = tmp_path / "manifest_full.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False))

    py = dump_python(manifest_path, tmp_path)
    js = dump_node(manifest_path, tmp_path)
    all_ids = {i["corpus_id"] for i in usc_items + cfr_items}
    assert set(py) == all_ids  # every corpus provision was rendered
    assert_parity(py, js)


# ── run-in wrapper (the reader sets "(a) Heading. Chapeau…" as one block) ──

def _render_py(content):
    """Render synthetic content through the Python renderer."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_reader_mod", BUILD_READER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    prov = {"id": "s-1", "heading": "Test", "content": content}
    html, texts, _ = mod.build_provision(
        {"display": "§ 1", "old_id": ""}, prov, "usc", "Act")
    return html, texts


def test_run_in_wraps_only_a_words_free_division_with_a_chapeau():
    import re
    html, texts = _render_py([
        # 1: no words of its own + chapeau first child -> run in
        {"type": "subsection", "num": "a", "heading": "Definitions", "text": "",
         "children": [{"type": "chapeau", "text": "When used here—"},
                      {"type": "paragraph", "num": "1", "text": "A term."}]},
        # 2: has its own text, then an unnumbered note paragraph -> NOT run in
        {"type": "subsection", "num": "b", "heading": "Limits", "text": "Own words.",
         "children": [{"type": "p", "text": "Note to paragraph (b): see rule."}]},
        # 3: first child is numbered -> NOT run in
        {"type": "subsection", "num": "c", "text": "",
         "children": [{"type": "paragraph", "num": "1", "text": "Sub."}]},
        # 4: first child carries a role (footnote) -> NOT run in
        {"type": "subsection", "num": "d", "text": "",
         "children": [{"type": "p", "role": "footnote", "text": "¹ a footnote"}]},
        # 5: plain p first child (no role), number only -> run in
        {"type": "subsection", "num": "e", "text": "",
         "children": [{"type": "p", "text": "The following apply:"}]},
    ])
    assert html.count('<div class="ri d1">') == 2
    # two wrappers + .prov-cite + .prov-body
    assert html.count("</div>") == 4
    # each wrapper holds exactly the lead paragraph, the "\n", and the chapeau
    wrapped = re.findall(r'<div class="ri d1">(.*?)</div>', html, flags=re.S)
    assert len(wrapped) == 2
    for w in wrapped:
        assert re.fullmatch(
            r'<p class="t d1">.*?</p>\n<p class="t d2">.*?</p>', w, flags=re.S)
    assert ('(a)</span> <span class="nh">Definitions.</span> </p>\n'
            '<p class="t d2">When used') in html
    # the anchor text is what it was before the wrapper existed
    assert texts[0] == "(a) Definitions."
    assert texts[1] == "When used here—"
    assert "(b) Limits. Own words." in texts


def test_run_in_wrapper_adds_no_text_nodes(tmp_path):
    """The wrapper is tags only: same <p>s, same "\\n" text nodes, so
    annotation anchoring cannot move. Every wrapper is balanced."""
    import re
    py = dump_python(SECREG_MANIFEST, tmp_path)
    wrappers = 0
    for cid, sec in py.items():
        html = sec["html"]
        opens = len(re.findall(r'<div class="ri d\d">', html))
        wrappers += opens
        closes = html.count("</div>")
        tables = html.count('<div class="tbl">')
        assert closes == opens + tables + 2, cid  # +2 = .prov-cite, .prov-body
        # a wrapper is always <p>…</p>\n<p>…</p></div> and nothing else
        for m in re.finditer(r'<div class="ri d\d">(.*?)</div>', html, flags=re.S):
            assert re.fullmatch(
                r'<p class="t d\d">.*?</p>\n<p class="t d\d">.*?</p>',
                m.group(1), flags=re.S), cid
    assert wrappers > 200  # the secreg manifest has hundreds of run-in heads
