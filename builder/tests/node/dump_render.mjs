#!/usr/bin/env node
// Parity harness: render every manifest provision through
// builder/reader/render-section.js and dump {sections: {id: {html, texts}}}
// — the same shape pipeline/build_reader.py --dump-render writes. Compared
// byte-for-byte by builder/tests/test_reader_parity.py.
//
// usage: node dump_render.mjs <corpus.json> <manifest.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { renderProvision } from "../../reader/render-section.js";

const [corpusPath, manifestPath, outPath] = process.argv.slice(2);
if (!corpusPath || !manifestPath || !outPath) {
  console.error("usage: node dump_render.mjs <corpus.json> <manifest.json> <out.json>");
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// cross-references display in original act numbering — mirrors the
// XREF_DISPLAY prep in build_reader.py main()
const xrefDisplay = {};
for (const g of manifest.groups || []) {
  if (g.kind !== "usc") continue;
  for (const item of g.items || []) {
    const cid = item.corpus_id || "";
    const m = /^§ (\S+)$/.exec(item.display || "");
    if (m && cid.startsWith("s-")) xrefDisplay[cid.slice(2)] = m[1];
  }
}

// Index every provision in the corpus by id
const byId = new Map();
for (const act of corpus.acts || []) {
  for (const s of act.sections || []) byId.set(s.id, ["usc", s]);
}
for (const reg of corpus.regulations || []) {
  for (const rule of reg.rules || []) byId.set(rule.id, ["cfr", rule]);
}

const sections = {};
for (const group of manifest.groups) {
  for (const item of group.items) {
    if ("subhead" in item) continue;
    const kindProv = byId.get(item.corpus_id);
    if (!kindProv) continue;
    const [kind, prov] = kindProv;
    const { html, texts, meta } = renderProvision(
      item, prov, kind, group.label, xrefDisplay
    );
    sections[meta.id] = { html, texts };
  }
}

writeFileSync(outPath, JSON.stringify({ sections }));
