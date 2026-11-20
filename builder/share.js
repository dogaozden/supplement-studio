// share.js — share-URL codec (docs/contracts.md § 5).
//
// Pure ESM, no DOM; runs in the browser and in Node. Encodes builder
// state into a versioned URL fragment and back. The encoder writes v=3,
// which names provisions the way lawyers do:
//
//   #v=3&c=securities&b=SecuritiesAct:2,5,11,12;ExchangeAct:10,16;Part230:144,506;Part240:10b-5
//     [&n=code][&t=<title>&st=…&co=…&te=…&pr=…&sc=…][&g=<partKey>=<title>]…
//     [&tr=7x10|6x9][&cr=0][&col=0]
//
//   b    the book, in the user's order: runs of "<group>:<token>,<token>,…"
//        joined by ";". Groups (makeNaming):
//          <act share_key>  Act section numbers ("SecuritiesAct:12", "ExchangeAct:10")
//          Part<nnn>        C.F.R. section numbers within that part ("Part240:10b-5")
//          USC              a Code section no Act section enacted ("USC:77r-1")
//          id               any other corpus id, verbatim with "–" as "~"
//   n    numbering: absent = Act numbering, "code" = U.S. Code numbering first
//
// Older links still decode: v=1 and v=2 carry corpus ids in s
// ("s:77b,77e;r-230:144"), m=o for Act numbering, and mean U.S. Code
// numbering when m is absent.
//
// API:
//   makeNaming(corpus) -> naming   (the corpus's link vocabulary)
//   encodeState(state, corpusId, naming) -> "#…"
//     state: { selection: [id…], metadata: {…, groupTitles}, options: { trim,
//              numbering: "original" | "codified", sourceCredits, colophon } }
//   decodeState(hash, naming) -> state | null
//     null on any malformed input (unknown version, missing v/c/selection,
//     bad escapes, bad option values, a v3 link without a naming). A v3
//     token the corpus does not know decodes to the id "missing:<group>:<token>",
//     which the studio shows as "No longer in the corpus", like an unknown v2 id.

import { cfrParts } from "./labels.js";

const VERSION = "3";
const READABLE_VERSIONS = new Set(["1", "2", "3"]);
const TRIMS = new Set(["letter", "7x10", "6x9"]);

const METADATA_PARAMS = [
  ["t", "title"],
  ["st", "subtitle"],
  ["co", "course"],
  ["te", "term"],
  ["pr", "professor"],
  ["sc", "school"],
];

function splitId(id) {
  // Prefix = everything before the LAST "-", suffix = the rest.
  // Ids without an interior dash (none exist today, but unknown ids
  // must survive) keep the whole id as the suffix with an empty prefix.
  const idx = id.lastIndexOf("-");
  if (idx <= 0) return ["", id];
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function expandSelection(value) {
  if (value === "") return [];
  const selection = [];
  for (const group of value.split(";")) {
    const idx = group.indexOf(":");
    if (idx === -1) return null;
    const prefix = group.slice(0, idx);
    for (const suffix of group.slice(idx + 1).split(",")) {
      const id = prefix === "" ? suffix : `${prefix}-${suffix}`;
      if (id === "") return null;   // "s=:" must not yield a [""] selection
      selection.push(id.replace(/~/g, "–"));
    }
  }
  return selection;
}

// ── naming: corpus ids <-> the tokens lawyers read ──────────────────────────
const TOKEN = /^[0-9A-Za-z().-]+$/;
const GROUP = /^[A-Za-z][0-9A-Za-z]*$/;
const slug = text => String(text).replace(/–/g, "-").replace(/[^0-9A-Za-z().-]+/g, "");

export function makeNaming(corpus) {
  const byId = new Map();     // id -> [group, token]
  const byName = new Map();   // "group:token" -> id
  const claim = (id, group, token) => {
    const key = `${group}:${token}`;
    if (!GROUP.test(group) || !TOKEN.test(token)) return;
    if (byName.has(key)) {                    // ambiguous: neither keeps the name
      const other = byName.get(key);
      if (other !== null) byId.delete(other);
      byName.set(key, null);
      return;
    }
    byName.set(key, id);
    byId.set(id, [group, token]);
  };
  for (const act of corpus?.acts || []) {
    for (const sec of act.sections || []) {
      const orig = sec.original?.num;
      if (orig && act.share_key) claim(sec.id, act.share_key, slug(orig));
      else if (sec.codified?.num) claim(sec.id, "USC", slug(sec.codified.num));
    }
  }
  for (const reg of corpus?.regulations || []) {
    for (const rule of reg.rules || []) {
      const { part, num, range } = cfrParts(rule, corpus?.meta);
      if (part && !range) claim(rule.id, `Part${part}`, slug(num));
    }
  }
  return {
    name: id => byId.get(id) || ["id", String(id).replace(/–/g, "~")],
    resolve: (group, token) => {
      if (group === "id") return token.replace(/~/g, "–");
      return byName.get(`${group}:${token}`) || `missing:${group}:${token}`;
    },
  };
}

function encodeBook(selection, naming) {
  const runs = [];
  for (const id of selection) {
    const [group, token] = naming.name(id);
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.tokens.push(token);
    else runs.push({ group, tokens: [token] });
  }
  return runs.map(r => `${r.group}:${r.tokens.join(",")}`).join(";");
}

function decodeBook(value, naming) {
  const selection = [];
  for (const run of value.split(";")) {
    const idx = run.indexOf(":");
    if (idx <= 0) return null;
    const group = run.slice(0, idx);
    for (const token of run.slice(idx + 1).split(",")) {
      if (token === "") return null;
      selection.push(naming.resolve(group, token));
    }
  }
  return selection;
}

export function encodeState(state, corpusId, naming) {
  const { selection = [], metadata = {}, options = {} } = state || {};
  const params = new URLSearchParams();
  params.set("v", VERSION);
  params.set("c", corpusId);
  params.set("b", encodeBook(selection, naming));
  if (options.numbering === "codified") params.set("n", "code");
  for (const [key, field] of METADATA_PARAMS) {
    const value = metadata[field];
    if (value !== undefined && value !== null && String(value) !== "") {
      params.set(key, String(value));
    }
  }
  // Custom part titles: one `g` param each, "<partKey>=<title>" (the key's
  // en-dash travels as "~", like ids).
  for (const [key, title] of Object.entries(metadata.groupTitles || {})) {
    if (typeof title === "string" && title.trim() !== "") {
      params.append("g", `${key.replace(/–/g, "~")}=${title}`);
    }
  }
  // Book options that differ from a new book's.
  if (TRIMS.has(options.trim) && options.trim !== "letter") params.set("tr", options.trim);
  if (options.sourceCredits === false) params.set("cr", "0");
  if (options.colophon === false) params.set("col", "0");
  // URLSearchParams percent-encodes the fragment-safe delimiters; put them
  // back so the link stays readable. After serialization every "%" begins a
  // valid escape, so these replacements only hit genuine encoded delimiters.
  const query = params
    .toString()
    .replace(/%2C/g, ",")
    .replace(/%3A/g, ":")
    .replace(/%3B/g, ";")
    .replace(/%7E/g, "~")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
  return `#${query}`;
}

// URLSearchParams silently passes malformed percent escapes through; we
// must instead reject them (decodeState contract: null on undecodable
// input), so the query string is parsed by hand with decodeURIComponent.
// Returns key -> [values]: repeated keys (`g`) keep every value.
function parseParams(query) {
  const params = new Map();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      return null;
    }
    if (!params.has(key)) params.set(key, []);
    params.get(key).push(value);
  }
  return params;
}

export function decodeState(hash, naming) {
  if (typeof hash !== "string") return null;
  const query = hash.startsWith("#") ? hash.slice(1) : hash;
  if (query === "") return null;

  const all = parseParams(query);
  if (all === null) return null;
  const params = {
    has: key => all.has(key),
    get: key => (all.has(key) ? all.get(key)[0] : undefined),   // first occurrence wins
  };
  const version = params.get("v");
  if (!READABLE_VERSIONS.has(version)) return null;

  const corpusId = params.get("c");
  if (!corpusId) return null;

  let selection;
  let mode;
  if (version === "3") {
    const book = params.get("b");
    if (book === undefined || !naming) return null;
    selection = book === "" ? [] : decodeBook(book, naming);
    if (selection === null) return null;
    const n = params.has("n") ? params.get("n") : "act";
    if (n !== "act" && n !== "code") return null;
    mode = n === "code" ? "codified" : "original";
  } else {
    const rawSelection = params.get("s");
    if (rawSelection === undefined) return null;
    selection = expandSelection(rawSelection);
    if (selection === null) return null;
    const m = params.has("m") ? params.get("m") : "c";
    if (m !== "c" && m !== "o") return null;
    mode = m === "o" ? "original" : "codified";
  }

  const state = {
    c: corpusId,
    selection,
    mode,
  };

  const metadata = {};
  let hasMetadata = false;
  for (const [key, field] of METADATA_PARAMS) {
    if (params.has(key)) {
      metadata[field] = params.get(key);
      hasMetadata = true;
    }
  }
  let colophon = true;
  if (params.has("col")) {
    const col = params.get("col");
    if (col !== "0" && col !== "1") return null;
    metadata.includeColophon = col !== "0";
    colophon = col !== "0";
    hasMetadata = true;
  }

  if (version !== "1") {
    // custom part titles
    const groupTitles = {};
    for (const entry of all.get("g") || []) {
      const eq = entry.indexOf("=");
      if (eq <= 0) return null;
      const title = entry.slice(eq + 1);
      if (title !== "") groupTitles[entry.slice(0, eq).replace(/~/g, "–")] = title;
    }
    if (all.has("g")) {
      metadata.groupTitles = groupTitles;
      hasMetadata = true;
    }
    // book options: absent params mean a new book's options
    let trim = "letter";
    if (params.has("tr")) {
      trim = params.get("tr");
      if (!TRIMS.has(trim)) return null;
    }
    let sourceCredits = true;
    if (params.has("cr")) {
      const cr = params.get("cr");
      if (cr !== "0" && cr !== "1") return null;
      sourceCredits = cr !== "0";
    }
    state.options = { trim, numbering: state.mode, sourceCredits, colophon };
  }
  if (hasMetadata) state.metadata = metadata;

  return state;
}
