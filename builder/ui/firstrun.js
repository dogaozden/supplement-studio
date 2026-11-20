// First run: while the book is empty, a single screen in place of the
// preview explains the three steps, offers templates to start from, and has a
// citation search box. No modal. The static copy lives in index.html; this
// module fills in the templates, runs the search, and swaps the screen in and
// out as the selection fills and empties.
import { getTemplates, onTemplates, templateMeta } from "./presets.js";
import { runQuery, addResult, fillNone } from "./palette.js";
import { renderResults, setActive } from "./results.js";
import { applyTemplate } from "./actions.js";
import { escapeHtml } from "./dom.js";
import { toast } from "./toast.js";

let refs = null;
let results = [];
let active = 0;

function drawTemplates() {
  const list = document.querySelector("#fr-templates");
  const all = getTemplates();
  list.innerHTML = all.map(t => `
    <li><button type="button" class="fr-template" data-id="${escapeHtml(t.id)}">
      <span class="t-name">${escapeHtml(t.name)}${t._source === "user" ? ' <span class="by">(yours)</span>' : ""}</span>
      <span class="t-desc">${escapeHtml(t.description || "")}</span>
      <span class="t-meta">${escapeHtml(templateMeta(t))}</span>
    </button></li>`).join("");
}

function drawResults() {
  const input = document.querySelector("#fr-search");
  const list = document.querySelector("#fr-results");
  const q = input.value;
  results = q.trim() ? runQuery(q).slice(0, 8) : [];
  active = 0;
  renderResults(list, results, {
    index: refs.index, selSet: new Set(refs.store.get().selection), active, prefix: "fr",
  });
  const none = document.querySelector("#fr-none");
  none.hidden = !q.trim() || results.length > 0;
  if (!none.hidden) fillNone(none, q);
  if (results.length) input.setAttribute("aria-activedescendant", "fr-opt-0");
  else input.removeAttribute("aria-activedescendant");
  reveal();
}

// The search box sits low on the screen: scroll the pane so the results show
// (they would otherwise open below the fold), keeping the box itself in view.
function reveal() {
  const pane = document.querySelector("#first-run");
  const box = document.querySelector(".fr-search");
  if (!pane || pane.hidden || !box) return;
  const p = pane.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const over = b.bottom + 16 - p.bottom;
  if (over > 0) pane.scrollTop += Math.min(over, Math.max(0, b.top - p.top - 16));
}

function swap() {
  const empty = refs.store.get().selection.length === 0;
  document.body.dataset.empty = String(empty);
  document.querySelector("#first-run").hidden = !empty;
  const pane = document.querySelector("#preview-pane");
  if (pane) pane.hidden = empty;
}

// the screen swaps to the book at once, so say what was added
const announce = said => { if (said) toast(`${said}.`); };

export function init(deps) {
  refs = deps;
  const input = document.querySelector("#fr-search");
  const list = document.querySelector("#fr-results");

  document.querySelector("#fr-templates").addEventListener("click", e => {
    const btn = e.target.closest(".fr-template");
    const tpl = btn && getTemplates().find(t => t.id === btn.dataset.id);
    if (tpl) applyTemplate(tpl);
  });
  document.querySelector("#fr-import").addEventListener("click", () => document.querySelector("#file-import").click());

  input.addEventListener("input", drawResults);
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = setActive(list, results, active + 1, input); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = setActive(list, results, active - 1, input); }
    else if (e.key === "Enter" && results[active]) { e.preventDefault(); announce(addResult(results[active])); }
  });
  list.addEventListener("click", e => {
    const li = e.target.closest("li.result");
    if (li && results[Number(li.dataset.i)]) announce(addResult(results[Number(li.dataset.i)]));
  });

  onTemplates(drawTemplates);
  drawTemplates();
  refs.store.subscribe(() => {
    swap();
    if (!refs.store.get().selection.length && input.value) drawResults();   // marks refresh after Undo
  });
}
