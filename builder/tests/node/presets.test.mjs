// presets.test.mjs — every built-in template (builder/presets/*.json) points at
// real provisions, keeps each source contiguous, and is wired into the UI.
// Run: node builder/tests/node/presets.test.mjs
//
// A template may name ids from sources the corpus does not carry yet (e.g.
// Sarbanes-Oxley, Regulation Crowdfunding before the corpus lane lands them):
// the UI skips them. But if the corpus HAS the source, every id must exist.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { indexCorpus } from "../../corpus.js";
import { coalesce, groupSelection, sortIntoCodeOrder } from "../../model.js";
import { isReserved } from "../../labels.js";
import { estimatePages } from "../../pdf/engine.js";

const dir = new URL("../../presets/", import.meta.url);
const corpus = JSON.parse(readFileSync(new URL("../../corpus.json", import.meta.url), "utf8"));
const index = indexCorpus(corpus);

const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
const presets = files.map(f => ({ file: f, data: JSON.parse(readFileSync(new URL(f, dir), "utf8")) }));

let failures = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error(`FAILED  ${name}\n        ${e.message}`); }
}

// Is the source an id belongs to (a U.S.C. chapter or a C.F.R. part) in the corpus?
function sourcePresent(id) {
  const rule = id.match(/^r-(\d+)-/);
  if (rule) return index.regById.has(`cfr-17-p${rule[1]}`);
  const sec = id.match(/^s-(\d+)/);
  if (!sec) return true;
  // sections 7201-7266 are Sarbanes-Oxley (15 U.S.C. ch. 98)
  if (/^72\d\d$/.test(sec[1])) return corpus.acts.some(a => /sarbanes/i.test(a.short_title));
  return true;
}

test("the templates directory is exactly what the UI loads", () => {
  const ui = readFileSync(new URL("../../ui/presets.js", import.meta.url), "utf8");
  const loaded = [...ui.matchAll(/"\.\/presets\/([\w-]+\.json)"/g)].map(m => m[1]).sort();
  assert.deepEqual(loaded, files);
});

for (const { file, data } of presets) {
  test(`${file}: shape`, () => {
    assert.ok(data.id && typeof data.id === "string");
    assert.ok(data.name && data.description);
    assert.ok(Array.isArray(data.selection) && data.selection.length > 5);
    assert.equal(new Set(data.selection).size, data.selection.length, "duplicate ids");
    for (const id of data.selection) assert.equal(typeof id, "string");
  });

  test(`${file}: every id exists, unless its whole source is not in the corpus yet`, () => {
    const bad = data.selection.filter(id => !index.byId.has(id) && sourcePresent(id));
    assert.deepEqual(bad, [], `ids missing although their source is in the corpus: ${bad.join(", ")}`);
  });

  test(`${file}: no [Reserved], repealed or empty provision`, () => {
    const bad = data.selection.filter(id => index.byId.has(id) && isReserved(index.byId.get(id)));
    assert.deepEqual(bad, [], `reserved ids in the template: ${bad.join(", ")}`);
  });

  test(`${file}: coalesced (each source contiguous) once absent ids are skipped`, () => {
    const ids = data.selection.filter(id => index.byId.has(id));
    assert.deepEqual(coalesce(ids, index), ids);
  });

  test(`${file}: default part titles name parts that exist or are not in the corpus yet`, () => {
    for (const key of Object.keys(data.groupTitles || {})) {
      assert.match(key, /^(act|reg):/);
      const id = key.slice(key.indexOf(":") + 1);
      const known = index.actById.has(id) || index.regById.has(id);
      const m = id.match(/^cfr-17-p(\d+)$/);
      assert.ok(known || (m && !index.regById.has(id)), `unknown part key ${key}`);
    }
  });

  test(`${file}: parts and page estimate`, () => {
    const ids = data.selection.filter(id => index.byId.has(id));
    const state = { selection: ids, metadata: { groupTitles: data.groupTitles || {} }, options: { trim: "letter" } };
    const groups = groupSelection(state, index);
    assert.ok(groups.length >= 1);
    assert.ok(groups.every(g => g.missing.length === 0));
    const { pages } = estimatePages(state, { corpus, index });
    assert.ok(pages > 10, `${pages} pages`);
  });
}

test("names are unique, and only the standard template matches 'Securities Reg'", () => {
  const names = presets.map(p => p.data.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.filter(n => n.includes("Securities Reg")), ["Securities Regulation — Standard"]);
});

test("the standard template is the whole Securities Act (Title I) plus the core rules", () => {
  const std = presets.find(p => p.file === "secreg-standard.json").data.selection;
  // the Act as enacted: § 77r–1 (SMMEA) sits in the chapter but is not part of the Act
  const act = corpus.acts.find(a => a.id === "act-ch2A").sections.filter(s => s.original?.num).map(s => s.id);
  const titleI = act.slice(0, act.indexOf("s-77aa") + 1);
  for (const id of titleI) assert.ok(std.includes(id), `${id} missing from Title I`);
  for (const id of ["r-240-10b-5", "r-230-144A", "r-230-506", "r-230-901", "r-230-251", "r-243-100", "r-229-404", "s-78j", "s-78u–4"]) {
    assert.ok(std.includes(id), `${id} missing`);
  }
  // all of Reg D and Reg S
  for (let n = 500; n <= 508; n++) assert.ok(std.includes(`r-230-${n}`) || isReserved(index.byId.get(`r-230-${n}`)), `r-230-${n}`);
  for (let n = 901; n <= 905; n++) assert.ok(std.includes(`r-230-${n}`), `r-230-${n}`);
});

test("the standard template teaches shelf registration, going private, tender offers and Regulation M (round-1 lawyer critic)", () => {
  const std = presets.find(p => p.file === "secreg-standard.json").data.selection;
  for (const id of ["r-230-415", "r-230-430B", "r-240-13e-3", "r-240-14e-1", "r-240-14e-2", "r-240-14e-3",
    "r-240-12g5-1", "r-242-101", "r-242-102"]) {
    assert.ok(index.byId.has(id), `${id} is not in the corpus`);
    assert.ok(std.includes(id), `${id} missing from the standard template`);
  }
  // Regulation M is its own part, titled by its name: not "Regulations M, SHO, ATS…"
  const state = { selection: std.filter(id => index.byId.has(id)), metadata: { groupTitles: {} } };
  const regM = groupSelection(state, index).find(g => g.key === "reg:cfr-17-p242");
  assert.equal(regM.title, "Regulation M");
  assert.deepEqual(regM.items, ["r-242-101", "r-242-102"]);
});

test("the standard template adds Regulation 14D's core, the proxy definitions, Rules 159A, 174 and 701 (round-2 lawyer critic)", () => {
  const std = presets.find(p => p.file === "secreg-standard.json").data.selection;
  for (const id of ["r-240-14d-1", "r-240-14d-2", "r-240-14d-9", "r-240-14d-10", "r-240-14a-1", "r-240-14a-2",
    "r-230-159A", "r-230-174", "r-230-701"]) {
    assert.ok(index.byId.has(id), `${id} is not in the corpus`);
    assert.ok(!isReserved(index.byId.get(id)), `${id} is reserved`);
    assert.ok(std.includes(id), `${id} missing from the standard template`);
  }
});

test("the standard template keeps every part in Code order", () => {
  const std = presets.find(p => p.file === "secreg-standard.json").data.selection.filter(id => index.byId.has(id));
  const sorted = groupSelection({ selection: std, metadata: { groupTitles: {} } }, index)
    .flatMap(g => sortIntoCodeOrder(g.items, index));
  assert.deepEqual(sorted, std);
});

console.log(`presets: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
