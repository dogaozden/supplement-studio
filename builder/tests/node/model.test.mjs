// model.test.mjs — node test for the studio's selection operations
// (builder/model.js additions, labels.js, units.js).
// Run: node builder/tests/node/model.test.mjs   (exits nonzero on failure)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexCorpus } from "../../corpus.js";
import {
  addIds, removeIds, removeGroup, sortGroup, moveItem, nudgeItem, moveGroup,
  withGroupTitle, unitStatus, groupSelection, coalesce, sourceKeyFor, defaultGroupTitle,
  splitPartTitle, partKicker, groupRepeatsTitle,
} from "../../model.js";
import { describe, scHtml, regulationDisplayTitle, ruleShortName, cleanHeading, currencyLine, isReserved, cfrParts, FORMS_TAG } from "../../labels.js";
import { buildUnits, groupSubtitle, partRange } from "../../units.js";
import { currencyLine as pdfCurrencyLine } from "../../pdf/document.js";
import { decorateCorpus } from "./decorate_corpus.mjs";

const raw = JSON.parse(readFileSync(new URL("../../corpus.json", import.meta.url), "utf8"));
const corpus = decorateCorpus(raw);
const index = indexCorpus(corpus);
const rawIndex = indexCorpus(raw);
const units = buildUnits(index);

let failures = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error(`FAILED  ${name}\n        ${e.stack || e.message}`); }
}
const act = id => units.byKey.get(`act:${id}`);

test("adding a whole act puts it in Code order and keeps it contiguous", () => {
  const securities = act("act-ch2A").ids;
  const sel = addIds(["r-240-10b-5", "s-78j"], securities.slice().reverse(), index);
  // the act joins its own part, not the end of the book, and is in Code order
  const groups = groupSelection({ selection: sel, metadata: {} }, index);
  assert.equal(groups.filter(g => g.key === "act:act-ch2A").length, 1);
  assert.deepEqual(groups.find(g => g.key === "act:act-ch2A").items, securities);
  assert.deepEqual(sel, coalesce(sel, index), "stored selection is coalesced");
});

test("adding to a part already in Code order merges back into Code order", () => {
  const sel0 = ["s-77a", "s-77e"];
  const sel = addIds(sel0, ["s-77c"], index);
  assert.deepEqual(sel, ["s-77a", "s-77c", "s-77e"]);
});

test("adding to a part the user reordered keeps their order and appends", () => {
  const sel = addIds(["s-77e", "s-77a"], ["s-77c"], index);
  assert.deepEqual(sel, ["s-77e", "s-77a", "s-77c"]);
});

test("a new part joins in Code order while the existing parts are in Code order", () => {
  // statutes before rules, Securities Act before Exchange Act
  assert.deepEqual(addIds(["r-240-10b-5"], ["s-77e", "s-77a"], index), ["s-77a", "s-77e", "r-240-10b-5"]);
  assert.deepEqual(addIds(["s-78j", "r-230-144"], ["s-77a"], index), ["s-77a", "s-78j", "r-230-144"]);
});

test("a new part is appended once the user has reordered the parts", () => {
  // rules ahead of the act: not Code order, so respect it
  const sel = addIds(["r-240-10b-5", "s-77a"], ["s-78j"], index);
  assert.deepEqual(sel, ["r-240-10b-5", "s-77a", "s-78j"]);
});

test("adding present ids returns the same array (no history entry)", () => {
  const sel = ["s-77a"];
  assert.equal(addIds(sel, ["s-77a"], index), sel);
});

test("a whole part added from scratch lands in Code order whatever order it arrives in", () => {
  const ids = units.parts.find(p => p.part === "230").ids;
  assert.deepEqual(addIds([], ids.slice().reverse(), index), ids);
  assert.deepEqual(addIds([], ids, index), ids);
});

test("removeIds and removeGroup", () => {
  const sel = ["s-77a", "r-240-10b-5", "s-77b", "r-230-144"];
  assert.deepEqual(removeIds(sel, ["s-77b"]), ["s-77a", "r-240-10b-5", "r-230-144"]);
  assert.equal(removeIds(sel, ["nope"]), sel);
  assert.deepEqual(removeGroup(sel, "act:act-ch2A", index), ["r-240-10b-5", "r-230-144"]);
});

test("sortGroup sorts one part into Code order and leaves others alone", () => {
  const sel = ["s-77e", "r-240-10b-5", "s-77a", "r-230-144", "s-77c"];
  assert.deepEqual(coalesce(sel, index), ["s-77e", "s-77a", "s-77c", "r-240-10b-5", "r-230-144"]);
  const c = coalesce(sel, index);
  assert.deepEqual(sortGroup(c, "act:act-ch2A", index), ["s-77a", "s-77c", "s-77e", "r-240-10b-5", "r-230-144"]);
  assert.deepEqual(sortGroup(c, "reg:cfr-17-p240", index), c, "already sorted: unchanged");
});

test("moveItem moves within a group only; cross-group drops are ignored", () => {
  const sel = ["s-77a", "s-77b", "s-77c", "r-230-144"];
  assert.deepEqual(moveItem(sel, "s-77c", "s-77a", false, index), ["s-77c", "s-77a", "s-77b", "r-230-144"]);
  assert.deepEqual(moveItem(sel, "s-77a", "s-77c", true, index), ["s-77b", "s-77c", "s-77a", "r-230-144"]);
  assert.equal(moveItem(sel, "s-77a", "r-230-144", true, index), sel);
  assert.equal(moveItem(sel, "s-77a", "s-77a", true, index), sel);
});

test("nudgeItem swaps neighbours inside the group and stops at the edges", () => {
  const sel = ["s-77a", "s-77b", "r-230-144"];
  assert.deepEqual(nudgeItem(sel, "s-77a", 1, index), ["s-77b", "s-77a", "r-230-144"]);
  assert.equal(nudgeItem(sel, "s-77a", -1, index), sel);
  assert.equal(nudgeItem(sel, "s-77b", 1, index), sel, "never crosses into the next part");
});

test("moveGroup reorders whole parts and keeps them contiguous", () => {
  const sel = ["s-77a", "s-77b", "r-230-144", "r-240-10b-5"];
  assert.deepEqual(moveGroup(sel, "reg:cfr-17-p240", 0, index), ["r-240-10b-5", "s-77a", "s-77b", "r-230-144"]);
});

test("withGroupTitle sets, trims, and clears on empty or default", () => {
  const def = "Securities Act of 1933";
  assert.deepEqual(withGroupTitle({}, "act:x", "  The '33 Act ", def), { "act:x": "The '33 Act" });
  assert.deepEqual(withGroupTitle({ "act:x": "A" }, "act:x", "", def), {});
  assert.deepEqual(withGroupTitle({ "act:x": "A" }, "act:x", def, def), {});
  const before = { "act:x": "A" };
  withGroupTitle(before, "act:x", "B", def);
  assert.deepEqual(before, { "act:x": "A" }, "input not mutated");
});

test("groupSelection applies custom titles and reports defaults", () => {
  const state = { selection: ["s-77a", "r-230-144"], metadata: { groupTitles: { "act:act-ch2A": "Part One" } } };
  const [a, r] = groupSelection(state, index);
  assert.equal(a.title, "Part One");
  assert.equal(a.custom, true);
  assert.equal(a.defaultTitle, defaultGroupTitle("act:act-ch2A", index));
  assert.equal(r.custom, false);
});

test("unitStatus is tri-state", () => {
  const ids = ["a", "b", "c"];
  assert.equal(unitStatus(ids, new Set()).state, "none");
  assert.equal(unitStatus(ids, new Set(["a"])).state, "some");
  assert.equal(unitStatus(ids, new Set(ids)).state, "all");
  assert.equal(unitStatus(ids, new Set(["a", "z"])).selected, 1);
});

test("units: an Act's Add all leaves out Code sections another statute enacted", () => {
  const sa = act("act-ch2A");
  assert.ok(sa.allIds.includes("s-77r–1"), "§ 77r–1 (SMMEA) stays in the list");
  assert.ok(!sa.ids.includes("s-77r–1"), "but Add all leaves it out");
  assert.ok(sa.ids.includes("s-77r"), "§ 18 is the Act's own");
  assert.equal(describe("s-77r–1", index).tag, "Not part of the Act");
  assert.equal(describe("s-77e", index).tag, "");
});

test("units: acts, subject groups and parts carry counts and ranges", () => {
  const regD = units.byKey.get("grp:cfr-17-p230-regd");
  assert.equal(regD.allIds.length, 9);
  assert.equal(regD.ids.length, 8, "Rule 505 is [Reserved]: shown in the tree, never added");
  assert.ok(!regD.ids.includes("r-230-505") && regD.allIds.includes("r-230-505"));
  assert.equal(regD.short, "Regulation D");
  assert.equal(regD.range, "§§ 230.500–230.508");
  const p230 = units.parts.find(p => p.part === "230");
  assert.ok(p230.children.length >= 3, `${p230.children.length} subject groups`);
  assert.ok(p230.children.some(c => c.short === "Regulation D"));
  assert.ok(p230.ungrouped.length < p230.ids.length);
  const exch = act("act-ch2B");
  assert.match(exch.range, /78a/);
  assert.ok(units.acts.some(a => /Sarbanes/.test(a.label)));
});

test("labels: citation first, both numberings", () => {
  const sec = describe("s-77e", index);
  assert.equal(sec.cite, "§ 5 · 15 U.S.C. § 77e");
  assert.equal(sec.lead, "§ 5");
  assert.equal(sec.altShort, "77e");
  const rule = describe("r-240-10b-5", index);
  assert.equal(rule.lead, "Rule 10b-5");
  assert.equal(rule.cite, "Rule 10b-5 · § 240.10b-5");
  assert.equal(rule.fullCite, "Rule 10b-5 · 17 C.F.R. § 240.10b-5");
  assert.equal(rule.heading, "Employment of manipulative and deceptive devices");
  const item = describe("r-229-404", index);
  assert.equal(item.lead, "Item 404");
  assert.equal(item.heading, "Transactions with related persons, promoters and certain control persons");
  const sx = describe("r-210-4-01", index);   // Regulation S-X rules are named "Rule 4-01"
  assert.match(sx.lead, /^(Rule 4-01|§ 210\.4-01)$/);
  assert.equal(describe("nope", index).kind, "missing");
});

test("labels fall back when the corpus predates the new fields", () => {
  // no short_name/common_name on most rules, no display_title, no part
  assert.equal(ruleShortName(rawIndex.byId.get("r-230-144A"), rawIndex.corpus.meta), "Rule 144A");
  assert.equal(ruleShortName(rawIndex.byId.get("r-249-310"), rawIndex.corpus.meta), "Form 10-K");
  // the shipped corpus carries curated short titles; one that predates them is derived from the heading
  const bare = structuredClone(raw);
  for (const reg of bare.regulations) delete reg.short_title;
  const bareIndex = indexCorpus(bare);
  assert.equal(regulationDisplayTitle(bareIndex.regById.get("cfr-17-p230")), "General Rules and Regulations, Securities Act of 1933");
  assert.equal(regulationDisplayTitle(bareIndex.regById.get("cfr-17-p243")), "Regulation FD");
  assert.equal(regulationDisplayTitle(bareIndex.regById.get("cfr-17-p229")), "Regulation S-K");
  assert.equal(defaultGroupTitle("reg:cfr-17-p240", bareIndex), "General Rules and Regulations, Securities Exchange Act of 1934");
  assert.equal(defaultGroupTitle("reg:cfr-17-p240", rawIndex), "Rules under the Securities Exchange Act of 1934");
});

test("heading cleanup: stray suffix letter, (Item N), trailing period", () => {
  assert.equal(cleanHeading({ heading: "A Private resales of securities to institutions." }, "144A"), "Private resales of securities to institutions");
  assert.equal(cleanHeading({ heading: "(Item 303) Management's discussion." }, "303"), "Management's discussion");
  assert.equal(cleanHeading({ heading: "(4)-8 Pooled investment vehicles." }, "206(4)-8"), "Pooled investment vehicles");
  assert.equal(cleanHeading({ heading: "Short title" }), "Short title");
});

test("status line: one currency phrase, the one on the PDF cover", () => {
  assert.equal(currencyLine({ source: { usc_release_point: "119-102", ecfr_date: "2026-08-06" } }),
    "Statutes current through Public Law 119-102; regulations current as of August 6, 2026.");
  assert.equal(currencyLine({ source: { usc_release_point: "119-134", usc_release_label: "Public Law 119-134 (October 20, 2026)", ecfr_date: "2026-10-29" } }),
    "Statutes current through Public Law 119-134 (October 20, 2026); regulations current as of October 29, 2026.");
  assert.equal(currencyLine({ source: { ecfr_date: "2026-10-29" } }), "Regulations current as of October 29, 2026.");
  assert.equal(currencyLine({}), "");
  assert.equal(currencyLine(corpus), currencyLine(raw), "decoration leaves the source block alone");
  // the studio footer (ui/topbar.js asks the PDF lane first) and this fallback never drift apart
  assert.equal(currencyLine(raw), pdfCurrencyLine(raw));
  assert.equal(currencyLine({ source: { usc_release_point: "119-102", ecfr_date: "2026-08-06" } }),
    pdfCurrencyLine({ source: { usc_release_point: "119-102", ecfr_date: "2026-08-06" } }));
});

test("isReserved: [Reserved] rules, repealed and omitted sections, anything without text", () => {
  assert.equal(isReserved(raw.regulations.flatMap(r => r.rules).find(r => r.id === "r-230-505")), true);
  assert.equal(isReserved(raw.regulations.flatMap(r => r.rules).find(r => r.id === "r-230-300-230.346")), true);
  assert.equal(isReserved(raw.acts.flatMap(a => a.sections).find(s => s.id === "s-78jj")), true, "repealed");
  assert.equal(isReserved(raw.acts.flatMap(a => a.sections).find(s => s.id === "s-78ii")), true, "omitted");
  assert.equal(isReserved(raw.acts.flatMap(a => a.sections).find(s => s.id === "s-77e")), false);
  assert.equal(isReserved(raw.regulations.flatMap(r => r.rules).find(r => r.id === "r-240-10b-5")), false);
  assert.equal(isReserved({ heading: "[Removed and Reserved]", content: [{ type: "p", text: "x" }] }), true);
  assert.equal(isReserved({ heading: "Definitions" }), false, "a corpus without content arrays is not all reserved");
  assert.equal(isReserved(null), false);
});

test("a range of reserved sections reads as a range, not as '230.300-230.346'", () => {
  const r = index.byId.get("r-230-300-230.346");
  assert.deepEqual(cfrParts(r, corpus.meta), { part: "230", num: "300", section: "230.300–230.346",
    range: { first: "230.300", last: "230.346" } });
  assert.equal(ruleShortName(r, corpus.meta), "Rules 300–346");
  assert.equal(describe(r.id, index).cite, "Rules 300–346 · §§ 230.300–230.346");
  const dash = index.byId.get("r-240-10b-6 - 240.10b-8");
  assert.equal(cfrParts(dash, corpus.meta).num, "10b-6");
  assert.equal(ruleShortName(dash, corpus.meta), "Rules 10b-6–10b-8");
  assert.equal(cfrParts(index.byId.get("r-240-10b-5"), corpus.meta).range, null);
});

test("group ranges and subtitles come from the corpus, not from string surgery", () => {
  const regA = units.byKey.get("grp:cfr-17-p230-rega");
  assert.equal(regA.range, "§§ 230.251–230.263", "the reserved run after Rule 263 is not part of the range");
  assert.ok(regA.allIds.includes("r-230-300-230.346") && !regA.ids.includes("r-230-300-230.346"));
  assert.equal(groupSubtitle("Regulation 14A: Solicitation of Proxies", "Regulation 14A"), "Solicitation of Proxies");
  assert.equal(groupSubtitle("Regulation A—Conditional Small Issues Exemption", "Regulation A"), "Conditional Small Issues Exemption");
  assert.equal(groupSubtitle("Regulation M", "Regulation M"), "");
  assert.equal(groupSubtitle("Subpart 229.1000—Mergers and Acquisitions (Regulation M-A)", "Regulation M-A"), "Mergers and Acquisitions (Regulation M-A)");
  assert.equal(units.byKey.get("grp:cfr-17-p240-reg14a").desc, "Solicitation of Proxies");
  for (const u of units.all) assert.ok(!/^[\s—–:;,.-]/.test(u.desc), `${u.key}: "${u.desc}"`);
  // every unit's addable ids are a subset of what it holds, and nothing addable is reserved
  for (const u of units.all) {
    assert.ok(u.ids.every(id => u.allIds.includes(id)), u.key);
    assert.ok(u.ids.every(id => !describe(id, index).reserved), u.key);
  }
  assert.ok(units.byKey.get("rest:reg:cfr-17-p240").allIds.length > 0);
});

test("Part 239 and 249 sections are labelled as filing rules, nothing else is", () => {
  assert.equal(describe("r-249-310", index).tag, FORMS_TAG);
  assert.equal(describe("r-239-11", index).tag, FORMS_TAG);
  assert.match(FORMS_TAG, /the form itself is not in the C\.F\.R\./);
  for (const id of ["r-240-10b-5", "r-230-144", "r-229-404", "s-77e"]) assert.equal(describe(id, index).tag, "");
});

test("a part's default title is the one regulation picked from it (Regulation M, not 'M, SHO, ATS…')", () => {
  const title = (ids, key) => groupSelection({ selection: ids, metadata: {} }, index).find(g => g.key === key);
  const m = title(["r-242-101", "r-242-102"], "reg:cfr-17-p242");
  assert.equal(m.title, "Regulation M");
  assert.equal(m.defaultTitle, "Regulation M");
  assert.equal(m.custom, false);
  assert.equal(title(["r-242-101", "r-242-201"], "reg:cfr-17-p242").title, "Regulations M, SHO, ATS, AC, NMS, SE, and SBSR", "two regulations: the part's own name");
  assert.equal(title(["r-240-14a-8", "r-240-14a-9"], "reg:cfr-17-p240").title, "Regulation 14A");
  assert.equal(title(["r-240-14a-8", "r-240-10b-5"], "reg:cfr-17-p240").title, "Rules under the Securities Exchange Act of 1934");
  assert.equal(title(["r-230-144"], "reg:cfr-17-p230").title, "Rules under the Securities Act of 1933", "'General' is not a named regulation");
  assert.equal(title(["r-229-404"], "reg:cfr-17-p229").title, "Regulation S-K", "a Subpart is not a named regulation");
  assert.equal(title(["r-230-501", "r-230-506"], "reg:cfr-17-p230").title, "Regulation D");
  assert.equal(defaultGroupTitle("reg:cfr-17-p242", index), "Regulations M, SHO, ATS, AC, NMS, SE, and SBSR", "no picks: the part's own name");
  // a custom title still wins, and clearing it falls back to the picked regulation
  const named = groupSelection({ selection: ["r-242-101"], metadata: { groupTitles: { "reg:cfr-17-p242": "Distribution rules" } } }, index)[0];
  assert.equal(named.title, "Distribution rules");
  assert.equal(named.defaultTitle, "Regulation M");
  assert.deepEqual(withGroupTitle({ "reg:cfr-17-p242": "Regulation M" }, "reg:cfr-17-p242", "Regulation M", named.defaultTitle), {});
});

test("groupRepeatsTitle: a subject group named like its part gets no subhead", () => {
  const regD = { short: "Regulation D", label: "Regulation D — Rules Governing the Limited Offer and Sale of Securities" };
  assert.equal(groupRepeatsTitle(regD, "Regulation D"), true);
  assert.equal(groupRepeatsTitle(regD, "Part II. Regulation D"), true, "a typed kicker is not part of the title");
  assert.equal(groupRepeatsTitle(regD, "regulation d."), true);
  assert.equal(groupRepeatsTitle(regD, "Rules under the Securities Act of 1933"), false);
  assert.equal(groupRepeatsTitle(null, "Regulation D"), false);
});

test("splitPartTitle: a typed 'Part I.' becomes the kicker, the rest the title", () => {
  assert.deepEqual(splitPartTitle("Part I. Securities Act of 1933"), { kicker: "Part I", title: "Securities Act of 1933" });
  assert.deepEqual(splitPartTitle("PART IV — SEC Rules under the Exchange Act"), { kicker: "Part IV", title: "SEC Rules under the Exchange Act" });
  assert.deepEqual(splitPartTitle("Part 2: Exchange Act"), { kicker: "Part 2", title: "Exchange Act" });
  assert.deepEqual(splitPartTitle("part three - Rules"), { kicker: "Part Three", title: "Rules" });
  assert.deepEqual(splitPartTitle("Part A. Statutes"), { kicker: "Part A", title: "Statutes" });
  assert.deepEqual(splitPartTitle("  Part xii.  The ’40 Acts "), { kicker: "Part XII", title: "The ’40 Acts" });
  // not a number prefix: left alone
  assert.deepEqual(splitPartTitle("Securities Act of 1933"), { kicker: null, title: "Securities Act of 1933" });
  assert.deepEqual(splitPartTitle("Part Time Employees"), { kicker: null, title: "Part Time Employees" });
  assert.deepEqual(splitPartTitle("Part I"), { kicker: null, title: "Part I" }, "nothing after it: keep the title");
  assert.deepEqual(splitPartTitle("Part I."), { kicker: null, title: "Part I." });
  assert.deepEqual(splitPartTitle("Part 240 rules"), { kicker: null, title: "Part 240 rules" }, "no separator");
  assert.deepEqual(splitPartTitle(""), { kicker: null, title: "" });
  assert.deepEqual(splitPartTitle(undefined), { kicker: null, title: "" });
  assert.equal(partKicker(1), "Part One");
  assert.equal(partKicker(10), "Part Ten");
  assert.equal(partKicker(21), "Part 21");
});

test("every corpus item describes without throwing", () => {
  for (const id of index.byId.keys()) {
    const d = describe(id, index);
    assert.ok(d.lead && d.cite, id);
  }
  assert.ok(sourceKeyFor("s-77a", index).startsWith("act:"));
});

test("scHtml wraps every run of digits so small caps never set them (design critic 2)", () => {
  assert.equal(scHtml("Subpart 229.100—Business"), 'Subpart <span class="fig">229.100</span>—Business');
  assert.equal(scHtml("Part 1"), 'Part <span class="fig">1</span>');
  assert.equal(scHtml("Regulation 14A"), 'Regulation <span class="fig">14</span>A');
  assert.equal(scHtml("Section 16(b)"), 'Section <span class="fig">16</span>(b)');
  assert.equal(scHtml("Part 1,234 and 5"), 'Part <span class="fig">1,234</span> and <span class="fig">5</span>');
  assert.equal(scHtml("Part Nine"), "Part Nine");
  assert.equal(scHtml(""), "");
  assert.equal(scHtml(null), "");
  // escaped, and the entity digits are not wrapped
  assert.equal(scHtml("A & B's <3"), 'A &amp; B&#39;s &lt;<span class="fig">3</span>');
});

const partOf = (ids, key) => groupSelection({ selection: ids, metadata: {} }, index).find(g => g.key === key);
test("partRange states what the part holds, the whole range only when it is all in (design critic 7)", () => {
  const sec = act("act-ch2A");
  // one section
  assert.equal(partRange(partOf(["s-77e"], sec.key), index), "15 U.S.C. § 77e");
  // several: first to last in Code order, whatever the order in the book
  assert.equal(partRange(partOf(["s-77l", "s-77e", "s-77g"], sec.key), index), "15 U.S.C. §§ 77e–77l");
  // the whole act: the act's own range
  assert.equal(partRange(partOf(sec.ids, sec.key), index), sec.range);
  assert.equal(sec.range, "15 U.S.C. §§ 77a–77aa");
  // all but one: not the whole act
  assert.equal(sec.ids.at(-2), "s-77z–4");
  assert.equal(partRange(partOf(sec.ids.slice(0, -1), sec.key), index), "15 U.S.C. §§ 77a to 77z–4");
  // numbers that carry their own dash read with "to"
  const ica = act("act-ch2D");
  assert.equal(partRange(partOf(["s-80a–5", "s-80a–2"], ica.key), index), "15 U.S.C. §§ 80a–2 to 80a–5");
  // rules: one, several, the whole part
  assert.equal(partRange(partOf(["r-230-506"], "reg:cfr-17-p230"), index), "17 C.F.R. § 230.506");
  assert.equal(partRange(partOf(["r-230-506", "r-230-501"], "reg:cfr-17-p230"), index), "17 C.F.R. §§ 230.501–230.506");
  assert.equal(partRange(partOf(["r-240-16b-3", "r-240-10b-5"], "reg:cfr-17-p240"), index), "17 C.F.R. §§ 240.10b-5 to 240.16b-3");
  // Act numbering names what lawyers name
  assert.equal(partRange(partOf(["r-230-506", "r-230-144"], "reg:cfr-17-p230"), index, "original"), "Rules 144–506");
  assert.equal(partRange(partOf(["r-240-16b-3", "r-240-10b-5"], "reg:cfr-17-p240"), index, "original"), "Rules 10b-5 to 16b-3");
  assert.equal(partRange(partOf(["s-77l", "s-77b", "s-77e"], "act:act-ch2A"), index, "original"), "§§ 2–12");
  const p243 = units.byKey.get("reg:cfr-17-p243");
  assert.equal(partRange(partOf(p243.ids, p243.key), index), "17 C.F.R. Part 243");
  // nothing, and a part the corpus does not know
  assert.equal(partRange({ key: "act:act-ch2A", items: [] }, index), "");
  assert.equal(partRange({ key: "other", items: ["s-77e"] }, index), "");
});

test("every corpus act's part range of its first section is a single-section citation", () => {
  for (const u of units.acts) {
    const first = u.ids[0];
    assert.match(partRange({ key: u.key, items: [first] }, index), /^15 U\.S\.C\. § \S+$/, u.key);
  }
});

console.log(`model: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
