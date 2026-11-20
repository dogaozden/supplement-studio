// Every way the UI changes the book goes through here, so each one is a
// single undoable step with a label, keeps the selection coalesced (a part
// never appears twice), and — for the destructive ones — offers Undo in a
// toast instead of asking "are you sure?".
import {
  addIds, removeIds, removeGroup, sortGroup, moveItem, nudgeItem, moveGroup,
  withGroupTitle, coalesce, sortIntoCodeOrder, groupSelection, sourceKeyFor, splitPartTitle,
} from "../model.js";
import { describe, isReserved } from "../labels.js";
import { toast } from "./toast.js";
import { plural } from "./dom.js";

let refs = null;   // { corpus, index, store }

export function init(deps) { refs = deps; }

const store = () => refs.store;
const index = () => refs.index;

export function undoToast(message) {
  toast(message, { action: { label: "Undo", onClick: () => refs.store.undo() } });
}

// ── adding and removing ─────────────────────────────────────────────────────

// "[Reserved]" and repealed sections are never added (they stay visible,
// greyed, in the browse tree).
const addable = id => !isReserved(index().byId.get(id));

// Returns how many ids were new.
export function addProvisions(ids, label) {
  const before = store().get().selection;
  const have = new Set(before);
  const fresh = ids.filter(id => !have.has(id) && addable(id));
  if (!fresh.length) return 0;
  store().set(s => ({ ...s, selection: addIds(s.selection, fresh, index()) }), { label: label || "Added provisions" });
  // let the outline scroll to it (a single provision, or the part it joined)
  window.dispatchEvent(new CustomEvent("ss:reveal", {
    detail: { key: sourceKeyFor(fresh[0], index()), id: fresh.length === 1 ? fresh[0] : null },
  }));
  return fresh.length;
}

export function removeProvisions(ids, label) {
  store().set(s => ({ ...s, selection: removeIds(s.selection, ids) }), { label: label || "Removed provisions" });
}

// The × on an item in the book's outline. Never silent: a toast says what went
// (and that its part went with it, when it was the part's last item) and Undo
// brings everything back, including a title the professor typed for that part.
export function removeFromBook(id) {
  const d = describe(id, index());
  const key = sourceKeyFor(id, index());
  const part = groupSelection(store().get(), index()).find(g => g.key === key);
  const last = part && part.items.length + part.missing.length === 1;
  removeProvisions([id], `Removed ${d.lead}`);
  undoToast(`Removed ${d.lead}${last ? " and its part" : ""}`);
}

// The checkbox on a single provision.
export function setProvision(id, on) {
  const d = describe(id, index());
  if (on) addProvisions([id], `Added ${d.lead}`);
  else removeProvisions([id], `Removed ${d.lead}`);
}

// "Add all" / "Remove all" on a unit (act, division, part, subject group).
// `ids` may be a filtered subset (the tree filter).
export function addUnit(unit, ids = unit.ids) {
  const n = addProvisions(ids, `Added ${unit.short || unit.label}`);
  return n;
}

export function removeUnit(unit, ids = unit.ids) {
  removeProvisions(ids, `Removed ${unit.short || unit.label}`);
  undoToast(`Removed ${unit.short || unit.label} (${plural(ids.length, "provision")}).`);
}

// ── parts ───────────────────────────────────────────────────────────────────

function partInfo(key) {
  return groupSelection(store().get(), index()).find(g => g.key === key);
}

// A title the professor typed as "Part I. Securities Act" is shown, and named
// in toasts, as "Securities Act": the number is positional.
const shownTitle = part => splitPartTitle(part.title).title || part.title;

export function removePart(key) {
  const part = partInfo(key);
  if (!part) return;
  const n = part.items.length + part.missing.length;
  store().set(s => ({
    ...s,
    selection: removeGroup(s.selection, key, index()),
    metadata: { ...s.metadata, groupTitles: withGroupTitle(s.metadata.groupTitles, key, "", "") },
  }), { label: `Removed ${part.title}` });
  // Undo restores the part's own title too: the history keeps the metadata
  undoToast(`Removed “${shownTitle(part)}” (${plural(n, "provision")}).`);
}

export function renamePart(key, title) {
  const part = partInfo(key);
  if (!part) return;
  store().set(s => ({
    ...s,
    metadata: { ...s.metadata, groupTitles: withGroupTitle(s.metadata.groupTitles, key, title, part.defaultTitle) },
  }), { label: "Renamed a part" });
}

export function sortPart(key) {
  store().set(s => ({ ...s, selection: sortGroup(s.selection, key, index()) }), { label: "Sorted a part into Code order" });
}

export function sortEverything() {
  store().set(s => ({
    ...s, selection: coalesce(sortIntoCodeOrder(s.selection, index()), index()),
  }), { label: "Sorted the book into Code order" });
}

export function movePart(key, toIndex) {
  const part = partInfo(key);
  if (!part) return;
  const order = () => groupSelection(store().get(), index()).map(g => g.key);
  const from = order().indexOf(key);
  const way = toIndex < from ? "up" : "down";   // the Undo toast says the same words as this one
  store().set(s => ({ ...s, selection: moveGroup(s.selection, key, toIndex, index()) }), { label: `Moved ${shownTitle(part)} ${way}` });
  const to = order().indexOf(key);
  if (to !== from) undoToast(`Moved ${shownTitle(part)} ${to < from ? "up" : "down"}`);
}

// ── items ───────────────────────────────────────────────────────────────────

export function moveProvision(id, targetId, after) {
  store().set(s => ({ ...s, selection: moveItem(s.selection, id, targetId, after, index()) }), { label: "Reordered" });
}

export function nudgeProvision(id, delta) {
  store().set(s => ({ ...s, selection: nudgeItem(s.selection, id, delta, index()) }), { label: "Reordered" });
}

export function clearAll() {
  const n = store().get().selection.length;
  if (!n) return;
  store().set(s => ({
    ...s, selection: [],
    metadata: { ...s.metadata, groupTitles: {} },
  }), { label: "Cleared the book" });
  undoToast(`Cleared ${plural(n, "provision")} from the book.`);
}

// ── templates ───────────────────────────────────────────────────────────────

// Ids a template contributes: only those the corpus has.
export function templateIds(tpl) {
  return (tpl.selection || []).filter(id => index().byId.has(id) && addable(id));
}

// mode: "replace" (default) | "merge". Replacing a non-empty book offers Undo.
export function applyTemplate(tpl, mode = "replace") {
  const ids = templateIds(tpl);
  const had = store().get().selection.length;
  store().set(s => {
    const titles = { ...(tpl.groupTitles || {}) };
    if (mode === "merge") {
      return {
        ...s,
        selection: addIds(s.selection, ids, index()),
        metadata: { ...s.metadata, groupTitles: { ...titles, ...s.metadata.groupTitles } },
        lastPreset: tpl.id,
      };
    }
    return {
      ...s,
      selection: coalesce(ids, index()),
      metadata: { ...s.metadata, groupTitles: titles },
      lastPreset: tpl.id,
    };
  }, { label: `Applied “${tpl.name}”` });
  if (mode === "merge") {
    toast(`Added “${tpl.name}” to your book.`, { action: { label: "Undo", onClick: () => refs.store.undo() } });
  } else if (had) {
    undoToast(`Replaced your ${plural(had, "provision")} with “${tpl.name}”.`);
  }
}
