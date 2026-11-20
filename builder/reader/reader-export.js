// Client-side reader export — JS port of pipeline/build_reader.py main().
//
// assembleManifest() turns the builder's ordered selection into a reader
// manifest (docs/contracts.md §6); buildReaderHtml() replicates
// build_reader.py's assembly exactly: XREF_DISPLAY construction, the render
// loop (per-section bytes guaranteed by render-section.js, contracts §7),
// doc_meta, toc_groups, and the placeholder replace sequence (contracts §9).
//
// IMPORTANT: the manifest `name` keys the reader's localStorage
// ('supplementAnnotations.v2.' + name). It is derived from the corpus id +
// slugified supplement title, so re-exporting a supplement with the same
// title produces the same key — annotations carry over and re-anchor to the
// regenerated text.

import { renderProvision, esc } from "./render-section.js";
import { ruleName } from "../pdf/document.js";
import { defaultGroupTitle, splitPartTitle } from "../model.js";

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── manifest assembly ────────────────────────────────────────────────────

// 'Rule 144A' / 'Item 303' / '§ 243.100' (display_for_rule + the
// Regulation S-K items): rule-styled parts use the
// CFR's own capitalization taken from the cite.
// The PDF's name for a rule ("Rule 101" of Regulation M, "Schedule 13D",
// "Item 402"), so the reader and the book say the same thing; the section
// cite when a rule has no name.
function cfrItemDisplay(rule, reg) {
  const name = ruleName(rule, reg);
  if (name) return name;
  const m = /§\s*(\d+)\.(\S+)$/.exec(rule.cite || "");
  return m ? `§ ${m[1]}.${m[2]}` : (rule.common_name || rule.id);
}

// Mode-aware statute display. Original mode shows the act's own numbering
// (corpus original.num — same primary/fallback rule as pdf/composer.js
// composeStatuteEntry); the '§ <num>' shape is load-bearing: buildReaderHtml
// derives XREF_DISPLAY from it exactly like build_reader.py main().
function uscItemDisplay(section, mode) {
  const primary =
    mode === "original" && section.original ? section.original : section.codified;
  return `§ ${primary?.num || section.codified?.num || ""}`;
}

// The reader's TOC shows each group as a name plus the citation it lives
// under, in the same style as the studio and the PDF: 'Securities Act of
// 1933' / '15 U.S.C. §§ 77a–77aa'. The act's own usc_range is the citation
// when the corpus has one; the chapter is the fallback.
function uscGroupSublabel(act, meta) {
  if (act.usc_range) return act.usc_range;
  if (!act.usc_chapter) return "";
  const chapter = String(act.usc_chapter).split("/").pop();
  const prefix = meta.uscCitePrefix || "";
  return prefix ? `${prefix} ch. ${chapter}` : `ch. ${chapter}`;
}

// Regulation groups are named the way the corpus names them (short_title,
// then display_title: real sentence/proper case, not the raw all-caps CFR
// heading) and cited as '17 C.F.R. Part 240' (never the corpus's '17 CFR
// Part 240', which clashes with the '17 C.F.R. § 240.10b-5' cites on the
// provisions themselves).
function cfrGroupLabel(reg, meta) {
  return reg.short_title || reg.display_title || cfrGroupSublabel(reg, meta);
}

function cfrGroupSublabel(reg, meta) {
  const prefix = meta.cfrCitePrefix || "";
  if (prefix && reg.part != null) return `${prefix} Part ${reg.part}`;
  // no prefix/part in the corpus: fix the style of the title it does have
  return String(reg.title || "").replace(/\bCFR\b/, "C.F.R.");
}

// Walk the selection in user order and group consecutive runs by act /
// regulation part — the same grouping semantics as pdf/composer.js
// composeDocument (ids missing from the corpus are skipped, as there).
export function assembleManifest(state, corpus, index) {
  const mode = state.mode === "original" ? "original" : "codified";
  const meta = corpus?.meta || {};
  const metadata = state.metadata || {};
  const title = metadata.title || meta.defaultTitle || "Statutory Supplement";
  const corpusId = meta.id || "corpus";

  const groups = [];
  const skipped = [];   // selection ids absent from the corpus (e.g. stale
  let currentKey = null; // ids from an old share URL) — surfaced post-export

  for (const id of state.selection || []) {
    const prov = index.byId.get(id);
    if (!prov) { skipped.push(id); continue; }

    let key, makeGroup, item;
    if (index.actBySectionId.has(id)) {
      const act = index.actBySectionId.get(id);
      key = `act-${act.id}`;
      makeGroup = () => ({
        key: `act:${act.id}`,
        label: act.short_title,
        sublabel: uscGroupSublabel(act, meta),
        kind: "usc",
        items: [],
      });
      item = { corpus_id: id, old_id: "", display: uscItemDisplay(prov, mode) };
    } else if (index.regBySectionId.has(id)) {
      const reg = index.regBySectionId.get(id);
      key = `reg-${reg.id}`;
      makeGroup = () => ({
        key: `reg:${reg.id}`,
        label: cfrGroupLabel(reg, meta),
        sublabel: cfrGroupSublabel(reg, meta),
        kind: "cfr",
        items: [],
      });
      item = { corpus_id: id, old_id: "", display: cfrItemDisplay(prov, reg) };
    } else {
      skipped.push(id);
      continue;
    }

    if (key !== currentKey) groups.push(makeGroup());
    groups[groups.length - 1].items.push(item);
    currentKey = key;
  }

  // part titles as the PDF prints them: the professor's own, else the default
  // ("Regulation M" when only Regulation M is picked), without a typed "Part I."
  for (const g of groups) {
    const custom = (metadata.groupTitles || {})[g.key];
    const ids = g.items.map(i => i.corpus_id);
    g.label = splitPartTitle(custom || defaultGroupTitle(g.key, index, ids) || g.label).title;
    delete g.key;
  }

  return {
    name: `${corpusId}-${slugify(title) || "supplement"}`,
    title,
    subtitle: metadata.subtitle || "",
    edition: [metadata.course, metadata.term].filter(Boolean).join(" · "),
    groups,
    unmapped_legacy_ids: skipped,
  };
}

// ── reader assembly (mirrors build_reader.py main()) ─────────────────────

// Python str.replace replaces every occurrence (e.g. __TITLE__ appears three
// times in shell.html); split/join does the same and is immune to the `$`
// substitution patterns String.replace gives replacement strings.
function fill(s, token, value) {
  return s.split(token).join(value);
}

// Replicates build_reader.py main(). templates = {shell, css, js} (see
// fetchTemplates). Returns {html, missing}: `missing` lists manifest
// corpus_ids absent from the corpus (skipped, like the pipeline's WARNING).
export function buildReaderHtml(manifest, corpus, templates) {
  // cross-references display per the manifest's section numbering — exactly
  // build_reader.py's XREF_DISPLAY construction (re.match(r"§ (\S+)$")).
  // In an original-mode manifest this maps '77e' -> '5' so xref text reads
  // the way Congress wrote it.
  const xrefDisplay = {};
  for (const g of manifest.groups || []) {
    if (g.kind !== "usc") continue;
    for (const item of g.items || []) {
      const cid = item.corpus_id || "";
      const m = /^§ (\S+)$/.exec(item.display || "");
      // skip identity mappings: codified-mode displays ('§ 77e') would
      // otherwise rewrite 'section 77e(c) of this title' to the truncated
      // 'section 77e(c)'. Only a real translation (original numbering,
      // '77e' -> '5') should rewrite xref text.
      if (m && cid.startsWith("s-") && m[1] !== cid.slice(2)) {
        xrefDisplay[cid.slice(2)] = m[1];
      }
    }
  }

  // index every provision in the corpus by id
  const byId = new Map();
  for (const act of corpus.acts || [])
    for (const s of act.sections || []) byId.set(s.id, ["usc", s]);
  for (const reg of corpus.regulations || [])
    for (const rule of reg.rules || []) byId.set(rule.id, ["cfr", rule]);

  const sectionsHtml = [];
  const tocGroups = [];
  const renderedIds = new Set();
  const missing = [...(manifest.unmapped_legacy_ids || [])];
  let n = 0;

  for (const group of manifest.groups || []) {
    const tocItems = [];
    for (const item of group.items || []) {
      if ("subhead" in item) {
        tocItems.push({ subhead: item.subhead });
        sectionsHtml.push(
          `<div class="reg-subhead" id="sub-${n}">${esc(item.subhead)}</div>`
        );
        n += 1;
        continue;
      }
      const kindProv = byId.get(item.corpus_id);
      if (!kindProv) {
        missing.push(item.corpus_id);
        continue;
      }
      const [kind, prov] = kindProv;
      const { html, meta } = renderProvision(
        item, prov, kind, group.label, xrefDisplay
      );
      sectionsHtml.push(html);
      renderedIds.add(meta.id);
      tocItems.push(meta);
    }
    tocGroups.push({
      label: group.label,
      sublabel: group.sublabel || "",
      items: tocItems,
    });
  }

  const src = corpus.source || {};
  const docMeta = {
    name: manifest.name,
    title: manifest.title,
    subtitle: manifest.subtitle || "",
    edition: manifest.edition || "",
    generated: new Date().toISOString().slice(0, 19) + "Z",
    source: {
      usc_release: src.usc_release_point || "",
      usc_label: src.usc_release_label || "",
      usc_generated: src.usc_generated || "",
      ecfr_date: src.ecfr_date || "",
    },
    provisions: renderedIds.size,
  };

  // JSON destined for a <script> island: a literal "</" in any string
  // (e.g. "</script>" typed into the supplement title) would close the
  // element early — stored XSS in the exported file plus a broken reader.
  // "<\/" is the same string after JSON.parse. Mirrors build_reader.py.
  const jsonIsland = (value) => JSON.stringify(value).split("</").join("<\\/");

  // the placeholder replace sequence, in contract order (contracts.md §9);
  // __SEED__/__ORPHANS__ are the string "null" for client exports.
  let out = templates.shell;
  out = fill(out, "/*__CSS__*/", templates.css);
  out = fill(out, "__TITLE__", esc(manifest.title));
  out = fill(out, "__DOC_META__", jsonIsland(docMeta));
  out = fill(out, "__TOC__", jsonIsland(tocGroups));
  out = fill(out, "__SEED__", "null");
  out = fill(out, "__ORPHANS__", "null");
  out = fill(out, "__CONTENT__", sectionsHtml.join("\n"));
  out = fill(out, "//__JS__", templates.js);

  return { html: out, missing };
}

// ── template loading ─────────────────────────────────────────────────────

// Paths resolve against the document base (builder/index.html). Cached with
// a module-level promise so repeat exports don't refetch; reset on failure
// so a retry can succeed.
const TEMPLATE_URLS = [
  "./reader/template/shell.html",
  "./reader/template/reader.css",
  "./reader/template/reader.js",
];

let templatesPromise = null;

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.text();
}

export function fetchTemplates() {
  if (!templatesPromise) {
    templatesPromise = Promise.all(TEMPLATE_URLS.map(fetchText))
      .then(([shell, css, js]) => ({ shell, css, js }))
      .catch((err) => {
        templatesPromise = null;
        throw err;
      });
  }
  return templatesPromise;
}
