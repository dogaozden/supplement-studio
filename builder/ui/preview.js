// Live preview + "Download PDF" (the PDF lane's module).
//
// The preview IS the PDF: every change (debounced) is typeset by the Typst
// engine (builder/pdf/engine.js) and the resulting PDF is drawn page by page
// with pdf.js, so what the professor sees is exactly what they download.
//
// DOM contract (index.html): #preview-pane (this module owns its contents),
// #btn-generate (Download PDF), #btn-export-reader (student reader),
// optional #page-estimate (owned by the studio UI).
// Test hooks: window.__pdfReady, window.__pdfPages, window.__pdfError,
// window.__pdfBytes (latest PDF), window.__pdfDoc (its document JSON),
// window.__pdfProvPages (provision id -> page), and .pdf-page elements.
import { estimatePages, generatePdf, isBigBook, warmEngine } from "../pdf/engine.js";
import { assembleManifest, buildReaderHtml, fetchTemplates, slugify } from "../reader/reader-export.js";

const PDFJS = new URL("../assets/vendor/pdfjs-6.5.438-legacy/pdf.min.mjs", import.meta.url).href;
const PDFJS_WORKER = new URL("../assets/vendor/pdfjs-6.5.438-legacy/pdf.worker.min.mjs", import.meta.url).href;
const DEBOUNCE_MS = 650;
const KEEP_RENDERED = 10;
// Above this (estimated) length the preview stops re-typesetting on every
// change and waits for "Typeset preview" (long books can need the main thread).
const AUTO_PAGES = 1100;   // the worker typesets ~800 pages in ~8 s; beyond ~1,000 it may need the main thread

let refs = null;
let pdfjs = null;
let timer = null;
let version = 0;          // bumps on every state change
let built = null;         // { version, bytes, pages, filename, ms, provPages }
let buildingFor = 0;
let doc = null;           // pdf.js document of `built`
let observer = null;
const rendered = new Map();   // page number -> canvas
let els = null;

window.__pdfReady = false;
window.__pdfPages = 0;
window.__pdfError = null;
window.__pdfPaused = false;
let labels = null;   // printed folios ("i", "1", …) from the PDF's page labels

function ensureStyles() {
  if (document.querySelector("link[data-preview-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("../pdf/preview.css", import.meta.url).href;
  l.dataset.previewCss = "";
  document.head.appendChild(l);
}

function mount() {
  const pane = document.querySelector("#preview-pane") || document.querySelector("#paged-target");
  pane.innerHTML = `
    <div class="pv" data-state="idle">
      <div class="pv-bar">
        <span class="pv-status" role="status" aria-live="polite"></span>
        <button type="button" class="pv-run" hidden>Typeset preview</button>
        <span class="pv-where"></span>
      </div>
      <div class="pv-scroll" tabindex="0" aria-label="PDF preview">
        <div class="pv-pages"></div>
        <div class="pv-empty"><p>Pick a template or add provisions, and the book appears here, typeset.</p></div>
      </div>
    </div>`;
  els = {
    root: pane.querySelector(".pv"),
    status: pane.querySelector(".pv-status"),
    where: pane.querySelector(".pv-where"),
    scroll: pane.querySelector(".pv-scroll"),
    pages: pane.querySelector(".pv-pages"),
  };
  els.scroll.addEventListener("scroll", updateWhere, { passive: true });
  els.run = pane.querySelector(".pv-run");
  els.run.addEventListener("click", () => { els.run.hidden = true; build(version); });
}

function setState(s, message = "") {
  els.root.dataset.state = s;
  els.status.textContent = message;
  if (s === "busy" || s === "stale") els.where.textContent = "";   // never show the old book's count
}

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  return pdfjs;
}

function schedule() {
  version += 1;
  window.__pdfReady = false;
  clearTimeout(timer);
  const sel = refs.store.get().selection;
  if (!sel.length) {
    built = null;
    showEmpty();
    return;
  }
  const est = estimatePages(refs.store.get(), { corpus: refs.corpus, index: refs.index }).pages;
  if (est > AUTO_PAGES || (isBigBook() && est > 600)) {
    setState(els.root.dataset.state === "ready" ? "stale" : "paused",
      `A long book (about ${est.toLocaleString("en-US")} pages). The preview waits for “Typeset preview”; Download PDF always works.`);
    els.run.hidden = false;
    window.__pdfPaused = true;
    return;
  }
  window.__pdfPaused = false;
  els.run.hidden = true;
  setState(els.root.dataset.state === "ready" ? "stale" : "busy", "Changes pending…");
  timer = setTimeout(() => build(version), DEBOUNCE_MS);
}

function showEmpty() {
  els.pages.innerHTML = "";
  rendered.clear();
  doc?.destroy?.();
  doc = null;
  els.where.textContent = "";
  setState("empty", "");
}

async function build(v) {
  if (buildingFor === v) return built?.version === v ? built : null;
  buildingFor = v;
  const state = refs.store.get();
  try {
    const res = await generatePdf(state, { corpus: refs.corpus, index: refs.index }, {
      onStage: (s) => { if (v === version) setState("busy", s); },
    });
    if (v !== version) return null;           // superseded while typesetting
    built = { version: v, ...res };
    window.__pdfBytes = res.bytes;
    window.__pdfDoc = res.doc;
    window.__pdfProvPages = res.provPages;
    window.__pdfError = null;
    await show(res);
    window.__pdfPages = res.pages;
    window.__pdfReady = true;
    window.dispatchEvent(new CustomEvent("ss:pdf", { detail: { pages: res.pages, ms: res.ms } }));
    return built;
  } catch (err) {
    if (v !== version) return null;
    console.error("typesetting failed", err);
    window.__pdfError = String(err?.message || err);
    setState("error", `Couldn’t typeset this selection. ${window.__pdfError.split("\n")[0]}`);
    return null;
  } finally {
    if (buildingFor === v) buildingFor = 0;
  }
}

async function show(res) {
  const lib = await loadPdfjs();
  const keepPage = currentPage();
  const next = await lib.getDocument({ data: res.bytes.slice(), isEvalSupported: false }).promise;
  doc?.destroy?.();
  doc = next;
  rendered.clear();
  observer?.disconnect();
  els.pages.innerHTML = "";
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const ratio = vp.height / vp.width;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= doc.numPages; i++) {
    const d = document.createElement("div");
    d.className = "pdf-page";
    d.dataset.page = String(i);
    d.style.aspectRatio = `${vp.width} / ${vp.height}`;
    d.setAttribute("aria-label", `Page ${i}`);
    frag.appendChild(d);
  }
  els.pages.appendChild(frag);
  els.pages.style.setProperty("--page-ratio", ratio);
  observer = new IntersectionObserver(onVisible, { root: els.scroll, rootMargin: "600px 0px" });
  els.pages.querySelectorAll(".pdf-page").forEach(p => observer.observe(p));
  try { labels = await doc.getPageLabels(); } catch { labels = null; }
  if (keepPage > 1) scrollToPage(keepPage, false);
  setState("ready", "Up to date");
  updateWhere();
}

function onVisible(entries) {
  for (const e of entries) {
    const n = +e.target.dataset.page;
    if (e.isIntersecting) renderPage(e.target, n);
  }
}

async function renderPage(holder, n) {
  if (!doc || rendered.has(n)) return;
  rendered.set(n, null);
  const page = await doc.getPage(n);
  const width = holder.clientWidth || 600;
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (width / vp1.width) * dpr;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  try {
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
  } catch { rendered.delete(n); return; }
  if (!holder.isConnected) return;
  holder.replaceChildren(canvas);
  holder.classList.add("is-rendered");
  rendered.set(n, canvas);
  if (rendered.size > KEEP_RENDERED * 2) evictFar(n);
}

function evictFar(center) {
  for (const n of [...rendered.keys()]) {
    if (Math.abs(n - center) > KEEP_RENDERED) {
      const holder = els.pages.querySelector(`.pdf-page[data-page="${n}"]`);
      holder?.replaceChildren();
      holder?.classList.remove("is-rendered");
      rendered.delete(n);
    }
  }
}

function currentPage() {
  const pages = els?.pages.querySelectorAll(".pdf-page");
  if (!pages?.length) return 1;
  const top = els.scroll.getBoundingClientRect().top;
  for (const p of pages) {
    const r = p.getBoundingClientRect();
    if (r.bottom > top + 40) return +p.dataset.page;
  }
  return 1;
}

function updateWhere() {
  if (!doc || ["busy", "stale"].includes(els.root.dataset.state)) { els.where.textContent = ""; return; }
  const n = currentPage();
  const label = labels?.[n - 1];
  els.where.textContent = label ? `p. ${label}  (${n} of ${doc.numPages})` : `${n} of ${doc.numPages}`;
}

function scrollToPage(n, smooth = true) {
  const el = els.pages.querySelector(`.pdf-page[data-page="${n}"]`);
  if (el) els.scroll.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
}

// Other modules can ask the preview to show a provision: dispatch
// new CustomEvent("ss:goto", { detail: { id } }).
function onGoto(e) {
  const page = built?.provPages?.[e.detail?.id];
  if (page) scrollToPage(page);
}

async function surfaceMessage(message) {
  try {
    const topbar = await import("./topbar.js");
    if (typeof topbar.toast === "function") { topbar.toast(message); return; }
  } catch { /* fall through */ }
  setState(els.root.dataset.state, message);
}

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function onDownload() {
  const btn = document.querySelector("#btn-generate");
  if (!refs.store.get().selection.length) {
    surfaceMessage("Add at least one provision before downloading the PDF.");
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Typesetting…";
  try {
    clearTimeout(timer);
    let res = built?.version === version ? built : await build(version);
    if (!res) res = built?.version === version ? built : null;
    if (!res) throw new Error(window.__pdfError || "typesetting did not finish");
    download(res.bytes, res.filename);
    // the browser saves silently; say what was saved and how big it is
    surfaceMessage(`Downloaded ${res.filename} (${res.pages ? `${res.pages} pages, ` : ""}${(res.bytes.length / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    surfaceMessage(`The PDF couldn’t be made: ${err?.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ── student reader export (secondary) ────────────────────────────────────
function downloadHtml(html, filename) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportReader() {
  const state = refs.store.get();
  if (!state.selection.length) {
    surfaceMessage("Add at least one provision before exporting the reader.");
    return;
  }
  const btn = document.querySelector("#btn-export-reader");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Exporting…";
  try {
    const templates = await fetchTemplates();
    const manifest = assembleManifest(state, refs.corpus, refs.index);
    const { html, missing } = buildReaderHtml(manifest, refs.corpus, templates);
    downloadHtml(html, `${slugify(manifest.title) || "supplement"}.html`);
    if (missing.length) {
      surfaceMessage(`Reader exported, but ${missing.length} selected item${missing.length > 1 ? "s were" : " was"} not found: ${missing.join(", ")}`);
    }
  } catch (e) {
    console.error("reader export failed", e);
    surfaceMessage(`Reader export failed: ${e?.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export function init(deps) {
  refs = deps;
  ensureStyles();
  mount();
  refs.store.subscribe(schedule);
  window.addEventListener("ss:goto", onGoto);
  document.querySelector("#btn-generate")?.addEventListener("click", onDownload);
  const exportBtn = document.querySelector("#btn-export-reader");
  if (exportBtn) {
    exportBtn.removeAttribute("hidden");
    exportBtn.title = "Download the same selection as a single offline HTML file students can highlight and annotate.";
    exportBtn.addEventListener("click", exportReader);
  }
  warmEngine();
  schedule();
}
