// Selection + corpus -> the typesetting document (plain JSON) that the Typst
// template (builder/pdf/supplement.typ) renders. Pure ESM, no DOM: the same
// module runs in the browser worker and in Node (samples, tests).
//
// Everything editorial happens here, in one place: part grouping (model.js),
// numbering mode, cross-reference resolution (internal link / official-source
// link), anchors, the Table of Sections, the currency and colophon lines. The
// template only lays out what it is given and never interprets legal text.
//
// Document shape (consumed by supplement.typ; keep in sync):
// {
//   meta:  { title, subtitle, course, term, professor, school, trim, numbering,
//            sourceCredits, colophon, product, currency, sources[], verification,
//            generated, counts{provisions,statutes,rules,parts}, linkNote },
//   parts: [{ lab, kicker, title, sub, kind,
//             items: [{ lab, kind, num, num2, url, head, run, credit, sub, repealed,
//                       body: [ para | table ] }] }],
//   index: { statutes: [{ title, rows: [{ a, b, lab }] }],
//            rules:    [{ title, rows: [{ a, b, lab }] }] }
// }
// para  = { k: "p", l: level 0-6, n: "(a)"|null, h: heading|null, r: runs,
//           a: anchor label|null, s: null|"cont"|"note"|"noteh"|"subh"|"fn"|"intro" }
// table = { k: "t", l: level, rows: [[{ r: runs, h: bool, hr?: bool, cs, rs }]], w: [column weight] }
//           (hr: the "(a) … (j)" column-letter row that repeats with the header; w: relative
//           widths the template uses for wide tables, see colWeights)
// runs  = [ "plain text" | { t, l: label } | { t, u: url } | { t, i: true } | { t, sup: true }
//           | { fn: [text] } ]

import { groupSelection, sortIntoCodeOrder, splitPartTitle, partKicker, partNumberStyle, groupRepeatsTitle } from "../model.js";
export { splitPartTitle };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function localIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// ── official-source permalinks ───────────────────────────────────────────
const dash = s => String(s).replace(/–/g, "-");
export function uscUrl(title, section) {
  // GPO's permanent link service (govinfo.gov) resolves to the official U.S. Code;
  // uscode.house.gov's view.xhtml links stopped resolving with OLRC's 2026 site change.
  return `https://www.govinfo.gov/link/uscode/${title}/${dash(section)}?link-type=html`;
}
export function ecfrUrl(title, section, para = "") {
  const base = `https://www.ecfr.gov/current/title-${title}/section-${section}`;
  return para ? `${base}#p-${section}${para}` : base;
}

// ── HTML-ish corpus text -> runs ─────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// -> [{t, to?, i?, sup?}]
export function tokenize(html) {
  const out = [];
  const re = /<a\b[^>]*data-to="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<(i|em)>([\s\S]*?)<\/\3>|<sup[^>]*>([\s\S]*?)<\/sup>|<[^>]+>/gi;
  let last = 0, m;
  const text = String(html || "");
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: decode(text.slice(last, m.index)) });
    if (m[1] !== undefined) out.push({ t: decode(m[2].replace(/<[^>]+>/g, "")), to: decode(m[1]) });
    else if (m[3]) out.push({ t: decode(m[4].replace(/<[^>]+>/g, "")), i: true });
    else if (m[5] !== undefined) out.push({ t: decode(m[5].replace(/<[^>]+>/g, "")), sup: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: decode(text.slice(last)) });
  return out.filter(x => x.t !== "");
}

// ── document builder ─────────────────────────────────────────────────────
export function buildDocument(state, ctx, opts = {}) {
  const { corpus, index } = ctx;
  const meta0 = corpus.meta || {};
  const options = {
    trim: "letter", numbering: state.mode === "codified" ? "codified" : "original",
    sourceCredits: true, colophon: state.metadata?.includeColophon !== false,
    ...(state.options || {}),
  };
  if (state.options?.numbering) options.numbering = state.options.numbering;
  const original = options.numbering === "original";
  const uscTitle = (meta0.uscCitePrefix || "15 U.S.C.").split(" ")[0];
  const cfrTitle = (meta0.cfrCitePrefix || "17 C.F.R.").split(" ")[0];

  const groups = groupSelection(state, index);
  const included = new Set(groups.flatMap(g => g.items));

  // pass 1: anchors that will exist in the document (provision + subdivision)
  const anchors = new Set();
  for (const id of included) {
    anchors.add(id);
    collectAnchors(index.byId.get(id).content, id, anchors);
  }

  const linker = makeLinker({ index, included, anchors, original, uscTitle, cfrTitle });

  const parts = [];
  let partNo = 0;
  const numberStyle = partNumberStyle(groups.filter(g => g.items.length));
  for (const g of groups) {
    if (!g.items.length) continue;
    partNo += 1;
    const split = splitPartTitle(g.title);
    const part = {
      lab: `part-${partNo}`,
      kicker: partKicker(partNo, numberStyle),
      title: typo(split.title),
      sub: partSubtitle(g, index, meta0, original),
      kind: g.kind,
      items: [],
    };
    let lastSub = null;
    for (const id of g.items) {
      const item = index.byId.get(id);
      const prov = g.kind === "act"
        ? statuteProvision(id, item, index.actBySectionId.get(id), { original, uscTitle, linker, options })
        : ruleProvision(id, item, index, { cfrTitle, linker, options });
      const sg = index.ruleGroupById?.get(id);
      const sgObj = sg ? index.subjectGroupById.get(sg) : null;
      // a sub-group names its regulation ("Regulation C—General Requirements"); a rule in no
      // group after a grouped run gets its own line, so it never reads as part of that group
      const up = sgObj?.parent ? index.subjectGroupById.get(sgObj.parent) : null;
      let subLabel = null, subShort = null;
      if (sgObj && !groupRepeatsTitle(sgObj, g.title)) {
        subLabel = (up ? `${up.short}\u2014` : "") + (sgObj.label || sgObj.short);
        subShort = (up ? `${up.short}\u2014` : "") + (sgObj.short || sgObj.label);
      } else if (!sgObj && lastSub && g.kind === "regulation") {
        subLabel = subShort = "Other Rules";
      }
      if (subLabel && subLabel !== lastSub) { prov.sub = subLabel; prov.subShort = subShort; }
      lastSub = subLabel;
      part.items.push(prov);
    }
    parts.push(part);
  }

  const source = corpus.source || {};
  const rp = source.usc_release_point || "";
  const ecfrDate = humanDate(source.ecfr_date);

  const counts = {
    parts: parts.length,
    provisions: included.size,
    statutes: [...included].filter(id => index.actBySectionId.has(id)).length,
    rules: [...included].filter(id => index.regBySectionId.has(id)).length,
  };

  const verification = opts.verifyReport ? verificationLine(opts.verifyReport, included, corpus) : "";
  const md = state.metadata || {};
  return {
    meta: {
      title: (md.title || meta0.defaultTitle || "Statutory Supplement").trim(),
      subtitle: (md.subtitle || "").trim(),
      course: (md.course || "").trim(),
      term: (md.term || "").trim(),
      professor: (md.professor || "").trim(),
      school: (md.school || "").trim(),
      trim: ["letter", "7x10", "6x9"].includes(options.trim) ? options.trim : "letter",
      numbering: options.numbering,
      sourceCredits: options.sourceCredits !== false,
      colophon: options.colophon !== false,
      product: opts.productName || "Supplement Studio",
      currency: currencyLine(corpus),
      currencyDetail: [
        rp ? `United States Code release point ${rp} (uscode.house.gov)` : "",
        ecfrDate ? `Electronic Code of Federal Regulations as of ${ecfrDate} (ecfr.gov)` : "",
      ].filter(Boolean).join("; ") + ".",
      sources: [
        "Statutes: Office of the Law Revision Counsel, United States Code, USLM XML (uscode.house.gov).",
        "Regulations: Electronic Code of Federal Regulations, Versioner API (ecfr.gov).",
      ],
      verification,
      generated: humanDate(opts.now || localIsoDate()),
      counts,
      numberingNote: original
        ? "Sections are numbered as in the original Acts, with the U.S. Code section beneath each heading. Cross-references to these Acts that the U.S. Code writes as “section 77j of this title” are shown in Act numbering; references to other laws keep their Code form."
        : "Sections are numbered as in the United States Code, with the original Act section beneath each heading.",
      linkNote: "Cross-references are live links. A solid underline goes to a provision inside this book; a dotted underline opens the official text online (the United States Code at govinfo.gov, regulations at ecfr.gov).",
    },
    parts,
    index: buildIndex(parts, index),
  };
}

// The single currency phrase (cover, studio footer, landing page).
export function currencyLine(corpus) {
  const source = corpus?.source || {};
  const rp = source.usc_release_point || "";
  const label = source.usc_release_label || (rp ? `Public Law ${rp}` : "");
  const ecfr = humanDate(source.ecfr_date);
  const parts = [];
  if (label) parts.push(`Statutes current through ${label}`);
  if (ecfr) parts.push(`regulations current as of ${ecfr}`);
  if (!parts.length) return "";
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

// What the verification report says about THIS book's provisions.
function verificationLine(rep, included, corpus) {
  if (!rep || !rep.checked) return "";
  const src = corpus?.source || {};
  if (rep.usc_release_point && src.usc_release_point && rep.usc_release_point !== src.usc_release_point) return "";
  const bad = new Set((rep.mismatches || []).map(m => m.id));
  const spacing = new Set((rep.whitespace_only_detail || []).map(m => m.id));
  const ids = [...included];
  const n = ids.length;
  const nBad = ids.filter(id => bad.has(id)).length;
  const nSpace = ids.filter(id => spacing.has(id)).length;
  const what = n === 1 ? "The provision in this book was" : `All ${n.toLocaleString("en-US")} provisions in this book were`;
  if (nBad) return `${what} compared word for word with the official source files; ${nBad} did not match and should be checked against the source.`;
  const tail = nSpace ? ` (${nSpace} ${nSpace === 1 ? "differs" : "differ"} only in spacing)` : "";
  return `${what} compared word for word with the official source files from which they were built, and match${tail}.`;
}


function partSubtitle(g, index, meta0, original) {
  const first = index.byId.get(g.items[0]);
  if (g.kind === "act") {
    const act = index.actBySectionId.get(g.items[0]);
    const prefix = meta0.uscCitePrefix || "15 U.S.C.";
    const all = (act?.sections || []).filter(sec => sec.status !== "repealed").map(sec => sec.id);
    if (act?.usc_range && all.length && all.every(id => g.items.includes(id))) return act.usc_range;
    const ids = sortIntoCodeOrder(g.items, index);
    const num = id => index.byId.get(id)?.codified?.num || "";
    const code = ids.length === 1 ? `${prefix} § ${num(ids[0])}` : `${prefix} §§ ${num(ids[0])}–${num(ids[ids.length - 1])}`;
    const acts = ids.map(id => index.byId.get(id)?.original?.num).filter(n => /^\d/.test(n || ""));
    if (original && acts.length) {
      const span = acts.length === 1 ? `§ ${acts[0]}` : `§§ ${acts[0]}–${acts[acts.length - 1]}`;
      return `${span}${ids.length > 1 ? " (selected)" : ""}  ·  ${code}`;
    }
    return ids.length === 1 ? code : `${code} (selected)`;
  }
  if (g.kind === "regulation") {
    const reg = index.regBySectionId.get(g.items[0]);
    const part = reg?.part || (/Part (\d+)/i.exec(reg?.title || "") || [])[1] || "";
    const prefix = meta0.cfrCitePrefix || "17 C.F.R.";
    return part ? `${prefix} Part ${part}` : (first?.cite || "");
  }
  return "";
}

// ── provisions ───────────────────────────────────────────────────────────
function cleanHeading(h) {
  return typo(String(h || "").replace(/^\(Item [^)]+\)\s*/, "").replace(/\s+/g, " ").trim().replace(/\.$/, ""));
}

function statuteProvision(id, sec, act, { original, uscTitle, linker, options }) {
  const cod = sec.codified?.num || "";
  const orig = sec.original?.num || "";
  const actName = act?.short_title || "";
  const short = act?.original_name_short || shortActName(actName);
  const useOrig = original && orig;
  const numeric = /^\d/.test(orig);
  const origLabel = numeric ? `§ ${orig}` : orig;            // "§ 12" | "Schedules A, B"
  const codCite = `${uscTitle} U.S.C. § ${cod}`;
  const origCite = orig ? (numeric ? `${short} § ${orig}` : `${short}, ${orig}`) : "";
  // In Act numbering, a Code section that no section of the Act enacted (77r–1, from
  // SMMEA) is named by its Code cite, never as a bare "§ 77r–1" among Act sections.
  const num = useOrig ? origLabel : original ? codCite : `§ ${cod}`;
  const enactedBy = original && !orig ? enactingLaw(sec.source_credit) : "";
  return {
    lab: id,
    kind: "usc",
    num,
    num2: useOrig ? codCite : original ? (enactedBy ? `Not a section of the ${short}; enacted by ${enactedBy}` : `Not a section of the ${short}`) : origCite,
    url: uscUrl(uscTitle, cod),
    head: cleanHeading(sec.heading),
    run: useOrig ? `${origCite}  ·  ${codCite}` : (orig ? `§ ${cod}  ·  ${origCite}` : `§ ${cod}`),
    short: num,
    // contents label "§ 5 · 77e": the other numbering follows, bare and small
    toc: useOrig ? { a: origLabel, b: cod }
      : original ? { a: `§ ${cod}`, b: `${uscTitle} U.S.C.` }
      : { a: `§ ${cod}`, b: "" },
    credit: options.sourceCredits !== false && sec.source_credit ? typo(sec.source_credit) : null,
    repealed: sec.status === "repealed" || /^(Repealed|Omitted|Transferred)\b/.test(sec.heading || ""),
    body: flatten(sec.content, id, linker, { original, id, dropMarks: droppedFootnotes(sec.content),
      fnMap: footnoteMap(sec.content), usedFn: new Set() }),
  };
}

// "(Pub. L. 98–440, title I, § 106, Oct. 3, 1984, …)" -> "Pub. L. 98–440, title I, § 106"
function enactingLaw(credit) {
  const m = /^\((Pub\. L\. [\d–-]+(?:, (?:title|div\.) [\w]+)*, § [\w–-]+)/.exec(String(credit || ""));
  return m ? m[1] : "";
}

function shortActName(name) {
  return String(name).replace(/ of \d{4}$/, "").replace(/^Securities Exchange Act$/, "Exchange Act");
}

export function ruleName(rule, reg) {
  if (rule.short_name) return rule.short_name;
  const cn = String(rule.common_name || "").replace(/\s*\((Reg|Regulation) [^)]*\)$/, "");
  if (cn && /^(Rule|Item|Form)\b/.test(cn)) return cn.replace(/ of Regulation .*$/, "");
  const sec = String(rule.cite || "").split("§ ").pop();
  const [part, rest] = sec.split(".");
  if (!rest) return "";
  if (["230", "240", "270", "275"].includes(part)) return `Rule ${rest}`;
  if (part === "229") return `Item ${rest}`;
  return "";
}

function ruleProvision(id, rule, index, { cfrTitle, linker, options }) {
  const reg = index.regBySectionId.get(id);
  const sec = String(rule.cite || "").split("§ ").pop();
  const name = ruleName(rule, reg);
  const cite = `${cfrTitle} C.F.R. § ${sec}`;
  // Parts 239/249 hold the rules that prescribe each form, not the forms
  const formRule = /^2[34]9\./.test(sec);
  return {
    lab: id,
    kind: "cfr",
    num: name || `§ ${sec}`,
    num2: (name ? cite : "") + (formRule ? `${name ? "  ·  " : ""}the rule prescribing the form; the form itself is published by the SEC and is not part of the C.F.R.` : ""),
    url: ecfrUrl(cfrTitle, sec),
    head: cleanHeading(rule.heading),
    run: name ? `${name}  ·  § ${sec}` : `§ ${sec}`,
    short: name || `§ ${sec}`,
    toc: { a: name || `§ ${sec}`, b: name ? sec : "" },
    credit: null,
    repealed: /^\[Reserved\]$/.test(String(rule.heading || "").trim()),
    body: flatten(rule.content, id, linker, { original: false, id, dropMarks: droppedFootnotes(rule.content),
      fnMap: footnoteMap(rule.content), usedFn: new Set() }),
  };
}

// ── content flattening ───────────────────────────────────────────────────
function collectAnchors(nodes, base, set, path = []) {
  for (const n of nodes || []) {
    if (n.num) {
      const p = [...path, n.num];
      const a = `${base}/${p.join("/")}`;
      if (!set.has(a)) set.add(a);
      collectAnchors(n.children, base, set, p);
    } else {
      collectAnchors(n.children, base, set, path);
    }
  }
}

// "Instructions to Item 402(c)(2)(iii) and (iv). 1. If the amount …": the
// eCFR sets the label in italics; the corpus keeps it in the paragraph's text.
// Set it as an italic run (only when the whole label is plain text).
const INSTR_LABEL = /^(Instructions? (?:\d+ )?to [^.:]{1,90}[.:])(\s+|$)/;
function italicLabel(runs) {
  const m = typeof runs[0] === "string" ? INSTR_LABEL.exec(runs[0]) : null;
  if (!m) return runs;
  return [{ t: m[1], i: true }, m[2] + runs[0].slice(m[0].length), ...runs.slice(1)];
}

const ROLE_STYLE = { note: "note", "note-heading": "noteh", heading: "subh", footnote: "fn", omitted: "omit" };

function flatten(nodes, provId, linker, opt) {
  const out = [];
  const seen = new Set();
  let inNote = false;   // numbered instruction paragraphs that follow a note keep its style
  const walk = (list, level, path) => {
    const deferred = [];   // footnotes print after the node they annotate, not inside it
    for (const n of list || []) {
      if (n.role === "footnote") { deferred.push(n); continue; }
      if (n.role === "note" || n.role === "note-heading") inNote = true;
      else if (n.num || n.role) inNote = false;
      else if (n.type === "p" && inNote && !/^\d+\.\s/.test(n.text || "")) inNote = false;
      if (n.type === "table") {
        const rows = tableRows(n.html, linker, provId, opt);
        out.push({ k: "t", l: Math.max(0, level), rows, w: colWeights(rows), lw: longestWords(rows) });
        continue;
      }
      if (n.type === "chapeau" || n.type === "continuation" || n.type === "p") {
        const s = n.type === "continuation" ? "cont"
          : (ROLE_STYLE[n.role] || (inNote && n.type === "p" ? "note" : (level === 0 && n.type === "p" ? "intro" : null)));
        const r = linker.runs(n.text, provId, opt);
        out.push({ k: "p", l: Math.max(0, n.type === "continuation" ? level - 1 : level), n: null, h: null,
          r: s === "note" ? italicLabel(r) : r, a: null, s });
        continue;
      }
      // numbered division
      // A division with no words of its own whose first child is numbered runs
      // that child in: "(1)(i) Subject to …" (pin-cite style) instead of a lone
      // "(1)" line. Every number keeps its anchor.
      const chain = [n];
      while (chain.length < 4) {
        const c = chain[chain.length - 1];
        if (!c.num || (c.text || "").trim() || (c.heading || "").trim()) break;
        const first = (c.children || []).find(k => k.role !== "footnote");
        if (!first || !first.num) break;
        chain.push(first);
      }
      if (chain.length > 1) {
        const anchors = [];
        let pp = path;
        for (const c of chain) {
          pp = [...pp, c.num];
          const a = `${provId}/${pp.join("/")}`;
          if (!seen.has(a)) { seen.add(a); anchors.push(a); }
        }
        const last = chain[chain.length - 1];
        const lastKids = last.children || [];
        let text = last.text || "";
        let rest = lastKids;
        const lead = lastKids.findIndex(k => k.role !== "footnote");
        if (!text && lead >= 0 && (lastKids[lead].type === "chapeau" || (lastKids[lead].type === "p" && !lastKids[lead].role))) {
          text = lastKids[lead].text; rest = lastKids.filter((_, i) => i !== lead);
        }
        const head = last.heading ? linker.origHeading(last.heading.trim(), provId) : "";
        out.push({ k: "p", l: level + 1, n: chain.map(c => `(${c.num})`).join(""), h: head || null,
          r: text ? linker.runs(text, provId, opt) : [], a: anchors.pop() || null, a2: anchors, s: null });
        // the deepest number's own children, then each ancestor's remaining children
        walk(rest, level + chain.length, pp);
        for (let i = chain.length - 2; i >= 0; i--) {
          const parentPath = pp.slice(0, pp.length - (chain.length - 1 - i));
          walk((chain[i].children || []).filter(k => k !== chain[i + 1]), level + i + 1, parentPath);
        }
        continue;
      }
      const p = n.num ? [...path, n.num] : path;
      let anchor = n.num ? `${provId}/${p.join("/")}` : null;
      if (anchor && seen.has(anchor)) anchor = null;   // duplicate enacted numbering
      if (anchor) seen.add(anchor);
      const kids = n.children || [];
      let text = n.text || "";
      let rest = kids;
      // a leading chapeau runs in after the number and heading
      const lead = kids.findIndex(k => k.role !== "footnote");
      if (!text && lead >= 0 && (kids[lead].type === "chapeau" || (kids[lead].type === "p" && !kids[lead].role))) {
        text = kids[lead].text; rest = kids.filter((_, i) => i !== lead);
      }
      const head = n.heading ? linker.origHeading(n.heading.trim(), provId) : "";
      const r = text ? linker.runs(text, provId, opt) : [];
      // a footnote whose marker sat in the heading (markers are kept out of
      // headings) is set as a page footnote right after the heading
      for (const k of kids) {
        if (k.role !== "footnote") continue;
        const m = /^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/.exec(k.text || "");
        if (!m || opt.dropMarks?.has(m[1]) || opt.usedFn?.has(m[1]) || (text || "").includes(m[1])) continue;
        const note = opt.fnMap?.get(m[1]);
        if (note) { r.unshift({ fn: [typo(note)] }); opt.usedFn.add(m[1]); }
      }
      out.push({
        k: "p", l: level + 1,
        n: n.num ? `(${n.num})` : null,
        h: head || null,
        r,
        a: anchor, s: null,
      });
      walk(rest, level + 1, p);
    }
    for (const n of deferred) {
      const m = /^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/.exec(n.text || "");
      if (m && (opt.dropMarks?.has(m[1]) || opt.usedFn?.has(m[1]))) continue;   // set as a page footnote
      if (m) {
        out.push({ k: "p", l: Math.max(0, level), n: null, h: null, a: null, s: "fn",
          r: [{ t: fromSup(m[1]), sup: true }, typo(n.text.slice(m[1].length))] });
        continue;
      }
      out.push({ k: "p", l: Math.max(0, level), n: null, h: null, r: linker.runs(n.text, provId, opt), a: null, s: "fn" });
    }
  };
  walk(nodes, 0, []);
  return out;
}

function tableRows(html, linker, provId, opt) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html || ""))) {
    const cells = [];
    const cellRe = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = cellRe.exec(tr[1]))) {
      const attrs = c[2];
      const cs = +(/colspan="?(\d+)/i.exec(attrs)?.[1] || 1);
      const rs = +(/rowspan="?(\d+)/i.exec(attrs)?.[1] || 1);
      cells.push({ r: linker.runs(c[3], provId, opt), h: c[1].toLowerCase() === "th", cs, rs });
    }
    if (cells.length) rows.push(cells);
  }
  padRows(rows);
  // the column-letter row under a header ("(a) (b) … (j)", which the instructions cite) repeats with it
  const nh = rows.findIndex(r => !r.every(c => c.h));
  if (nh > 0 && rows[nh].every(c => /^\s*(\([a-z]{1,2}\))?\s*$/.test(plainOf(c.r))) && rows[nh].some(c => plainOf(c.r).trim())) {
    for (const c of rows[nh]) c.hr = true;
  }
  return rows;
}

// A row with fewer cells than the table has columns (the eCFR's Item 402(h)
// header has 5 cells over 6 columns) is padded with empty cells at its end, as a
// browser shows it. Typst fills cells in order, so without this every later
// cell would shift one column ("(b)" under "Name").
function padRows(rows) {
  const busy = [];
  const width = rows.map((row, y) => {
    let x = 0;
    for (const c of row) {
      while (busy[y]?.[x]) x++;
      for (let dy = 0; dy < c.rs; dy++) for (let dx = 0; dx < c.cs; dx++) (busy[y + dy] ||= [])[x + dx] = true;
      x += c.cs;
    }
    return (busy[y] || []).length;
  });
  const ncol = Math.max(0, ...width);
  rows.forEach((row, y) => {
    const filled = (busy[y] || []).filter(Boolean).length;
    for (let k = filled; k < ncol; k++) row.push({ r: [], h: row.every(c => c.h), cs: 1, rs: 1 });
  });
  // a trailing column that is empty in every row is the source's stray cell: drop it
  const blank = c => c && c.cs === 1 && c.rs === 1 && !plainOf(c.r).trim();
  while (rows.length && rows.every(row => blank(row[row.length - 1]))) rows.forEach(row => row.pop());
}

const plainOf = rs => rs.map(r => (typeof r === "string" ? r : (r.t || ""))).join("");

// Per column, the longest word in its header cells and in its body cells (single-column
// cells only): the template measures them so no column is narrower than a word it holds.
// A third entry is the longest header word that can't hyphenate (a designator, a
// number, a short word): the floor when long header words may break.
const breakable = w => /^[A-Za-z]{7,}[,.;:)]?$/.test(w);
export function longestWords(rows) {
  const ncol = Math.max(0, ...rows.map(r => r.reduce((n, c) => n + c.cs, 0)));
  const lw = Array.from({ length: ncol }, () => ["", "", ""]);
  const busy = [];
  // columns whose body cells hold at most "X" / "N/A": their short heads may be set upright
  // (rotated) when the table is too wide; the fourth entry flags such a column
  const narrow = Array(ncol).fill(true);
  const at = [];
  rows.forEach((row, y) => {
    let x = 0;
    for (const c of row) {
      while (busy[y]?.[x]) x++;
      at.push([c, x]);
      for (let dy = 0; dy < c.rs; dy++) for (let dx = 0; dx < c.cs; dx++) (busy[y + dy] ||= [])[x + dx] = true;
      if (!c.h && !c.hr && c.cs === 1 && plainOf(c.r).trim().length > 3) narrow[x] = false;
      x += c.cs;
    }
  });
  busy.length = 0;
  for (const [c, x] of at) if (c.h && c.cs === 1 && narrow[x] && plainOf(c.r).trim().length <= 14) c.v = true;
  rows.forEach((row, y) => {
    let x = 0;
    for (const c of row) {
      while (busy[y]?.[x]) x++;
      for (let dy = 0; dy < c.rs; dy++) for (let dx = 0; dx < c.cs; dx++) (busy[y + dy] ||= [])[x + dx] = true;
      if (c.cs === 1 && x < ncol) {
        const k = c.h ? 0 : 1;
        // split at real spaces only: "Rule\u00a013a-14(a)" never breaks, so it is one word here
        for (const word of plainOf(c.r).split(/[ \t\r\n]+/)) {
          if (word.length > lw[x][k].length) lw[x][k] = word;
          if (c.h && !breakable(word) && word.length > lw[x][2].length) lw[x][2] = word;
        }
      }
      x += c.cs;
    }
  });
  return lw.map((e, x) => [...e, narrow[x] ? "narrow" : ""]);
}

// Relative shares of a wide table's spare width (after each column has its longest word,
// see longestWords): text volume, so prose columns ("Change in pension value and …", the
// exhibit table's row labels) take the width that empty or "X" columns don't need.
export function colWeights(rows) {
  const ncol = Math.max(0, ...rows.map(r => r.reduce((n, c) => n + c.cs, 0)));
  const w = Array(ncol).fill(1);
  const busy = [];
  rows.forEach((row, y) => {
    let x = 0;
    for (const c of row) {
      while (busy[y]?.[x]) x++;
      for (let dy = 0; dy < c.rs; dy++) for (let dx = 0; dx < c.cs; dx++) (busy[y + dy] ||= [])[x + dx] = true;
      if (c.cs === 1 && x < ncol) {
        // the room left after every column has its longest word (longestWords) goes by
        // text volume, damped a little so one long header doesn't take everything
        // ("X", "N/A" and other tiny cells claim no spare width: their minimum is enough)
        const len = plainOf(c.r).trim().length;
        if (len > 3) w[x] = Math.max(w[x], len ** 0.8);
      }
      x += c.cs;
    }
  });
  return w.map(v => Math.round(v * 100) / 100);
}

// ── cross-references ─────────────────────────────────────────────────────
function makeLinker({ index, included, anchors, original, uscTitle, cfrTitle }) {
  // "s-77e/c/1" -> internal label if present (deepest existing ancestor)
  const internal = to => {
    if (!to) return null;
    const [prov] = to.split("/");
    if (!included.has(prov)) return null;
    let a = to;
    while (a && !anchors.has(a)) a = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : "";
    return a || prov;
  };
  const external = to => {
    const [prov, ...rest] = to.split("/");
    const item = index.byId.get(prov);
    if (prov.startsWith("s-")) return uscUrl(uscTitle, prov.slice(2));
    if (prov.startsWith("r-") && item?.cite) {
      const sec = item.cite.split("§ ").pop();
      return ecfrUrl(cfrTitle, sec, rest.map(x => `(${x})`).join(""));
    }
    return null;
  };

  // original-numbering display of "section 77j(c) of this title"
  const origDisplay = (text, to, fromId) => {
    if (!original || !to?.startsWith("s-")) return text;
    const m = /^([Ss]ections?) ([\w–]+)((?:\([^)]+\))*) of this title$/.exec(text);
    if (!m) return text;
    const target = index.byId.get(to.split("/")[0]);
    if (!/^\d/.test(target?.original?.num || "")) return text;
    const fromAct = index.actBySectionId.get(fromId);
    const toAct = index.actBySectionId.get(target.id);
    const same = fromAct && toAct && fromAct.id === toAct.id;
    return `${m[1]} ${target.original.num}${m[3]}${same ? "" : ` of the ${toAct?.short_title || "Act"}`}`;
  };

  const byCodNum = new Map();
  for (const act of index.corpus?.acts || []) for (const sec of act.sections) byCodNum.set(sec.codified?.num, sec);
  const NUM = "\\d+[a-z]*(?:–\\d+[a-z]*)?(?:\\([a-zA-Z0-9]+\\))*";
  const SEP = "(?:,? and |,? or |, )";
  const PAREN = "(?:\\([a-zA-Z0-9]+\\))+";
  const ORIG_LIST = new RegExp(`\\b([Ss]ections?) (${NUM}(?:${SEP}(?:${NUM}|${PAREN}))*)([⁰¹²³⁴⁵⁶⁷⁸⁹]*) of this title\\b`, "g");
  const LNUM = "\\d+[a-z]*(?:[–-]\\d+[a-z]*)?(?:\\([a-zA-Z0-9]{1,5}\\))*";
  const LSEP = "(?:,? and |,? or |, )";
  const LIST_RE = new RegExp(`\\b[Ss]ections? (${LNUM}(?:${LSEP}(?:sections? )?(?:${LNUM}|(?:\\([a-zA-Z0-9]{1,5}\\))+))+)([⁰¹²³⁴⁵⁶⁷⁸⁹]*) of this title\\b`, "g");
  const LIST_ITEM = new RegExp(`(?:^[Ss]ections? |${LSEP}(?:sections? )?)(${LNUM}|(?:\\([a-zA-Z0-9]{1,5}\\))+)`, "g");
  // "sections 78i, 78o, and 78t of this title" -> Act numbering, only when
  // every number maps into one Act (never a half-converted phrase).
  const origPlain = (text, fromId) => {
    if (!original || !fromId?.startsWith("s-")) return text;
    return text.replace(ORIG_LIST, (m, word, list, mark) => {
      const pieces = list.split(/(,? and |,? or |, )/);
      let actId = null;
      const out = [];
      for (const piece of pieces) {
        if (/^(,? and |,? or |, )$/.test(piece)) { out.push(piece); continue; }
        if (/^(\([a-zA-Z0-9]+\))+$/.test(piece)) { out.push(piece); continue; }   // "or (e)": same section
        const mm = /^(\d+[a-z]*(?:–\d+[a-z]*)?)((?:\([a-zA-Z0-9]+\))*)$/.exec(piece);
        const sec = mm && byCodNum.get(mm[1]);
        if (!/^\d/.test(sec?.original?.num || "")) return m;
        const act = index.actBySectionId.get(sec.id);
        if (!act || (actId && act.id !== actId)) return m;
        actId = act.id;
        out.push(sec.original.num + mm[2]);
      }
      const fromAct = index.actBySectionId.get(fromId);
      const suffix = fromAct && fromAct.id === actId ? "" : ` of the ${index.actById.get(actId)?.short_title || "Act"}`;
      return `${word} ${out.join("")}${mark}${suffix}`;
    });
  };

  // Original-numbering mode: references split across tokens — "section " +
  // <a>77d(2)</a> + " of this title" — become "section " + <a>4(2)</a>.
  const origSplit = (toks, fromId) => {
    if (!original || !fromId?.startsWith("s-")) return;
    // "Schedule A of section 77aa of this title" -> "Schedule A", as the Act says it (§ 77aa holds both schedules)
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i], before = toks[i - 1];
      if (t.to !== "s-77aa" || before.to !== undefined || !/^section 77aa of this title$/.test(t.t)) continue;
      const m = /\b[Ss]chedule ([AB]) of $/.exec(before.t);
      if (!m) continue;
      before.t = before.t.slice(0, m.index);
      t.t = `Schedule ${m[1]}`;
    }
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.to === undefined || !t.to.startsWith("s-")) continue;
      const before = toks[i - 1], after = toks[i + 1];
      if (before.to !== undefined || after.to !== undefined) continue;
      if (!/\b[Ss]ections? $/.test(before.t) || !/^ of this title/.test(after.t)) continue;
      const m = /^([\w–]+)((?:\([^)]+\))*)$/.exec(t.t);
      const target = index.byId.get(t.to.split("/")[0]);
      if (!m || !/^\d/.test(target?.original?.num || "") || target.codified?.num !== m[1]) continue;
      const fromAct = index.actBySectionId.get(fromId);
      const toAct = index.actBySectionId.get(target.id);
      const same = fromAct && toAct && fromAct.id === toAct.id;
      t.t = `${target.original.num}${m[2]}`;
      after.t = (same ? "" : ` of the ${toAct?.short_title || "Act"}`) + after.t.slice(" of this title".length);
    }
  };

  const runs = (html, provId, opt) => {
    const out = [];
    const toks = tokenize(html);
    origSplit(toks, provId);
    let prev = " ";
    for (const tok of toks) {
      const t = typo(tok.t, prev);
      prev = tok.t.slice(-1) || prev;
      tok.t = t;
    }
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      if (tok.to !== undefined) {
        let to = tok.to;
        let t = origDisplay(tok.t, to, provId);
        // "§ 230.502" followed by "(a)(1)" in plain text: extend to the paragraph
        const next = toks[i + 1];
        if (to.startsWith("r-") && !to.includes("/") && next && next.to === undefined && !next.i) {
          const pm = /^((?:\([a-zA-Z0-9]{1,5}\))+)/.exec(next.t);
          if (pm) {
            const path = [...pm[1].matchAll(/\(([^)]+)\)/g)].map(x => x[1]);
            to = `${to}/${path.join("/")}`;
            t += pm[1];
            next.t = next.t.slice(pm[1].length);
          }
        }
        const lab = internal(to);
        if (lab) out.push({ t, l: lab });
        else {
          const u = external(to);
          out.push(u ? { t, u } : t);
        }
        continue;
      }
      if (tok.i) { out.push({ t: tok.t, i: true }); continue; }
      if (tok.sup) { out.push({ t: tok.t, sup: true }); continue; }
      for (const piece0 of plainLinks(tok.t, provId)) {
        const piece = typeof piece0 === "string" ? origPlain(piece0, provId) : piece0;
        if (typeof piece !== "string") { out.push(piece); continue; }
        // Unicode superscript runs are footnote markers (corpus convention)
        for (const part of piece.split(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/)) {
          if (!part) continue;
          if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(part)) {
            if (opt?.dropMarks?.has(part)) continue;
            const note = opt?.fnMap?.get(part);
            if (note) { out.push({ fn: [typo(note)] }); opt.usedFn.add(part); }
            else out.push({ t: fromSup(part), sup: true });
          } else out.push(part);
        }
      }
    }
    return mergeStrings(out);
  };

  // plain-text references the corpus did not linkify
  const PLAIN = [
    // paragraph (b)(1) of this section  /  paragraphs (a) and (b) of this section (first only)
    { re: /\b(paragraphs?) ((?:\([a-zA-Z0-9]{1,5}\))+)( of this section)/g,
      link: (m, provId) => {
        const path = [...m[2].matchAll(/\(([^)]+)\)/g)].map(x => x[1]);
        const lab = internal(`${provId}/${path.join("/")}`);
        return lab && lab !== provId ? { lab, start: m[1].length + 1, text: m[2] } : null;
      } },
    // 15 U.S.C. 77q / 15 U.S.C. 78c(a)(10)
    { re: /\b(\d{1,2}) U\.S\.C\. (?:§§?[ \u00a0]?)?(\d+[a-z]*(?:[–-]\d+[a-z]*)?)((?:\([a-zA-Z0-9]{1,5}\))*)/g,
      link: m => {
        const t = m[1], sec = m[2].replace(/-/g, "–");
        if (t === uscTitle) {
          const path = [...m[3].matchAll(/\(([^)]+)\)/g)].map(x => x[1]);
          const lab = internal([`s-${sec}`, ...path].join("/"));
          if (lab) return { lab, start: 0, text: m[0] };
        }
        return { url: uscUrl(t, m[2]), start: 0, text: m[0] };
      } },
    // Lists: "sections 78i, 78o, and 78t of this title", "section 77k or 77l(a)(2) of this
    // title", "section 78m(a) or section 78o(d) of this title", "section 78u(d) or (e) of this
    // title". Every number links. Original numbering shows Act numbers when every number maps
    // into one Act (otherwise the phrase stays whole in Code form, never half converted).
    { re: LIST_RE,
      link: (m, provId) => {
        const listEnd = m[0].length - m[2].length - " of this title".length;
        const items = [];
        let prev = null;
        for (const it of m[0].slice(0, listEnd).matchAll(LIST_ITEM)) {
          const ref = it[1];
          const at = it.index + it[0].length - ref.length;
          const [num0, ...rest] = ref.split("(");
          const path = rest.map(x => x.replace(")", ""));
          const num = num0 ? num0.replace(/-/g, "–") : prev;          // "(e)": the section before
          if (!num) return null;
          prev = num;
          items.push({ ref, at, num, path, bare: !num0 });
        }
        if (items.length < 2) return null;
        const fromAct = index.actBySectionId.get(provId);
        let actId = null;
        const convert = original && provId?.startsWith("s-") && items.every(x => {
          const sec = byCodNum.get(x.num);
          const act = sec && index.actBySectionId.get(sec.id);
          if (!/^\d/.test(sec?.original?.num || "") || !act || (actId && act.id !== actId)) return false;
          actId = act.id;
          return true;
        });
        const hits = items.map(x => {
          const lab = internal([`s-${x.num}`, ...x.path].join("/"));
          const shown = convert && !x.bare ? byCodNum.get(x.num).original.num + x.ref.slice(x.ref.indexOf("(") < 0 ? x.ref.length : x.ref.indexOf("(")) : x.ref;
          return { ...(lab ? { lab } : { url: uscUrl(uscTitle, x.num) }), start: x.at, text: x.ref, shown };
        });
        if (convert) {
          const same = fromAct && fromAct.id === actId;
          hits.push({ plain: true, start: listEnd, text: m[0].slice(listEnd),
            shown: m[2] + (same ? "" : ` of the ${index.actById.get(actId)?.short_title || "Act"}`) });
        }
        return hits;
      } },
    // section 632(a) of this title (U.S.C. title of the corpus, not linkified upstream)
    { re: /\b([Ss]ection) (\d+[a-z]*(?:[–-]\d+[a-z]*)?)((?:\([a-zA-Z0-9]{1,5}\))*)([⁰¹²³⁴⁵⁶⁷⁸⁹]*) of this title\b/g,
      link: (m, provId) => {
        const sec = m[2].replace(/-/g, "–");
        const path = [...m[3].matchAll(/\(([^)]+)\)/g)].map(x => x[1]);
        const lab = internal([`s-${sec}`, ...path].join("/"));
        // a footnote marker inside the reference ("section 77d(6)¹ of this title") moves out of
        // the link text and after it, where the marker handling drops or sets it like any other
        const mark = m[4];
        const bare = mark ? m[0].replace(mark, "") : m[0];
        const shown = original ? origPlain(bare.replace(/^Section/, "section"), provId).replace(/^section/, m[1]) : bare;
        const after = mark || undefined;
        return lab ? { lab, start: 0, text: m[0], shown, after } : { url: uscUrl(uscTitle, m[2]), start: 0, text: m[0], shown, after };
      } },
    // section 741 of title 11
    { re: /\bsection (\d+[a-z]*(?:[–-]\d+[a-z]*)?)((?:\([a-zA-Z0-9]{1,5}\))*) of title (\d{1,2})\b/g,
      link: m => (m[3] === uscTitle ? null : { url: uscUrl(m[3], m[1]), start: 0, text: m[0] }) },
    // 17 CFR 240.10b-5 / 17 CFR 270.2a51-1(b)
    { re: /\b(\d{1,2}) CFR (\d{1,3})\.([0-9][\w-]*)((?:\([a-zA-Z0-9]{1,5}\))*)/g,
      link: m => {
        const sec = `${m[2]}.${m[3]}`;
        const path = [...m[4].matchAll(/\(([^)]+)\)/g)].map(x => x[1]);
        if (m[1] === cfrTitle) {
          const lab = internal([`r-${m[2]}-${m[3]}`, ...path].join("/"));
          if (lab) return { lab, start: 0, text: m[0] };
        }
        return { url: ecfrUrl(m[1], sec, m[4]), start: 0, text: m[0] };
      } },
  ];

  const plainLinks = (text, provId) => {
    const hits = [];
    for (const rule of PLAIN) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text))) {
        const res = rule.link(m, provId);
        if (!res) continue;
        for (const r of Array.isArray(res) ? res : [res]) {
          const s = m.index + r.start;
          const e = s + r.text.length;
          if (hits.some(h => s < h.e && e > h.s)) continue;
          hits.push({ s, e, r });
        }
      }
    }
    if (!hits.length) return [text];
    hits.sort((a, b) => a.s - b.s);
    const out = [];
    let pos = 0;
    for (const h of hits) {
      if (h.s > pos) out.push(text.slice(pos, h.s));
      const shown = h.r.shown ?? text.slice(h.s, h.e);
      if (h.r.plain) out.push(shown);
      else out.push(h.r.lab ? { t: shown, l: h.r.lab } : { t: shown, u: h.r.url });
      if (h.r.after) out.push(h.r.after);
      pos = h.e;
    }
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  };

  // Headings cite the Code bare: "Exemptions of section 77c not applicable to this section".
  // Single references only (a list stays whole in Code form).
  const BARE = /\b([Ss]ections?) (\d+[a-z]*(?:–\d+[a-z]*)?)((?:\([a-zA-Z0-9]+\))*)(?![(\w–])(?! of this title)(?!,? (?:and|or) |, )/g;
  const origBare = (text, fromId) => {
    if (!original || !fromId?.startsWith("s-")) return text;
    return text.replace(BARE, (m, word, num, parens) => {
      const sec = byCodNum.get(num);
      const act = sec && index.actBySectionId.get(sec.id);
      if (!act || !/^\d/.test(sec.original?.num || "")) return m;
      const fromAct = index.actBySectionId.get(fromId);
      return `${word} ${sec.original.num}${parens}${fromAct && fromAct.id === act.id ? "" : ` of the ${act.short_title}`}`;
    });
  };

  return {
    runs,
    origPlain: (t, id) => typo(origPlain(t, id)),
    origHeading: (t, id) => typo(origBare(origPlain(t, id), id)),
  };
}

// Typesetting only (never applied to the corpus): curly quotes for the eCFR's
// straight quotes, and an em dash glued to the word before it (U+2060 WORD
// JOINER) so it can never start a line.
const OPENERS = /[\s([{\u2014\u2018\u201c\u2060]/;
export function typo(text, prev = " ") {
  let out = "";
  let before = prev;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1] || " ";
    if (ch === "\"") out += OPENERS.test(before) ? "\u201c" : "\u201d";
    else if (ch === "'") out += OPENERS.test(before) && /[A-Za-z]/.test(next) ? "\u2018" : "\u2019";
    else if (ch === "\u2014" && before && !/\s/.test(before) && before !== "\u2060") out += "\u2060\u2014";
    else if (ch === " " && before === "\u00a7") out += "\u00a0";                 // "§ 105" never splits
    else out += ch;
    before = ch;
  }
  return out
    // "Rule 145", "Item 404", "Form 8-K", "§ 105": the label stays with its number
    .replace(/(\bRules?|\bItems?|\bForms?|\bSchedules?|\bParts?|\bPub\. L\.|\bStat\.|§§?) (?=[0-9(])/g, "$1\u00a0")
    // "Regulation D", "Form S-3", "Schedule TO": a lettered designator stays with its name too
    .replace(/(\bRegulations?|\bForms?|\bSchedules?) (?=[A-Z0-9]{1,4}(?:-[A-Z0-9]{1,4})?\b)/g, "$1\u00a0");
  // "8-K", "S-K" never break at their hyphen: supplement.typ boxes them. (A
  // word joiner after the hyphen would reach the PDF's text layer, and a
  // search for "8-K" would miss "8-\u2060K".)
}

const SUPS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
function fromSup(s) { return [...s].map(ch => String(SUPS.indexOf(ch))).join(""); }

// OLRC editorial footnotes that only point at statutory notes this book does
// not print ("See References in Text note below.") are left out together
// with their markers; "So in original." and the like stay.
function footnoteMap(nodes, map = new Map()) {
  for (const n of nodes || []) {
    if (n.role === "footnote") {
      const m = /^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s*([\s\S]*)$/.exec(n.text || "");
      if (m && m[2].trim()) map.set(m[1], m[2].replace(/<[^>]+>/g, "").trim());
    }
    footnoteMap(n.children, map);
  }
  return map;
}

function droppedFootnotes(nodes, set = new Set()) {
  for (const n of nodes || []) {
    if (n.role === "footnote") {
      const m = /^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s*See References in Text note below\.?\s*$/.exec(n.text || "");
      if (m) set.add(m[1]);
    }
    droppedFootnotes(n.children, set);
  }
  return set;
}

function mergeStrings(runs) {
  const out = [];
  for (const r of runs) {
    if (typeof r === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += r;
    else if (r !== "") out.push(r);
  }
  return out;
}

// ── Table of Sections (back matter) ─────────────────────────────────────
function buildIndex(parts, index) {
  const statutes = new Map();
  const rules = new Map();
  const ordered = sortIntoCodeOrder(parts.flatMap(p => p.items.map(i => i.lab)), index);
  const byLab = new Map(parts.flatMap(p => p.items.map(i => [i.lab, i])));
  for (const id of ordered) {
    const prov = byLab.get(id);
    if (prov.kind === "usc") {
      const act = index.actBySectionId.get(id);
      const sec = index.byId.get(id);
      const key = act?.id || "other";
      if (!statutes.has(key)) statutes.set(key, { title: act?.short_title || "Statutes", rows: [] });
      const on = sec.original?.num;
      statutes.get(key).rows.push({ a: on ? (/^\d/.test(on) ? `§ ${on}` : on) : "—", b: `§ ${sec.codified.num}`, lab: id });
    } else {
      const reg = index.regBySectionId.get(id);
      const rule = index.byId.get(id);
      const key = reg?.id || "other";
      if (!rules.has(key)) {
        const part = reg?.part || (/Part (\d+)/i.exec(reg?.title || "") || [])[1] || "";
        rules.set(key, { title: `17 C.F.R. Part ${part}`.replace(/^17/, (index.corpus?.meta?.cfrCitePrefix || "17 C.F.R.").split(" ")[0]), rows: [], kind: "rule" });
      }
      const sec = String(rule.cite).split("§ ").pop();
      const a = ruleName(rule, reg) || "—";
      rules.get(key).rows.push({ a, b: `§ ${sec}`, lab: id });
      if (/^Item\b/.test(a)) rules.get(key).kind = "item";
      else if (/^Form\b/.test(a)) rules.get(key).kind = "form";
    }
  }
  return { statutes: [...statutes.values()], rules: [...rules.values()] };
}
