// store.test.mjs — node test for builder/store.js (undo/redo history, options,
// migration of pre-options states). Run: node builder/tests/node/store.test.mjs

import assert from "node:assert/strict";

const KEY = "stat-supp-builder-v1";
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures++; console.error(`FAILED  ${name}\n        ${e.stack || e.message}`); }
}

// Fresh module instance per test (the store keeps module-level state).
let n = 0;
async function freshStore(saved) {
  mem.clear();
  if (saved !== undefined) mem.set(KEY, typeof saved === "string" ? saved : JSON.stringify(saved));
  return import(`../../store.js?case=${n++}`);
}

await test("defaults: options present, mirrors in sync", async () => {
  const { store } = await freshStore();
  const s = store.get();
  assert.deepEqual(s.options, { trim: "letter", numbering: "original", sourceCredits: true, colophon: true });
  assert.equal(s.mode, "original");
  assert.equal(s.metadata.includeColophon, true);
  assert.deepEqual(s.metadata.groupTitles, {});
});

await test("migrates a pre-options state (mode + includeColophon become options)", async () => {
  const { store } = await freshStore({
    selection: ["s-77a", "s-77a", "s-77b"],
    metadata: { title: "Old", includeColophon: false },
    mode: "codified",
  });
  const s = store.get();
  assert.deepEqual(s.selection, ["s-77a", "s-77b"], "duplicates dropped");
  assert.equal(s.options.numbering, "codified");
  assert.equal(s.options.colophon, false);
  assert.equal(s.options.trim, "letter");
  assert.equal(s.metadata.title, "Old");
  assert.deepEqual(s.metadata.groupTitles, {});
});

await test("corrupt blobs fall back to a valid state", async () => {
  for (const bad of ["not json", "[]", "null", JSON.stringify({ selection: "x", userPresets: 5, metadata: 7, options: { trim: "a3", numbering: "x" } })]) {
    const { store } = await freshStore(bad);
    const s = store.get();
    assert.ok(Array.isArray(s.selection) && Array.isArray(s.userPresets));
    assert.equal(typeof s.metadata, "object");
    assert.equal(s.options.trim, "letter");
    assert.equal(s.options.numbering, "original");
  }
});

await test("set / undo / redo restore selection, titles and options", async () => {
  const { store } = await freshStore();
  store.set(s => ({ ...s, selection: ["s-77a"] }), { label: "Added § 1" });
  store.set(s => ({ ...s, metadata: { ...s.metadata, groupTitles: { "act:x": "Mine" } } }), { label: "Renamed" });
  store.set(s => ({ ...s, options: { ...s.options, trim: "6x9" } }), { label: "Trim" });
  assert.equal(store.undoLabel(), "Trim");
  assert.equal(store.undo(), "Trim");
  assert.equal(store.get().options.trim, "letter");
  assert.equal(store.undo(), "Renamed");
  assert.deepEqual(store.get().metadata.groupTitles, {});
  assert.deepEqual(store.get().selection, ["s-77a"]);
  assert.equal(store.undo(), "Added § 1");
  assert.deepEqual(store.get().selection, []);
  assert.equal(store.canUndo(), false);
  assert.equal(store.undo(), false);
  assert.equal(store.redo(), "Added § 1");
  assert.equal(store.redo(), "Renamed");
  assert.equal(store.redo(), "Trim");
  assert.equal(store.get().options.trim, "6x9");
  assert.equal(store.canRedo(), false);
});

await test("a new change clears the redo stack", async () => {
  const { store } = await freshStore();
  store.set({ selection: ["a"] });
  store.undo();
  assert.equal(store.canRedo(), true);
  store.set({ selection: ["b"] });
  assert.equal(store.canRedo(), false);
});

await test("undo: false and non-undoable fields do not record history", async () => {
  const { store } = await freshStore();
  store.set({ selection: ["a"] }, { undo: false });
  assert.equal(store.canUndo(), false);
  store.set(s => ({ ...s, userPresets: [{ id: "p" }], lastPreset: "p" }));
  assert.equal(store.canUndo(), false, "presets/lastPreset are not undoable state");
  store.set(s => ({ ...s, selection: [...s.selection] }));
  assert.equal(store.canUndo(), false, "no-op rewrite of the same selection");
});

await test("coalesce merges rapid same-key edits into one history entry", async () => {
  const { store } = await freshStore();
  for (const t of ["F", "Fa", "Fal", "Fall"]) {
    store.set(s => ({ ...s, metadata: { ...s.metadata, term: t } }), { coalesce: "term", label: "Edited term" });
  }
  assert.equal(store.historyDepth(), 1);
  store.undo();
  assert.equal(store.get().metadata.term, "");
  // a different key starts a new entry
  store.set(s => ({ ...s, metadata: { ...s.metadata, term: "x" } }), { coalesce: "term" });
  store.set(s => ({ ...s, metadata: { ...s.metadata, course: "y" } }), { coalesce: "course" });
  assert.equal(store.historyDepth(), 2);
});

await test("history is capped at 100", async () => {
  const { store, HISTORY_CAP } = await freshStore();
  for (let i = 0; i < 130; i++) store.set({ selection: [`id-${i}`] });
  assert.equal(HISTORY_CAP, 100);
  assert.equal(store.historyDepth(), 100);
  for (let i = 0; i < 100; i++) assert.ok(store.undo());
  assert.equal(store.undo(), false);
});

await test("mode and options.numbering stay in sync both ways", async () => {
  const { store } = await freshStore();
  store.set({ mode: "original" });                       // old code path (share boot, toggle)
  assert.equal(store.get().options.numbering, "original");
  store.set(s => ({ ...s, options: { ...s.options, numbering: "codified" } }));   // new code path
  assert.equal(store.get().mode, "codified");
});

await test("includeColophon and options.colophon stay in sync both ways", async () => {
  const { store } = await freshStore();
  store.set(s => ({ ...s, metadata: { ...s.metadata, includeColophon: false } }));
  assert.equal(store.get().options.colophon, false);
  store.set(s => ({ ...s, options: { ...s.options, colophon: true } }));
  assert.equal(store.get().metadata.includeColophon, true);
});

await test("state is persisted without history and survives a reload", async () => {
  const { store } = await freshStore();
  store.set({ selection: ["s-77a", "s-77b"] });
  store.set(s => ({ ...s, options: { ...s.options, trim: "7x10" } }));
  const saved = JSON.parse(mem.get(KEY));
  assert.deepEqual(saved.selection, ["s-77a", "s-77b"]);
  assert.equal(saved.options.trim, "7x10");
  assert.equal(saved.history, undefined);
  const again = await freshStore(saved);
  assert.deepEqual(again.store.get().selection, ["s-77a", "s-77b"]);
  assert.equal(again.store.get().options.trim, "7x10");
  assert.equal(again.store.canUndo(), false);
});

await test("subscribers hear set, undo and redo", async () => {
  const { store } = await freshStore();
  const seen = [];
  store.subscribe(s => seen.push(s.selection.length));
  store.set({ selection: ["a", "b"] });
  store.undo();
  store.redo();
  assert.deepEqual(seen, [0, 2, 0, 2]);
});

console.log(`store: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
