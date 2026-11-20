// Templates (the e2e contract still calls them presets: #btn-presets,
// .preset-card, .preset-card .name). A template is a starting book: a list of
// provision ids, optional default part titles. Ids the corpus lacks are
// skipped, so one template works across corpus versions.
//
// Built-ins live in builder/presets/*.json; "Save as template" keeps the
// user's own in localStorage (state.userPresets).
import { toast } from "./toast.js";
import { applyTemplate, templateIds } from "./actions.js";
import { coalesce } from "../model.js";
import { normalizeState } from "../store.js";
import { estimatePages } from "../pdf/engine.js";
import { escapeHtml, fmt, plural } from "./dom.js";

let refs = null;
let builtIn = [];
let loadFailures = [];   // urls of built-in template files that failed to fetch
const listeners = new Set();

const BUILT_IN_FILES = [
  "./presets/secreg-standard.json",
  "./presets/corp-finance.json",
  "./presets/securities-litigation.json",
  "./presets/investment-management.json",
];

async function loadBuiltIn() {
  const failures = [];
  const results = await Promise.all(BUILT_IN_FILES.map(async url => {
    try {
      const r = await fetch(url);
      if (!r.ok) { failures.push(url); return null; }
      const data = await r.json();
      data._source = "built-in";
      return data;
    } catch { failures.push(url); return null; }
  }));
  loadFailures = failures;
  return results.filter(Boolean);
}

export function getTemplates() {
  const user = refs?.store.get().userPresets || [];
  return [...builtIn, ...user.map(p => ({ ...p, _source: "user" }))];
}
export function onTemplates(fn) { listeners.add(fn); }

const statCache = new Map();
// { count, pages } for a template, against the current corpus and trim size.
export function templateStats(tpl) {
  const trim = refs.store.get().options?.trim || "letter";
  const key = `${tpl.id}|${trim}|${(tpl.selection || []).length}`;
  if (!statCache.has(key)) {
    const ids = coalesce(templateIds(tpl), refs.index);
    const { pages } = estimatePages(
      { selection: ids, metadata: { groupTitles: {} }, options: { trim } },
      { corpus: refs.corpus, index: refs.index });
    statCache.set(key, { count: ids.length, pages });
  }
  return statCache.get(key);
}

export function templateMeta(tpl) {
  const { count, pages } = templateStats(tpl);
  return `${plural(count, "provision")}${pages ? ` · ≈ ${fmt(pages)} pages` : ""}`;
}

/* Promise-based replacement for window.confirm. Uses #confirm-modal;
   resolves "ok" | "alt" | "cancel". */
export function confirmDialog({ title, message, okLabel = "OK", altLabel = null, cancelLabel = "Cancel" }) {
  const dlg = document.querySelector("#confirm-modal");
  dlg.querySelector("#confirm-title").textContent = title;
  dlg.querySelector("#confirm-message").textContent = message;
  const ok = dlg.querySelector("#confirm-ok");
  const alt = dlg.querySelector("#confirm-alt");
  const cancel = dlg.querySelector("#confirm-cancel");
  ok.textContent = okLabel;
  cancel.textContent = cancelLabel;
  alt.hidden = !altLabel;
  if (altLabel) alt.textContent = altLabel;

  return new Promise(resolve => {
    let result = "cancel";
    const onOk = () => { result = "ok"; dlg.close(); };
    const onAlt = () => { result = "alt"; dlg.close(); };
    const onCancel = () => { dlg.close(); };
    const closeBtns = [...dlg.querySelectorAll("[data-close]")];
    const onClose = () => {
      ok.removeEventListener("click", onOk);
      alt.removeEventListener("click", onAlt);
      cancel.removeEventListener("click", onCancel);
      for (const b of closeBtns) b.removeEventListener("click", onCancel);
      dlg.removeEventListener("close", onClose);
      resolve(result);
    };
    ok.addEventListener("click", onOk);
    alt.addEventListener("click", onAlt);
    cancel.addEventListener("click", onCancel);
    for (const b of closeBtns) b.addEventListener("click", onCancel);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

function render() {
  const root = document.querySelector("#presets-list");
  root.innerHTML = "";
  if (loadFailures.length) {
    const err = document.createElement("div");
    err.className = "preset-error";
    err.setAttribute("role", "alert");
    const names = loadFailures.map(u => u.split("/").pop()).join(", ");
    err.innerHTML = `
      <div class="title">Couldn’t load ${loadFailures.length} built-in template${loadFailures.length > 1 ? "s" : ""}</div>
      <div class="detail">${escapeHtml(names)} failed to fetch. Check your connection and reload the page.</div>`;
    root.appendChild(err);
  }
  const all = getTemplates();
  if (!all.length) {
    if (!loadFailures.length) root.innerHTML = `<div class="empty-state">No templates yet.</div>`;
    return;
  }
  const hasBook = refs.store.get().selection.length > 0;
  for (const p of all) {
    const el = document.createElement("div");
    el.className = "preset-card";
    el.dataset.id = p.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.innerHTML = `
      <div class="name">${escapeHtml(p.name)}${p._source === "user" ? ' <span class="by">(yours)</span>' : ""}</div>
      <div class="desc">${escapeHtml(p.description || "")}</div>
      <div class="count">${escapeHtml(templateMeta(p))}</div>
      <div class="card-actions">
        <span class="card-use">${hasBook ? "Replace my book" : "Use this template"}</span>
        ${hasBook ? '<button type="button" class="link" data-act="merge">Add to my book instead</button>' : ""}
        ${p._source === "user" ? '<button type="button" class="link link-danger" data-act="delete">Delete</button>' : ""}
      </div>`;
    el.addEventListener("click", async e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "delete") {
        const choice = await confirmDialog({
          title: "Delete template", message: `Delete “${p.name}” from your saved templates? This can’t be undone.`,
          okLabel: "Delete",
        });
        if (choice === "ok") refs.store.set(s => ({ ...s, userPresets: s.userPresets.filter(u => u.id !== p.id) }));
        return;
      }
      applyTemplate(p, act === "merge" ? "merge" : "replace");
      document.querySelector("#presets-modal").close();
    });
    el.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); el.click(); }
    });
    root.appendChild(el);
  }
}

function initSaveModal() {
  const dlg = document.querySelector("#preset-save-modal");
  const form = document.querySelector("#preset-save-form");
  for (const btn of dlg.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => dlg.close());
  }
  form.addEventListener("submit", e => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    const description = form.elements.description.value.trim();
    const id = "user-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)
               + "-" + Date.now().toString(36);
    const s = refs.store.get();
    const preset = {
      id, name, description, selection: [...s.selection],
      groupTitles: { ...(s.metadata.groupTitles || {}) },
    };
    refs.store.set(st => ({ ...st, userPresets: [...(st.userPresets || []), preset] }));
    dlg.close();
    toast(`Saved “${name}” to your templates.`);
  });
}

export async function init(deps) {
  refs = deps;
  initSaveModal();
  const dlg = document.querySelector("#presets-modal");
  document.querySelector("#btn-presets").addEventListener("click", () => {
    render(); dlg.showModal();
  });
  for (const btn of dlg.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => dlg.close());
  }
  refs.store.subscribe(() => { if (dlg.open) render(); for (const fn of listeners) fn(); });
  builtIn = await loadBuiltIn();
  for (const fn of listeners) fn();
}

// ── More menu: save / export / import ───────────────────────────────────────

export function saveAsPreset() {
  const state = refs.store.get();
  if (!state.selection.length) {
    toast("Nothing in the book to save as a template."); return;
  }
  const form = document.querySelector("#preset-save-form");
  form.reset();
  document.querySelector("#preset-save-modal").showModal();
}

export function exportSelection() {
  const state = refs.store.get();
  const payload = {
    title: state.metadata.title,
    metadata: state.metadata,
    mode: state.mode,
    options: state.options,
    selection: state.selection,
    savedAt: new Date().toISOString(),
  };
  download(payload, `selection-${slugify(state.metadata.title)}-${ymd()}.json`);
}

// Import replaces the book (title, parts, options) — Undo brings it back.
export async function importSelection(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("Import failed. That file isn’t valid JSON."); return; }
  if (!data || !Array.isArray(data.selection)) { toast("Import failed. No 'selection' list in that file."); return; }
  const had = refs.store.get().selection.length;
  const ids = data.selection.filter(id => typeof id === "string");
  // run the file through the store's own validation (older exports have no options)
  const clean = normalizeState({ selection: ids, metadata: data.metadata, mode: data.mode, options: data.options });
  const fields = Object.fromEntries(Object.entries(data.metadata || {}).filter(([, v]) => typeof v === "string"));
  refs.store.set(s => ({
    ...s,
    selection: coalesce(clean.selection, refs.index),
    metadata: { ...s.metadata, ...fields, groupTitles: clean.metadata.groupTitles, includeColophon: clean.options.colophon },
    mode: clean.mode,
    options: clean.options,
  }), { label: "Imported a saved selection" });
  const msg = `Imported ${plural(ids.length, "provision")}.`;
  toast(had ? `${msg} Your previous book is one Undo away.` : msg,
    had ? { action: { label: "Undo", onClick: () => refs.store.undo() } } : {});
}

export function download(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}
export function slugify(s) { return (s || "selection").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
export function ymd() { const d = new Date(); return d.toISOString().slice(0, 10); }
