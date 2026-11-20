// Citation-aware search over the corpus. Pure ESM, no DOM (node-tested in
// tests/node/search.test.mjs).
//
//   const { search } = createSearch(index, { Fuse })
//   search("Rule 10b-5")  ->  [{ type: "provision", id, score, note?, why? },
//                              { type: "unit", key, unitType, label, short,
//                                range, count, ids, score }, …]  best first
//
// A citation parser runs BEFORE fuzzy matching, and its hits rank first:
//   "Rule 10b-5", "240.10b-5", "17 CFR 240.10b-5"   -> rule
//   "§ 77e", "77e", "15 U.S.C. 77e"                  -> statute by U.S. Code number
//   "Section 5", "Securities Act § 5", "'33 Act § 5" -> statute by ACT section number
//   "Section 12(a)(2)"                               -> § 12 (subsection noted)
//   "Reg D", "Regulation S-K Item 404", "Form 10-K"  -> group / rule / form
//   "Securities Act"                                 -> the whole act
// then a small curated concept map ("accredited investor", "PSLRA"), then
// plain keyword matching over headings, then Fuse.js fuzzy matching.
//
// Fuse is injected (browser: the vendored global; node tests: require()).
import { describe, cfrParts, ruleCommonName, isReserved } from "./labels.js";
import { buildUnits } from "./units.js";
import { SECURITIES_ALIASES } from "./search-aliases.js";

const normNum = s => String(s ?? "").toLowerCase().replace(/[–—‒]/g, "-").replace(/\s+/g, "");
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set(["the", "of", "and", "for", "a", "an", "in", "on", "to", "or", "by", "with", "under", "about", "that", "is"]);

// Core sec-reg parts first when the same rule number exists in several parts.
const PART_PRIORITY = { "230": 7, "240": 6, "229": 5, "243": 4, "242": 3, "270": 2, "275": 2, "249": 1 };

// number-ish token: optional "240." part prefix, then 10b5-1, 144a, 77e,
// 78j-1, 206(4)-8, and trailing subsections "(a)(2)".
const IDENT = /^(?:(\d{1,3})\.)?(\d+(?:[a-z]+\d*)*(?:\([a-z0-9]+\))*(?:-[a-z0-9]+(?:\([a-z0-9]+\))*)*)$/;

export function createSearch(index, opts = {}) {
  const Fuse = opts.Fuse ?? globalThis.Fuse;
  const corpus = index.corpus;
  const meta = corpus.meta || {};
  const aliases = opts.aliases ?? meta.searchAliases ?? SECURITIES_ALIASES;
  const units = buildUnits(index);

  // ── index ────────────────────────────────────────────────────────────────
  const entries = [];
  const byId = new Map();
  const byCod = new Map();      // normalized U.S.C. number -> [entry]
  const byOrig = new Map();     // normalized act section number -> [entry]
  const byRuleNum = new Map();  // normalized rule number ("10b-5") -> [entry]
  const addTo = (map, key, e) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(e); };

  corpus.acts.forEach((act, actIdx) => {
    for (const s of act.sections) {
      if (isReserved(s)) continue;     // repealed / omitted: never offered
      const d = describe(s.id, index);
      const e = {
        id: s.id, kind: "section", actId: act.id, actIdx, heading: d.heading,
        cod: normNum(s.codified?.num), orig: s.original?.num ? normNum(s.original.num) : "",
        hay: d.heading.toLowerCase(),
      };
      entries.push(e); byId.set(e.id, e);
      addTo(byCod, e.cod, e); addTo(byOrig, e.orig, e);
    }
  });
  corpus.regulations.forEach(reg => {
    for (const r of reg.rules) {
      if (isReserved(r)) continue;     // "[Reserved]": never offered
      const d = describe(r.id, index);
      const { part, num } = cfrParts(r, meta);
      const common = ruleCommonName(r, meta);
      const e = {
        id: r.id, kind: "rule", regId: reg.id, part, num: normNum(num), heading: d.heading,
        name: d.name || "", common, groupId: r.group || null,
        hay: `${d.heading} ${common}`.toLowerCase(),
      };
      entries.push(e); byId.set(e.id, e);
      addTo(byRuleNum, e.num, e);
    }
  });

  const keysSorted = map => [...map.keys()].sort();
  const codKeys = keysSorted(byCod), origKeys = keysSorted(byOrig), ruleKeys = keysSorted(byRuleNum);

  // act alias -> corpus act ids
  const actIdsFor = alias => corpus.acts
    .filter(a => alias.is.test(`${a.short_title} ${a.original_name_short || ""}`))
    .map(a => a.id);
  const actAliasIds = new Map(aliases.acts.map(a => [a.id, actIdsFor(a)]));
  const phrases = [];   // [{ name, actIds }] longest first
  for (const a of aliases.acts) for (const name of a.names) phrases.push({ name, actIds: actAliasIds.get(a.id) });
  for (const g of aliases.actGroups || []) {
    const ids = g.acts.flatMap(id => actAliasIds.get(id) || []);
    for (const name of g.names) phrases.push({ name, actIds: ids });
  }
  phrases.sort((a, b) => b.name.length - a.name.length);

  // the act whose bare section numbers win ("Section 10(b)" is the Exchange Act's)
  const exFirst = new Set(aliases.exchangeFirst?.nums || []);
  const exIds = new Set(actAliasIds.get(aliases.exchangeFirst?.act) || []);

  // Does a section really have subsection "(a)(2)"? Read the content tree's
  // num chain once per entry; every note and ranking asks this first.
  const anchorCache = new Map();
  function anchorsOf(e) {
    let set = anchorCache.get(e.id);
    if (set) return set;
    set = new Set();
    const walk = (nodes, path) => {
      for (const n of nodes || []) {
        const p = n.num ? [...path, String(n.num).toLowerCase()] : path;
        if (n.num) set.add(p.join("/"));
        walk(n.children, p);
      }
    };
    walk(index.byId.get(e.id)?.content, []);
    anchorCache.set(e.id, set);
    return set;
  }
  const hasSub = (e, sub) =>
    anchorsOf(e).has([...sub.matchAll(/\(([a-z0-9]+)\)/g)].map(m => m[1]).join("/"));

  // Popular names for a set of provisions ("JOBS Act", "Dodd-Frank"): a row
  // "Add all N". Members come from the public law in their source credit,
  // explicit ids, or whole parts of the tree (search-aliases.js `bundles`).
  const usable = id => byId.has(id);
  const normPL = x => String(x ?? "").replace(/[–—‒]/g, "-");
  const bundles = (aliases.bundles || []).map(b => {
    let ids = [];
    let credited = null;
    if (b.pubL) {
      const re = new RegExp(`Pub\\. L\\. ${escapeRe(normPL(b.pubL))}(?!\\d)`);
      credited = new Set(corpus.acts.flatMap(a => a.sections)
        .filter(s => re.test(normPL(s.source_credit))).map(s => s.id));
      ids = [...credited].filter(usable);
    }
    if (b.ids) ids = b.ids.filter(id => usable(id) && (!credited || credited.has(id)));
    for (const key of b.unitKeys || []) ids.push(...(units.byKey.get(key)?.ids || []));
    ids = [...new Set(ids)];
    const sectionsOnly = ids.every(id => byId.get(id)?.kind === "section");
    return {
      ...b, ids,
      unit: {
        key: `bundle:${b.id}`, type: "bundle", label: b.label, short: b.label,
        range: b.range || (b.pubL ? `Pub. L. ${b.pubL}` : ""), desc: b.desc || "",
        ids, noun: sectionsOnly ? "sections" : "provisions",
      },
      featured: (b.featured || ids).filter(id => usable(id)).slice(0, 8),
    };
  }).filter(b => b.ids.length);
  const bundlePhrases = bundles.flatMap(b => b.names.map(name => ({ name, bundle: b })))
    .sort((a, b) => b.name.length - a.name.length);

  // subject groups by regulation name ("Regulation D" -> "d")
  const groupName = g => normNum(String(g.short || g.label).replace(/^regulation\s+/i, "").replace(/\+$/, ""));
  const groupsByName = new Map();
  for (const u of units.all) if (u.type === "group") addTo(groupsByName, groupName(u), u);
  const partByName = new Map();
  for (const r of aliases.regulations || []) for (const n of r.names) partByName.set(n, r);
  const unitByPart = new Map(units.parts.map(u => [u.part, u]));

  let fuse = null;
  const getFuse = () => fuse || (fuse = Fuse ? new Fuse(entries, {
    keys: [{ name: "heading", weight: 0.65 }, { name: "common", weight: 0.35 }],
    threshold: 0.3, ignoreLocation: true, minMatchCharLength: 3,
  }) : null);

  // ── query parsing ────────────────────────────────────────────────────────
  function parse(raw) {
    let s = String(raw).normalize("NFKC").toLowerCase();
    s = s.replace(/[’‘`´]/g, "'").replace(/[–—‒]/g, "-").replace(/\u00a0/g, " ");
    s = s.replace(/§+/g, " § ");
    s = s.replace(/\bu\.\s?s\.\s?c\.?/g, " usc ").replace(/\bc\.\s?f\.\s?r\.?/g, " cfr ");
    s = s.replace(/\bsecs?\b\.?/g, "section ").replace(/\bno\.\s*/g, "");
    s = s.replace(/(\w)\s+(\((?:[a-z]|\d+)\))/g, "$1$2");   // "12 (a)" -> "12(a)"
    // "10b 5" is a rule number typed with a space ("10b5": resolved below)
    s = s.replace(/(?<!\b(?:form|schedule)\s)(^|\s)(\d+[a-z]\d*)\s+(\d{1,3}(?:-\d+)?)(?=\s|$)/g, "$1$2$3");
    s = s.replace(/[,;:!?]+/g, " ").replace(/\.+(?=\s|$)/g, "").replace(/\s+/g, " ").trim();

    const P = {
      normalized: s, acts: [], actNamed: false, kw: {}, regName: "", regLabel: "",
      formWord: "", formName: "", ident: null, words: [], bundles: [],
    };

    // act names, longest first ("securities exchange act" before "exchange act")
    for (const { name, actIds } of phrases) {
      const re = new RegExp(`(^|\\s)${escapeRe(name)}(?=\\s|$)`);
      if (re.test(s)) {
        s = s.replace(re, " ");
        P.actNamed = true;
        for (const id of actIds) if (!P.acts.includes(id)) P.acts.push(id);
      }
    }
    // "reg d", "regulation s-k"
    const reg = s.match(/(^|\s)(?:regulation|reg|regs)\.?\s+([a-z0-9]+(?:-[a-z0-9]+)?)\+?(?=\s|$)/);
    if (reg) {
      P.regName = normNum(reg[2]);
      s = s.replace(reg[0], " ");
    }
    // popular names: "JOBS Act", "Dodd-Frank", "crowdfunding"
    for (const { name, bundle } of bundlePhrases) {
      const re = new RegExp(`(^|\\s)${escapeRe(name)}(?=\\s|$)`);
      if (re.test(s)) {
        s = s.replace(re, " ");
        if (!P.bundles.includes(bundle)) P.bundles.push(bundle);
      }
    }
    const words = s.split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      if (/^\d+$/.test(w) && (next === "usc" || next === "cfr")) continue;     // "15 usc", "17 cfr"
      if (w === "usc" || w === "cfr") { P.kw[w] = true; continue; }
      if (w === "rule" || w === "rules") { P.kw.rule = true; continue; }
      if (w === "section" || w === "sections") { P.kw.section = true; continue; }
      if (w === "§") { P.kw.sym = true; continue; }
      if (w === "item" || w === "items") { P.kw.item = true; continue; }
      if (w === "part" && next && /^\d+[a-z]?$/.test(next)) { P.kw.part = next; i++; continue; }
      if ((w === "form" || w === "schedule") && next) { P.formWord = w; P.formName = next; i++; continue; }
      if (aliases.bareRegulationNames?.includes(w) && !P.regName) { P.regName = w; continue; }
      if (STOP.has(w)) continue;
      const m = IDENT.exec(w);
      if (m && !P.ident) {
        P.ident = { raw: w, part: m[1] || "", num: m[2] };
        continue;
      }
      P.words.push(w);
    }
    if (P.regName) {
      const r = partByName.get(P.regName);
      P.regLabel = r ? r.label : "";
    }
    return P;
  }

  // ── citation resolution ──────────────────────────────────────────────────
  // type-ahead: "10b" lists the 10b-… family, shortest numbers first
  const prefixHits = (keys, map, token, cap = 14) => {
    if (token.length < 2) return [];
    const out = [];
    for (const k of keys) if (k !== token && k.startsWith(token)) out.push(...map.get(k));
    const len = e => (e.num ?? e.cod ?? "").length;
    out.sort((a, b) => len(a) - len(b) || (PART_PRIORITY[b.part] || 0) - (PART_PRIORITY[a.part] || 0));
    return out.slice(0, cap);
  };

  // A typed subsection is checked against the section's real content tree:
  // one that exists lifts the hit and is noted; one that does not sinks it and
  // is never claimed ("§ 77m has no subsection (d)").
  // `sub` records which way it went ("has" | "lacks") so search() can drop the
  // candidates that lack it whenever another candidate has it.
  function subInfo(e, sub, kind) {
    if (!sub) return { adj: 0, note: "", sub: "" };
    return hasSub(e, sub)
      ? { adj: 45, note: `Subsection ${sub} is part of this ${kind}; the whole ${kind} is added.`, sub: "has" }
      : { adj: -80, note: `This ${kind} has no subsection ${sub}; the whole ${kind} is added.`, sub: "lacks" };
  }

  // Try the full number, then strip trailing "(x)" groups to find a section
  // whose number is the leading part ("12(a)(2)" -> "12" + "(a)(2)").
  function splitSub(num, map) {
    let n = num, sub = "";
    for (;;) {
      if (map.has(n)) return { num: n, sub };
      const m = n.match(/^(.*?)((?:\([a-z0-9]+\))+)$/);
      if (!m || !m[1]) return { num, sub: "" };
      sub = m[2] + sub;
      n = m[1];
    }
  }

  // "10b5" is how people say "10b-5": a rule number typed without its hyphen
  const hyphenated = n => {
    const m = /^(\d+[a-z]+)(\d+)((?:\([a-z0-9]+\))*)$/.exec(n);
    return m ? `${m[1]}-${m[2]}${m[3]}` : "";
  };

  function citationHits(P, restrictIds) {
    const hits = [];
    const { ident, kw } = P;
    const ruleish = kw.rule || kw.cfr || kw.item || P.formWord;
    const codish = kw.usc || kw.section || kw.sym;
    const partCtx = ident.part || P.regPart || (P.regName ? (partByName.get(P.regName)?.part || "") : "");
    const allowed = e => !restrictIds || restrictIds.has(e.id);

    // rules
    if (!kw.usc && !(P.actNamed && !kw.rule && !kw.cfr)) {
      const raw = normNum(ident.num);
      let { num, sub } = splitSub(raw, byRuleNum);
      let viaHyphen = false;
      if (!byRuleNum.has(num) && hyphenated(raw)) {
        const alt = splitSub(hyphenated(raw), byRuleNum);
        if (byRuleNum.has(alt.num)) { ({ num, sub } = alt); viaHyphen = true; }
      }
      const shaped = /^\d+[a-z]+\d*-\d/.test(num);
      // a bare "9" or "18" is a statute section; a rule or form number needs its word
      const bareInt = /^\d+$/.test(num) && !ruleish && !partCtx;
      let list = (byRuleNum.get(num) || []).filter(allowed);
      if (partCtx) list = list.filter(e => e.part === partCtx);
      if (kw.item) list = list.filter(e => e.part === "229");
      for (const e of list) {
        let score = 200 + (PART_PRIORITY[e.part] || 0);
        if (ruleish || ident.part) score += 80;
        if (shaped) score += 40;
        if (kw.section) score -= 90;
        if (bareInt) score -= 95;
        const si = subInfo(e, sub, "rule");
        hits.push({ type: "provision", id: e.id, score: score + si.adj, note: si.note, sub: si.sub });
      }
      if (list.length) {
        // siblings: "144A" -> also "144"; "10b5-1" -> also "10b5"
        const base = num.replace(/[a-z]+$/, "");
        if (base !== num) for (const e of (byRuleNum.get(base) || []).filter(allowed)) {
          if (!partCtx || e.part === partCtx) hits.push({ type: "provision", id: e.id, score: 90 + (PART_PRIORITY[e.part] || 0) });
        }
      }
      const pre = (sub || kw.section ? [] : prefixHits(ruleKeys, byRuleNum, viaHyphen ? raw : num)).filter(allowed)
        .filter(e => (!partCtx || e.part === partCtx) && (!kw.item || e.part === "229"));
      pre.forEach((e, i) => hits.push({ type: "provision", id: e.id, score: 70 - i + (ruleish ? 10 : 0) }));
    }

    // an act the corpus doesn't carry (e.g. "Dodd-Frank § 922"): nothing to find by number
    const noAct = P.actNamed && !P.acts.length;

    // statutes by U.S. Code number
    if (!noAct && !kw.rule && !kw.item && !P.formWord && !restrictIds && !ident.part) {
      const { num, sub } = splitSub(normNum(ident.num), byCod);
      for (const e of byCod.get(num) || []) {
        if (P.acts.length && !P.acts.includes(e.actId)) continue;
        let score = 200;
        if (kw.usc) score += 70;
        if (codish) score += 40;
        if (/^\d{2,}[a-z]/.test(num)) score += 30;       // 77e, 78j-1: Code-shaped
        const si = subInfo(e, sub, "section");
        hits.push({ type: "provision", id: e.id, score: score + si.adj, note: si.note, sub: si.sub });
      }
      if (!P.acts.length) {
        prefixHits(codKeys, byCod, num).forEach((e, i) => hits.push({ type: "provision", id: e.id, score: 60 - i }));
      }
    }

    // statutes by ACT section number ("Section 5", "Securities Act § 5")
    if (!noAct && !kw.rule && !kw.item && !kw.usc && !P.formWord && !restrictIds && !ident.part) {
      const { num, sub } = splitSub(normNum(ident.num), byOrig);
      const seenAct = new Set();
      for (const e of byOrig.get(num) || []) {
        if (P.acts.length && !P.acts.includes(e.actId)) continue;
        let score = 150 + Math.max(0, 8 - e.actIdx);
        // typed without an act name, 9, 10, 16, 18, 20… mean the Exchange Act
        if (!P.actNamed && exIds.has(e.actId) && exFirst.has(num)) score += 14;
        // an act number can be mis-mapped onto a later, unrelated section:
        // the first section in Code order wins, the rest are demoted
        if (seenAct.has(e.actId)) score -= 70;
        seenAct.add(e.actId);
        if (P.actNamed) score += 60;
        if (kw.section || kw.sym) score += 35;
        else if (!/^\d+$/.test(num) || num.length > 3) score -= 40;
        const si = subInfo(e, sub, "section");
        hits.push({ type: "provision", id: e.id, score: score + si.adj, note: si.note, sub: si.sub });
      }
    }
    return hits;
  }

  // "Form 10-K", "Schedule 13D": a rule whose heading starts with it
  function formHits(P) {
    const name = P.formName.replace(/[.]+$/, "");
    const re = new RegExp(`^${P.formWord}\\s+${escapeRe(name)}(?![a-z0-9])`, "i");
    return entries.filter(e => e.kind === "rule" && (re.test(e.heading) || re.test(e.common || "")))
      .map((e, i) => ({ type: "provision", id: e.id, score: 400 - i }));
  }

  // "Item 1.01", "Form 8-K Item 5.02", "8-K item 2.02", "10-K item 1A": an item of
  // an SEC form. The C.F.R. prescribes which forms to file and when; the forms
  // and their items are published by the SEC, so no provision here is the item.
  // Returns { item, form, name } (form "" when the query does not say which
  // form: a decimal item such as 1.01 can only be a Form 8-K item) or null.
  function formItem(P) {
    if (P.formWord === "schedule") return null;     // a Schedule (13D…) is printed in the C.F.R.
    const norm = P.normalized;
    const name = (/(?:^|\s)(?:form\s+)?(\d{1,2}-[a-z])(?=\s|$)/.exec(norm) || [])[1] || (P.formWord === "form" ? P.formName : "");
    const form = name ? `Form ${name.toUpperCase()}` : "";
    const decimal = /(?:^|\s)items?\s+(\d{1,2}\.\d{2})(?=\s|$)/.exec(norm);
    if (decimal) return { item: decimal[1], name, form };
    const plain = /(?:^|\s)items?\s+(\d{1,2}[a-c]?)(?=\s|$)/.exec(norm);
    return plain && name ? { item: plain[1].toUpperCase(), name, form } : null;
  }
  const formItemNote = fi => `${fi.form || "Form 8-K"} items are not in the C.F.R.; the form is published by the SEC.`;

  const unitRow = (u, score, extra = {}) => ({
    type: "unit", key: u.key, unitType: u.type, label: u.label, short: u.short,
    range: u.range, desc: u.desc || "", count: u.ids.length, noun: u.noun, ids: u.ids, score, ...extra,
  });

  // ── keyword matching ─────────────────────────────────────────────────────
  function keywordHits(words, actIds, limit) {
    // a single letter ("D" in "Reg D") must match a whole word, never a prefix
    const ws = words.filter(w => !STOP.has(w));
    if (!ws.length) return [];
    const scored = [];
    for (const e of entries) {
      if (actIds?.length && !actIds.includes(e.actId)) continue;
      const hayWords = e.hay.split(/[^a-z0-9'-]+/);
      let total = 0, ok = true;
      for (const w of ws) {
        let best = 0;
        for (const hw of hayWords) {
          if (hw === w) { best = 3; break; }
          if (w.length === 1) continue;
          if (hw.startsWith(w)) best = Math.max(best, 2);
          else if (w.length >= 4 && hw.includes(w)) best = Math.max(best, 1);
        }
        if (!best) { ok = false; break; }
        total += best;
      }
      if (!ok) continue;
      if (e.hay.startsWith(ws[0])) total += 2;
      scored.push({ e, total });
    }
    scored.sort((a, b) => b.total - a.total || a.e.hay.length - b.e.hay.length);
    return scored.slice(0, limit).map(({ e, total }) => ({ type: "provision", id: e.id, score: 20 + total }));
  }

  // ── search ───────────────────────────────────────────────────────────────
  function search(query, { limit = 40 } = {}) {
    if (!String(query ?? "").trim()) return [];
    const P = parse(query);
    const out = new Map();
    const push = r => {
      const k = r.type === "unit" ? `u:${r.key}` : `p:${r.id}`;
      const prev = out.get(k);
      if (!prev || r.score > prev.score) out.set(k, { ...(prev || {}), ...r });
    };

    // 0. a form's item ("Item 1.01"): not in the C.F.R., so no fuzzy noise. The
    // form's filing rule is offered when the query names the form.
    const fi = formItem(P);
    if (fi) {
      if (!fi.form) return [];
      return formHits({ formWord: "form", formName: fi.name })
        .map(r => ({ ...r, note: `Item ${fi.item} is part of the form itself, which the SEC publishes.` })).slice(0, limit);
    }

    // 1. curated concepts
    for (const c of aliases.concepts || []) {
      if (!c.match.test(P.normalized)) continue;
      c.ids.filter(id => byId.has(id)).forEach((id, i) => push({ type: "provision", id, score: 1000 - i, why: c.why }));
    }

    // 1b. popular names ("JOBS Act", "Dodd-Frank"): an "Add all N" row, then
    // the provisions people usually mean
    P.bundles.forEach((b, i) => {
      push(unitRow(b.unit, 960 - i));
      b.featured.forEach((id, j) => push({ type: "provision", id, score: 820 - i * 20 - j }));
    });

    // 2. regulation groups and whole regulations ("Reg D", "Reg FD", "Part 240")
    let restrictIds = null;
    if (P.regName) {
      const groups = groupsByName.get(P.regName) || [];
      const part = partByName.get(P.regName);
      const partUnit = part ? unitByPart.get(part.part) : null;
      P.regPart = part?.part || "";
      if (groups.length || partUnit) {
        const units0 = groups.length ? groups : [partUnit];
        if (!P.ident) {
          units0.forEach((u, i) => {
            push(unitRow(u, 900 - i));
            if (u.type === "group") u.ids.slice(0, 12).forEach((id, j) => push({ type: "provision", id, score: 800 - i * 20 - j }));
          });
        } else {
          restrictIds = new Set(units0.flatMap(u => u.ids));
        }
      } else if (!P.ident) {
        // a regulation the corpus does not group (yet): find rules that name it
        P.words.push("regulation", P.regName);
      }
    }
    if (P.kw.part) {
      if (P.ident) P.ident.part = P.ident.part || P.kw.part;
      else if (unitByPart.get(P.kw.part)) push(unitRow(unitByPart.get(P.kw.part), 880));
    }

    // 3. whole acts ("Securities Act", "'40 Act")
    if (P.actNamed && !P.ident && !P.words.length) {
      P.acts.forEach((id, i) => {
        const u = units.byKey.get(`act:${id}`);
        if (u) { push(unitRow(u, 900 - i)); u.children.forEach((c, j) => push(unitRow(c, 700 - i * 20 - j))); }
      });
    }

    // 4. citations
    // (a number typed after a popular name — "JOBS Act § 201" — is that act's
    // own section number, which the Code does not carry: the concepts answer it)
    if (P.formWord) formHits(P).forEach(push);
    else if (P.ident && !P.bundles.length) citationHits(P, restrictIds).forEach(push);

    // 5. keywords (and a Fuse pass to forgive typos)
    const wantWords = [...P.words];
    if (P.ident && !P.bundles.length && ![...out.values()].some(r => r.type === "provision" && r.score >= 100)) wantWords.push(P.ident.raw);
    const haveStrong = out.size >= 6;
    if (wantWords.length && !(P.actNamed && !P.words.length)) {
      keywordHits(wantWords, P.actNamed ? P.acts : null, limit).forEach(push);
      const f = getFuse();
      if (f && !haveStrong && out.size < 12) {
        f.search(wantWords.join(" "), { limit: 10 }).forEach((h, i) => {
          if (!P.actNamed || P.acts.includes(h.item.actId)) push({ type: "provision", id: h.item.id, score: 10 - i * 0.1 });
        });
      }
    }

    // A pinpoint citation ("12(a)(2)") wants the rows that HAVE the subsection:
    // candidates that lack it go, unless none has it (then the note stays).
    const found = [...out.values()];
    const anyHas = found.some(r => r.sub === "has");
    const sorted = (anyHas ? found.filter(r => r.sub !== "lacks") : found)
      .sort((a, b) => b.score - a.score).slice(0, limit);
    // say each explanation once ("Subsection (a)(2) is part of this section…")
    const said = new Set();
    for (const r of sorted) {
      for (const k of ["note", "why"]) {
        if (!r[k]) continue;
        if (said.has(r[k])) delete r[k]; else said.add(r[k]);
      }
    }
    return sorted;
  }

  // What to say when a query has no row at all ("" otherwise): a form item, or
  // a citation outside the collection (Title 18: SOX § 906 is 18 U.S.C. § 1350).
  function notice(query) {
    const q = String(query ?? "").trim();
    if (/\b(?:SOX|Sarbanes[-\s]?Oxley(?: Act)?)\s*(?:§|sec(?:tion|\.)?)?\s*906\b/i.test(q)) {
      return "Sarbanes-Oxley § 906 is codified in the criminal code at 18 U.S.C. § 1350, which this collection doesn’t include (it has 15 U.S.C. and 17 C.F.R.).";
    }
    if (/\b18\s*U\.?\s*S\.?\s*C\.?/i.test(q)) {
      return "Title 18 (crimes and criminal procedure) isn’t in this collection: it has 15 U.S.C. and 17 C.F.R.";
    }
    const fi = q ? formItem(parse(query)) : null;
    return fi && !fi.form
      ? `${formItemNote(fi)} Search “Form 8-K” for the rule that prescribes it.`
      : "";
  }

  return { search, parse, entries, notice };
}
