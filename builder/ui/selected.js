// The book's outline: the selection grouped by part (one part per act or
// C.F.R. part, via model.groupSelection). Each part has an inline-editable
// title, an item count, a page estimate, "Sort into Code order", and moves or
// goes as a whole; items reorder by drag (or the arrow buttons) within their
// part. Rule subject groups (Regulation D…) show as light subheads.
import { groupSelection, subjectGroupFor, splitPartTitle, partKicker, partNumberStyle, groupRepeatsTitle } from "../model.js";
import { describe, scHtml } from "../labels.js";
import { partRange } from "../units.js";
import { estimatePages } from "../pdf/engine.js";
import {
  removePart, renamePart, sortPart, movePart, moveProvision, nudgeProvision,
  removeFromBook, clearAll,
} from "./actions.js";
import { escapeHtml, glyph, plural, fmt } from "./dom.js";

let refs = null;
let lastSig = null;
const collapsed = new Set();   // part keys whose items are folded away (kept in memory)
const markSec = text => escapeHtml(text).replace(/^§/, '<span class="sec">§</span>');

// What this part adds to the book: the book's estimate less the book without
// it. A book of one part has no such difference (its estimate is the cover,
// contents and tables too), so a lone part shows no figure of its own: the
// toolbar already says how long the book is.
function partPages(state, key, groups) {
  const ctx = { corpus: refs.corpus, index: refs.index };
  const total = estimatePages(state, ctx).pages;
  const rest = state.selection.filter(id => {
    const g = groups.find(x => x.items.includes(id) || x.missing.includes(id));
    return !g || g.key !== key;
  });
  return Math.max(1, total - estimatePages({ ...state, selection: rest }, ctx).pages);
}

function itemHtml(id) {
  const d = describe(id, refs.index);
  const missing = d.kind === "missing";
  return `<li class="item${missing ? " is-missing" : ""}" data-id="${escapeHtml(id)}" draggable="true">
      <div class="item-main">
        <div class="item-cite">${missing ? `Not in this corpus · ${escapeHtml(id)}` : `${markSec(d.lead)}${d.altFull ? `<span class="alt"> · ${escapeHtml(d.altFull)}</span>` : ""}`}</div>
        ${missing ? "" : `<div class="item-heading">${escapeHtml(d.heading)}</div>`}
      </div>
      <div class="item-actions">
        <button type="button" data-act="item-up" aria-label="Move up">${glyph.up}</button>
        <button type="button" data-act="item-down" aria-label="Move down">${glyph.down}</button>
        <button type="button" data-act="item-rm" aria-label="Remove from the book">${glyph.close}</button>
      </div>
    </li>`;
}

function itemsHtml(g) {
  const out = [];
  let lastGroup;   // undefined = nothing yet; null = ungrouped; object = subject group
  const hasGroups = g.items.some(id => subjectGroupFor(id, refs.index));
  for (const id of [...g.items, ...g.missing]) {
    if (hasGroups) {
      const sg = refs.index.byId.has(id) ? subjectGroupFor(id, refs.index) : null;
      const key = sg ? sg.id : null;
      if (key !== lastGroup && !(lastGroup === undefined && key === null) && !groupRepeatsTitle(sg, g.title)) {
        const up = sg?.parent ? refs.index.subjectGroupById.get(sg.parent) : null;
        out.push(`<li class="subhead">${scHtml(sg ? (up ? `${up.short}\u2014` : "") + (sg.short || sg.label) : "Other rules")}</li>`);
      }
      lastGroup = key;
    }
    out.push(itemHtml(id));
  }
  return out.join("");
}

// The kicker above a part's title, as the PDF will print it: "Part One",
// counted over the parts that hold something; a title the professor typed as
// "Part I. Securities Act" supplies its own ("Part I") and shows the rest.
function partHtml(g, i, groups, state, number) {
  const n = g.items.length + g.missing.length;
  const noun = g.kind === "regulation" ? "rule" : "section";
  const pages = g.items.length && groups.length > 1 ? partPages(state, g.key, groups) : 0;
  // the range of what this part holds (partRange), not of the whole act
  // each piece stays whole, so a long range wraps between pieces, never inside
  // one; the "·" travels with the piece after it, so no line ends on a "·"
  const meta = [partRange(g, refs.index, state.options.numbering), plural(n, noun), pages ? `≈ ${fmt(pages)} ${pages === 1 ? "p." : "pp."}` : ""]
    .filter(Boolean).map((piece, k) => `<span class="nw">${k ? "·\u00a0" : ""}${escapeHtml(piece)}</span>`).join(" ");
  const folded = collapsed.has(g.key);
  const split = splitPartTitle(g.title);
  const kicker = number ? partKicker(number, partNumberStyle(groups)) : "";
  const shown = split.kicker ? split.title : g.title;
  return `<section class="part${folded ? " collapsed" : ""}" data-key="${escapeHtml(g.key)}">
    <header class="part-head">
      <button type="button" class="part-grip" draggable="true" aria-label="Drag to move this part" title="Drag to move this part">${glyph.grip}</button>
      <div class="part-kick">
        <span class="part-kicker">${scHtml(kicker)}</span>
        ${g.custom ? '<button type="button" class="link" data-act="reset">Reset title</button>' : ""}
      </div>
      <textarea class="part-title" rows="1" aria-label="Title of this part (click to rename)"
             title="Click to rename this part" spellcheck="false" data-default="${escapeHtml(g.defaultTitle)}"
             data-raw="${escapeHtml(g.title)}" data-shown="${escapeHtml(shown)}">${escapeHtml(shown)}</textarea>
      <button type="button" class="part-meta" data-act="fold" aria-expanded="${!folded}"
              title="Show or hide the items in this part"><span class="fold-caret">${glyph.caret}</span><span>${meta}</span></button>
      <div class="part-actions">
        <span class="part-actions-l">
          ${g.kind === "other" || n < 2 ? "" : '<button type="button" class="link" data-act="sort">Sort into Code order</button>'}
        </span>
        <span class="part-actions-r">
          <button type="button" class="link" data-act="part-up" aria-label="Move this part up"${i === 0 ? " disabled" : ""}>${glyph.up}</button>
          <button type="button" class="link" data-act="part-down" aria-label="Move this part down"${i === groups.length - 1 ? " disabled" : ""}>${glyph.down}</button>
          <button type="button" class="link link-danger" data-act="remove">Remove part</button>
        </span>
      </div>
    </header>
    <ol class="items">${itemsHtml(g)}</ol>
  </section>`;
}

function render() {
  const state = refs.store.get();
  const sig = `${state.selection.join("|")}#${JSON.stringify(state.metadata.groupTitles)}#${state.options.trim}#${state.options.numbering}`;
  document.querySelector("#selected-count").textContent = state.selection.length;
  document.querySelector(".counter-noun").textContent = state.selection.length === 1 ? "provision" : "provisions";
  document.querySelector("#btn-clear").disabled = state.selection.length === 0;
  if (sig === lastSig) return;
  lastSig = sig;

  const root = document.querySelector("#selected");
  const scroll = root.scrollTop;
  if (!state.selection.length) {
    root.innerHTML = `<div class="empty-state">
      <p>Your book is empty.</p>
      <p>Choose provisions in the list, search with ⌘K, or start from a template.</p>
    </div>`;
    return;
  }
  const groups = groupSelection(state, refs.index);
  let number = 0;   // the PDF numbers only the parts that hold something
  root.innerHTML = groups.map((g, i) => partHtml(g, i, groups, state, g.items.length ? ++number : 0)).join("");
  fitTitles();
  root.scrollTop = scroll;
}

// A part title is a one-row textarea that grows to show the whole title.
function fitTitle(el) {
  if (!el.offsetParent) return;   // hidden (another mobile tab): refit when shown
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}
function fitTitles() {
  document.querySelectorAll("#selected .part-title").forEach(fitTitle);
}

// ── events ──────────────────────────────────────────────────────────────────

function partKeys() {
  return [...document.querySelectorAll("#selected .part")].map(el => el.dataset.key);
}

function onClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const part = btn.closest(".part");
  const key = part?.dataset.key;
  const item = btn.closest(".item");
  switch (btn.dataset.act) {
    case "item-rm": removeFromBook(item.dataset.id); break;
    case "item-up": nudgeProvision(item.dataset.id, -1); break;
    case "item-down": nudgeProvision(item.dataset.id, 1); break;
    case "fold": {
      const folded = part.classList.toggle("collapsed");
      btn.setAttribute("aria-expanded", String(!folded));
      if (folded) collapsed.add(key); else collapsed.delete(key);
      return;
    }
    case "sort": sortPart(key); break;
    case "remove": removePart(key); break;
    case "reset": renamePart(key, ""); break;
    case "part-up": { const k = partKeys(); movePart(key, Math.max(0, k.indexOf(key) - 1)); break; }
    case "part-down": { const k = partKeys(); movePart(key, k.indexOf(key) + 1); break; }
    default: return;
  }
  // keep keyboard focus on the same control after the list re-renders
  const act = btn.dataset.act;
  if (act.endsWith("-up") || act.endsWith("-down")) {
    const sel = item ? `.item[data-id="${CSS.escape(item.dataset.id)}"]` : `.part[data-key="${CSS.escape(key)}"] .part-head`;
    queueMicrotask(() => document.querySelector(`#selected ${sel} [data-act="${act}"]:not([disabled])`)?.focus());
  }
}

function onTitleChange(e) {
  const input = e.target.closest(".part-title");
  if (!input) return;
  renamePart(input.closest(".part").dataset.key, input.value);
  lastSig = null;
  render();
}
function onTitleInput(e) {
  const input = e.target.closest(".part-title");
  if (input) fitTitle(input);
}
// At rest the box shows the title as the book sets it (a typed "Part I." is
// the kicker above, not part of the title); while you edit it shows exactly
// what you typed, so nothing is lost.
function onTitleFocus(e) {
  const input = e.target.closest?.(".part-title");
  if (!input || input.value === input.dataset.raw) return;
  input.value = input.dataset.raw;
  fitTitle(input);
}
function onTitleBlur(e) {
  const input = e.target.closest?.(".part-title");
  if (!input || input.value !== input.dataset.raw || input.value === input.dataset.shown) return;
  input.value = input.dataset.shown;
  fitTitle(input);
}
function onTitleKey(e) {
  const input = e.target.closest(".part-title");
  if (!input) return;
  if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  if (e.key === "Escape") {
    const part = refs.store.get();
    const g = groupSelection(part, refs.index).find(x => x.key === input.closest(".part").dataset.key);
    input.value = g ? g.title : input.value;
    input.blur();
  }
}

// drag to reorder: items within their part, parts by their grip
let drag = null;
function clearMarks() {
  document.querySelectorAll("#selected .drop-before, #selected .drop-after, #selected .dragging")
    .forEach(el => el.classList.remove("drop-before", "drop-after", "dragging"));
}
const isAfter = (e, el) => {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

function onDragStart(e) {
  const grip = e.target.closest(".part-grip");
  if (grip) {
    const part = grip.closest(".part");
    drag = { type: "part", key: part.dataset.key };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", drag.key);
    e.dataTransfer.setDragImage(part.querySelector(".part-head"), 12, 12);
    part.classList.add("dragging");
    return;
  }
  const item = e.target.closest(".item");
  if (!item) return;
  drag = { type: "item", id: item.dataset.id, key: item.closest(".part").dataset.key };
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", drag.id);
  item.classList.add("dragging");
}
function onDragOver(e) {
  if (!drag) return;
  if (drag.type === "item") {
    const over = e.target.closest(".item");
    if (!over || over.dataset.id === drag.id || over.closest(".part").dataset.key !== drag.key) return;
    e.preventDefault();
    clearMarks(); document.querySelector(`#selected .item[data-id="${CSS.escape(drag.id)}"]`)?.classList.add("dragging");
    over.classList.add(isAfter(e, over) ? "drop-after" : "drop-before");
  } else {
    const over = e.target.closest(".part");
    if (!over || over.dataset.key === drag.key) return;
    e.preventDefault();
    clearMarks(); document.querySelector(`#selected .part[data-key="${CSS.escape(drag.key)}"]`)?.classList.add("dragging");
    over.classList.add(isAfter(e, over) ? "drop-after" : "drop-before");
  }
}
function onDrop(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === "item") {
    const over = e.target.closest(".item");
    if (!over || over.dataset.id === d.id) { clearMarks(); return; }
    e.preventDefault();
    const after = isAfter(e, over);
    clearMarks();
    moveProvision(d.id, over.dataset.id, after);
  } else {
    const over = e.target.closest(".part");
    if (!over || over.dataset.key === d.key) { clearMarks(); return; }
    e.preventDefault();
    const after = isAfter(e, over);
    clearMarks();
    const order = partKeys().filter(k => k !== d.key);
    movePart(d.key, order.indexOf(over.dataset.key) + (after ? 1 : 0));
  }
}
function onDragEnd() { drag = null; clearMarks(); }

// Scroll the outline to what was just added (actions.js announces it).
function reveal(e) {
  const { key, id } = e.detail || {};
  const part = key && document.querySelector(`#selected .part[data-key="${CSS.escape(key)}"]`);
  if (part?.classList.contains("collapsed")) { part.classList.remove("collapsed"); collapsed.delete(key); }
  const target = (id && document.querySelector(`#selected .item[data-id="${CSS.escape(id)}"]`)) || part;
  target?.scrollIntoView({ block: "nearest" });
}

export function init(deps) {
  refs = deps;
  window.addEventListener("ss:reveal", reveal);
  const root = document.querySelector("#selected");
  root.addEventListener("click", onClick);
  root.addEventListener("change", onTitleChange);
  root.addEventListener("input", onTitleInput);
  root.addEventListener("focusin", onTitleFocus);
  root.addEventListener("focusout", onTitleBlur);
  root.addEventListener("keydown", onTitleKey);
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("dragend", onDragEnd);
  document.querySelector("#btn-clear").addEventListener("click", clearAll);
  window.addEventListener("ss:panelchange", fitTitles);   // mobile tab switch
  window.addEventListener("resize", fitTitles);
  // The first part ever added is drawn while its column is still hidden (the
  // empty-book screen has not yet made way for it), so it has no width to fit
  // against: refit whenever the outline gains or changes size, and once the
  // web fonts are in.
  if (typeof ResizeObserver === "function") new ResizeObserver(fitTitles).observe(root);
  document.fonts?.ready.then(fitTitles);
  refs.store.subscribe(render);
}
