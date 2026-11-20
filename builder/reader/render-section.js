// Client-side port of pipeline/build_reader.py's section renderer.
//
// CONTRACT (docs/contracts.md §7): renderProvision() must produce
// BYTE-IDENTICAL output to build_reader.py's build_provision() — both the
// section HTML string and the `texts` array (annotation anchor text).
// Enforced by builder/tests/test_reader_parity.py. Any change here must be
// mirrored in pipeline/build_reader.py and re-verified with that test.
//
// Pure strings, no DOM — runs in the browser and in Node.

export const MAX_DEPTH = 6;

// Python str.strip() whitespace set (characters where str.isspace() is
// True). Differs from JS String.trim(): Python also strips the file/group/
// record/unit separators (\x1c-\x1f) and NEL (\x85); JS trim() strips BOM
// (﻿) which Python does not. We mirror Python exactly.
const PY_WS =
  "\\t\\n\\x0b\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

function pyStrip(s) {
  return s.replace(PY_STRIP_RE, "");
}

// Mirrors python html.escape(s, quote=False): ampersand first, then angles.
export function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Mirrors python html.escape(s, quote=True) — used for attribute values.
export function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

// Mirrors build_reader.py XREF_RE (re.S — dot matches newline).
const XREF_RE = /<a class="xref" data-to="([^"]*)">([\s\S]*?)<\/a>/g;

// Mirrors CODIFIED_REF_RE — note the literal en-dash (U+2013) in ids.
const CODIFIED_REF_RE =
  /section (\d+[a-z]+(?:–\d+)?)((?:\([^()]*\))*) of this title/g;

// 'section 77e(c) of this title' -> 'section 5(c)' when known.
// xrefDisplay: plain object, codified num ('77e') -> original display ('5').
export function displayRef(inner, xrefDisplay = {}) {
  return inner.replace(CODIFIED_REF_RE, (m0, num, parens) => {
    const orig = xrefDisplay[num];
    if (!orig) return m0;
    return `section ${orig}${parens}`;
  });
}

// Plain-text view of corpus text (xref tags removed, inner kept,
// references shown in original act numbering).
export function stripXrefs(s, xrefDisplay = {}) {
  return s.replace(XREF_RE, (m0, to, inner) => displayRef(inner, xrefDisplay));
}

// Escape text but turn corpus xref tags into real links. The link target
// keeps only the section part of paths like 's-77e/c'; textContent is
// identical to stripXrefs(s), so annotation anchoring is unaffected.
export function renderRich(s, xrefDisplay = {}) {
  const out = [];
  let last = 0;
  XREF_RE.lastIndex = 0;
  let m;
  while ((m = XREF_RE.exec(s)) !== null) {
    out.push(esc(s.slice(last, m.index)));
    const target = m[1].split("/")[0];
    if (target) {
      out.push(
        `<a class="xref" href="#${escAttr(target)}" ` +
          `data-to="${escAttr(m[1])}">${esc(displayRef(m[2], xrefDisplay))}</a>`
      );
    } else {
      // footnote-style marker with no target — plain text
      out.push(esc(m[2]));
    }
    last = m.index + m[0].length;
  }
  out.push(esc(s.slice(last)));
  return out.join("");
}

// Renders one provision's content tree to flat hanging-indent paragraphs,
// and collects the plain text in identical order (build_reader.py
// SectionRenderer).
class SectionRenderer {
  constructor(xrefDisplay) {
    this.parts = [];
    this.texts = [];
    this.xrefDisplay = xrefDisplay;
    this.runIn = false; // the next paragraph closes an open run-in wrapper
  }

  textOf(node) {
    return pyStrip(node.text || "");
  }

  emitP(depth, { num = null, heading = null, text = "", cls = "", open = "" } = {}) {
    const d = Math.min(depth, MAX_DEPTH);
    const bits = open ? [open] : [];
    bits.push(`<p class="t d${d}${cls ? " " + cls : ""}">`);
    const plain = [];
    if (num) {
      bits.push(`<span class="n">(${esc(num)})</span> `);
      plain.push(`(${num})`);
    }
    if (heading) {
      heading = stripXrefs(heading, this.xrefDisplay);
      bits.push(`<span class="nh">${esc(heading)}</span> `);
      plain.push(heading);
    }
    if (text) {
      bits.push(renderRich(text, this.xrefDisplay));
      plain.push(stripXrefs(text, this.xrefDisplay));
    }
    bits.push("</p>");
    this.parts.push(bits.join(""));
    if (plain.length) this.texts.push(plain.join(" "));
  }

  render(node, depth) {
    const t = node.type;
    if (
      t === "subsection" || t === "paragraph" || t === "subparagraph" ||
      t === "clause" || t === "subclause" || t === "item"
    ) {
      const num = pyStrip(node.num || "");
      const heading = pyStrip(node.heading || "");
      const text = this.textOf(node);
      if (num || heading || text) {
        // A division with no words of its own whose first child is a plain
        // paragraph runs that paragraph in after its number and heading
        // ("(a) Definitions. When used in …"), as the PDF sets it. The two
        // <p>s stay separate (same text nodes, same "\n" between them); the
        // wrapper <div class="ri"> only lets CSS set them as one block with
        // a hanging indent. Nothing here touches the anchor text.
        const first = (node.children || [])[0];
        const runIn = !text && !!(num || heading) && !!first &&
          (first.type === "chapeau" || (first.type === "p" && !first.role)) &&
          this.textOf(first) !== "";
        this.emitP(depth, {
          num: num || null,
          // official run-in headings already end ".—" / "—" / ":" ("… requirement.—"): no extra period
          heading: heading ? (/[.:\u2014-]$/.test(heading) ? heading : heading + ".") : null,
          text,
          open: runIn ? `<div class="ri d${Math.min(depth, MAX_DEPTH)}">` : "",
        });
        this.runIn = runIn;
      }
      for (const child of node.children || []) this.render(child, depth + 1);
    } else if (t === "p" || t === "chapeau" || t === "continuation") {
      const text = this.textOf(node);
      if (text) {
        // chapeau/continuation sit at the parent's depth
        this.emitP(
          t === "continuation" ? Math.max(depth - 1, 0) : depth,
          { text }
        );
        if (this.runIn) { // closes the wrapper the division above opened
          this.parts[this.parts.length - 1] += "</div>";
          this.runIn = false;
        }
      }
    } else if (t === "signature") {
      const text = this.textOf(node);
      if (text) this.emitP(depth, { text, cls: "sig" });
    } else if (t === "table") {
      this.parts.push(`<div class="tbl">${node.html ?? ""}</div>`);
      // plain text of tables intentionally omitted from anchor text
    } else {
      for (const child of node.children || []) this.render(child, depth + 1);
    }
  }
}

// Render one <section>. Mirrors build_reader.py build_provision().
// Returns {html, texts, meta}. xrefDisplay is passed in (no module state).
export function renderProvision(item, prov, kind, groupLabel, xrefDisplay = {}) {
  const r = new SectionRenderer(xrefDisplay);
  for (const node of prov.content || []) r.render(node, 1);

  const cid = prov.id;
  const oldId = item.old_id ?? "";
  const display = item.display;

  let citeLine;
  if (kind === "usc") {
    const cite = (prov.codified || {}).cite || "";
    const alt = (prov.original || {}).cite || "";
    citeLine = [cite, alt].filter((x) => x).join(" · ");
  } else {
    citeLine = prov.cite || "";
    const common = prov.common_name || "";
    if (common && !display.toLowerCase().includes(common.toLowerCase())) {
      citeLine = citeLine ? `${citeLine} · ${common}` : common;
    }
  }

  // "(Item 402) Executive compensation": the label already says "Item 402"
  const heading = pyStrip(
    stripXrefs(prov.heading || "", xrefDisplay)
  ).replace(/\.+$/, "").replace(/^\(Item [^)]+\)\s*/, "");
  const credit = pyStrip(stripXrefs(prov.source_credit || "", xrefDisplay));

  const headHtml =
    `<header class="prov-head">` +
    `<h2 class="prov-title"><span class="prov-num">${esc(display)}</span>` +
    `<span class="prov-name">${esc(heading)}</span></h2>` +
    `<div class="prov-cite">${esc(citeLine)}</div>` +
    `</header>`;
  const creditHtml = credit
    ? `<footer class="prov-credit">${esc(credit)}</footer>`
    : "";
  const bodyHtml = r.parts.join("\n"); // the newline becomes a DOM text node:
  // part of the anchoring contract (docs/contracts.md §7) — never change it
  const html =
    `<section class="prov" id="${esc(cid)}" data-old-id="${esc(oldId)}" ` +
    `data-display="${esc(display)}" data-group="${esc(groupLabel)}">` +
    `${headHtml}<div class="prov-body">\n${bodyHtml}\n</div>${creditHtml}</section>`;

  const meta = {
    id: cid,
    old_id: oldId,
    display,
    heading,
    group: groupLabel,
  };
  return { html, texts: r.texts, meta };
}
