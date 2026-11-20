// The corpus as "units you can add in one click": acts, act divisions,
// C.F.R. parts and their subject groups (Regulation D…). Pure ESM, no DOM.
// The browse tree and the search results both read from here.
//
// Corpus fields used when present (everything falls back when absent):
//   act.divisions            [{id, label, sections:[ids]}]
//   act.usc_range            "15 U.S.C. §§ 77a–77aa"
//   act.original_name_short  "Securities Act"
//   regulation.groups        [{id, label, short, rules:[ids]}]
//   regulation.display_title / .part
import { cfrParts, isReserved, regulationDisplayTitle, regulationPart, ruleShortName } from "./labels.js";
import { sortIntoCodeOrder } from "./model.js";

const DASH = "–";

function rangeLabel(first, last, single, plural) {
  if (!first) return "";
  return first === last ? `${single} ${first}` : `${plural} ${first}${DASH}${last}`;
}

// "Regulation 14A: Solicitation of Proxies" with short "Regulation 14A" ->
// "Solicitation of Proxies". "" when the label adds nothing to the short name.
export function groupSubtitle(label, short) {
  const l = String(label || "").trim();
  const s = String(short || "").trim();
  if (!l || !s || l === s) return "";
  const rest = l.startsWith(s) ? l.slice(s.length) : l.replace(/^[^—–:]*[—–:]\s*/, "");
  return rest.replace(/^[\s—–:;,.-]+/, "").trim();
}

// Unit shape:
// { key, type: "act"|"division"|"part"|"group"|"rest", label, short, range, desc,
//   ids      what "Add all" adds (reserved / repealed provisions left out)
//   allIds   everything the unit holds; the browse tree shows reserved ones greyed
//   noun: "sections"|"rules", parentKey, children: [unit],
//   ungrouped: [ids] (of allIds, in no child), rest: the "Other rules" unit or null }
export function buildUnits(index) {
  if (index.__units) return index.__units;
  const { corpus } = index;
  const meta = corpus.meta || {};
  const acts = [];
  const parts = [];
  const all = [];
  const byKey = new Map();
  const reg = u => { all.push(u); byKey.set(u.key, u); return u; };
  const usable = id => !isReserved(index.byId.get(id));
  const make = (u, allIds) => ({ desc: "", children: [], rest: null, ...u, allIds, ids: allIds.filter(usable) });

  // the "Other rules" bucket of a unit whose children leave some ids unclaimed
  const addRest = (unit, claimed) => {
    unit.ungrouped = unit.allIds.filter(id => !claimed.has(id));
    if (!unit.children.length || !unit.ungrouped.length) { if (!unit.children.length) unit.ungrouped = unit.allIds; return; }
    const noun = unit.noun === "rules" ? "rules" : "sections";
    unit.rest = reg(make({
      key: `rest:${unit.key}`, type: "rest", label: `Other ${noun}`, short: `Other ${noun} in ${unit.short}`,
      range: "", noun: unit.noun, parentKey: unit.key, ungrouped: unit.ungrouped,
    }, unit.ungrouped));
  };

  for (const act of corpus.acts) {
    const allIds = act.sections.map(s => s.id);
    const idSet = new Set(allIds);
    const first = act.sections[0]?.codified?.num;
    const last = act.sections[act.sections.length - 1]?.codified?.num;
    const prefix = meta.uscCitePrefix || "15 U.S.C.";
    const unit = reg(make({
      key: `act:${act.id}`, type: "act", id: act.id,
      label: act.short_title,
      short: act.original_name_short || act.short_title,
      range: act.usc_range || (first ? `${prefix} ${rangeLabel(first, last, "§", "§§")}` : ""),
      noun: "sections", parentKey: null, ungrouped: allIds,
    }, allIds));
    const used = new Set();
    for (const d of act.divisions || []) {
      const dids = (d.sections || []).filter(id => idSet.has(id));
      if (!dids.length) continue;
      dids.forEach(id => used.add(id));
      unit.children.push(reg(make({
        key: `div:${d.id}`, type: "division", id: d.id,
        label: d.label, short: d.label, range: "",
        noun: "sections", parentKey: unit.key, ungrouped: dids,
      }, dids)));
    }
    addRest(unit, used);
    // "Add all" adds the Act as enacted: sections with an Act section number.
    // Code sections the chapter holds from other statutes stay in the list.
    if (act.sections.some(s => s.original?.num)) {
      const enacted = new Set(act.sections.filter(s => s.original?.num).map(s => s.id));
      for (const u of [unit, ...unit.children, unit.rest].filter(Boolean)) u.ids = u.ids.filter(id => enacted.has(id));
    }
    acts.push(unit);
  }

  for (const regulation of corpus.regulations) {
    const allIds = regulation.rules.map(r => r.id);
    const idSet = new Set(allIds);
    const part = regulationPart(regulation);
    const prefix = meta.cfrCitePrefix || "17 C.F.R.";
    const unit = reg(make({
      key: `reg:${regulation.id}`, type: "part", id: regulation.id,
      label: regulationDisplayTitle(regulation),
      short: part ? `Part ${part}` : regulation.title,
      part, range: part ? `${prefix} Part ${part}` : "",
      noun: "rules", parentKey: null, ungrouped: allIds,
    }, allIds));
    const used = new Set();
    const cfrOf = id => cfrParts(index.byId.get(id) || {}, meta);
    for (const g of regulation.groups || []) {
      const gids = (g.rules || []).filter(id => idSet.has(id));
      if (!gids.length) continue;
      gids.forEach(id => used.add(id));
      const short = g.short || String(g.label || "").split(/\s*[—:]\s*/)[0];
      // the range names the provisions you would actually get ("Regulation A"
      // ends at § 230.263; the reserved run after it does not count)
      const real = gids.filter(usable);
      const ends = real.length ? real : gids;
      const s0 = cfrOf(ends[0]).range?.first || cfrOf(ends[0]).section;
      const s1 = cfrOf(ends[ends.length - 1]).range?.last || cfrOf(ends[ends.length - 1]).section;
      unit.children.push(reg(make({
        key: `grp:${g.id}`, type: "group", id: g.id,
        label: g.label || short, short, desc: groupSubtitle(g.label, short),
        range: s0 ? rangeLabel(s0, s1, "§", "§§") : "",
        noun: "rules", parentKey: unit.key, ungrouped: gids,
      }, gids)));
    }
    addRest(unit, used);
    parts.push(unit);
  }

  index.__units = { acts, parts, all, byKey };
  return index.__units;
}

// What a part of the book actually holds, as a citation: "15 U.S.C. § 77e" for
// one section, "15 U.S.C. §§ 77e–77l" for several (first to last in Code order
// of the ones in the book), "17 C.F.R. § 230.506" / "§§ 230.501–230.508" for
// rules. Only a part that holds everything the act or C.F.R. part has gets the
// whole range ("15 U.S.C. §§ 77a–77aa", "17 C.F.R. Part 230").
//   group: a part from model.groupSelection ({ key, items: [id] })
//   numbering: "original" names an Act's sections by Act section ("§§ 2–12"),
//   with the Code range after it; "codified" gives the Code range alone.
export function partRange(group, index, numbering) {
  const unit = buildUnits(index).byKey.get(group.key);
  if (!unit) return "";
  const ids = sortIntoCodeOrder((group.items || []).filter(id => index.byId.has(id)), index);
  if (!ids.length) return "";
  const have = new Set(ids);
  const whole = unit.ids.every(id => have.has(id));
  if (unit.type === "act" && numbering === "original") {
    if (whole) return `Whole Act · ${unit.range}`;
    const acts = ids.map(id => index.byId.get(id)?.original?.num).filter(n => /^\d/.test(n || ""));
    if (acts.length) {
      const a = acts[0], b = acts[acts.length - 1];
      return a === b ? `§ ${a}` : `§§ ${a}${/[–-]/.test(a + b) ? " to " : DASH}${b}`;
    }
  }
  if (whole) return unit.range;
  const meta = index.corpus?.meta || {};
  const ends = (a, b, prefix) => {
    if (a === b) return `${prefix} § ${a}`;
    // numbers that carry their own dash ("80a–1", "240.10b-5") need a word between them
    return `${prefix} §§ ${a}${/[–-]/.test(a + b) ? " to " : DASH}${b}`;
  };
  if (unit.type === "act") {
    const num = id => index.byId.get(id)?.codified?.num || id.replace(/^s-/, "");
    return ends(num(ids[0]), num(ids[ids.length - 1]), meta.uscCitePrefix || "15 U.S.C.");
  }
  if (numbering === "original") {
    // "Rules 144–506", "Items 101–105": the names lawyers use, when both ends have one
    const [a, z] = [ids[0], ids[ids.length - 1]].map(id => ruleShortName(index.byId.get(id), meta));
    const kind = (a.match(/^(Rule|Item) /) || [])[1];
    if (kind && z.startsWith(`${kind} `)) {
      const x = a.slice(kind.length + 1), y = z.slice(kind.length + 1);
      return x === y ? a : `${kind}s ${x}${/[–-]/.test(x + y) ? " to " : DASH}${y}`;
    }
  }
  const cfr = id => cfrParts(index.byId.get(id), meta);
  const first = cfr(ids[0]);
  const last = cfr(ids[ids.length - 1]);
  return ends(first.range?.first || first.section, last.range?.last || last.section, meta.cfrCitePrefix || "17 C.F.R.");
}
