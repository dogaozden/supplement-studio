// search.test.mjs — node test for builder/search.js (citation-aware search).
// Run: node builder/tests/node/search.test.mjs   (exits nonzero on failure)
//
// Every query from the studio brief, against the checked-in corpus AND the
// same corpus decorated with the fields the corpus lane is adding (subject
// groups, common names, split acts, Sarbanes-Oxley). A case that needs a field
// the checked-in corpus doesn't have yet is skipped there (and counted), and
// runs automatically once the corpus has it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexCorpus } from "../../corpus.js";
import { createSearch } from "../../search.js";
import { describe } from "../../labels.js";
import { decorateCorpus } from "./decorate_corpus.mjs";

await import("../../assets/vendor/fuse.min.js");   // sets globalThis.Fuse
const Fuse = globalThis.Fuse;
assert.equal(typeof Fuse, "function", "vendored Fuse did not load");

const raw = JSON.parse(readFileSync(new URL("../../corpus.json", import.meta.url), "utf8"));
const variants = [
  ["checked-in corpus", raw],
  ["decorated corpus", decorateCorpus(raw)],
].map(([name, corpus]) => {
  const index = indexCorpus(corpus);
  return { name, corpus, index, s: createSearch(index, { Fuse }) };
});

const needsGroup = (id) => v => v.index.subjectGroupById.has(id);
const needsId = (...ids) => v => ids.every(id => v.index.byId.has(id));

// [query, expectation, needs?]
//   top:      id of the first result (a provision)
//   topUnit:  key of the first result (a unit row), optional count
//   within:   ids that must all appear in the first N results
//   note:     regex the first result's note must match
const CASES = [
  // rules
  ["Rule 10b-5", { top: "r-240-10b-5" }],
  ["10b-5", { top: "r-240-10b-5" }],
  ["Rule 10b5-1", { top: "r-240-10b5-1" }],
  ["240.10b-5", { top: "r-240-10b-5" }],
  ["17 CFR 240.10b-5", { top: "r-240-10b-5" }],
  ["17 C.F.R. § 240.10b-5", { top: "r-240-10b-5" }],
  ["rule 10B-5.", { top: "r-240-10b-5" }],
  ["Rule 144", { top: "r-230-144" }],
  ["Rule 144A", { top: "r-230-144A" }],
  ["Rule 14a-8", { top: "r-240-14a-8" }],
  ["Rule 501", { top: "r-230-501" }],
  ["Rule 15c2-11", { top: "r-240-15c2-11" }],
  ["Rule 10b", { within: ["r-240-10b-5", "r-240-10b5-1"], n: 16 }],
  // statutes by U.S. Code number
  ["§ 77e", { top: "s-77e" }],
  ["77e", { top: "s-77e" }],
  ["§§ 77e", { top: "s-77e" }],
  ["15 U.S.C. 77e", { top: "s-77e" }],
  ["15 USC § 77e", { top: "s-77e" }],
  ["15 U.S.C. § 78j-1", { top: "s-78j–1" }],
  ["§ 78j–1", { top: "s-78j–1" }],
  // statutes by act section number
  ["Section 5", { top: "s-77e", within: ["s-77e", "s-78e", "s-80a–5"], n: 6 }],
  ["Sec. 5", { top: "s-77e", within: ["s-78e"], n: 6 }],
  ["SEC. 5", { top: "s-77e" }],
  ["Securities Act § 5", { top: "s-77e" }],
  ["'33 Act § 5", { top: "s-77e" }],
  ["’33 Act § 5", { top: "s-77e" }],
  ["1933 Act section 5", { top: "s-77e" }],
  ["Securities Act § 11", { top: "s-77k" }],
  ["Section 12(a)(2)", { top: "s-77l", note: /\(a\)\(2\)/ }],
  ["Exchange Act § 10(b)", { top: "s-78j", note: /\(b\)/ }],
  ["'34 Act § 10(b)", { top: "s-78j" }],
  ["Exchange Act § 21D", { top: "s-78u–4" }, v => v.index.byId.get("s-78u–4")?.original?.num === "21D"],
  // the famous Exchange Act citations, typed without the act (round-1 lawyer critic, gap 3)
  ["Section 16(b)", { top: "s-78p", note: /\(b\)/ }],
  ["Section 13(d)", { top: "s-78m", note: /\(d\)/ }],
  ["Section 10(b)", { top: "s-78j", note: /\(b\)/ }],
  ["14(a)", { top: "s-78n", note: /\(a\)/ }],
  ["9", { top: "s-78i" }],
  ["18", { top: "s-78r" }],
  ["20(a)", { top: "s-78t", note: /\(a\)/ }],
  ["Section 21D", { top: "s-78u–4" }, v => v.index.byId.get("s-78u–4")?.original?.num === "21D"],
  // ...and the Securities Act ones stay with the Securities Act
  ["12(a)(2)", { top: "s-77l", note: /\(a\)\(2\)/ }],
  ["Section 11", { top: "s-77k" }],
  ["Section 17(a)", { top: "s-77q" }],
  ["Securities Act § 16(b)", { top: "s-77p" }],
  ["Securities Act § 13(d)", { top: "s-77m", note: /no subsection \(d\)/ }],
  ["Exchange Act § 16(b)", { top: "s-78p" }],
  // rule numbers typed without their hyphen
  ["10b5", { top: "r-240-10b-5", within: ["r-240-10b5-1"], n: 3 }],
  ["10b 5", { top: "r-240-10b-5" }],
  ["rule 10b5", { top: "r-240-10b-5" }],
  ["14a8", { top: "r-240-14a-8" }],
  ["13d1", { top: "r-240-13d-1" }],
  // groups, items, forms
  ["Reg D",{ topUnit: "grp:cfr-17-p230-regd", count: 8 }, needsGroup("cfr-17-p230-regd")],
  ["Regulation D", { topUnit: "grp:cfr-17-p230-regd", count: 8 }, needsGroup("cfr-17-p230-regd")],
  ["reg d", { topUnit: "grp:cfr-17-p230-regd" }, needsGroup("cfr-17-p230-regd")],
  ["Reg S", { topUnit: "grp:cfr-17-p230-regs" }, needsGroup("cfr-17-p230-regs")],
  ["Reg A", { topUnit: "grp:cfr-17-p230-rega" }, needsGroup("cfr-17-p230-rega")],
  ["Reg D 506", { top: "r-230-506" }, needsGroup("cfr-17-p230-regd")],
  ["Regulation S-K Item 404", { top: "r-229-404" }],
  ["Item 404", { top: "r-229-404" }],
  ["S-K 404", { top: "r-229-404" }],
  ["Reg S-K", { topUnit: "reg:cfr-17-p229" }],
  ["Reg FD", { topUnitCovers: ["r-243-100", "r-243-101", "r-243-102", "r-243-103"] }],
  ["Form 10-K", { top: "r-249-310" }],
  ["Schedule 13D", { top: "r-240-13d-101" }],
  // other acts
  ["SOX 302", { top: "s-7241" }, needsId("s-7241")],
  ["Sarbanes-Oxley § 302", { top: "s-7241" }, needsId("s-7241")],
  ["Sarbanes-Oxley Act section 404", { top: "s-7262" }, needsId("s-7262")],
  ["Advisers Act § 206", { top: "s-80b–6" }, v => v.corpus.acts.some(a => /advisers act/i.test(a.short_title))],
  ["TIA § 305", { top: "s-77eee" }, v => v.corpus.acts.some(a => /trust indenture/i.test(a.short_title))],
  // ideas
  ["PSLRA", { within: ["s-78u–4", "s-77z–1"], n: 2 }],
  ["accredited investor", { top: "r-230-501" }],
  ["insider trading", { within: ["r-240-10b5-1", "r-240-10b5-2", "s-78u–1"], n: 8 }],
  // whole acts and parts
  ["Exchange Act", { topUnit: "act:act-ch2B" }],
  ["'33 Act", { topUnit: "act:act-ch2A" }],
  ["Securities Act of 1933", { topUnit: "act:act-ch2A" }],
  ["Part 240", { topUnit: "reg:cfr-17-p240" }],
  // plain keywords over headings
  ["tender offers", { within: ["r-240-14e-3"], n: 12 }],
  ["selective disclosure", { within: ["r-243-100"], n: 3 }],
  ["manipulative deceptive", { within: ["s-78j", "r-240-10b-5"], n: 6 }],
  ["isider trading", { within: ["s-78u–1"], n: 12 }],   // typo forgiven
];

let failures = 0;
let skipped = 0;
let passed = 0;
const describeResult = (v, r) => r.type === "unit"
  ? `[${r.unitType}] ${r.key} (${r.count})`
  : `${r.id} ${describe(r.id, v.index).cite}`;

for (const v of variants) {
  for (const [q, want, needs] of CASES) {
    const label = `${v.name}: "${q}"`;
    if (needs && !needs(v)) { skipped++; continue; }
    try {
      const results = v.s.search(q, { limit: 40 });
      assert.ok(results.length > 0, "no results");
      const first = results[0];
      const shown = results.slice(0, 5).map(r => describeResult(v, r)).join("  |  ");
      if (want.top) {
        assert.equal(first.type, "provision", `top result is a unit: ${shown}`);
        assert.equal(first.id, want.top, `top is ${first.id}; first five: ${shown}`);
      }
      if (want.topUnit) {
        assert.equal(first.type, "unit", `top result is not a unit: ${shown}`);
        assert.equal(first.key, want.topUnit, `top unit is ${first.key}`);
        if (want.count) assert.equal(first.count, want.count);
      }
      if (want.topUnitCovers) {
        assert.equal(first.type, "unit", `top result is not a unit: ${shown}`);
        for (const id of want.topUnitCovers) assert.ok(first.ids.includes(id), `${first.key} lacks ${id}`);
      }
      if (want.within) {
        const head = new Set(results.slice(0, want.n || 5).filter(r => r.type === "provision").map(r => r.id));
        for (const id of want.within) assert.ok(head.has(id), `${id} not in the first ${want.n || 5}: ${shown}`);
      }
      if (want.note) assert.match(first.note || "", want.note, "subsection note missing");
      passed++;
    } catch (e) {
      failures++;
      console.error(`FAILED  ${label}\n        ${e.message}`);
    }
  }
}

function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error(`FAILED  ${name}\n        ${e.message}`); }
}

test("empty and whitespace queries return nothing", () => {
  for (const v of variants) {
    assert.deepEqual(v.s.search(""), []);
    assert.deepEqual(v.s.search("   "), []);
  }
});

test("garbage never throws", () => {
  for (const v of variants) {
    for (const q of ["(((", "§", "§§§ ", "rule", "section", "'", "10b-", "((a)(b))", "\\", "17 CFR", "a", "zzzzzzzz", "77e(((", "%ZZ"]) {
      assert.ok(Array.isArray(v.s.search(q)), q);
    }
  }
});

test("an exact citation outranks keyword matches", () => {
  for (const v of variants) {
    const r = v.s.search("Rule 144");
    assert.equal(r[0].id, "r-230-144");
    // Rule 159A's heading mentions section 12(a)(2); a citation query must not surface it first
    assert.notEqual(v.s.search("Section 12(a)(2)")[0].id, "r-230-159A");
  }
});

test("every result id exists and no id repeats", () => {
  for (const v of variants) {
    for (const [q] of CASES) {
      const results = v.s.search(q, { limit: 40 });
      const keys = results.map(r => (r.type === "unit" ? `u:${r.key}` : `p:${r.id}`));
      assert.equal(new Set(keys).size, keys.length, `duplicates for ${q}`);
      for (const r of results) if (r.type === "provision") assert.ok(v.index.byId.has(r.id), `${r.id} for ${q}`);
    }
  }
});

test("search is fast (all cases under 150 ms each)", () => {
  for (const v of variants) {
    for (const [q] of CASES) {
      const t0 = performance.now();
      v.s.search(q);
      assert.ok(performance.now() - t0 < 150, `${q} took ${(performance.now() - t0).toFixed(0)} ms`);
    }
  }
});

// ── round-1 critic fixes ────────────────────────────────────────────────────

// does the section really contain subsection "(a)(2)"? (own walk, not search.js's)
function hasSubsection(index, id, sub) {
  const chain = [...sub.matchAll(/\(([a-z0-9]+)\)/gi)].map(m => m[1].toLowerCase());
  const find = (nodes, depth) => (nodes || []).some(n =>
    n.num && String(n.num).toLowerCase() === chain[depth]
      ? (depth === chain.length - 1 || find(n.children, depth + 1))
      : find(n.children, depth));
  return find(index.byId.get(id).content, 0);
}

test("a subsection is never claimed unless the section has it", () => {
  const queries = ["Section 13(d)", "Section 16(b)", "Section 10(b)", "14(a)", "12(a)(2)", "20(a)", "Section 5(c)",
    "Section 21D(b)", "77m(d)", "Securities Act § 13(d)", "Rule 144(d)", "Rule 506(b)(2)", "17(a)", "Section 12(g)"];
  for (const v of variants) {
    for (const q of queries) {
      for (const r of v.s.search(q, { limit: 40 })) {
        if (r.type !== "provision" || !r.note) continue;
        const sub = (/subsection (\([^ ]+\))/.exec(r.note) || [])[1];
        if (!sub) continue;
        const has = hasSubsection(v.index, r.id, sub);
        assert.equal(/is part of this/.test(r.note), has, `${q}: ${r.id} ${has ? "has" : "lacks"} ${sub} but says "${r.note}"`);
      }
    }
  }
});

test("Securities Act § 13 says it has no subsection (d); the Exchange Act § 13 says it has", () => {
  for (const v of variants) {
    const r = v.s.search("Securities Act § 13(d)")[0];
    assert.equal(r.id, "s-77m");
    assert.match(r.note, /no subsection \(d\)/);
    assert.doesNotMatch(r.note, /is part of/);
    assert.match(v.s.search("Section 13(d)")[0].note, /Subsection \(d\) is part of this section/);
  }
});

test("12(a)(2): an Act section outranks every rule, Rule 12 of Regulation S-T included", () => {
  for (const v of variants) for (const q of ["12(a)(2)", "Section 12(a)(2)", "§ 12(a)(2)"]) {
    const results = v.s.search(q);
    const firstRule = results.findIndex(r => r.type === "provision" && v.index.regBySectionId.has(r.id));
    const lastAct = results.reduce((n, r, i) => (r.type === "provision" && v.index.actBySectionId.has(r.id) && r.score > 100 ? i : n), -1);
    assert.equal(results[0].id, "s-77l", q);
    assert.ok(firstRule < 0 || lastAct < firstRule, `${q}: a rule (${results[firstRule]?.id}) comes before an Act section`);
  }
});

test("[Reserved], repealed and omitted provisions never appear in search results", () => {
  for (const v of variants) {
    const reserved = new Set();
    for (const reg of v.corpus.regulations) for (const r of reg.rules) if (/^\[.*reserved.*\]$/i.test(r.heading)) reserved.add(r.id);
    for (const a of v.corpus.acts) for (const s of a.sections) if (s.status !== "active" || !s.content?.length) reserved.add(s.id);
    assert.ok(reserved.size > 50, "the corpus has reserved sections to test against");
    const queries = ["Rule 505", "Rule 10b-2", "10b", "Rule 155", "§ 78jj", "Section 12(a)(2)", "Reg D", "Reg A", "Regulation A+",
      "Part 239", "reserved", "repealed", "omitted", "Rule 300", "239.12", "Form S-1", "Rule 4-05", "Rule 3-19"];
    for (const q of queries) {
      for (const r of v.s.search(q, { limit: 60 })) {
        if (r.type === "provision") assert.ok(!reserved.has(r.id), `${q}: ${r.id} is reserved`);
        else for (const id of r.ids) assert.ok(!reserved.has(id), `${q}: unit ${r.key} would add reserved ${id}`);
      }
    }
    // counts follow: Regulation D has 9 entries and one is reserved
    assert.equal(v.s.search("Reg D")[0].count, 8);
  }
});

test("popular names: JOBS Act, Dodd-Frank, SLUSA, crowdfunding, Regulation A+ each give an Add-all row", () => {
  const credited = (v, re) => v.corpus.acts.flatMap(a => a.sections)
    .filter(s => re.test(String(s.source_credit).replace(/[–—]/g, "-"))).map(s => s.id);
  for (const v of variants) {
    const jobs = v.s.search("JOBS Act")[0];
    assert.equal(jobs.type, "unit");
    assert.equal(jobs.key, "bundle:jobs");
    assert.deepEqual(jobs.ids, credited(v, /Pub\. L\. 112-106(?!\d)/));
    for (const id of ["s-77d–1", "s-77b", "s-78l", "s-77e"]) assert.ok(jobs.ids.includes(id), `JOBS Act lacks ${id}`);
    assert.match(jobs.range, /112–106/);

    const df = v.s.search("Dodd-Frank")[0];
    assert.equal(df.key, "bundle:dodd-frank");
    assert.deepEqual(df.ids, credited(v, /Pub\. L\. 111-203(?!\d)/));
    assert.ok(df.ids.includes("s-78u–6"), "whistleblower § 21F");
    assert.equal(v.s.search("dodd frank act")[0].key, "bundle:dodd-frank");
    assert.equal(v.s.search("Dodd-Frank § 922")[0].id, "s-78u–6");
    assert.equal(v.s.search("whistleblower")[0].id, "s-78u–6");

    const slusa = v.s.search("SLUSA")[0];
    assert.equal(slusa.key, "bundle:slusa");
    assert.deepEqual([...slusa.ids].sort(), ["s-77p", "s-77v", "s-77z–1", "s-78bb", "s-78u–4"].sort());

    const cf = v.s.search("crowdfunding")[0];
    assert.equal(cf.key, "bundle:crowdfunding");
    for (const id of ["s-77d", "s-77d–1", "r-227-100", "r-227-201"]) assert.ok(cf.ids.includes(id), `crowdfunding lacks ${id}`);

    const rega = v.s.search("Regulation A+")[0];
    assert.equal(rega.type, "unit");
    assert.equal(rega.key, "grp:cfr-17-p230-rega");
    assert.equal(v.s.search("Reg A+")[0].key, "grp:cfr-17-p230-rega");

    // the old names still work next to the new
    assert.equal(v.s.search("Regulation Crowdfunding")[0].key, "reg:cfr-17-p227");
    assert.equal(v.s.search("JOBS Act § 302")[0].id, "s-77d–1");
  }
});

// ── round-2 critic fixes ────────────────────────────────────────────────────

test("a pinpoint citation drops the candidates that lack the subsection when another has it (design critic 11)", () => {
  for (const v of variants) for (const q of ["Section 12(a)(2)", "12(a)(2)", "§ 12(a)(2)", "Section 12(g)(2)"]) {
    const results = v.s.search(q, { limit: 40 });
    assert.ok(results.length >= 1 && results.length <= 3, `${q}: ${results.length} rows`);
    for (const r of results) {
      assert.equal(r.type, "provision");
      const sub = q.slice(q.indexOf("("));
      assert.ok(hasSubsection(v.index, r.id, sub), `${q}: ${r.id} lacks ${sub}`);
      assert.doesNotMatch(r.note || "", /has no subsection/, q);
    }
  }
});

test("when no candidate has the subsection, the note stays", () => {
  for (const v of variants) {
    const results = v.s.search("Securities Act § 13(d)");
    assert.equal(results[0].id, "s-77m");
    assert.match(results[0].note, /no subsection \(d\)/);
    assert.match(v.s.search("Section 13(z)")[0].note, /no subsection \(z\)/);
  }
});

test("form items are not in the C.F.R.: no fuzzy noise, and the notice says so (lawyer critic)", () => {
  for (const v of variants) {
    for (const q of ["Item 1.01", "item 5.02", "Item 2.02", "Item 9.01"]) {
      assert.deepEqual(v.s.search(q), [], `${q} should have no rows`);
      assert.match(v.s.notice(q), /Form 8-K items are not in the C\.F\.R\.; the form is published by the SEC/, q);
    }
    // a query that names the form finds its filing rule, never a California exemption
    for (const q of ["Form 8-K Item 1.01", "Item 1.01 of Form 8-K", "8-K item 5.02"]) {
      const r = v.s.search(q);
      assert.deepEqual(r.map(x => x.id), ["r-249-308"], q);
      assert.match(r[0].note, /part of the form itself/);
      assert.equal(v.s.notice(q), "");
    }
    // real Regulation S-K items, and Item 10 (a real S-K item), are untouched
    assert.equal(v.s.search("Item 404")[0].id, "r-229-404");
    assert.equal(v.s.search("Item 10")[0].id, "r-229-10");
    assert.equal(v.s.search("Schedule 13D Item 4")[0].id, "r-240-13d-101");
    assert.equal(v.s.notice("Item 404"), "");
    assert.equal(v.s.notice(""), "");
  }
});

test("citations outside the collection say so (SOX § 906 is 18 U.S.C. § 1350)", () => {
  for (const v of variants) {
    for (const q of ["SOX 906", "Sarbanes-Oxley § 906", "sox section 906"]) {
      assert.deepEqual(v.s.search(q), [], `${q} should have no rows`);
      assert.match(v.s.notice(q), /18 U\.S\.C\. § 1350/, q);
    }
    assert.match(v.s.notice("18 U.S.C. 1348"), /Title 18/);
    assert.equal(v.s.notice("SOX 302"), "");
  }
});

console.log(`search: ${passed} passed, ${skipped} skipped (need corpus fields the checked-in corpus lacks), ${failures} failed`);
if (failures > 0) process.exit(1);
