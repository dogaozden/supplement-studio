// Selection model shared by the studio UI and the PDF/document builder.
// Pure ESM, no DOM — runs in the browser and in Node (tests, CLI samples).
//
// The stored selection stays a flat, ordered array of provision ids (the
// share-hash and reader-export contracts depend on that). Parts ("groups")
// are DERIVED: one group per source (a statute/act, or a C.F.R. part), in
// order of first appearance, items keeping their relative order. Custom part
// titles live in state.metadata.groupTitles keyed by the group key, so
// renaming survives reordering.

import { regulationDisplayTitle } from "./labels.js";

// Source key of one provision: "act:<actId>" | "reg:<regulationId>" | "other".
export function sourceKeyFor(id, index) {
  const act = index.actBySectionId.get(id);
  if (act) return `act:${act.id}`;
  const reg = index.regBySectionId.get(id);
  if (reg) return `reg:${reg.id}`;
  return "other";
}

// Reorder ids so each source is contiguous, in first-appearance order.
// Stable: items keep their relative order inside a source. Idempotent.
export function coalesce(selection, index) {
  const order = [];
  const buckets = new Map();
  for (const id of selection) {
    const key = sourceKeyFor(id, index);
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(id);
  }
  return order.flatMap(key => buckets.get(key));
}

// Subject group (e.g. "Regulation D") a rule belongs to, or null.
// Corpus field (builder/build): regulation.groups = [{id, label, short, rules}]
// and rule.group = groupId. Tolerates corpora without it.
export function subjectGroupFor(id, index) {
  const gid = index.ruleGroupById?.get(id);
  return gid ? index.subjectGroupById.get(gid) || null : null;
}

// When every rule picked from a C.F.R. part belongs to ONE named regulation
// (only Regulation M from Part 242), that regulation's short name is the
// part's title: "Regulation M", not "Regulations M, SHO, ATS, AC, NMS…".
// "" when the picks are mixed, ungrouped, or in a group that is not a named
// regulation ("Subpart B—…", "General").
function selectedRegulationName(items, index) {
  if (!items?.length) return "";
  let only = null;
  for (const id of items) {
    const g = subjectGroupFor(id, index);
    if (!g || (only && g.id !== only.id)) return "";
    only = g;
  }
  const short = String(only.short || "").trim();
  return /^Regulations?\s+\S/i.test(short) ? short : "";
}

// Default (uncustomized) title for a group key. `items` (the ids picked from
// that part) lets a C.F.R. part take the name of the one regulation picked.
export function defaultGroupTitle(key, index, items) {
  if (key.startsWith("act:")) {
    const act = index.actById.get(key.slice(4));
    return act ? act.short_title : "Statutes";
  }
  if (key.startsWith("reg:")) {
    const reg = index.regById?.get(key.slice(4));
    if (!reg) return "Regulations";
    // display_title when the corpus has it, else derived from the PART heading
    return selectedRegulationName(items, index) || regulationDisplayTitle(reg);
  }
  return "Other provisions";
}

// "Part Three": the kicker the PDF prints above each part title, n counted
// from 1 over the parts that hold something.
const ORDINALS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen", "Twenty"];
const toRoman = n => {
  let out = "";
  for (const [v, r] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"],
    [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]) while (n >= v) { out += r; n -= v; }
  return out;
};
// Part numbers are always positional; the style is the book's ("Part One",
// "Part I", "Part 1", "Part A"), set by the first title a professor typed
// with a "Part …" prefix, so renaming or moving parts never yields
// "Part One / Part I / Part Three".
export const partKicker = (n, style = "words") => (
  style === "roman" ? `Part ${toRoman(n)}`
    : style === "arabic" ? `Part ${n}`
    : style === "letter" ? `Part ${String.fromCharCode(64 + Math.min(n, 26))}`
    : `Part ${ORDINALS[n] || n}`);

// A professor who titles a part "Part I. Securities Act of 1933" has already
// numbered it. The leading "Part I." (a roman numeral, a number, a single
// letter or a number word, then . : – — or -) becomes the kicker and the rest
// the title, so the book never reads "Part One / Part I. Securities Act".
//   splitPartTitle("Part I. Securities Act") -> { kicker: "Part I", title: "Securities Act" }
//   splitPartTitle("Securities Act")         -> { kicker: null, title: "Securities Act" }
const PART_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
const PART_PREFIX = new RegExp(`^part\\s+([ivxlcdm]+|[a-z]|\\d+[a-z]?|${PART_WORDS})\\s*[.:\\u2013\\u2014-]+\\s*(\\S[\\s\\S]*)$`, "i");
export function partNumberStyle(groups) {
  for (const g of groups || []) {
    const m = PART_PREFIX.exec(String(g.title ?? "").trim());
    if (!m) continue;
    const tok = m[1];
    if (/^[ivxlcdm]+$/i.test(tok) && tok.length > 0 && !/^[cdm]$/i.test(tok)) return "roman";
    if (/^\d/.test(tok)) return "arabic";
    if (/^[a-z]$/i.test(tok)) return "letter";
    return "words";
  }
  return "words";
}

export function splitPartTitle(title) {
  const t = String(title ?? "").trim();
  const m = PART_PREFIX.exec(t);
  if (!m) return { kicker: null, title: t };
  const tok = m[1];
  const numeral = /^[ivxlcdm]+$/i.test(tok) || /^[a-z]$/i.test(tok) || /^\d/.test(tok);
  return { kicker: `Part ${numeral ? tok.toUpperCase() : tok[0].toUpperCase() + tok.slice(1).toLowerCase()}`, title: m[2].trim() };
}

// True when a rule subject group only repeats the part's own title (a part
// titled "Regulation D" holding Regulation D): its subhead would say the same
// thing twice, so the outline and the PDF leave it out.
export function groupRepeatsTitle(sg, title) {
  const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = norm(splitPartTitle(title).title);
  return !!sg && !!t && (norm(sg.short) === t || norm(sg.label) === t);
}

// The derived parts list the UI shows and the PDF prints.
// [{ key, kind: "act"|"regulation"|"other", title, defaultTitle, custom,
//    items: [id], missing: [id] }]
export function groupSelection(state, index) {
  const titles = state?.metadata?.groupTitles || {};
  const groups = [];
  const byKey = new Map();
  for (const id of state.selection || []) {
    const key = sourceKeyFor(id, index);
    let g = byKey.get(key);
    if (!g) {
      const custom = typeof titles[key] === "string" && titles[key].trim() !== "";
      g = {
        key,
        kind: key.startsWith("act:") ? "act" : key.startsWith("reg:") ? "regulation" : "other",
        title: custom ? titles[key].trim() : "",
        defaultTitle: "",
        custom,
        items: [],
        missing: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    if (index.byId.has(id)) g.items.push(id); else g.missing.push(id);
  }
  // default titles depend on what was picked, so they are set once the parts are full
  for (const g of groups) {
    g.defaultTitle = defaultGroupTitle(g.key, index, g.items);
    if (!g.custom) g.title = g.defaultTitle;
  }
  return groups.filter(g => g.items.length || g.missing.length);
}

// Code order: statutes by act order then section order; rules by part
// order then rule order — i.e. the corpus order. Used by "Sort into Code
// order" (per group or whole selection).
export function codeOrderRank(index) {
  if (index.__rank) return index.__rank;
  const rank = new Map();
  let n = 0;
  for (const act of index.corpus?.acts || []) for (const s of act.sections) rank.set(s.id, n++);
  for (const reg of index.corpus?.regulations || []) for (const r of reg.rules) rank.set(r.id, n++);
  index.__rank = rank;
  return rank;
}

export function sortIntoCodeOrder(ids, index) {
  const rank = codeOrderRank(index);
  return [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
}

// Move a whole group (by key) to position `to` among groups.
export function moveGroup(selection, key, to, index) {
  const groups = [];
  const byKey = new Map();
  for (const id of coalesce(selection, index)) {
    const k = sourceKeyFor(id, index);
    if (!byKey.has(k)) { byKey.set(k, []); groups.push(k); }
    byKey.get(k).push(id);
  }
  const from = groups.indexOf(key);
  if (from < 0) return selection;
  groups.splice(from, 1);
  groups.splice(Math.max(0, Math.min(to, groups.length)), 0, key);
  return groups.flatMap(k => byKey.get(k));
}

// ─── Studio editing operations (pure; used by the UI and node-tested) ───────
// Every function returns a NEW selection array (or the same array when
// nothing changes) and keeps the selection coalesced: one contiguous run per
// source, so a part never appears twice in the book.

function inCodeOrder(ids, rank) {
  let last = -1;
  for (const id of ids) {
    const r = rank.get(id) ?? 1e9;
    if (r < last) return false;
    last = r;
  }
  return true;
}

// Code order of whole parts: statutes by act order, then regulations by part
// order. A part's rank is its first provision's place in the corpus.
function partRank(index) {
  if (index.__partRank) return index.__partRank;
  const rank = new Map();
  let n = 0;
  for (const act of index.corpus?.acts || []) rank.set(`act:${act.id}`, n++);
  for (const reg of index.corpus?.regulations || []) rank.set(`reg:${reg.id}`, n++);
  index.__partRank = rank;
  return rank;
}

// Add ids. New ids of a source that was already in Code order are merged
// back into Code order (adding the rest of a part you started stays tidy);
// a source the user has reordered keeps its order and new ids go to its end.
// A source not yet in the book is added as a whole, in Code order. Likewise
// a new PART joins the book in Code order (statutes before rules) while the
// existing parts are in Code order, and is appended once the user has
// reordered them.
export function addIds(selection, ids, index) {
  const have = new Set(selection);
  const fresh = [];
  for (const id of ids) if (!have.has(id)) { have.add(id); fresh.push(id); }
  if (!fresh.length) return selection;

  const rank = codeOrderRank(index);
  const touched = new Set(fresh.map(id => sourceKeyFor(id, index)));
  const sorted = new Map();
  for (const key of touched) {
    const existing = selection.filter(id => sourceKeyFor(id, index) === key);
    sorted.set(key, inCodeOrder(existing, rank));
  }
  const before = [];
  for (const id of selection) {
    const key = sourceKeyFor(id, index);
    if (!before.includes(key)) before.push(key);
  }
  const merged = coalesce([...selection, ...fresh], index);
  let order = [];
  const buckets = new Map();
  for (const id of merged) {
    const key = sourceKeyFor(id, index);
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(id);
  }
  const pr = partRank(index);
  const rankOf = k => pr.get(k) ?? 1e9;
  const partsInOrder = before.every((k, i) => i === 0 || rankOf(before[i - 1]) <= rankOf(k));
  if (partsInOrder && order.length > before.length) order = [...order].sort((a, b) => rankOf(a) - rankOf(b));
  return order.flatMap(key => {
    const items = buckets.get(key);
    return touched.has(key) && sorted.get(key) ? sortIntoCodeOrder(items, index) : items;
  });
}

export function removeIds(selection, ids) {
  const drop = new Set(ids);
  const next = selection.filter(id => !drop.has(id));
  return next.length === selection.length ? selection : next;
}

export function removeGroup(selection, key, index) {
  return selection.filter(id => sourceKeyFor(id, index) !== key);
}

// Put one group's items into Code order, leaving every other group alone.
export function sortGroup(selection, key, index) {
  const items = selection.filter(id => sourceKeyFor(id, index) === key);
  const sorted = sortIntoCodeOrder(items, index);
  if (sorted.every((id, i) => id === items[i])) return selection;
  let n = 0;
  return selection.map(id => (sourceKeyFor(id, index) === key ? sorted[n++] : id));
}

// Move `id` next to `targetId` (before it, or after it when `after`), only
// within the same group. Returns the selection unchanged for cross-group drops.
export function moveItem(selection, id, targetId, after, index) {
  if (id === targetId) return selection;
  if (sourceKeyFor(id, index) !== sourceKeyFor(targetId, index)) return selection;
  const from = selection.indexOf(id);
  if (from < 0 || selection.indexOf(targetId) < 0) return selection;
  const list = selection.slice();
  list.splice(from, 1);
  const to = list.indexOf(targetId);
  list.splice(after ? to + 1 : to, 0, id);
  return list;
}

// Nudge one item up (-1) or down (+1) inside its own group.
export function nudgeItem(selection, id, delta, index) {
  const key = sourceKeyFor(id, index);
  const items = selection.filter(x => sourceKeyFor(x, index) === key);
  const at = items.indexOf(id);
  const target = items[at + delta];
  if (at < 0 || target === undefined) return selection;
  return moveItem(selection, id, target, delta > 0, index);
}

// Rename a part. An empty title, or one equal to the default, clears the
// override (the part shows its default title again).
export function withGroupTitle(titles, key, title, defaultTitle) {
  const next = { ...(titles || {}) };
  const t = String(title ?? "").trim();
  if (!t || t === defaultTitle) delete next[key]; else next[key] = t;
  return next;
}

// How much of a unit (act, part, subject group…) is in the book.
export function unitStatus(ids, selSet) {
  let n = 0;
  for (const id of ids) if (selSet.has(id)) n++;
  return { total: ids.length, selected: n, state: n === 0 ? "none" : n === ids.length ? "all" : "some" };
}
