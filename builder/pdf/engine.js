// PDF engine facade (Typst compiled to WebAssembly, run in a Web Worker).
// UI code imports ONLY this module for anything PDF-related.
//
//   estimatePages(state, ctx)            -> { pages, words }   (sync, cheap)
//   generatePdf(state, ctx, { onStage }) -> Promise<{ bytes: Uint8Array,
//                                            pages: number, ms: number,
//                                            filename: string }>
//
// ctx = { corpus, index } as produced by corpus.js. `onStage(label)` gets
// human-readable progress ("Loading typesetter…", "Typesetting 212 pages…").
//
import { groupSelection } from "../model.js";
import { buildDocument } from "./document.js";
import { patchCatalog } from "./pdf-patch.js";
import { PRODUCT } from "../config.js";

// Words per page by trim, measured against the Typst template (standard
// template + a 241-provision book; within ~3% of the typeset count).
const WORDS_PER_PAGE = { letter: 575, "7x10": 560, "6x9": 500 };

function countWords(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (node.text) n += node.text.split(/\s+/).length;
    if (node.heading) n += node.heading.split(/\s+/).length;
    if (node.html) n += node.html.replace(/<[^>]+>/g, " ").split(/\s+/).length;
    if (node.children) n += countWords(node.children);
  }
  return n;
}

const wordCache = new WeakMap();
function wordsOf(item) {
  if (!item) return 0;
  if (!wordCache.has(item)) wordCache.set(item, countWords(item.content) + 12);
  return wordCache.get(item);
}

export function estimatePages(state, ctx) {
  const trim = state?.options?.trim || "letter";
  const perPage = WORDS_PER_PAGE[trim] || WORDS_PER_PAGE.letter;
  const groups = groupSelection(state, ctx.index);
  const items = groups.reduce((n, g) => n + g.items.length, 0);
  let words = 0;
  for (const g of groups) for (const id of g.items) words += wordsOf(ctx.index.byId.get(id));
  if (!words) return { pages: 0, words: 0 };
  const scale = WORDS_PER_PAGE.letter / perPage;          // smaller trims: more pages of apparatus too
  const front = 2.5 + Math.ceil((items + groups.length) / 34 * scale);   // cover, colophon, contents, blank to a recto
  const body = words / perPage + groups.length * 0.5;     // each part opens a new page
  const back = 1 + Math.ceil(items / 80 * scale);         // Table of Sections
  return { pages: Math.round(front + body + back), words };
}

// ── Typst worker plumbing ────────────────────────────────────────────────
const BASE = new URL("../", import.meta.url).href;          // the builder root
let worker = null;
let seq = 0;
const pending = new Map();
let queue = Promise.resolve();
// Set once a book was too long for the worker: the preview should then stop
// re-typesetting on every change (main-thread compiles block the page).
let bigBook = false;
export const isBigBook = () => bigBook;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./typst-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, stage, ok } = e.data || {};
    const job = pending.get(id);
    if (!job) return;
    if (stage) { job.onStage?.(stage); return; }
    pending.delete(id);
    if (ok) job.resolve(e.data); else job.reject(new Error(e.data.error || "Typesetting failed"));
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || "The typesetter crashed"));
    pending.clear();
    worker = null;
  };
  return worker;
}

function restartWorker() {
  try { worker?.terminate(); } catch { /* already gone */ }
  for (const job of pending.values()) job.reject(new Error("The typesetter was restarted"));
  pending.clear();
  worker = null;
}

function call(msg, onStage) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onStage });
    getWorker().postMessage({ ...msg, id });
  });
}

let templatePromise = null;
const template = () => (templatePromise ??= fetch(new URL("./supplement.typ", import.meta.url))
  .then(r => { if (!r.ok) throw new Error(`template: HTTP ${r.status}`); return r.text(); }));
let verifyPromise = null;
const verifyReport = () => (verifyPromise ??= fetch(new URL("../verify_report.json", import.meta.url))
  .then(r => (r.ok ? r.json() : null)).catch(() => null));

// Start loading the compiler and fonts early (e.g. when the studio opens).
export function warmEngine() {
  return call({ type: "warm", base: BASE }).catch(() => {});
}

export function slugify(s) {
  return String(s || "supplement").toLowerCase().normalize("NFKD")
    .replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 80) || "supplement";
}

// One compile at a time; callers that only want the latest result (the live
// preview) should debounce before calling.
export function generatePdf(state, ctx, { onStage } = {}) {
  const run = async () => {
    onStage?.("Preparing the text…");
    const [tpl, report] = await Promise.all([template(), verifyReport()]);
    const doc = buildDocument(state, ctx, { verifyReport: report, productName: PRODUCT.name });
    const t0 = performance.now();
    const data = JSON.stringify(doc);
    let res;
    try {
      try {
        res = await call({ type: "compile", base: BASE, template: tpl, data }, onStage);
      } catch (err) {
        // A wasm trap ("unreachable", out of memory) leaves the compiler unusable:
        // start a fresh worker and try once more before giving up.
        if (!/unreachable|RuntimeError|memory|crashed/i.test(String(err?.message || err))) throw err;
        restartWorker();
        onStage?.("Restarting the typesetter…");
        res = await call({ type: "compile", base: BASE, template: tpl, data }, onStage);
      }
    } catch (err) {
      // Workers get a smaller stack than the main thread; Typst's PDF export
      // of very long books (~1,000+ pages) can exceed it. Retry here.
      if (!/call stack|too much recursion|RangeError/i.test(String(err?.message || err))) throw err;
      onStage?.("Typesetting a long book on the main thread (this can take a little while)…");
      await new Promise(r => setTimeout(r, 60));          // let the message paint
      const core = await import("./typst-core.js");
      res = await core.compilePdf(BASE, tpl, data);
      bigBook = true;
    }
    return {
      bytes: patchCatalog(res.pdf),
      pages: res.pages || 0,
      provPages: res.provPages || {},
      ms: Math.round(performance.now() - t0),
      filename: `${slugify(doc.meta.title)}.pdf`,
      doc,
    };
  };
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}
