// Browse tree: Act -> (division) -> sections; C.F.R. Part -> subject group
// (Regulation D…) -> rules. Every act, division, part and group has
// "Add all" / "Remove all" with a tri-state box and a count, so a whole unit
// is one click. Top-level rows start collapsed; children render on open.
import { buildUnits } from "../units.js";
import { describe } from "../labels.js";
import { unitStatus } from "../model.js";
import { addUnit, removeUnit, setProvision } from "./actions.js";
import { escapeHtml, glyph, nb } from "./dom.js";

const ROOT_SEL = "#tree";

let refs = null;
let units = null;
const open = new Set();          // unit keys currently expanded
const live = new Map();          // key -> { el, unit, ids }  (rendered units)
let filterQ = "";
let hayCache = new Map();

const noun = u => (u.noun === "rules" ? "rules" : "sections");
const markSec = text => escapeHtml(text).replace(/^§/, '<span class="sec">§</span>');

function hay(id) {
  let h = hayCache.get(id);
  if (h === undefined) {
    const d = describe(id, refs.index);
    h = `${d.lead} ${d.altShort} ${d.altFull} ${d.heading}`.toLowerCase();
    hayCache.set(id, h);
  }
  return h;
}

// Ids of a unit that pass the filter (all of them when there is none).
function visibleIds(ids) {
  if (!filterQ) return ids;
  const words = filterQ.split(/\s+/).filter(Boolean);
  return ids.filter(id => words.every(w => hay(id).includes(w)));
}

function itemHtml(id, checked) {
  const d = describe(id, refs.index);
  const title = d.heading ? `${d.fullCite}. ${d.heading}` : d.fullCite;
  // "[Reserved]" and repealed sections stay in the list so the numbering has
  // no holes, but greyed and without a box: they can never enter a book
  if (d.reserved) {
    return `<div class="tree-item is-reserved" title="${escapeHtml(`${d.fullCite}. Nothing to print here.`)}">
      <span class="t-text"><span class="t-cite">${markSec(d.lead)}${d.altShort ? `<span class="t-alt"> · ${escapeHtml(d.altShort)}</span>` : ""}</span>
      <span class="t-heading">${escapeHtml(d.heading)}</span></span>
    </div>`;
  }
  return `<label class="tree-item${checked ? " checked" : ""}" title="${escapeHtml(title)}">
      <input type="checkbox" data-id="${escapeHtml(id)}"${checked ? " checked" : ""}>
      <span class="t-text"><span class="t-cite">${markSec(d.lead)}${d.altShort ? `<span class="t-alt"> · ${escapeHtml(d.altShort)}</span>` : ""}</span>
      <span class="t-heading">${escapeHtml(d.heading)}</span>${d.tag ? `<span class="t-tag">${escapeHtml(d.tag)}</span>` : ""}</span>
    </label>`;
}

function itemsHtml(ids, selSet) {
  return ids.map(id => itemHtml(id, selSet.has(id))).join("");
}

function unitHtml(u, depth, selSet) {
  // a unit shows while anything in it passes the filter; the count and
  // "Add all" speak only of what can be added (u.ids), the list shows it all
  if (!visibleIds(u.allIds).length) return "";
  const isOpen = open.has(u.key) || !!filterQ;
  const label = u.type === "part"
    ? `<b class="u-num">${escapeHtml(u.short)}</b> <span class="u-title">${nb(u.label)}</span>`
    : `<span class="u-title">${nb(u.type === "group" ? u.short : u.label)}</span>${u.range && u.type === "group" ? ` <span class="u-range">${escapeHtml(u.range)}</span>` : ""}`;
  const tip = u.type === "group" && u.desc ? ` title="${escapeHtml(`${u.short}: ${u.desc}`)}"` : "";
  return `<div class="unit depth-${depth}${isOpen ? " open" : ""}" data-key="${escapeHtml(u.key)}">
    <div class="unit-head">
      <input type="checkbox" class="unit-box" aria-label="Select all in ${escapeHtml(u.short || u.label)}">
      <button type="button" class="unit-toggle" aria-expanded="${isOpen}"${tip}>
        <span class="caret">${glyph.caret}</span><span class="u-label">${label}</span>
      </button>
      <span class="unit-sub"><span class="unit-count"></span><button type="button" class="unit-action"></button></span>
    </div>
    <div class="unit-body"${isOpen ? "" : " hidden"}>${isOpen ? bodyHtml(u, depth, selSet) : ""}</div>
  </div>`;
}

function bodyHtml(u, depth, selSet) {
  if (!u.children.length) return itemsHtml(visibleIds(u.allIds), selSet);
  const kids = u.children.map(c => unitHtml(c, depth + 1, selSet)).join("");
  const rest = u.rest ? unitHtml(u.rest, depth + 1, selSet) : "";
  return kids + rest;
}

function render() {
  const { corpus, store } = refs;
  const selSet = new Set(store.get().selection);
  const root = document.querySelector(ROOT_SEL);
  const meta = corpus.meta || {};
  const acts = units.acts.map(u => unitHtml(u, 0, selSet)).join("");
  const parts = units.parts.map(u => unitHtml(u, 0, selSet)).join("");
  root.innerHTML = `
    ${acts ? `<h3 class="tree-label">Statutes <span class="tree-label-sub">${escapeHtml(meta.uscCitePrefix || "")}</span></h3>${acts}` : ""}
    ${parts ? `<h3 class="tree-label">Regulations <span class="tree-label-sub">${escapeHtml(meta.cfrCitePrefix || "")}</span></h3>${parts}` : ""}
    ${!acts && !parts ? `<p class="tree-none">Nothing matches “${escapeHtml(filterQ)}”. Try ⌘K to search by citation.</p>` : ""}`;
  indexLive();
  sync();
}

function indexLive() {
  live.clear();
  for (const el of document.querySelectorAll(`${ROOT_SEL} .unit`)) {
    const unit = units.byKey.get(el.dataset.key);
    if (unit) live.set(el.dataset.key, { el, unit });
  }
}

// Refresh checked marks, tri-state boxes, counts and button words.
function sync() {
  const selSet = new Set(refs.store.get().selection);
  for (const cb of document.querySelectorAll(`${ROOT_SEL} .tree-item input[data-id]`)) {
    const on = selSet.has(cb.dataset.id);
    if (cb.checked !== on) cb.checked = on;
    cb.parentElement.classList.toggle("checked", on);
  }
  for (const { el, unit } of live.values()) {
    const ids = visibleIds(unit.ids);
    const st = unitStatus(ids, selSet);
    const head = el.querySelector(":scope > .unit-head");
    const box = head.querySelector(".unit-box");
    box.checked = st.state === "all";
    box.indeterminate = st.state === "some";
    el.dataset.state = st.state;
    head.querySelector(".unit-count").textContent =
      !st.total ? "nothing to add"
      : st.state === "none" ? `${st.total} ${st.total === 1 ? noun(unit).replace(/s$/, "") : noun(unit)}`
      : st.state === "some" ? `${st.selected} of ${st.total}`
      : `all ${st.total}`;
    const btn = head.querySelector(".unit-action");
    btn.hidden = !st.total;
    box.disabled = !st.total;
    btn.textContent = st.state === "all" ? "Remove all" : st.state === "some" ? "Add rest" : (filterQ ? `Add ${st.total} shown` : "Add all");
    btn.classList.toggle("is-remove", st.state === "all");
    btn.title = st.state === "all"
      ? `Remove all ${st.total} from your book`
      : `Add ${st.state === "some" ? `the other ${st.total - st.selected}` : `all ${st.total}`} to your book`;
  }
}

function toggleOpen(el) {
  const key = el.dataset.key;
  const unit = units.byKey.get(key);
  const nowOpen = !el.classList.contains("open");
  el.classList.toggle("open", nowOpen);
  el.querySelector(":scope > .unit-head .unit-toggle").setAttribute("aria-expanded", String(nowOpen));
  const body = el.querySelector(":scope > .unit-body");
  body.hidden = !nowOpen;
  if (nowOpen) {
    open.add(key);
    if (!body.firstChild) {
      const depth = Number(/depth-(\d+)/.exec(el.className)[1]);
      body.innerHTML = bodyHtml(unit, depth, new Set(refs.store.get().selection));
      indexLive();
      sync();
    }
  } else {
    open.delete(key);
  }
}

function toggleUnit(el) {
  const entry = live.get(el.dataset.key);
  if (!entry) return;
  const ids = visibleIds(entry.unit.ids);
  const st = unitStatus(ids, new Set(refs.store.get().selection));
  if (st.state === "all") removeUnit(entry.unit, ids);
  else addUnit(entry.unit, ids);
}

function onClick(e) {
  const toggle = e.target.closest(".unit-toggle");
  if (toggle) { toggleOpen(toggle.closest(".unit")); return; }
  const action = e.target.closest(".unit-action");
  if (action) { toggleUnit(action.closest(".unit")); return; }
}

function onChange(e) {
  const box = e.target.closest(".unit-box");
  if (box) { toggleUnit(box.closest(".unit")); return; }
  const cb = e.target.closest('input[type="checkbox"][data-id]');
  if (cb) setProvision(cb.dataset.id, cb.checked);
}

export function init(deps) {
  refs = deps;
  units = buildUnits(deps.index);
  const root = document.querySelector(ROOT_SEL);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  render();
  refs.store.subscribe(sync);

  const filter = document.querySelector("#tree-filter");
  let timer = null;
  filter.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filterQ = filter.value.trim().toLowerCase();
      render();
    }, 120);
  });
}
