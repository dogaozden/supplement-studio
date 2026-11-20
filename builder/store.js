// Reactive store backed by localStorage, with an undo/redo history.
//
// State shape (selection stays a FLAT ORDERED ID ARRAY — the share-hash and
// reader-export contracts depend on it):
//   selection   [id]
//   metadata    { title, subtitle, course, term, professor, school,
//                 includeColophon, groupTitles: { [partKey]: "Custom title" } }
//   mode        "codified" | "original"     (mirror of options.numbering)
//   options     { trim: "letter"|"7x10"|"6x9", numbering, sourceCredits, colophon }
//   lastPreset, userPresets
//
// Invariants kept by reconcile(): mode === options.numbering and
// metadata.includeColophon === options.colophon, so older code that only
// knows `mode` / `includeColophon` (print page, reader export) keeps working.
//
// Undo/redo covers selection, metadata, mode and options. History lives in
// memory (cap HISTORY_CAP); it is not persisted. States are treated as
// immutable — always build new arrays/objects, never mutate in place.
const KEY = "stat-supp-builder-v1";
export const HISTORY_CAP = 100;
const COALESCE_MS = 1500;

export const TRIMS = ["letter", "7x10", "6x9"];
export const NUMBERINGS = ["codified", "original"];

export const defaultOptions = () => ({
  trim: "letter",
  numbering: "original",
  sourceCredits: true,
  colophon: true,
});

export const defaultState = () => ({
  selection: [],          // array of IDs in user-chosen order
  metadata: {
    title: "",            // backfilled from corpus meta.defaultTitle at boot (app.js)
    subtitle: "",
    course: "", term: "", professor: "", school: "",
    includeColophon: true,
    groupTitles: {},      // part key ("act:<id>" | "reg:<id>") -> custom title
  },
  mode: "original",       // Act numbering ("§ 5"); or "codified" (U.S. Code first)
  options: defaultOptions(),
  lastPreset: null,
  userPresets: [],        // [{id, name, description, selection}]
});

const isObject = v => typeof v === "object" && v !== null && !Array.isArray(v);

// Coerce any parsed blob into a valid state. `hadOptions` distinguishes a
// pre-options state (migrate from mode / includeColophon) from a current one.
export function normalizeState(raw) {
  const base = defaultState();
  const src = isObject(raw) ? raw : {};
  const state = { ...base, ...src };

  // a hand-corrupted blob with non-array fields would throw deep inside the
  // UI (new Set(selection)) and brick boot behind a misleading network-error
  // screen — validate the iterables here instead
  state.selection = Array.isArray(src.selection)
    ? [...new Set(src.selection.filter(id => typeof id === "string" && id !== ""))]
    : [];
  state.userPresets = Array.isArray(src.userPresets) ? src.userPresets : [];

  const md = isObject(src.metadata) ? src.metadata : {};
  const groupTitles = {};
  if (isObject(md.groupTitles)) {
    for (const [k, v] of Object.entries(md.groupTitles)) {
      if (typeof v === "string" && v.trim() !== "") groupTitles[k] = v;
    }
  }
  state.metadata = { ...base.metadata, ...md, groupTitles };

  // options (+ migration of pre-options states)
  const opt = isObject(src.options) ? src.options : null;
  const numbering = opt && NUMBERINGS.includes(opt.numbering)
    ? opt.numbering
    : NUMBERINGS.includes(src.mode) ? src.mode : "original";
  const colophon = opt && typeof opt.colophon === "boolean"
    ? opt.colophon
    : state.metadata.includeColophon !== false;
  state.options = {
    trim: opt && TRIMS.includes(opt.trim) ? opt.trim : "letter",
    numbering,
    sourceCredits: opt && typeof opt.sourceCredits === "boolean" ? opt.sourceCredits : true,
    colophon,
  };
  state.mode = numbering;
  state.metadata.includeColophon = colophon;
  return state;
}

// After a change, make the legacy mirrors (mode, includeColophon) and their
// options counterparts agree: whichever side moved wins.
export function reconcile(next, prev) {
  const options = { ...defaultOptions(), ...(next.options || {}) };
  const metadata = { ...next.metadata };
  if (next.mode !== prev.mode && options.numbering === prev.options.numbering) {
    options.numbering = NUMBERINGS.includes(next.mode) ? next.mode : prev.options.numbering;
  }
  if (metadata.includeColophon !== prev.metadata.includeColophon
      && options.colophon === prev.options.colophon) {
    options.colophon = metadata.includeColophon !== false;
  }
  const mode = options.numbering;
  metadata.includeColophon = options.colophon;
  if (!isObject(metadata.groupTitles)) metadata.groupTitles = {};
  const unchanged = mode === next.mode
    && metadata.includeColophon === next.metadata.includeColophon
    && shallowEqual(options, next.options)
    && metadata.groupTitles === next.metadata.groupTitles;
  return unchanged ? next : { ...next, mode, options, metadata };
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => a[k] === b[k]);
}

function sameSelection(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameUndoable(a, b) {
  if (a === b) return true;
  if (!sameSelection(a.selection, b.selection)) return false;
  if (a.mode !== b.mode || !shallowEqual(a.options, b.options)) return false;
  const { groupTitles: ga, ...ma } = a.metadata;
  const { groupTitles: gb, ...mb } = b.metadata;
  return shallowEqual(ma, mb) && shallowEqual(ga, gb);
}

const snapshot = s => ({ selection: s.selection, metadata: s.metadata, options: s.options, mode: s.mode });

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch { return defaultState(); }
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
}

const listeners = new Set();
let state = load();
let past = [];      // [{ snap, label, key, t }]
let future = [];

function notify() { for (const l of listeners) l(state); }

export const store = {
  get() { return state; },

  // set(patch | fn, { label, undo = true, coalesce })
  //   label    short description ("Removed Regulation D") shown by Undo
  //   undo     false = apply without recording history
  //   coalesce key: consecutive sets with the same key within 1.5 s share one
  //            history entry (typing in a text field)
  set(patch, opts = {}) {
    const prev = state;
    let next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
    if (!next || next === prev) return;
    next = reconcile(next, prev);
    if (opts.undo !== false && !sameUndoable(prev, next)) {
      const top = past[past.length - 1];
      const now = Date.now();
      const merge = opts.coalesce && top && top.key === opts.coalesce && now - top.t < COALESCE_MS;
      if (merge) top.t = now;
      else {
        past.push({ snap: snapshot(prev), label: opts.label || "", key: opts.coalesce || null, t: now });
        if (past.length > HISTORY_CAP) past.shift();
      }
      future = [];
    }
    state = next;
    save(state);
    notify();
  },

  undo() {
    const entry = past.pop();
    if (!entry) return false;
    future.push({ snap: snapshot(state), label: entry.label });
    state = { ...state, ...entry.snap };
    save(state); notify();
    return entry.label || true;
  },
  redo() {
    const entry = future.pop();
    if (!entry) return false;
    past.push({ snap: snapshot(state), label: entry.label, key: null, t: 0 });
    state = { ...state, ...entry.snap };
    save(state); notify();
    return entry.label || true;
  },
  canUndo() { return past.length > 0; },
  canRedo() { return future.length > 0; },
  undoLabel() { return past.length ? past[past.length - 1].label : ""; },
  redoLabel() { return future.length ? future[future.length - 1].label : ""; },
  historyDepth() { return past.length; },

  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },
  reset() {
    state = defaultState(); past = []; future = [];
    save(state); notify();
  },
};
