// Top bar and the dialogs/menus hanging off it: the book title, Undo/Redo,
// "Cover & settings", "Copy link" (with its popover), the More menu, the
// keyboard help, and the corpus-currency status line.
import { encodeState } from "../share.js";
import { toast } from "./toast.js";
import { popover } from "./popover.js";
import { isTextEntry } from "./dom.js";
import { currencyLine } from "../labels.js";

export { toast };   // ui/preview.js imports `toast` from here

let refs = null;

const SHARE_URL_WARN_BYTES = 8 * 1024;
const COPIED_FLASH_MS = 1500;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* insecure context / permission denied — try execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// ── title ───────────────────────────────────────────────────────────────────

function init_title() {
  const input = document.querySelector("#supp-title");
  input.value = refs.store.get().metadata.title;
  input.addEventListener("input", () => {
    refs.store.set(s => ({ ...s, metadata: { ...s.metadata, title: input.value } }),
      { coalesce: "title", label: "Edited the title" });
  });
  refs.store.subscribe(s => {
    if (document.activeElement !== input && input.value !== s.metadata.title) input.value = s.metadata.title;
  });
}

// ── undo / redo ─────────────────────────────────────────────────────────────

function doUndo() {
  const label = refs.store.undo();
  if (label === false) return;
  toast(typeof label === "string" && label ? `Undone: ${label}.` : "Undone.",
    { action: { label: "Redo", onClick: () => refs.store.redo() } });
}
function doRedo() {
  const label = refs.store.redo();
  if (label === false) return;
  toast(typeof label === "string" && label ? `Redone: ${label}.` : "Redone.");
}

function init_history() {
  const undo = document.querySelector("#btn-undo");
  const redo = document.querySelector("#btn-redo");
  undo.addEventListener("click", doUndo);
  redo.addEventListener("click", doRedo);
  refs.store.subscribe(() => {
    undo.disabled = !refs.store.canUndo();
    redo.disabled = !refs.store.canRedo();
    undo.title = refs.store.canUndo() ? `Undo ${refs.store.undoLabel() || "the last change"} (⌘Z)` : "Nothing to undo";
    redo.title = refs.store.canRedo() ? `Redo ${refs.store.redoLabel() || "the change"} (⇧⌘Z)` : "Nothing to redo";
  });
  window.addEventListener("keydown", e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    // while typing in a text field, ⌘Z is the field's own undo
    if ((key === "z" || key === "y") && isTextEntry(e.target)) return;
    if (document.querySelector("dialog[open]") && !e.target.closest?.("#metadata-modal")) return;
    if (key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((key === "z" && e.shiftKey) || (key === "y" && !e.metaKey)) { e.preventDefault(); doRedo(); }
  });
}

// ── cover & settings ────────────────────────────────────────────────────────

const TEXT_FIELDS = ["title", "subtitle", "course", "term", "professor", "school"];

function fillSettings(form) {
  const s = refs.store.get();
  for (const name of TEXT_FIELDS) {
    const el = form.elements[name];
    if (el && document.activeElement !== el) el.value = s.metadata[name] || "";
  }
  form.elements.trim.value = s.options.trim;
  document.querySelector("#toggle-codified").checked = s.options.numbering === "codified";
  document.querySelector("#toggle-original").checked = s.options.numbering === "original";
  form.elements.sourceCredits.checked = s.options.sourceCredits;
  form.elements.includeColophon.checked = s.options.colophon;
}

function init_settings() {
  const dlg = document.querySelector("#metadata-modal");
  const form = document.querySelector("#metadata-form");

  document.querySelector("#btn-metadata").addEventListener("click", () => {
    fillSettings(form);
    dlg.showModal();
  });

  // Every change applies at once (and is one Undo step per field), so there
  // is no "did it save?" — the button just says Done.
  const setOption = (key, value, label) =>
    refs.store.set(s => ({ ...s, options: { ...s.options, [key]: value } }), { label });
  form.addEventListener("input", e => {
    const t = e.target;
    if (TEXT_FIELDS.includes(t.name)) {
      refs.store.set(s => ({ ...s, metadata: { ...s.metadata, [t.name]: t.value } }),
        { coalesce: t.name === "title" ? "title" : `cover-${t.name}`, label: "Edited the cover" });
    }
  });
  form.addEventListener("change", e => {
    const t = e.target;
    if (t.name === "trim") setOption("trim", t.value, "Changed the page size");
    else if (t.name === "numbering") setOption("numbering", t.value, "Changed the numbering");
    else if (t.name === "sourceCredits") setOption("sourceCredits", t.checked, "Changed source credits");
    else if (t.name === "includeColophon") setOption("colophon", t.checked, "Changed the colophon");
  });
  form.addEventListener("submit", e => { e.preventDefault(); dlg.close(); });
  for (const btn of dlg.querySelectorAll("[data-close]")) btn.addEventListener("click", () => dlg.close());

  // keep the fields true to the store (Undo, share-link boot) — the radios
  // matter even while the dialog is closed (#toggle-original is read by tests)
  refs.store.subscribe(() => fillSettings(form));
}

// ── share ───────────────────────────────────────────────────────────────────

function buildShareUrl() {
  const state = refs.store.get();
  const hash = encodeState(state, refs.corpus.meta.id, refs.naming);
  return location.origin + location.pathname + location.search + hash;
}

function init_share() {
  const btn = document.querySelector("#btn-share");
  const panel = document.querySelector("#share-pop");
  btn.removeAttribute("hidden");
  btn.setAttribute("aria-live", "polite");   // announce the Copied flash
  btn.title = "Copy a link that opens this book";
  // an empty selection has nothing to share (and its link would clear
  // the recipient's stored selection — boot guards it too)
  refs.store.subscribe(s => { btn.disabled = s.selection.length === 0; });
  const label = btn.textContent;
  let restoreTimer = null;
  // clicking "Copy link" copies first, then shows the link in a popover
  const pop = popover(btn, panel, { onTrigger: async api => {
    const url = buildShareUrl();
    const ok = await copyText(url);
    const link = panel.querySelector("#share-link");
    link.value = url;
    panel.querySelector(".pop-status").innerHTML = ok
      ? '<span class="ok">Link copied.</span> Paste it into an email or a course page.'
      : '<span class="bad">Couldn’t copy automatically.</span> Select the link below and copy it.';
    const long = url.length > SHARE_URL_WARN_BYTES;
    panel.querySelector(".pop-warn").hidden = !long;
    if (long) panel.querySelector(".pop-warn").textContent =
      `This link is ${(url.length / 1024).toFixed(1)} KB long. Some apps cut off links that long.`;
    if (!api.isOpen) api.open();
    if (!ok) link.select();
    if (ok) {
      btn.textContent = "Copied";
      btn.classList.add("copied");
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, COPIED_FLASH_MS);
    }
  } });
  panel.querySelector("#share-copy").addEventListener("click", async () => {
    const ok = await copyText(panel.querySelector("#share-link").value);
    // one status line, the same words as the first copy
    panel.querySelector(".pop-status").innerHTML = ok
      ? '<span class="ok">Link copied.</span> Paste it into an email or a course page.'
      : '<span class="bad">Couldn’t copy automatically.</span> Select the link and copy it.';
  });
  panel.querySelector("#share-link").addEventListener("focus", e => e.target.select());
  panel.querySelector("[data-close]").addEventListener("click", () => { pop.close(); btn.focus(); });
}

// ── more menu, help ─────────────────────────────────────────────────────────

function init_more() {
  const btn = document.querySelector("#btn-more");
  const menu = document.querySelector("#more-menu");
  const pop = popover(btn, menu, { onOpen: () => menu.querySelector("button:not([disabled])")?.focus() });
  menu.addEventListener("click", e => { if (e.target.closest("button")) pop.close(); });
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });

  refs.store.subscribe(s => {
    for (const id of ["#btn-export-json", "#btn-save-preset", "#btn-sort-all"]) {
      document.querySelector(id).disabled = s.selection.length === 0;
    }
  });

  import("./presets.js").then(m => {
    document.querySelector("#btn-save-preset").addEventListener("click", m.saveAsPreset);
    document.querySelector("#btn-export-json").addEventListener("click", m.exportSelection);
    document.querySelector("#btn-import-json").addEventListener("click",
      () => document.querySelector("#file-import").click());
    document.querySelector("#file-import").addEventListener("change", e => {
      if (e.target.files[0]) m.importSelection(e.target.files[0]);
      e.target.value = "";
    });
  });
  import("./actions.js").then(m => {
    document.querySelector("#btn-sort-all").addEventListener("click", m.sortEverything);
  });
}

function init_help() {
  const dlg = document.querySelector("#help-modal");
  document.querySelector("#btn-help").addEventListener("click", () => dlg.showModal());
  for (const btn of dlg.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => dlg.close());
  }
}

// ── status line ─────────────────────────────────────────────────────────────

// The footer reads exactly like the PDF cover's currency line: it asks the PDF
// lane's currencyLine (pdf/document.js) first, and builds the same sentence
// from corpus.source (labels.currencyLine) when that module has none.
async function init_status() {
  const el = document.querySelector("#corpus-status");
  if (!el) return;
  let line = "";
  try {
    const doc = await import("../pdf/document.js");
    if (typeof doc.currencyLine === "function") line = doc.currencyLine(refs.corpus) || "";
  } catch { /* the page still works without the PDF module */ }
  el.textContent = line || currencyLine(refs.corpus);
  el.title = "The text comes from uscode.house.gov and ecfr.gov";
}

export function init(deps) {
  refs = deps;
  init_title();
  init_history();
  init_settings();
  init_share();
  init_more();
  init_help();
  init_status();
}
