#!/usr/bin/env node
// Build a supplement PDF from the command line with the SAME document builder
// and Typst template the studio uses in the browser.
//
//   node scripts/pdf/build_pdf.mjs --preset builder/presets/secreg-standard.json \
//        --out out.pdf [--trim letter|7x10|6x9] [--numbering original|codified]
//        [--title "…" --course "…" --term "…" --professor "…" --school "…"]
//        [--json data.json] [--pages provpages.json] [--typst /path/to/typst]
//        [--png dir --ppi 110 --pages-range 1-12]
//
// Requires a Typst 0.14.x binary (the version compiled into the browser
// engine): $TYPST_BIN, --typst, or `typst` on PATH.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { indexCorpus } = await import(path.join(ROOT, "builder/corpus.js"));
const { buildDocument } = await import(path.join(ROOT, "builder/pdf/document.js"));

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 ? dflt : argv[i + 1]; };

const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, arg("corpus", "builder/corpus.json")), "utf8"));
const index = indexCorpus(corpus);
let state;
if (arg("state")) state = JSON.parse(fs.readFileSync(arg("state"), "utf8"));
else {
  const preset = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg("preset", "builder/presets/secreg-standard.json")), "utf8"));
  state = { selection: preset.selection, metadata: { groupTitles: preset.groupTitles || {} }, mode: "original" };
}
state.metadata = {
  ...state.metadata,
  title: arg("title", state.metadata?.title || "Securities Regulation"),
  subtitle: arg("subtitle", state.metadata?.subtitle || "Selected Statutes, Rules and Forms"),
  course: arg("course", state.metadata?.course || ""),
  term: arg("term", state.metadata?.term || ""),
  professor: arg("professor", state.metadata?.professor || ""),
  school: arg("school", state.metadata?.school || ""),
};
state.options = { ...(state.options || {}), trim: arg("trim", state.options?.trim || "letter"),
  numbering: arg("numbering", state.options?.numbering || "original") };

let verifyReport = null;
const reportPath = path.join(ROOT, "builder/verify_report.json");
if (fs.existsSync(reportPath)) verifyReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const doc = buildDocument(state, { corpus, index }, { verifyReport });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "supp-typst-"));
fs.writeFileSync(path.join(work, "data.json"), JSON.stringify(doc));
fs.copyFileSync(path.join(ROOT, "builder/pdf/supplement.typ"), path.join(work, "main.typ"));
if (arg("json")) fs.copyFileSync(path.join(work, "data.json"), arg("json"));

const typst = arg("typst", process.env.TYPST_BIN || "typst");
const out = path.resolve(arg("out", "supplement.pdf"));
const t0 = Date.now();
execFileSync(typst, ["compile", "--root", work, "--font-path", path.join(ROOT, "builder/assets/fonts/typst"),
  "--ignore-system-fonts", path.join(work, "main.typ"), out], { stdio: "inherit" });
const { patchCatalog } = await import(path.join(ROOT, "builder/pdf/pdf-patch.js"));
fs.writeFileSync(out, patchCatalog(new Uint8Array(fs.readFileSync(out))));
console.error(`compiled ${out} in ${Date.now() - t0} ms`);
if (arg("pages")) {
  // provision -> physical page (Typst query of the <provpage> markers)
  const raw = execFileSync(typst, ["query", "--root", work, "--font-path", path.join(ROOT, "builder/assets/fonts/typst"),
    "--ignore-system-fonts", path.join(work, "main.typ"), "<provpage>", "--field", "value"], { encoding: "utf8" });
  const map = Object.fromEntries(JSON.parse(raw).map(m => [m.l, m.p]));
  fs.writeFileSync(arg("pages"), JSON.stringify(map));
}
if (arg("png")) {
  fs.mkdirSync(arg("png"), { recursive: true });
  execFileSync(typst, ["compile", "--root", work, "--font-path", path.join(ROOT, "builder/assets/fonts/typst"),
    "--ignore-system-fonts", "--ppi", arg("ppi", "110"), "--pages", arg("pages-range", "1-12"),
    path.join(work, "main.typ"), path.join(arg("png"), "p{0p}.png")], { stdio: "inherit" });
}
fs.rmSync(work, { recursive: true, force: true });
