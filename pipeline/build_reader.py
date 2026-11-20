#!/usr/bin/env python3
"""Generate a single-file offline reader from a corpus + manifest.

Domain-agnostic: point it at any corpus.json produced by builder/build
(USC titles via USLM XML from uscode.house.gov, CFR parts via the eCFR
API) and a manifest listing which provisions to include, and it emits a
self-contained annotatable HTML reader.

Usage:
    python3 pipeline/build_reader.py \
        --corpus builder/corpus.json \
        --manifest pipeline/manifest_secreg.json \
        --out out/reader.html

Also writes <out-stem>-text.json: the per-section flattened plain text
(identical to what the DOM will contain), so annotation anchoring
tools and browser-side restoration can never disagree.
"""
import argparse
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# the reader template is shared with the builder web app (client-side
# reader export); it lives under builder/ so the deployed site can ship it
TEMPLATE_DIR = ROOT / "builder" / "reader" / "template"

MAX_DEPTH = 6


def esc(s):
    return html.escape(s, quote=False)


XREF_RE = re.compile(r'<a class="xref" data-to="([^"]*)">(.*?)</a>', re.S)

# codified num ('77e') -> original display num ('5'). Filled from the
# manifest in main(); when set, cross-reference text reads the way
# Congress wrote it ('section 5(c)') instead of the codified form
# ('section 77e(c) of this title') — matching the print supplement.
XREF_DISPLAY = {}

CODIFIED_REF_RE = re.compile(
    r"section (\d+[a-z]+(?:–\d+)?)((?:\([^()]*\))*) of this title")


def display_ref(inner):
    """'section 77e(c) of this title' -> 'section 5(c)' when known."""
    def sub(m):
        orig = XREF_DISPLAY.get(m.group(1))
        if not orig:
            return m.group(0)
        return f"section {orig}{m.group(2)}"
    return CODIFIED_REF_RE.sub(sub, inner)


def strip_xrefs(s):
    """Plain-text view of corpus text (xref tags removed, inner kept,
    references shown in original act numbering)."""
    return XREF_RE.sub(lambda m: display_ref(m.group(2)), s)


def render_rich(s):
    """Escape text but turn corpus xref tags into real links.
    The link target keeps only the section part of paths like
    's-77e/c'; textContent is identical to strip_xrefs(s), so
    annotation anchoring is unaffected by the markup."""
    out = []
    last = 0
    for m in XREF_RE.finditer(s):
        out.append(esc(s[last:m.start()]))
        target = m.group(1).split("/")[0]
        if target:
            out.append(
                f'<a class="xref" href="#{html.escape(target, quote=True)}" '
                f'data-to="{html.escape(m.group(1), quote=True)}">{esc(display_ref(m.group(2)))}</a>'
            )
        else:
            # footnote-style marker with no target — plain text
            out.append(esc(m.group(2)))
        last = m.end()
    out.append(esc(s[last:]))
    return "".join(out)


class SectionRenderer:
    """Renders one provision's content tree to flat hanging-indent
    paragraphs, and collects the plain text in identical order."""

    def __init__(self):
        self.parts = []
        self.texts = []
        self.run_in = False  # the next paragraph closes an open run-in wrapper

    def text_of(self, node):
        return (node.get("text") or "").strip()

    def emit_p(self, depth, num=None, heading=None, text="", cls="", open_tag=""):
        d = min(depth, MAX_DEPTH)
        bits = [open_tag] if open_tag else []
        bits.append(f'<p class="t d{d}{" " + cls if cls else ""}">')
        plain = []
        if num:
            bits.append(f'<span class="n">({esc(num)})</span> ')
            plain.append(f"({num})")
        if heading:
            heading = strip_xrefs(heading)
            bits.append(f'<span class="nh">{esc(heading)}</span> ')
            plain.append(heading)
        if text:
            bits.append(render_rich(text))
            plain.append(strip_xrefs(text))
        bits.append("</p>")
        self.parts.append("".join(bits))
        if plain:
            self.texts.append(" ".join(plain))

    def render(self, node, depth):
        t = node.get("type")
        if t in ("subsection", "paragraph", "subparagraph", "clause", "subclause", "item"):
            num = (node.get("num") or "").strip()
            heading = (node.get("heading") or "").strip()
            text = self.text_of(node)
            if num or heading or text:
                # A division with no words of its own whose first child is a
                # plain paragraph runs that paragraph in after its number and
                # heading ("(a) Definitions. When used in ..."), as the PDF
                # sets it. The two <p>s stay separate (same text nodes, same
                # "\n" between them); the wrapper <div class="ri"> only lets
                # CSS set them as one block with a hanging indent. Nothing
                # here touches the anchor text. Mirrors render-section.js.
                kids = node.get("children") or []
                first = kids[0] if kids else None
                run_in = bool(
                    not text and (num or heading) and first
                    and (first.get("type") == "chapeau"
                         or (first.get("type") == "p" and not first.get("role")))
                    and self.text_of(first) != "")
                self.emit_p(depth, num=num or None,
                            # official run-in headings already end ".—"/"—"/":": no extra period
                            heading=(heading if heading.endswith((".", ":", "\u2014", "-")) else heading + ".")
                            if heading else None, text=text,
                            open_tag=f'<div class="ri d{min(depth, MAX_DEPTH)}">' if run_in else "")
                self.run_in = run_in
            for child in node.get("children") or []:
                self.render(child, depth + 1)
        elif t in ("p", "chapeau", "continuation"):
            text = self.text_of(node)
            if text:
                # chapeau/continuation sit at the parent's depth
                self.emit_p(max(depth - 1, 0) if t == "continuation" else depth, text=text)
                if self.run_in:  # closes the wrapper the division above opened
                    self.parts[-1] += "</div>"
                    self.run_in = False
        elif t == "signature":
            text = self.text_of(node)
            if text:
                self.emit_p(depth, text=text, cls="sig")
        elif t == "table":
            self.parts.append(f'<div class="tbl">{node.get("html", "")}</div>')
            # plain text of tables intentionally omitted from anchor text
        else:
            for child in node.get("children") or []:
                self.render(child, depth + 1)


def build_provision(item, prov, kind, group_label):
    """Render one <section>. Returns (html, plaintext_list, meta)."""
    r = SectionRenderer()
    for node in prov.get("content") or []:
        r.render(node, 1)

    cid = prov["id"]
    old_id = item.get("old_id", "")
    display = item["display"]

    if kind == "usc":
        cite = (prov.get("codified") or {}).get("cite", "")
        alt = (prov.get("original") or {}).get("cite", "")
        cite_line = " · ".join(x for x in (cite, alt) if x)
    else:
        cite_line = prov.get("cite", "")
        common = prov.get("common_name", "")
        if common and common.lower() not in display.lower():
            cite_line = f"{cite_line} · {common}" if cite_line else common

    heading = strip_xrefs((prov.get("heading") or "")).strip().rstrip(".")
    # "(Item 402) Executive compensation": the label already says "Item 402"
    heading = re.sub(r"^\(Item [^)]+\)\s*", "", heading)
    credit = strip_xrefs((prov.get("source_credit") or "")).strip()

    head_html = (
        f'<header class="prov-head">'
        f'<h2 class="prov-title"><span class="prov-num">{esc(display)}</span>'
        f'<span class="prov-name">{esc(heading)}</span></h2>'
        f'<div class="prov-cite">{esc(cite_line)}</div>'
        f"</header>"
    )
    credit_html = (
        f'<footer class="prov-credit">{esc(credit)}</footer>' if credit else ""
    )
    body_html = "\n".join(r.parts)  # the newline becomes a DOM text node:
    # the runtime's text walker then sees the same inter-paragraph space
    # the sidecar encodes, so cross-paragraph highlights anchor identically
    sec_html = (
        f'<section class="prov" id="{esc(cid)}" data-old-id="{esc(old_id)}" '
        f'data-display="{esc(display)}" data-group="{esc(group_label)}">'
        f"{head_html}<div class=\"prov-body\">\n{body_html}\n</div>{credit_html}</section>"
    )
    meta = {
        "id": cid,
        "old_id": old_id,
        "display": display,
        "heading": heading,
        "group": group_label,
    }
    return sec_html, r.texts, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(ROOT / "builder" / "corpus.json"))
    ap.add_argument("--manifest", default=str(ROOT / "pipeline" / "manifest_secreg.json"))
    ap.add_argument("--out", default=str(ROOT / "dist" / "reader.html"))
    ap.add_argument("--annotations", default="",
                    help="optional annotations JSON to seed into the reader "
                         "(used on first open when localStorage is empty)")
    ap.add_argument("--orphans", default="",
                    help="optional migration-report JSON whose orphans become "
                         "in-reader placeable cards")
    ap.add_argument("--dump-render", default="",
                    help="optional path: write per-section rendered html+texts "
                         "as JSON (renderer-parity harness, see "
                         "builder/tests/test_reader_parity.py)")
    args = ap.parse_args()

    corpus = json.loads(Path(args.corpus).read_text())
    manifest = json.loads(Path(args.manifest).read_text())

    # cross-references display in original act numbering (print style)
    for g in manifest.get("groups", []):
        if g.get("kind") != "usc":
            continue
        for item in g.get("items", []):
            cid = item.get("corpus_id", "")
            m = re.match(r"§ (\S+)$", item.get("display", ""))
            if m and cid.startswith("s-"):
                XREF_DISPLAY[cid[2:]] = m.group(1)

    # Index every provision in the corpus by id
    by_id = {}
    for act in corpus.get("acts", []):
        for s in act.get("sections", []):
            by_id[s["id"]] = ("usc", s)
    for reg in corpus.get("regulations", []):
        for rule in reg.get("rules", []):
            by_id[rule["id"]] = ("cfr", rule)

    sections_html = []
    toc_groups = []
    text_map = {}
    render_dump = {}
    missing = list(manifest.get("unmapped_legacy_ids", []))
    n = 0

    for group in manifest["groups"]:
        toc_items = []
        for item in group["items"]:
            if "subhead" in item:
                toc_items.append({"subhead": item["subhead"]})
                sections_html.append(
                    f'<div class="reg-subhead" id="sub-{n}">{esc(item["subhead"])}</div>'
                )
                n += 1
                continue
            kind_prov = by_id.get(item["corpus_id"])
            if not kind_prov:
                missing.append(item["corpus_id"])
                continue
            kind, prov = kind_prov
            sec_html, texts, meta = build_provision(item, prov, kind, group["label"])
            sections_html.append(sec_html)
            text_map[meta["id"]] = {"old_id": meta["old_id"], "texts": texts}
            render_dump[meta["id"]] = {"html": sec_html, "texts": texts}
            toc_items.append(meta)
        toc_groups.append(
            {
                "label": group["label"],
                "sublabel": group.get("sublabel", ""),
                "items": toc_items,
            }
        )

    if args.dump_render:
        Path(args.dump_render).write_text(json.dumps(
            {"sections": render_dump}, ensure_ascii=False))

    src = corpus.get("source", {})
    doc_meta = {
        "name": manifest["name"],
        "title": manifest["title"],
        "subtitle": manifest.get("subtitle", ""),
        "edition": manifest.get("edition", ""),
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "usc_release": src.get("usc_release_point", ""),
            "usc_label": src.get("usc_release_label", ""),
            "usc_generated": src.get("usc_generated", ""),
            "ecfr_date": src.get("ecfr_date", ""),
        },
        "provisions": len(text_map),
    }

    shell = (TEMPLATE_DIR / "shell.html").read_text()
    css = (TEMPLATE_DIR / "reader.css").read_text()
    js = (TEMPLATE_DIR / "reader.js").read_text()

    seed = "null"
    if args.annotations:
        seed_data = json.loads(Path(args.annotations).read_text())
        seed = json.dumps(seed_data, ensure_ascii=False).replace("</", "<\\/")

    orphan_json = "null"
    if args.orphans:
        rep = json.loads(Path(args.orphans).read_text())
        orphan_list = [
            {"oid": f"orph_{o['i']}", "text": o["text"], "color": o["color"],
             "note": o.get("note", ""), "near": o.get("near", "")}
            for o in rep.get("orphans", [])
        ]
        orphan_json = json.dumps(orphan_list, ensure_ascii=False).replace("</", "<\\/")

    # "</" inside any JSON string would close the <script> island early
    # (stored XSS + broken reader); "<\/" parses back identically.
    # Mirrors reader-export.js jsonIsland(); seed/orphans above already do it.
    out_html = (
        shell.replace("/*__CSS__*/", css)
        .replace("__TITLE__", esc(manifest["title"]))
        .replace("__DOC_META__",
                 json.dumps(doc_meta, ensure_ascii=False).replace("</", "<\\/"))
        .replace("__TOC__",
                 json.dumps(toc_groups, ensure_ascii=False).replace("</", "<\\/"))
        .replace("__SEED__", seed)
        .replace("__ORPHANS__", orphan_json)
        .replace("__CONTENT__", "\n".join(sections_html))
        .replace("//__JS__", js)
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(out_html)
    text_out = out.with_name(out.stem + "-text.json")
    text_out.write_text(json.dumps(
        {"doc": doc_meta["name"], "sections": text_map}, ensure_ascii=False))

    size_mb = out.stat().st_size / 1e6
    print(f"reader: {out} ({size_mb:.1f} MB, {len(text_map)} provisions)")
    print(f"text sidecar: {text_out}")
    if missing:
        print(f"WARNING missing provisions: {missing}")


if __name__ == "__main__":
    main()
