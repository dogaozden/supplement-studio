// share_roundtrip.mjs — node test for builder/share.js (contracts.md § 5).
// Run: node builder/tests/node/share_roundtrip.mjs   (exits nonzero on failure)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeState, decodeState, makeNaming } from "../../share.js";

const corpus = JSON.parse(readFileSync(new URL("../../corpus.json", import.meta.url), "utf8"));
const naming = makeNaming(corpus);

const allIds = [];
for (const act of corpus.acts) for (const section of act.sections) allIds.push(section.id);
for (const reg of corpus.regulations) for (const rule of reg.rules) allIds.push(rule.id);
assert.ok(allIds.length > 1000, `corpus unexpectedly small: ${allIds.length} ids`);

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(items, rand) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const UNICODE_METADATA = {
  title: "Federal Securities Laws — Selected Provisions",
  subtitle: "§§ 77a–78pp, “annotated” & ‘curated’",
  course: "Sécurités Régulation — Übungen",
  term: "Fall 2026 — 1L/2L",
  professor: "Prof. Łukasz Müller-Ñoño",
  school: "Cornell Law School — Ithaca, NY",
};
const OPTIONS = { trim: "letter", numbering: "original", sourceCredits: true, colophon: true };
const enc = (selection, extra = {}) =>
  encodeState({ selection, metadata: {}, options: OPTIONS, ...extra }, "securities", naming);
const dec = hash => decodeState(hash, naming);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok      ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAILED  ${name}`);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

// ── v3: provisions by Act section and rule number ───────────────────────────

test("v3 names the book the way lawyers do", () => {
  const hash = enc(["s-77b", "s-77e", "s-77k", "s-77l", "s-78j", "s-78p", "r-230-144", "r-230-506", "r-240-10b-5"]);
  assert.equal(hash,
    "#v=3&c=securities&b=SecuritiesAct:2,5,11,12;ExchangeAct:10,16;Part230:144,506;Part240:10b-5");
});

test("Code sections outside any Act, schedules and parenthesised rule numbers stay readable", () => {
  const sel = ["s-77r–1", "s-77aa", "r-275-206(4)-8", "s-78dd–2"];
  const hash = enc(sel);
  assert.match(hash, /b=USC:77r-1;SecuritiesAct:SchedulesAB;Part275:206\(4\)-8;USC:78dd-2$/);
  assert.deepEqual(dec(hash).selection, sel);
});

test("every corpus id roundtrips, order preserved", () => {
  const decoded = dec(enc(allIds));
  assert.deepEqual(decoded, { c: "securities", selection: allIds, mode: "original", options: OPTIONS });
});

test("seeded shuffle + unicode metadata + every option roundtrip", () => {
  const selection = shuffled(allIds, mulberry32(0x1c)).slice(0, 250);
  const options = { trim: "6x9", numbering: "codified", sourceCredits: false, colophon: false };
  const groupTitles = {
    "act:act-ch2A": "The ’33 Act",
    "act:act-ch2B–1": "SIPA, “Investor Protection” & more = 5",
    "reg:cfr-17-p230": "Rules ~ under the '33 Act: A/B; (C)",
  };
  const hash = encodeState({ selection, metadata: { ...UNICODE_METADATA, groupTitles }, options }, "securities", naming);
  assert.ok(!hash.includes("–"), "no raw en-dash in the hash");
  const decoded = dec(hash);
  assert.deepEqual(decoded.selection, selection);
  assert.deepEqual(decoded.options, options);
  assert.equal(decoded.mode, "codified");
  assert.deepEqual(decoded.metadata, { ...UNICODE_METADATA, groupTitles, includeColophon: false });
});

test("Act numbering is a new book's numbering and is not written; Code numbering is n=code", () => {
  const params = new URLSearchParams(enc(["s-77a"]).slice(1));
  for (const key of ["n", "tr", "cr", "col", "g", "t"]) assert.ok(!params.has(key), key);
  const code = enc(["s-77a"], { options: { ...OPTIONS, numbering: "codified" } });
  assert.equal(new URLSearchParams(code.slice(1)).get("n"), "code");
});

test("a provision the corpus no longer has decodes to a visible missing id", () => {
  assert.deepEqual(dec("#v=3&c=securities&b=SecuritiesAct:2,99;Part230:9999").selection,
    ["s-77b", "missing:SecuritiesAct:99", "missing:Part230:9999"]);
  assert.deepEqual(dec(enc(["x-999", "s-77a"])).selection, ["x-999", "s-77a"]);
});

// ── older links ─────────────────────────────────────────────────────────────

test("v1 links decode with exactly the v1 shape (Code numbering unless m=o)", () => {
  assert.deepEqual(dec("#v=1&c=securities&m=o&s=s:77a,77b;r-230:144&t=Old%20link&co=Sec%20Reg&col=0"), {
    c: "securities",
    selection: ["s-77a", "s-77b", "r-230-144"],
    mode: "original",
    metadata: { title: "Old link", course: "Sec Reg", includeColophon: false },
  });
  assert.deepEqual(dec("#v=1&c=securities&s=s:77a"), { c: "securities", selection: ["s-77a"], mode: "codified" });
});

test("v2 links decode: ids, en-dash as ~, part titles and options", () => {
  const decoded = dec("#v=2&c=securities&s=s:77b,77b~1;r-240-10b:5&tr=7x10&g=act:act-ch2B~1=SIPA");
  assert.deepEqual(decoded.selection, ["s-77b", "s-77b–1", "r-240-10b-5"]);
  assert.deepEqual(decoded.options, { trim: "7x10", numbering: "codified", sourceCredits: true, colophon: true });
  assert.deepEqual(decoded.metadata.groupTitles, { "act:act-ch2B–1": "SIPA" });
});

test("malformed inputs decode to null", () => {
  const malformed = [
    "", "#", "#v=0&c=securities&s=s:77a", "#v=4&c=securities&b=SecuritiesAct:5",
    "#v=3&c=securities&s=s:77a", "#v=3&c=securities&b=SecuritiesAct:5&n=x",
    "#v=3&c=securities&b=:5", "#v=3&c=securities&b=SecuritiesAct:5,", "#v=3&c=securities&b=5",
    "#v=2&c=securities&s=s:77a&tr=a4", "#v=2&c=securities&s=s:77a&cr=x",
    "#v=2&c=securities&s=s:77a&g==Title", "#v=2&c=securities&s=s:77a&g=act:x",
    "#foo=bar", "#v=1&c=securities&s=s:77a%2", "#v=1&c=securities&s=%",
    "#c=securities&s=s:77a", "#v=1&s=s:77a", "#v=1&c=securities", "#v=1&c=securities&s=77a,77b",
    "#v=1&c=securities&s=s:77a&m=x", "#v=1&c=securities&s=:", "#v=1&c=securities&s=s:77a&col=x",
  ];
  for (const input of malformed) assert.equal(dec(input), null, input);
  assert.equal(decodeState("#v=3&c=securities&b=SecuritiesAct:5"), null, "v3 needs the corpus naming");
  assert.equal(dec(null), null);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall share codec tests passed");
