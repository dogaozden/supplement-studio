"""Orchestrate parse_uslm + fetch_ecfr → builder/corpus.json + build_manifest.json.

Domain specifics come from a per-corpus config (--config, default:
builder/build/corpora/securities.json). Running with no extra args
behaves exactly as the historical securities build. See
docs/corpus-adapter.md for the config + corpus schema.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # script invocation: python builder/build/build_corpus.py
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from builder.build.corpus_config import DEFAULT_CONFIG_PATH, load_config
from builder.build.parse_uslm import parse_title
from builder.build import fetch_ecfr
from builder.build.fetch_ecfr import fetch_all, CACHE_ROOT

ROOT = Path(__file__).resolve().parents[2]   # repo root
BUILDER_DIR = ROOT / "builder"


def _act_translation_table(acts: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per-act {name, sections: {original.num -> codified section id}}, for
    fetch_ecfr's Act-ref linkification. An original.num that names more than
    one section within an act is ambiguous (a map_sourcecredit data quirk,
    e.g. a mis-parsed source credit) and is dropped rather than guessed —
    a missed link is fine, a wrong one is not."""
    out: dict[str, dict[str, Any]] = {}
    for act in acts:
        by_num: dict[str, list[str]] = {}
        for sec in act["sections"]:
            if sec["original"]:
                by_num.setdefault(sec["original"]["num"], []).append(sec["id"])
        out[act["id"]] = {
            "name": act["short_title"],
            "sections": {num: ids[0] for num, ids in by_num.items() if len(ids) == 1},
        }
    return out


_XREF_RE = re.compile(r'<a class="xref" data-to="([^"]*)">(.*?)</a>')


def _collect_corpus_ids(corpus: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for act in corpus["acts"]:
        for sec in act["sections"]:
            ids.add(sec["id"])
    for reg in corpus["regulations"]:
        for rule in reg["rules"]:
            ids.add(rule["id"])
    return ids


def _unwrap_unresolved(text: str, known_ids: set[str]) -> str:
    """Drop the <a class="xref"> wrapper (keep inner text, byte-identical)
    around any anchor whose data-to base id isn't in known_ids."""
    def repl(m: re.Match) -> str:
        base = m.group(1).split("/", 1)[0]
        return m.group(0) if base in known_ids else m.group(2)
    return _XREF_RE.sub(repl, text)


def _strip_unresolved_node(node: Any, known_ids: set[str]) -> None:
    if not isinstance(node, dict):
        return
    if isinstance(node.get("text"), str):
        node["text"] = _unwrap_unresolved(node["text"], known_ids)
    if isinstance(node.get("html"), str):
        node["html"] = _unwrap_unresolved(node["html"], known_ids)
    for child in node.get("children") or []:
        _strip_unresolved_node(child, known_ids)


def _enforce_resolvable_xrefs(corpus: dict[str, Any]) -> None:
    """Guarantee every xref anchor in the built corpus resolves within it:
    unwrap any anchor (acts or regulations) whose data-to base id isn't a
    section/rule id present in this build. Must run last — after statute
    parsing AND eCFR linkification — so it also nets anchors Task 2 adds."""
    known_ids = _collect_corpus_ids(corpus)
    for act in corpus["acts"]:
        for sec in act["sections"]:
            for node in sec["content"]:
                _strip_unresolved_node(node, known_ids)
    for reg in corpus["regulations"]:
        for rule in reg["rules"]:
            for node in rule["content"]:
                _strip_unresolved_node(node, known_ids)


def build(
    *,
    ecfr_date: str,
    usc_path: Path | None = None,
    out_path: Path | None = None,
    manifest_path: Path | None = None,
    skip_ecfr: bool = False,
    ecfr_parts: list[int] | None = None,
    config: dict[str, Any] | str | Path | None = None,
    release_label: str = "",
    release_note: str = "",
    cache_dir: Path | None = None,
) -> dict[str, Any]:
    """Build a corpus. `config` is a corpus-config dict or a path to one;
    None means the securities default (back-compat).

    `release_label` ("Public Law 119-134 (October 20, 2026)") becomes
    source.usc_release_label for the currency line; `release_note` (why the
    release point isn't OLRC's newest listed one, from check_releases) goes
    in build_manifest.json as usc_release_note. `cache_dir` keeps the raw eCFR
    XML (default: builder/build/.cache/ecfr, self-gitignored) so
    verify_corpus can re-read exactly what was parsed."""
    cfg = config if isinstance(config, dict) else load_config(config)
    usc_path = usc_path or (ROOT / cfg["uslm"]["xml_path"])

    parsed = parse_title(usc_path, config=cfg)
    regs: list[dict[str, Any]] = []
    if not skip_ecfr:
        act_translation = _act_translation_table(parsed["acts"])
        regs = fetch_all(ecfr_date, parts=ecfr_parts, config=cfg,
                         act_translation=act_translation,
                         cache_dir=cache_dir if cache_dir is not None else CACHE_ROOT)
        if fetch_ecfr.UNKNOWN_TAGS:
            print("WARN: eCFR tags with no dedicated handling (kept as plain paragraphs): "
                  + ", ".join(sorted(fetch_ecfr.UNKNOWN_TAGS)))

    # Read USLM generated date + release point from the XML header
    usc_release_point, usc_generated = _read_usc_meta(usc_path)
    release_label = release_label or (
        f"Public Law {usc_release_point}" if usc_release_point else "")

    corpus = {
        "version": "1",
        "generated_at": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "source": {
            "usc_release_point": usc_release_point,
            "usc_generated": usc_generated,
            "usc_release_label": release_label,
            "ecfr_date": ecfr_date,
        },
        "meta": cfg["meta"],
        "acts": parsed["acts"],
        "regulations": regs,
        "presets": [],  # presets are separate files; this field reserved
    }
    _enforce_resolvable_xrefs(corpus)
    _assert_unique_ids(corpus)

    out_path = out_path or (BUILDER_DIR / "corpus.json")
    manifest_path = manifest_path or (BUILDER_DIR / "build_manifest.json")
    out_path.write_text(json.dumps(corpus, ensure_ascii=False, indent=2))
    manifest = {
        "generated_at": corpus["generated_at"],
        "usc_release_point": usc_release_point,
        "usc_generated": usc_generated,
        "usc_release_label": release_label,
        "usc_release_note": release_note,
        "ecfr_date": ecfr_date,
        "ecfr_parts": ecfr_parts or cfg["ecfr"]["parts"],
        "section_count": sum(len(a["sections"]) for a in corpus["acts"]),
        "regulation_count": sum(len(r["rules"]) for r in corpus["regulations"]),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return corpus


def _assert_unique_ids(corpus: dict[str, Any]) -> None:
    """Ids are permanent and must be unique; they also feed share URLs, whose
    grammar forbids the literal characters , : ; ~ (docs/corpus-adapter.md)."""
    seen: dict[str, str] = {}
    def claim(kind: str, i: str) -> None:
        if i in seen:
            raise ValueError(f"duplicate corpus id {i!r} ({kind} and {seen[i]})")
        if any(c in i for c in ",:;~"):
            raise ValueError(f"corpus id {i!r} contains a character the share-hash grammar forbids")
        seen[i] = kind
    for act in corpus["acts"]:
        claim("act", act["id"])
        for sec in act["sections"]:
            claim("section", sec["id"])
    for reg in corpus["regulations"]:
        claim("regulation", reg["id"])
        for rule in reg["rules"]:
            claim("rule", rule["id"])


def _read_usc_meta(usc_path: Path) -> tuple[str, str]:
    from lxml import etree
    tree = etree.parse(str(usc_path))
    root = tree.getroot()
    ns = {"u": "http://xml.house.gov/schemas/uslm/1.0",
          "dc": "http://purl.org/dc/elements/1.1/",
          "dcterms": "http://purl.org/dc/terms/"}
    pub_name_el = root.find(".//u:docPublicationName", ns)
    rp = pub_name_el.text.split("@")[-1] if pub_name_el is not None and pub_name_el.text else ""
    gen_el = root.find(".//dcterms:created", ns)
    gen = gen_el.text[:10] if gen_el is not None and gen_el.text else ""
    return rp, gen


def main() -> None:
    ap = argparse.ArgumentParser(description="Build corpus.json from USLM + eCFR")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH,
                    help="per-corpus build config JSON (default: builder/build/corpora/securities.json)")
    ap.add_argument("--usc", type=Path, default=None,
                    help="USLM XML path (default: uslm.xml_path from --config)")
    ap.add_argument("--ecfr-date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--skip-ecfr", action="store_true")
    ap.add_argument("--parts", type=int, nargs="*", help="override eCFR parts")
    ap.add_argument("--release-info", type=Path, default=None,
                    help="check_releases JSON (supplies usc_release_label / usc_release_note)")
    ap.add_argument("--usc-release-label", default="", help="e.g. 'Public Law 119-134 (October 20, 2026)'")
    ap.add_argument("--usc-release-note", default="", help="why this isn't OLRC's newest listed release point")
    ap.add_argument("--cache-dir", type=Path, default=None, help="raw eCFR XML cache (default: builder/build/.cache/ecfr)")
    ap.add_argument("--out", type=Path, default=None, help="corpus output path (default: builder/corpus.json)")
    ap.add_argument("--manifest", type=Path, default=None, help="manifest output path (default: builder/build_manifest.json)")
    args = ap.parse_args()
    info = json.loads(args.release_info.read_text()) if args.release_info else {}
    corpus = build(
        ecfr_date=args.ecfr_date,
        usc_path=args.usc,
        skip_ecfr=args.skip_ecfr,
        ecfr_parts=args.parts,
        config=args.config,
        release_label=args.usc_release_label or info.get("usc_release_label", ""),
        release_note=args.usc_release_note or info.get("usc_release_note", ""),
        cache_dir=args.cache_dir,
        out_path=args.out,
        manifest_path=args.manifest,
    )
    print(f"Built corpus: {len(corpus['acts'])} acts, "
          f"{sum(len(a['sections']) for a in corpus['acts'])} sections, "
          f"{sum(len(r['rules']) for r in corpus['regulations'])} rules.")


if __name__ == "__main__":
    main()
