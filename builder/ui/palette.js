// ⌘K search palette. Citation-aware (search.js): "Rule 10b-5", "§ 77e",
// "Securities Act § 5", "Reg D" all land on the right provision first.
// ↑↓ move · Enter adds · Shift+Enter adds and closes · Esc closes.
import { createSearch } from "../search.js";
import { describe } from "../labels.js";
import { renderResults, setActive } from "./results.js";
import { addProvisions } from "./actions.js";
import { plural } from "./dom.js";

let refs = null;
let searcher = null;
let results = [];
let active = 0;

// Shared with the first-run search box.
export function runQuery(q) {
  return searcher ? searcher.search(q, { limit: 40 }) : [];
}

// What to say when a form-item query ("Item 1.01") has no row ("" otherwise).
// Shared with the first-run search box.
export function runNotice(q) {
  return searcher ? searcher.notice(q) : "";
}

// The "nothing matches" line: the default help, or the notice that explains
// why there is no row. `el` keeps its default text in data-default.
export function fillNone(el, q) {
  if (el.dataset.default === undefined) el.dataset.default = el.textContent;
  el.textContent = runNotice(q) || el.dataset.default;
}

// Add what a result stands for (one provision, or a whole unit).
// Returns a short phrase for the status line, or "" when nothing was new.
export function addResult(r) {
  const { index } = refs;
  if (r.type === "unit") {
    const n = addProvisions(r.ids, `Added ${r.short || r.label}`);
    return n ? `Added ${r.short || r.label} (${plural(n, "provision")})` : "";
  }
  const d = describe(r.id, index);
  return addProvisions([r.id], `Added ${d.lead}`) ? `Added ${d.lead}` : "";
}

const els = () => ({
  dlg: document.querySelector("#palette"),
  input: document.querySelector("#palette-input"),
  list: document.querySelector("#palette-results"),
  hint: document.querySelector("#palette-hint"),
  status: document.querySelector("#palette-status"),
});

function draw(keepActive = false) {
  const { input, list, hint } = els();
  const q = input.value;
  if (!keepActive) active = 0;
  results = q.trim() ? runQuery(q) : [];
  active = Math.min(active, Math.max(0, results.length - 1));
  const selSet = new Set(refs.store.get().selection);
  renderResults(list, results, { index: refs.index, selSet, active, prefix: "palette" });
  hint.hidden = !!q.trim() && results.length > 0;
  const none = hint.querySelector(".palette-none");
  none.hidden = !q.trim() || results.length > 0;
  if (!none.hidden) fillNone(none, q);
  hint.querySelector(".palette-try").hidden = !!q.trim();
  if (results.length) input.setAttribute("aria-activedescendant", `palette-opt-${active}`);
  else input.removeAttribute("aria-activedescendant");
}

function say(text) {
  const { status } = els();
  const n = refs.store.get().selection.length;
  status.textContent = text ? `${text} · ${plural(n, "provision")} in your book` : "";
}

function activate(i, { close = false } = {}) {
  const r = results[i];
  if (!r) return;
  const said = addResult(r);
  say(said || "Already in your book");
  draw(true);
  if (close) els().dlg.close();
}

export function open(prefill = "") {
  const { dlg, input } = els();
  if (!dlg.open) dlg.showModal();
  input.value = prefill;
  els().status.textContent = "";
  draw();
  input.focus();
  input.select();
}

export function init(deps) {
  refs = deps;
  searcher = createSearch(deps.index, { Fuse: globalThis.Fuse });
  const { dlg, input, list } = els();

  document.querySelector("#btn-search").addEventListener("click", () => open());
  // the shortcut hint matches the keyboard
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    document.querySelector("#btn-search .kbd").textContent = "Ctrl K";
  }
  document.querySelector("#palette-close").addEventListener("click", () => dlg.close());
  document.querySelector("#palette-done").addEventListener("click", () => dlg.close());

  window.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dlg.open) dlg.close(); else open();
    }
  });

  input.addEventListener("input", () => { els().status.textContent = ""; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = setActive(list, results, active + 1, input); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = setActive(list, results, active - 1, input); }
    else if (e.key === "Enter") { e.preventDefault(); activate(active, { close: e.shiftKey }); }
    else if (e.key === "Escape") { e.preventDefault(); dlg.close(); }
  });
  list.addEventListener("click", e => {
    const li = e.target.closest("li.result");
    if (li) { active = Number(li.dataset.i); activate(active); input.focus(); }
  });
  // clicking the backdrop closes
  dlg.addEventListener("mousedown", e => { if (e.target === dlg) dlg.close(); });
  // keep the "in your book" marks fresh if the book changes while open (undo)
  refs.store.subscribe(() => { if (dlg.open) draw(true); });
}
