"""USLM XML parser — turns a USC title's XML into structured Python dicts.

Domain specifics (target chapters, citation prefix, act-name map, acts split
out of a chapter by subchapter) come from a corpus config
(builder/build/corpora/*.json); the securities config is the default. See
docs/corpus-adapter.md.

Footnotes. USLM splices footnote markers and bodies into the content flow:
`<ref class="footnoteRef">1</ref><note type="footnote"><num>1</num> So in
original.</note>` (later references to the same note are a bare `<sup>1</sup>`).
They are editorial annotations, so they never enter heading or running text as
words. They are kept as data instead:

* the reference spot in running text becomes a run of Unicode superscript
  digits ("¹", see textutil.superscript), glued to the preceding word;
* the footnote body becomes a `{"type": "p", "role": "footnote", "text":
  "¹ So in original."}` node placed right after the paragraph that carries it
  (as that paragraph's first child when it is a container, otherwise as the
  next sibling);
* headings never carry the marker (they stay clean), but a footnote that sat
  in a heading is still emitted after its node.
"""
from __future__ import annotations
import html as _html
import re
from pathlib import Path
from typing import Any, Mapping
from lxml import etree
from builder.build.corpus_config import default_config
from builder.build.map_sourcecredit import original_for_section
from builder.build.textutil import smart_title, superscript

NS = {"u": "http://xml.house.gov/schemas/uslm/1.0"}
NS_URI = "{http://xml.house.gov/schemas/uslm/1.0}"
XHTML_NS = "http://www.w3.org/1999/xhtml"

NESTING_BLOCKS = {"subsection", "paragraph", "subparagraph", "clause", "subclause", "item"}
# USLM levels the content grammar has no type for: map onto the nearest one so
# their text is kept ("level" holds numbered clauses under a subparagraph,
# "subitem" sits under an item). Dropping them silently lost statute text.
NESTING_ALIASES = {"level": "clause", "subitem": "item"}
LEAF_BLOCKS = {"chapeau", "continuation"}
STRUCTURAL_CHILDREN = (NESTING_BLOCKS | set(NESTING_ALIASES) | LEAF_BLOCKS
                       | {"p", "content", "proviso"})

# whitespace before a footnote marker is dropped so the marker hugs its word
_MARK_GLUE_RE = re.compile("\\s+(?=[\u2070\u00b9\u00b2\u00b3\u2074-\u2079])")


def _tag(el) -> str:
    """Strip namespace prefix, return local tag name."""
    return etree.QName(el).localname


def _norm(s: str) -> str:
    return _MARK_GLUE_RE.sub("", " ".join(s.split()))


class _Footnotes:
    """Collects the footnote bodies met while serializing one node's own text.
    `take()` hands them over (as footnote nodes) and clears the buffer."""

    def __init__(self) -> None:
        self.pending: list[etree._Element] = []

    def add(self, note_el) -> None:
        self.pending.append(note_el)

    def take(self) -> list[dict[str, Any]]:
        notes, self.pending = self.pending, []
        return [_footnote_node(n) for n in notes]


def _is_note(child) -> bool:
    """The inline <note> body USLM splices into the content flow."""
    return _tag(child) == "note"


def _is_marker(child) -> bool:
    """The superscript marker of a footnote: a footnoteRef <ref>, or a <sup>
    that holds only digits / only footnoteRefs. Every <sup> in Title 15 is a
    pure-digit footnote marker (no exponents or ordinals), so a digit-only
    <sup> is one."""
    tag = _tag(child)
    if tag == "ref" and child.get("class", "") == "footnoteRef":
        return True
    if tag == "sup":
        refs = [c for c in child if _tag(c) == "ref"]
        if refs:
            return all(c.get("class", "") == "footnoteRef" for c in refs)
        return not len(child) and (child.text or "").strip().isdigit()
    return False


def _is_footnote(child) -> bool:
    return _is_note(child) or _is_marker(child)


def _marker_of(el) -> str:
    return superscript("".join(el.itertext()))


def _clean_itertext(el, fn: _Footnotes | None = None, mark: bool = True) -> str:
    """itertext() that skips footnote notes (handing them to `fn` when given)
    and either replaces footnote markers with superscript digits (`mark`) or
    drops them. Skips at any depth, so a marker nested inside an inline wrapper
    doesn't leak its digit into running text. Tails of skipped nodes are kept."""
    parts: list[str] = []
    if el.text:
        parts.append(el.text)
    for child in el:
        if _is_note(child):
            if fn is not None:
                fn.add(child)
        elif _is_marker(child):
            if mark:
                parts.append(_marker_of(child))
        else:
            parts.append(_clean_itertext(child, fn, mark))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _text(el, fn: _Footnotes | None = None) -> str:
    """Whitespace-normalized text with footnote apparatus removed — no marker
    either: used for headings, source credits and notes, which stay clean.
    Footnote bodies found inside are handed to `fn` (when given)."""
    if el is None:
        return ""
    return _norm(_clean_itertext(el, fn, mark=False))


def _child_str(child, fn: _Footnotes | None, link: bool = True) -> str:
    """One inline child (without its tail) as text: footnote bodies go to `fn`,
    a footnote marker becomes superscript digits, a <ref href="/us/usc/t15/s77j">
    becomes <a class="xref" data-to="s-77j">…</a>, anything else its clean text."""
    if _is_note(child):
        if fn is not None:
            fn.add(child)
        return ""
    if _is_marker(child):
        return _marker_of(child)
    if link and _tag(child) == "ref":
        href = child.get("href", "")
        to = "s-" + href.rsplit("/s", 1)[-1] if "/s" in href else ""
        return f'<a class="xref" data-to="{to}">{_clean_itertext(child, fn)}</a>'
    return _clean_itertext(child, fn)


def _serialize_children(el, fn: _Footnotes | None, skip=None, link: bool = True) -> str:
    """Serialize element content (see _child_str). `skip` is a child to leave out."""
    out: list[str] = []
    if el.text:
        out.append(el.text)
    for child in el:
        if child is not skip:
            out.append(_child_str(child, fn, link))
        if child.tail:
            out.append(child.tail)
    return _norm("".join(out))


def _text_with_refs(el, fn: _Footnotes | None = None) -> str:
    return _serialize_children(el, fn)


def _footnote_node(note_el) -> dict[str, Any]:
    """A `note type="footnote"` -> {"type":"p","role":"footnote","text":"¹ body"}."""
    num_el = note_el.find("u:num", NS)
    marker = superscript("".join(num_el.itertext())) if num_el is not None else ""
    body = _serialize_children(note_el, None, skip=num_el)
    return {"type": "p", "role": "footnote", "text": f"{marker} {body}".strip()}


# children that are blocks of their own inside a content/p wrapper
BLOCK_CHILDREN = STRUCTURAL_CHILDREN | {"table"}


def _has_block_children(el) -> bool:
    return any(_tag(child) in BLOCK_CHILDREN for child in el)


def _has_table(el) -> bool:
    return el.find(f".//{{{XHTML_NS}}}table") is not None


def _span_attrs(cell) -> str:
    attrs = ""
    for name in ("colspan", "rowspan"):
        v = (cell.get(name) or "").strip()
        if v.isdigit() and int(v) > 1:
            attrs += f' {name}="{int(v)}"'
    return attrs


def _serialize_table(table_el, fn: _Footnotes | None = None) -> str:
    """Render a USLM/XHTML <table> as clean HTML: only table/thead/tbody/tr/
    th/td, colspan/rowspan kept, no inline styles, cell text HTML-escaped."""
    rows_html: list[str] = []

    def _cell_text(cell) -> str:
        paras = [c for c in cell if _tag(c) == "p"]
        if paras:  # one cell can hold several paragraphs: keep them apart
            return " ".join(_norm(_clean_itertext(p, fn)) for p in paras)
        return _norm(_clean_itertext(cell, fn))

    def _cells(tr_el) -> str:
        out: list[str] = []
        for cell in tr_el:
            tag = etree.QName(cell).localname
            if tag not in ("th", "td"):
                continue
            text = _html.escape(_cell_text(cell), quote=False)
            out.append(f"<{tag}{_span_attrs(cell)}>{text}</{tag}>")
        return "".join(out)

    thead = table_el.find(f"{{{XHTML_NS}}}thead")
    if thead is not None:
        head_rows = [
            f"<tr>{_cells(tr)}</tr>" for tr in thead.findall(f"{{{XHTML_NS}}}tr")
        ]
        if head_rows:
            rows_html.append(f"<thead>{''.join(head_rows)}</thead>")

    tbody = table_el.find(f"{{{XHTML_NS}}}tbody")
    body_tr_source = tbody if tbody is not None else table_el
    body_rows = [
        f"<tr>{_cells(tr)}</tr>"
        for tr in body_tr_source.findall(f"{{{XHTML_NS}}}tr")
    ]
    if body_rows:
        rows_html.append(f"<tbody>{''.join(body_rows)}</tbody>")

    return f"<table>{''.join(rows_html)}</table>"


def _mixed_blocks(el, fn: _Footnotes) -> dict[str, Any] | list[dict[str, Any]]:
    """A <content>/<p> that mixes running text with block children (nested
    <p>s, provisos, tables…): the text before, between and after the blocks
    becomes `p` nodes in place, so nothing the element says is lost."""
    blocks: list[dict[str, Any]] = []
    buf: list[str] = []

    def flush() -> None:
        text = _norm("".join(buf))
        buf.clear()
        if text:
            blocks.append({"type": "p", "text": text})
            blocks.extend(fn.take())

    if el.text:
        buf.append(el.text)
    for child in el:
        tag = _tag(child)
        if tag == "table":
            flush()
            blocks.append({"type": "table", "html": _serialize_table(child, fn)})
            blocks.extend(fn.take())
        elif tag in STRUCTURAL_CHILDREN:
            flush()
            parsed = _parse_content_block(child, fn)
            if parsed is not None:
                blocks.extend(parsed if isinstance(parsed, list) else [parsed])
        else:
            buf.append(_child_str(child, fn))
        if child.tail:
            buf.append(child.tail)
    flush()
    blocks.extend(fn.take())
    return blocks if len(blocks) != 1 else blocks[0]


def _parse_content_block(el, fn: _Footnotes) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Convert one USLM content-ish element into a dict block, or None to skip.
    Footnote bodies met in the node's own text come out right after it (or as
    the first children of a container)."""
    tag = _tag(el)
    if tag in ("content", "p"):
        if _has_block_children(el) or _has_table(el):
            return _mixed_blocks(el, fn)
        return _with_footnotes({"type": "p", "text": _text_with_refs(el, fn)}, fn)
    if tag == "table":
        return {"type": "table", "html": _serialize_table(el, fn)}
    if tag in LEAF_BLOCKS:
        return _with_footnotes({"type": tag, "text": _text_with_refs(el, fn)}, fn)
    if tag == "proviso":  # "Provided, That …": a flush paragraph
        return _with_footnotes({"type": "p", "text": _text_with_refs(el, fn)}, fn)
    if tag in NESTING_BLOCKS or tag in NESTING_ALIASES:
        node_type = NESTING_ALIASES.get(tag, tag)
        num_el = el.find("u:num", NS)
        heading_el = el.find("u:heading", NS)
        num = num_el.get("value", "") if num_el is not None else ""
        heading = _text(heading_el, fn)
        content_el = el.find("u:content", NS)
        only_content = content_el is not None and all(
            c is num_el or c is heading_el or c is content_el for c in el)
        if only_content and not _has_block_children(content_el) and not _has_table(content_el):
            node = {
                "type": node_type,
                "num": num,
                "heading": heading,
                "text": _text_with_refs(content_el, fn),
            }
            notes = fn.take()
            if notes:
                node["children"] = notes
            return node
        children_out: list[dict[str, Any]] = fn.take()  # footnotes carried by the heading
        for child in el:
            if child is num_el or child is heading_el:
                continue
            block = _parse_content_block(child, fn)
            if block is None:
                continue
            if isinstance(block, list):
                children_out.extend(block)
            else:
                children_out.append(block)
        return {
            "type": node_type,
            "num": num,
            "heading": heading,
            "children": children_out,
        }
    return None


def _with_footnotes(node: dict[str, Any], fn: _Footnotes) -> dict[str, Any] | list[dict[str, Any]]:
    notes = fn.take()
    return [node, *notes] if notes else node


def _parse_notes(notes_el) -> list[dict[str, Any]]:
    if notes_el is None:
        return []
    out: list[dict[str, Any]] = []
    for note_el in notes_el.findall("u:note", NS):
        heading_el = note_el.find("u:heading", NS)
        blocks: list[dict[str, Any]] = []
        for child in note_el:
            if child is heading_el:
                continue
            tag = _tag(child)
            if tag == "p":
                blocks.append({"type": "p", "text": _text(child)})
            else:
                # collect other note children as generic blocks
                blocks.append({"type": tag, "text": _text(child)})
        out.append({"heading": _text(heading_el), "blocks": blocks})
    return out


def _section_id(identifier: str) -> str:
    """'/us/usc/t15/s77a' → 's-77a'."""
    return "s-" + identifier.rsplit("/s", 1)[-1]


def _parse_section(
    sec_el, cite_prefix: str, act_name: str | None,
    *, statute_chapters=None, pub_laws=None, usc_chapter: str = "",
) -> dict[str, Any]:
    identifier = sec_el.get("identifier", "")
    num_el = sec_el.find("u:num", NS)
    heading_el = sec_el.find("u:heading", NS)
    num_val = num_el.get("value", "") if num_el is not None else ""
    fn = _Footnotes()
    heading_text = _text(heading_el, fn)
    status = "repealed" if (
        "[Repealed]" in heading_text or "[Reserved]" in heading_text
        or "Repealed." in heading_text or "Reserved." in heading_text
    ) else "active"

    # Walk immediate children that are content-bearing
    content: list[dict[str, Any]] = fn.take()  # footnotes carried by the section heading
    for child in sec_el:
        if child is num_el or child is heading_el:
            continue
        tag = _tag(child)
        if tag in ("sourceCredit", "notes"):
            continue
        block = _parse_content_block(child, fn)
        if block is None:
            continue
        if isinstance(block, list):
            content.extend(block)
        else:
            content.append(block)

    sc_el = sec_el.find("u:sourceCredit", NS)
    source_credit = _text(sc_el) if sc_el is not None else ""
    original = (
        original_for_section(
            source_credit, usc_chapter, act_name=act_name,
            statute_chapters=statute_chapters, pub_laws=pub_laws,
        ) if (source_credit and act_name) else None
    )

    notes_el = sec_el.find("u:notes", NS)
    notes = _parse_notes(notes_el)

    return {
        "id": _section_id(identifier),
        "codified": {"num": num_val, "cite": f"{cite_prefix} \u00a7 {num_val}"},
        "original": original,
        "heading": heading_text,
        "status": status,
        "content": content,
        "source_credit": source_credit,
        "notes": notes,
    }


def _chapter_id(chapter_el, usc_title: str) -> str:
    identifier = chapter_el.get("identifier", "")
    return f"{usc_title}/" + identifier.rsplit("/ch", 1)[-1]


def _usc_range(cite_prefix: str, sections: list[dict[str, Any]]) -> str:
    """'15 U.S.C. §§ 77a–77aa' (or 'to' when an endpoint itself contains a dash)."""
    nums = [s["codified"]["num"] for s in sections]
    if not nums:
        return ""
    first, last = nums[0], nums[-1]
    if first == last:
        return f"{cite_prefix} \u00a7 {first}"
    joiner = " to " if re.search(r"[-\u2013]", first + last) else "\u2013"
    return f"{cite_prefix} \u00a7\u00a7 {first}{joiner}{last}"


def _division_label(div_el, acronyms) -> str:
    kind = _tag(div_el).capitalize()
    num_el = div_el.find("u:num", NS)
    num = num_el.get("value", "") if num_el is not None else ""
    heading = smart_title(_text(div_el.find("u:heading", NS)), acronyms)
    return f"{kind} {num}\u2014{heading}" if heading else f"{kind} {num}"


def _section_els(container):
    """Real sections of a chapter/subchapter, in document order (never the
    sections quoted inside statutory notes)."""
    return container.xpath(
        ".//u:section[not(ancestor::u:note) and not(ancestor::u:notes)]", namespaces=NS
    )


def parse_title(xml_path: Path, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Parse a USLM title XML into {acts: [...]} per the corpus config.

    `config` is a full corpus config dict (see corpus_config.load_config);
    None means the securities default.

    One act is built per target chapter; `uslm.split_acts` carves a subchapter
    that is really a separate act (the Trust Indenture Act is subchapter III of
    chapter 2A, the Investment Advisers Act is subchapter II of chapter 2D) out
    of its chapter into its own act with a new id. The chapter's own act keeps
    its id (`act-ch2A`) and the remaining sections. Acts come back sorted by
    `order`.
    """
    cfg = config or default_config()
    uslm = cfg["uslm"]
    usc_title = str(uslm["title"])
    target_chapters = set(uslm["target_chapters"])
    cite_prefix = uslm["cite_prefix"]
    act_names = uslm["act_names"]
    act_meta = uslm.get("act_meta", {})
    splits = uslm.get("split_acts", [])
    acronyms = cfg.get("ecfr", {}).get("acronyms", [])

    tree = etree.parse(str(xml_path))
    root = tree.getroot()
    acts: list[dict[str, Any]] = []

    def build_act(spec: dict[str, Any], sections_els, division_els) -> dict[str, Any]:
        sections = [
            _parse_section(
                s, cite_prefix, spec.get("original_act_name"),
                statute_chapters=spec.get("original_statute_chapters"),
                pub_laws=spec.get("original_pub_laws"),
                usc_chapter=spec["usc_chapter"],
            )
            for s in sections_els
        ]
        act: dict[str, Any] = {
            "id": spec["id"],
            "short_title": spec["short_title"],
            "usc_chapter": spec["usc_chapter"],
            "pub_law": "",
            "stat_cite": "",
            "original_name_short": spec.get("original_name_short", spec["short_title"]),
            "order": spec.get("order", len(acts) + 1),  # unconfigured: document order
            "usc_range": _usc_range(cite_prefix, sections),
        }
        if spec.get("subchapter"):
            act["usc_subchapter"] = spec["subchapter"]
        if spec.get("share_key"):
            act["share_key"] = spec["share_key"]
        divisions = _divisions(spec, sections_els, division_els, sections)
        if divisions:
            act["divisions"] = divisions
        act["sections"] = sections
        return act

    def _divisions(spec, sections_els, division_els, sections):
        """Subchapter/part divisions of this act, as a partition of its
        sections (sections before the first division go in a leading
        'General provisions' division). Only emitted when there are two or
        more; a lone subchapter is the whole act."""
        if len(division_els) < 1:
            return []
        id_of = {el.get("identifier"): s["id"] for el, s in zip(sections_els, sections)}
        by_div: list[list[str]] = [
            [id_of[s.get("identifier")] for s in _section_els(d) if s.get("identifier") in id_of]
            for d in division_els
        ]
        in_div = {sid for ids in by_div for sid in ids}
        leading = [s["id"] for s in sections if s["id"] not in in_div]
        divs: list[dict[str, Any]] = []
        if leading:
            divs.append({"id": f"{spec['id']}-general", "label": "General provisions", "sections": leading})
        for d, ids in zip(division_els, by_div):
            if ids:
                divs.append({
                    "id": f"{spec['id']}-" + d.get("identifier", "").rsplit("/", 1)[-1],
                    "label": _division_label(d, acronyms),
                    "sections": ids,
                })
        return divs if len(divs) >= 2 else []

    for chapter_el in root.iter(f"{NS_URI}chapter"):
        ch_id = _chapter_id(chapter_el, usc_title)
        chap_num = ch_id.split("/", 1)[1]
        if chap_num not in target_chapters:
            continue
        heading_el = chapter_el.find("u:heading", NS)
        chapter_splits = [sp for sp in splits if sp["usc_chapter"] == ch_id]
        split_subs = {sp["subchapter"] for sp in chapter_splits}
        meta = act_meta.get(ch_id, {})
        main_spec = {
            "id": f"act-ch{chap_num}",
            "usc_chapter": ch_id,
            "short_title": act_names.get(ch_id, smart_title(_text(heading_el), acronyms)),
            # the original-numbering name; unnamed chapters get no original cites
            "original_act_name": act_names.get(ch_id),
            **meta,
        }
        divisions_all = [
            d for d in chapter_el
            if isinstance(d.tag, str) and _tag(d) in ("subchapter", "part")
        ]

        def sub_id(el):
            return el.get("identifier", "").rsplit("/", 1)[-1]

        main_divs = [d for d in divisions_all if sub_id(d) not in split_subs]
        main_secs = [
            s for s in _section_els(chapter_el)
            if not any(
                _tag(a) in ("subchapter", "part") and sub_id(a) in split_subs
                for a in s.iterancestors()
            )
        ]
        acts.append(build_act(main_spec, main_secs, main_divs))
        for sp in chapter_splits:
            sub_el = next((d for d in divisions_all if sub_id(d) == sp["subchapter"]), None)
            if sub_el is None:
                raise ValueError(f"split_acts: {ch_id} has no subchapter {sp['subchapter']!r}")
            acts.append(build_act({**sp, "original_act_name": sp["short_title"]},
                                  _section_els(sub_el), []))
    acts.sort(key=lambda a: a["order"])  # stable: ties keep document order
    return {"acts": acts}
