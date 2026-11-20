// Unit tests for builder/pdf/document.js (run: node --test builder/tests/node/document.test.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { indexCorpus } = await import(path.join(ROOT, "builder/corpus.js"));
const { buildDocument, tokenize } = await import(path.join(ROOT, "builder/pdf/document.js"));
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "builder/corpus.json"), "utf8"));
const index = indexCorpus(corpus);
const ctx = { corpus, index };

const doc = (selection, extra = {}) =>
  buildDocument({ selection, metadata: { title: "T" }, mode: "codified", ...extra }, ctx, { now: "2027-08-01" });
const item = (d, lab) => d.parts.flatMap(p => p.items).find(i => i.lab === lab);
const allRuns = it => it.body.flatMap(b => (b.k === "t" ? b.rows.flat().flatMap(c => c.r) : b.r));
const anchors = d => new Set(d.parts.flatMap(p => p.items.flatMap(i =>
  [i.lab, ...i.body.flatMap(b => [b.a, ...(b.a2 || [])]).filter(Boolean)])));

test("tokenize keeps xref targets and decodes entities", () => {
  const t = tokenize('see <a class="xref" data-to="s-77e">section 77e of this title</a> &amp; more');
  assert.deepEqual(t, [{ t: "see " }, { t: "section 77e of this title", to: "s-77e" }, { t: " & more" }]);
});

test("cross-reference inside the book becomes an internal link", () => {
  const d = doc(["s-77d", "s-77e"]);
  const link = allRuns(item(d, "s-77d")).find(r => r.t === "section 77e of this title");
  assert.equal(link.l, "s-77e");
});

test("cross-reference outside the book links to the official text", () => {
  const d = doc(["s-77d"]);
  const link = allRuns(item(d, "s-77d")).find(r => r.t === "section 77e of this title");
  assert.equal(link.u, "https://www.govinfo.gov/link/uscode/15/77e?link-type=html");
});

test("every internal link points at an anchor that exists in the document", () => {
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "builder/presets/secreg-standard.json"), "utf8"));
  const d = doc(preset.selection);
  const a = anchors(d);
  const dangling = d.parts.flatMap(p => p.items.flatMap(i => allRuns(i))).filter(r => r.l && !a.has(r.l));
  assert.deepEqual(dangling, []);
});

test("subsection anchors and duplicate enacted numbers", () => {
  const d = doc(["s-77e"]);
  const a = anchors(d);
  assert.ok(a.has("s-77e/a") && a.has("s-77e/a/1") && a.has("s-77e/b/2"));
});

test("CFR paragraph reference extends the link to the paragraph", () => {
  const d = doc(["r-230-500", "r-230-502", "r-230-506"]);
  const runs = allRuns(item(d, "r-230-506"));
  const hit = runs.find(r => r.l && r.l.startsWith("r-230-502/"));
  assert.ok(hit, "expected a link into § 230.502(x)");
  assert.match(hit.t, /^(§[ \u00a0])?230\.502\([a-z0-9]+\)/);
});

test("Act numbering: headings, heads, contents and references name the Act section", () => {
  const d = doc(["s-77e", "s-77j", "s-78j"], { mode: "original" });
  const e = item(d, "s-77e");
  assert.equal(e.num, "§ 5");
  assert.equal(e.num2, "15 U.S.C. § 77e");
  assert.equal(e.run, "Securities Act § 5  ·  15 U.S.C. § 77e");
  assert.deepEqual(e.toc, { a: "§ 5", b: "77e" });
  assert.equal(item(d, "s-78j").run, "Exchange Act § 10  ·  15 U.S.C. § 78j");
  assert.equal(d.parts[0].sub, "§§ 5–10 (selected)  ·  15 U.S.C. §§ 77e–77j");
  const b = e.body.find(p => p.n === "(b)");
  assert.match(b.h, /section 10\b/);
  assert.doesNotMatch(b.h, /77j/);
  const toTen = allRuns(e).find(r => r.l === "s-77j" || /^section 10/.test(r.t || ""));
  assert.ok(toTen);
});

test("Code numbering shows the Act section as the second citation", () => {
  const d = doc(["s-77e"]);
  const e = item(d, "s-77e");
  assert.equal(e.num, "§ 77e");
  assert.equal(e.num2, "Securities Act § 5");
});

test("Act numbering never shows a Code section no Act section enacted as if it were one", () => {
  const r1 = item(doc(["s-77r", "s-77r–1"], { mode: "original" }), "s-77r–1");
  assert.equal(r1.num, "15 U.S.C. § 77r–1");
  assert.equal(r1.num2, "Not a section of the Securities Act; enacted by Pub. L. 98–440, title I, § 106");
});

test("parts follow first appearance and accept custom titles", () => {
  const d = buildDocument({ selection: ["r-240-10b-5", "s-77e", "r-240-14a-9"],
    metadata: { title: "T", groupTitles: { "act:act-ch2A": "The Securities Act" } } }, ctx);
  assert.deepEqual(d.parts.map(p => p.items.map(i => i.lab)), [["r-240-10b-5", "r-240-14a-9"], ["s-77e"]]);
  assert.equal(d.parts[1].title, "The Securities Act");
  assert.equal(d.parts[0].kicker, "Part One");
});

test("a subject-group label that repeats the part title is left out", () => {
  const regD = doc(["r-230-501", "r-230-506"]);
  assert.equal(regD.parts[0].title, "Regulation\u00a0D");   // the designator stays with its name
  assert.ok(regD.parts[0].items.every(i => !i.sub), "no 'Regulation D' line under a 'Regulation D' part");
  const mixed = doc(["r-230-144", "r-230-501", "r-230-506"]);
  assert.ok(mixed.parts[0].items.some(i => /Regulation D/.test(i.sub || "")), "kept when the part holds more");
});

test("Table of Sections is in Code order with both numberings", () => {
  const d = doc(["s-77l", "s-77e", "r-240-10b-5"]);
  assert.deepEqual(d.index.statutes[0].rows.map(r => [r.a, r.b]), [["§ 5", "§ 77e"], ["§ 12", "§ 77l"]]);
  assert.equal(d.index.rules[0].rows[0].a, "Rule 10b-5");
});

test("currency line and trims", () => {
  const d = buildDocument({ selection: ["s-77e"], metadata: {}, options: { trim: "6x9" } }, ctx);
  assert.equal(d.meta.trim, "6x9");
  assert.match(d.meta.currency, /^Statutes current through Public Law \d+-\d+ \(.+\); regulations current as of \w+ \d+, \d{4}\.$/);
  assert.match(d.meta.currencyDetail, /release point \d+-\d+/);
  assert.equal(buildDocument({ selection: ["s-77e"], metadata: {}, options: { trim: "a4" } }, ctx).meta.trim, "letter");
});

test("typography: curly quotes, glued em dashes", async () => {
  const { typo } = await import(path.join(ROOT, "builder/pdf/document.js"));
  assert.equal(typo(`the issuer's "control" person`), "the issuer\u2019s \u201ccontrol\u201d person");
  assert.equal(typo("which may include\u2014"), "which may include\u2060\u2014");
});

test("Instructions labels are set in italic, as the eCFR prints them", () => {
  const it = item(doc(["r-229-402"]), "r-229-402");
  const b = it.body.find(x => x.k === "p" && x.r[0] && x.r[0].i && /^Instructions to Item[ \u00a0]402\(c\)\(2\)\(iii\) and \(iv\)\.$/.test(x.r[0].t));
  assert.ok(b, "label run");
  assert.match(b.r[1], /^ 1\. /, "the instructions follow in roman");
});

test("footnote markers never print as text: each becomes a footnote or is dropped with its note", () => {
  const std = JSON.parse(fs.readFileSync(path.join(ROOT, "builder/presets/secreg-standard.json"), "utf8")).selection;
  for (const mode of ["codified", "original"]) {
    const d = doc(std, { mode });
    const stray = [];
    for (const it of d.parts.flatMap(p => p.items)) for (const b of it.body) {
      if (b.k !== "p") continue;   // table notes are real superscripts
      for (const r of b.r) if (/[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(typeof r === "string" ? r : (r.t || ""))) stray.push(`${it.lab}: ${typeof r === "string" ? r.slice(0, 40) : r.t}`);
    }
    assert.deepEqual(stray, [], mode);
  }
  // "section 77d(6)¹ of this title": the marker of a dropped OLRC note goes with the note
  const d = doc(["s-77d", "s-77d–1"], { mode: "original" });
  const runs = item(d, "s-77d–1").body.flatMap(b => b.r || []);
  assert.ok(runs.some(r => r.t === "section 4(6)" && r.l === "s-77d"));
});

test("original numbering: lists that repeat 'section' convert whole and link every number", () => {
  const d = doc(["s-77z–2", "s-77l", "s-77m", "s-77g"], { mode: "original" });
  const text = lab => item(d, lab).body.flatMap(b => b.r || []).map(r => typeof r === "string" ? r : r.t).join("").replace(/\u00a0/g, " ");
  assert.match(text("s-77z–2"), /section 13\(a\) or section 15\(d\) of the Securities Exchange Act of 1934/);
  assert.match(text("s-77m"), /section 11 or 12\(a\)\(2\) unless/);
  assert.match(text("s-77g"), /specified in Schedule A, and/);
  assert.ok(item(d, "s-77m").body.flatMap(b => b.r || []).some(r => r.t === "12(a)(2)" && r.l === "s-77l/a/2"), "linked");
});

test("tables: short rows are padded so every cell keeps its column (Item 402(h) column letters)", () => {
  const it = item(doc(["r-229-402"]), "r-229-402");
  const text = c => c.r.map(r => (typeof r === "string" ? r : r.t || "")).join("");
  for (const t of it.body.filter(b => b.k === "t")) {
    const width = row => row.reduce((n, c) => n + c.cs, 0);
    const flat = t.rows.every(row => row.every(c => c.rs === 1));
    if (flat) assert.equal(new Set(t.rows.map(width)).size, 1, "every row spans the same columns");
  }
  const pension = it.body.find(b => b.k === "t" && b.rows.some(r => /Number of years credited/.test(r.map(text).join("|"))));
  assert.deepEqual(pension.rows[1].map(text), ["(a)", "(b)", "(c)", "(d)", "(e)"]);
  assert.equal(text(pension.rows[0][0]), "Name");
});

test("run-in enumerators keep every anchor", () => {
  const d = doc(["r-240-10b5-1"]);
  const it = item(d, "r-240-10b5-1");
  const runin = it.body.find(b => b.n && /^\(\w+\)\(\w+\)/.test(b.n));
  if (runin) assert.ok(runin.a && runin.a2.length >= 1, JSON.stringify(runin).slice(0, 200));
});

test("a typed 'Part I.' becomes the kicker", async () => {
  const { splitPartTitle } = await import(path.join(ROOT, "builder/pdf/document.js"));
  assert.deepEqual(splitPartTitle("Part I. Securities Act of 1933"), { kicker: "Part I", title: "Securities Act of 1933" });
  assert.deepEqual(splitPartTitle("Securities Act of 1933"), { kicker: null, title: "Securities Act of 1933" });
  // numbering is positional; a typed "Part IV" only chooses Roman numerals for the whole book
  const d = buildDocument({ selection: ["s-78j", "s-77e"], metadata: { groupTitles: { "act:act-ch2A": "Part IV — The '33 Act" } } }, ctx);
  assert.deepEqual(d.parts.map(p => p.kicker), ["Part I", "Part II"]);
  assert.equal(d.parts[1].title, "The \u201933 Act");
  const w = buildDocument({ selection: ["s-78j", "s-77e"], metadata: {} }, ctx);
  assert.deepEqual(w.parts.map(p => p.kicker), ["Part One", "Part Two"]);
});

test("footnotes become page footnotes", () => {
  const d = doc(["s-78c"]);
  const fns = allRuns(item(d, "s-78c")).filter(r => r.fn);
  assert.ok(fns.length >= 1);
  assert.ok(!item(d, "s-78c").body.some(b => b.s === "fn" && /So in original/.test(JSON.stringify(b.r))));
});

test("original numbering leaves no Act cross-reference in U.S. Code form", () => {
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "builder/presets/secreg-standard.json"), "utf8"));
  const d = buildDocument({ selection: preset.selection, metadata: {}, mode: "original", options: { numbering: "original" } }, ctx);
  const actNums = new Set(corpus.acts.flatMap(a => a.sections.filter(s => /^\d/.test(s.original?.num || "")).map(s => s.codified.num)));
  const left = [];
  for (const p of d.parts) for (const it of p.items) {
    if (it.kind !== "usc") continue;
    const text = it.body.flatMap(b => b.r || []).map(r => (typeof r === "string" ? r : r.t || "")).join("");
    for (const m of text.matchAll(/\b[Ss]ections? (\d+[a-z]*(?:–\d+[a-z]*)?)\S* of this title/g)) {
      if (actNums.has(m[1])) left.push(`${it.lab}: ${m[0]}`);
    }
  }
  assert.deepEqual(left, []);
});

test("codified lists 'section 77k or 77l(a)(2)' link every number", () => {
  const d = doc(["s-77m", "s-77k", "s-77l"]);
  const runs = allRuns(item(d, "s-77m"));
  assert.ok(runs.some(r => r.l === "s-77k") && runs.some(r => r.l && r.l.startsWith("s-77l/a")));
});
