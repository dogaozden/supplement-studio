"""Structural checks for a generated supplement PDF (shared by the Typst CLI
test and the browser e2e test).

check_book(pdf_path) runs the typesetting checks that need no document JSON
(heads and folios against /PageLabels, recto openers, blanks only before
openers, overprint, '.—.', broken designators, one-word title lines, an even
body rhythm); check_pdf runs it too. It also guards the committed landing
sample (test_sample_pdf.py, scripts/gen_samples.py).

check_pdf(pdf_path, doc, prov_pages) verifies, against the document JSON that
produced the PDF (builder/pdf/document.js) and the provision -> page map
(Typst query of <provpage>):

- the PDF outline (bookmarks) holds every part and every provision, in order,
  each pointing at the page where the provision starts;
- every contents entry is a link that lands on its provision's page;
- every in-text internal link lands inside the page span of the provision it
  names (cross-references like "section 77e of this title" / "§ 230.502(a)");
- every external link is an official-source permalink (govinfo.gov's U.S. Code
  link service, ecfr.gov);
- the file is tagged (StructTreeRoot, MarkInfo/Marked), has a language, a
  title, and embeds EB Garamond.
Returns a dict of counts for reporting; raises AssertionError with details.
"""
import re
from collections import Counter

import pdfplumber
from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject

ALLOWED_EXTERNAL = ("https://www.govinfo.gov/link/uscode/", "https://www.ecfr.gov/current/title-")


def _page_index_map(reader):
    return {p.indirect_reference.idnum: i for i, p in enumerate(reader.pages)}


def _dest_page(reader, pidx, dest):
    if isinstance(dest, IndirectObject):
        dest = dest.get_object()
    if isinstance(dest, (str, bytes)) or hasattr(dest, "original_bytes"):
        name = str(dest)
        nd = reader.named_destinations.get(name)
        return reader.get_destination_page_number(nd) if nd is not None else None
    if isinstance(dest, ArrayObject) and dest:
        ref = dest[0]
        if isinstance(ref, IndirectObject):
            return pidx.get(ref.idnum)
        if isinstance(ref, int):
            return int(ref)
    return None


def links(reader):
    """[(page_index, rect, kind, target)] kind in {"int", "ext"}."""
    pidx = _page_index_map(reader)
    out = []
    for i, page in enumerate(reader.pages):
        for a in page.get("/Annots") or []:
            a = a.get_object()
            if a.get("/Subtype") != "/Link":
                continue
            rect = [float(x) for x in a["/Rect"]]
            act = a.get("/A")
            act = act.get_object() if act is not None else None
            if isinstance(act, DictionaryObject) and act.get("/S") == "/URI":
                out.append((i, rect, "ext", str(act["/URI"])))
            elif isinstance(act, DictionaryObject) and act.get("/S") == "/GoTo":
                out.append((i, rect, "int", _dest_page(reader, pidx, act["/D"])))
            elif "/Dest" in a:
                out.append((i, rect, "int", _dest_page(reader, pidx, a["/Dest"])))
    return out


def outline(reader):
    flat = []

    def walk(items, depth):
        for it in items:
            if isinstance(it, list):
                walk(it, depth + 1)
            else:
                flat.append((depth, it.title, reader.get_destination_page_number(it)))
    walk(reader.outline, 0)
    return flat


def rect_text(plumber_pdf, page_index, rect):
    page = plumber_pdf.pages[page_index]
    x0, y0, x1, y1 = rect
    h = float(page.height)
    box = (max(0, x0 - 0.5), max(0, h - y1 - 0.5), min(float(page.width), x1 + 0.5), min(h, h - y0 + 0.5))
    try:
        return (page.within_bbox(box).extract_text() or "").replace("\n", " ").strip()
    except ValueError:
        return ""


def _overprinted(page):
    """Characters printed over other characters: two words set in the same place.
    Character boxes, not words: pdfplumber merges colliding words into one
    ("NamGreant"). Two glyphs overprint when their boxes share more than a third
    of the narrower one's width (kerning never does) and most of their height."""
    chars = [c for c in page.chars if c["text"].strip()]
    bands = {}
    for i, c in enumerate(chars):
        bands.setdefault(int(c["top"] // 3), []).append(i)
    seen, out = set(), []
    for k, ids in bands.items():
        pool = sorted(set(ids + bands.get(k + 1, [])), key=lambda i: chars[i]["x0"])
        for n, i in enumerate(pool):
            a = chars[i]
            for j in pool[n + 1:]:
                b = chars[j]
                if b["x0"] >= a["x1"]:
                    break
                dx = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
                dy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
                narrow = min(a["x1"] - a["x0"], b["x1"] - b["x0"])
                short = min(a["bottom"] - a["top"], b["bottom"] - b["top"])
                if dx > max(1.0, narrow / 3) and dy > short * 0.5 and (i, j) not in seen:
                    seen.add((i, j))
                    out.append((a["text"], b["text"]))
    return out


def check_book(pdf_path):
    """Book-level typesetting checks that need no document JSON, so they also
    run on the committed landing sample (gen_samples.py, test_sample_pdf.py).
    From the first part opener on:

    - every page with text has a running head whose folio is the page's label
      (/PageLabels), except part openers;
    - part openers (and the Table of Sections) start on rectos; a page left
      blank is always the verso before an opener;
    - no word prints over another;
    - no ".—." and no designator broken at its hyphen ("Form 8-/K");
    - a part title on its opener has no line holding a single word;
    - the body rhythm is even: a paragraph break is one line, within 0.6 pt;
    - few justified lines are left short: at most 2.5 in 1,000 body lines end
      20 pt or more short of the measure in the middle of a paragraph;
    - the right edge is straight: at most 1 in 1,000 mid-paragraph lines ends
      1.5–20 pt inside the measure (a paragraph set narrower than the page);
    - no word of three or more letters is set below 5.9 pt (tables shrink to fit).
    Returns counts; raises AssertionError listing every kind of failure."""
    reader = PdfReader(str(pdf_path))
    n = len(reader.pages)
    labels = reader.page_labels
    openers = sorted(pg for d, t, pg in outline(reader) if d == 0 and t != "Contents")
    assert openers, "no part openers in the outline"
    bad = {k: [] for k in ("headless", "folio", "verso opener", "stray blank", "overprint",
                           "'.—.'", "designator broken", "one-word title line")}
    bad["verso opener"] = [i + 1 for i in openers if (i + 1) % 2 == 0]
    line_gaps, para_gaps = [], []
    body_lines, short_lines, wobble, tiny = 0, [], [], []
    with pdfplumber.open(str(pdf_path)) as pp:
        for i in range(openers[0], n):
            page = pp.pages[i]
            text = page.extract_text() or ""
            bad["overprint"] += [(i + 1, a, b) for a, b in _overprinted(page)]
            if ".\u2014." in text:
                bad["'.—.'"].append(i + 1)
            lines = [l.strip() for l in text.split("\n")]
            for a, b in zip(lines, lines[1:]):
                if (re.search(r"(?:^|\s)(?:\d[0-9A-Za-z]{0,3}|[A-Z]{1,3})-$", a) and re.match(r"[A-Z0-9]{1,4}\b", b)) \
                        or (re.search(r"(?:^|\s)N/$", a) and b.startswith("A")):
                    bad["designator broken"].append((i + 1, a[-12:], b[:8]))
            words = page.extract_words(extra_attrs=["size", "fontname"])
            tiny += [(i + 1, w["text"], round(w["size"], 1)) for w in words
                     if w["size"] < 5.9 and sum(ch.isalpha() for ch in w["text"]) >= 3]
            if i in openers:
                rows = {}
                for w in words:
                    if w["size"] > 18:
                        rows.setdefault(round(w["top"]), []).append(w["text"])
                if len(rows) > 1 and any(len(r) == 1 for r in rows.values()):
                    bad["one-word title line"].append((i + 1, [" ".join(r) for r in rows.values()]))
                continue
            if not text.strip():
                if i + 1 not in openers:
                    bad["stray blank"].append(i + 1)
                continue
            band = [w["text"] for w in words if w["bottom"] < 62]
            if not band:
                bad["headless"].append(i + 1)
            elif labels[i] not in band:
                bad["folio"].append((i + 1, labels[i], band[-3:]))
            # rhythm: baseline steps between body lines, inside a paragraph vs at a "(x)" break
            sizes = Counter(round(w["size"], 1) for w in words if w["bottom"] >= 62)
            if not sizes:
                continue
            body = sizes.most_common(1)[0][0]
            rows = {}
            for w in words:
                if w["bottom"] >= 62 and abs(w["size"] - body) < 0.2:
                    rows.setdefault(round(w["bottom"], 1), []).append(w)
            ys = sorted(rows)
            right = sorted(max(w["x1"] for w in rows[y]) for y in ys)[-3] if len(ys) >= 5 else None
            edges = Counter(round(max(w["x1"] for w in rows[y]), 1) for y in ys)
            measure = edges.most_common(1)[0][0] if ys else None
            for y0, y1 in zip(ys, ys[1:]):
                step = y1 - y0
                if step > body * 1.6:
                    continue                          # a heading, table or note between
                a = sorted(rows[y0], key=lambda w: w["x0"])
                b = sorted(rows[y1], key=lambda w: w["x0"])
                first = b[0]["text"]
                (para_gaps if re.match(r"\([0-9A-Za-z]{1,5}\)", first) else line_gaps).append(step)
                # a justified line in mid-paragraph (the next line continues it) left short
                body_lines += 1
                # (the sentence runs on: the next line starts in lower case; headings are ragged by design)
                if right and step < body * 1.4 and b[0]["x0"] >= a[0]["x0"] - 0.5 and first[:1].islower() \
                        and len(a) >= 5 and a[-1]["x1"] < right - 20 and not a[-1]["text"].endswith((".", ":", ";")) \
                        and not any("Bold" in w.get("fontname", "") for w in a):
                    short_lines.append((i + 1, " ".join(w["text"] for w in a)[-30:]))
                if measure and step < body * 1.4 and first[:1].islower() and len(a) >= 5 \
                        and not any("Bold" in w.get("fontname", "") for w in a) \
                        and 1.5 < measure - a[-1]["x1"] < 20:
                    wobble.append((i + 1, round(measure - a[-1]["x1"], 1), " ".join(w["text"] for w in a)[-30:]))
    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else 0.0
    rhythm = (round(med(line_gaps), 2), round(med(para_gaps), 2))
    problems = {k: v for k, v in bad.items() if v}
    if line_gaps and para_gaps and abs(rhythm[0] - rhythm[1]) > 0.6:
        problems["uneven rhythm (line, paragraph)"] = [rhythm]
    if body_lines and len(short_lines) * 1000 > 2.5 * body_lines:
        problems[f"short justified lines ({len(short_lines)} in {body_lines})"] = short_lines
    if body_lines and len(wobble) * 1000 > 1 * body_lines:
        problems[f"ragged right edge ({len(wobble)} in {body_lines})"] = wobble
    if tiny:
        problems["type below 5.9 pt"] = tiny
    assert not problems, "; ".join(f"{k}: {len(v)} e.g. {v[:3]}" for k, v in problems.items())
    return {"pages": n, "openers": len(openers), "rhythm": rhythm,
            "short_lines": f"{len(short_lines)}/{body_lines}", "ragged": len(wobble)}


def check_pdf(pdf_path, doc, prov_pages):
    reader = PdfReader(str(pdf_path))
    n_pages = len(reader.pages)
    items = [it for p in doc["parts"] for it in p["items"]]
    labs = [it["lab"] for it in items]
    # Typst page numbers are 1-based physical pages
    start = {lab: prov_pages[lab] - 1 for lab in labs}
    order = sorted(labs, key=lambda l: start[l])
    nxt = {l: (start[order[i + 1]] if i + 1 < len(order) else n_pages - 1) for i, l in enumerate(order)}

    # ── tagging, metadata, fonts
    root = reader.trailer["/Root"]
    assert "/StructTreeRoot" in root, "PDF is not tagged (no StructTreeRoot)"
    assert root.get("/MarkInfo", {}).get("/Marked"), "MarkInfo/Marked missing"
    assert str(root.get("/Lang", "")).startswith("en"), "document language missing"
    assert root.get("/PageMode") == "/UseOutlines", "PDF should open with the bookmarks panel"
    assert (reader.metadata or {}).get("/Title") == doc["meta"]["title"], "PDF title metadata"
    fonts = set()
    for page in reader.pages[: min(n_pages, 8)]:
        res = page.get("/Resources") or {}
        for f in (res.get("/Font") or {}).values():
            fonts.add(str(f.get_object().get("/BaseFont")))
    assert any("EBGaramond" in f or "EB Garamond" in f for f in fonts), f"EB Garamond not embedded: {fonts}"

    # ── heads, folios, openers, blanks, overprint, designators, rhythm
    book = check_book(pdf_path)

    # ── outline
    ol = outline(reader)
    titles = [t for _, t, _ in ol]
    for part in doc["parts"]:
        assert any(t.startswith(part["kicker"]) for t in titles), f"part missing from outline: {part['title']}"
    prov_marks = [(t, pg) for d, t, pg in ol if d >= 1]
    for it in items:
        want = f"{it['num']}  {it['head']}".replace("\u2060", "")   # bookmarks drop the em-dash joiner
        hits = [pg for t, pg in prov_marks if t.strip() == want.strip()]
        assert hits, f"outline entry missing: {want!r}"
        assert start[it["lab"]] in hits, f"outline {want!r} -> page {hits}, provision starts on {start[it['lab']]}"

    # ── links
    all_links = links(reader)
    ext = [l for l in all_links if l[2] == "ext"]
    bad_ext = [u for _, _, _, u in ext if not u.startswith(ALLOWED_EXTERNAL)]
    assert not bad_ext, f"non-official external links: {bad_ext[:5]}"
    ints = [l for l in all_links if l[2] == "int"]
    assert all(l[3] is not None for l in ints), "internal link without a resolvable destination"

    # contents entries: the first internal links, in order, on the contents pages
    contents_pages = sorted({pg for d, t, pg in ol if t == "Contents"})
    body_first = min(start.values())
    toc_links = [l for l in ints if contents_pages and contents_pages[0] <= l[0] < body_first]
    toc_targets = Counter(l[3] for l in toc_links)
    for lab in labs:
        assert toc_targets[start[lab]] >= 1, f"no contents link to {lab} (page {start[lab]})"

    # in-text cross-references: link text names its target provision
    by_num = {}
    for it in items:
        num = it["lab"]
        if num.startswith("s-"):
            by_num[("usc", num[2:])] = num
        elif num.startswith("r-"):
            m = re.match(r"r-(\d+)-(.+)$", num)
            by_num[("cfr", f"{m.group(1)}.{m.group(2)}")] = num
    checked = wrong = 0
    errors = []
    with pdfplumber.open(str(pdf_path)) as pp:
        for pi, rect, _, dest in ints:
            if pi < body_first:
                continue
            text = rect_text(pp, pi, rect)
            m = re.search(r"(?:section|§)\s*(\d+[a-z]*(?:[–-]\d+[a-z]*)?)(?:\(|\s+of this title)", text)
            m2 = re.search(r"§\s*(\d{3})\.([0-9][\w-]*?)(?:\(|$|\s)", text)
            target = None
            if m and ("of this title" in text or "U.S.C" in text) and ("usc", m.group(1).replace("-", "–")) in by_num:
                target = by_num[("usc", m.group(1).replace("-", "–"))]
            elif m2 and ("cfr", f"{m2.group(1)}.{m2.group(2)}") in by_num:
                target = by_num[("cfr", f"{m2.group(1)}.{m2.group(2)}")]
            if not target:
                continue
            checked += 1
            if not (start[target] <= dest <= nxt[target]):
                wrong += 1
                errors.append((pi, text, target, dest, start[target], nxt[target]))
    assert checked >= 10, f"too few in-text cross-references verified ({checked})"
    assert not errors, f"{wrong}/{checked} cross-references land outside their target: {errors[:5]}"
    return {
        "pages": n_pages, "outline": len(ol), "internal_links": len(ints), "external_links": len(ext),
        "contents_links": len(toc_links), "xrefs_verified": checked, "fonts": sorted(fonts)[:4],
    }
