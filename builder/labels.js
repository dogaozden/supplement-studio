// How provisions are named on screen. Pure ESM, no DOM (node-tested).
//
// A provision is shown by its citation, in both numberings:
//   statute  "§ 5 · 15 U.S.C. § 77e"        (act section first, then the Code)
//   rule     "Rule 10b-5 · 17 C.F.R. § 240.10b-5"
//   item     "Item 404 · 17 C.F.R. § 229.404"
// Corpus fields used when present, with fallbacks when the corpus predates
// them (docs/contracts.md §8, docs/corpus-adapter.md):
//   rule.short_name / rule.common_name   -> else derived from the cite
//   regulation.display_title / .part     -> else derived from the PART heading

const SMALL_WORDS = new Set(["of", "and", "the", "for", "to", "in", "under", "on", "with", "or", "a", "an", "by", "at"]);
const KEEP_UPPER = /^(fd|s-[a-z]|sho|nms|ats|cfr|ii|iii|iv|sec|usc)$/i;

export function titleCase(s) {
  return String(s).toLowerCase().replace(/[a-z0-9()'’.-]+/g, (w, offset) => {
    if (KEEP_UPPER.test(w)) return w.toUpperCase();
    if (offset > 0 && SMALL_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

// "PART 230—GENERAL RULES AND REGULATIONS, SECURITIES ACT OF 1933"
//   -> "General Rules and Regulations, Securities Act of 1933"
export function regulationDisplayTitle(reg) {
  if (reg.short_title) return reg.short_title;          // curated (corpus config)
  const heading = reg.display_title || String(reg.heading || "").replace(/^PART\s+\d+[A-Z]?\s*[—–-]\s*/i, "");
  if (!heading) return reg.title || "Regulations";
  // "…—REGULATION S-K" style headings are best known by their regulation name
  const tail = heading.match(/[—–]\s*(REGULATION [A-Z0-9-]+)\s*$/i);
  if (tail) return titleCase(tail[1]);
  return reg.display_title || titleCase(heading);
}

export function regulationPart(reg) {
  if (reg.part != null && reg.part !== "") return String(reg.part);
  const m = String(reg.title || reg.id || "").match(/(\d+[A-Z]?)\s*$/i);
  return m ? m[1] : "";
}

// Parse a rule's cite into its C.F.R. part and section number.
//   "17 C.F.R. § 240.10b-5" -> { part: "240", num: "10b-5", section: "240.10b-5" }
// The corpus keeps a run of consecutive reserved sections as ONE entry whose
// cite is a range ("230.300-230.346", "240.10b-6 - 240.10b-8"); that comes
// back as { num: first number, section: "230.300–230.346", range: {first, last} }.
const RANGE_SPLIT = /\s*-\s*(?=\d+\.\d)/;
export function cfrParts(rule, meta) {
  const prefix = meta?.cfrCitePrefix ? `${meta.cfrCitePrefix} § ` : "17 C.F.R. § ";
  let rest = String(rule.cite || "");
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  else if (rest.includes("§")) rest = rest.replace(/^.*?§\s*/, "");
  else rest = String(rule.id || "").replace(/^r-/, "").replace("-", ".");
  const ends = rest.split(RANGE_SPLIT);
  const first = ends[0];
  const last = ends.length > 1 ? ends[ends.length - 1] : null;
  const dot = first.indexOf(".");
  return {
    part: dot > 0 ? first.slice(0, dot) : "",
    num: dot > 0 ? first.slice(dot + 1) : first,
    section: last ? `${first}–${last}` : first,
    range: last ? { first, last } : null,
  };
}

// A section the book cannot use: "[Reserved]" rules, repealed or omitted
// statute sections, anything with no text at all. They stay visible (greyed)
// in the browse tree but never enter search results, "Add all" or a template.
const RESERVED_HEADING = /^\[(?:removed(?: and reserved)?|reserved|omitted)\]\.?$/i;
export function isReserved(item) {
  if (!item) return false;
  if (RESERVED_HEADING.test(String(item.heading || "").trim())) return true;
  if (item.status && item.status !== "active") return true;
  return Array.isArray(item.content) && item.content.length === 0;
}

const RULE_PARTS = new Set(["230", "240", "270", "275"]);

// Short, human name of a rule: "Rule 10b-5", "Item 404", "Form 10-K".
// Returns "" when the rule has no natural name (it is then shown by its § cite).
export function ruleShortName(rule, meta) {
  if (rule.short_name) return rule.short_name;
  const { part, num, range } = cfrParts(rule, meta);
  if (range && RULE_PARTS.has(part)) {           // "Rules 203A-4–203A-6" (a run of sections)
    return `Rules ${num}–${range.last.replace(/^\d+\./, "")}`;
  }
  if (RULE_PARTS.has(part)) return `Rule ${num}`;
  if (part === "229") return `Item ${num}`;
  const form = String(rule.heading || "").match(/^((?:Form|Schedule)\s+[A-Za-z0-9-]+)\b/);
  if (form) return form[1];
  return "";
}

// Full common name ("Item 404 of Regulation S-K") when the corpus has it.
export function ruleCommonName(rule, meta) {
  return rule.common_name && !/\(.*\)\s*$/.test(rule.common_name)
    ? rule.common_name
    : ruleShortName(rule, meta);
}

// Rule headings arrive as "(Item 404) Transactions with…" or with a stray
// suffix letter ("A Private resales…" under 144A). Show the clean sentence.
export function cleanHeading(item, secNum = "") {
  let h = String(item.heading || "").trim();
  h = h.replace(/^\(Item [\w.]+\)\s*/i, "");
  const suffix = (String(secNum).match(/[A-Za-z]$/) || [])[0];
  if (suffix && new RegExp(`^${suffix}\\s+[A-Z]`).test(h)) h = h.slice(suffix.length).trim();
  // "(4)-8 Pooled investment vehicles" under § 275.206(4)-8: the heading
  // starts with the tail of the section number
  const tail = h.match(/^(\([\w]+\)(?:-[\w]+)?)\s+(\S.*)$/);
  if (tail && String(secNum).endsWith(tail[1])) h = tail[2];
  return h.replace(/\.$/, "");
}

// EB Garamond's small-cap digits read as letters ("SUBPART 229.IOO", "PART 1"),
// and CSS cannot switch them to lining figures. So any small-caps label that
// can hold a number goes through scHtml(): the text is escaped and each run of
// digits ("229.100", "16") wrapped in <span class="fig">, which app.css sets
// back to normal caps at a size that sits with the small capitals.
const escHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function scHtml(text) {
  const s = String(text ?? "");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/\d+(?:[.,]\d+)*/g)) {
    out += `${escHtml(s.slice(last, m.index))}<span class="fig">${m[0]}</span>`;
    last = m.index + m[0].length;
  }
  return out + escHtml(s.slice(last));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso || "";
}

// How current the text is, in the one phrase used everywhere: the studio's
// footer and the PDF cover. corpus.source carries usc_release_point
// ("119-134"), optionally usc_release_label ("Public Law 119-134 (October 20,
// 2026)"), and ecfr_date ("2026-10-29").
//   "Statutes current through Public Law 119-134 (October 20, 2026);
//    regulations current as of October 29, 2026."
// The PDF lane's currencyLine (pdf/document.js) wins when it exists
// (ui/topbar.js asks it first); this is the same sentence, built from the corpus.
export function currencyLine(corpus) {
  const src = corpus?.source || {};
  const rp = src.usc_release_point || "";
  const label = src.usc_release_label || (rp ? `Public Law ${rp}` : "");
  const parts = [];
  if (label) parts.push(`Statutes current through ${label}`);
  if (src.ecfr_date) parts.push(`${parts.length ? "regulations" : "Regulations"} current as of ${shortDate(src.ecfr_date)}`);
  return parts.length ? `${parts.join("; ")}.` : "";
}

// Parts 239 and 249 of the C.F.R. say which form to file and when; the form
// itself (its items and instructions) is not printed in the C.F.R.
export const FORMS_TAG = "Filing rule — the form itself is not in the C.F.R.";
// A Code section the Act's chapter holds but another statute enacted
// (15 U.S.C. § 77r–1, from SMMEA): no Act section number, and "Add all"
// for the Act leaves it out (units.js).
export const NOT_IN_ACT_TAG = "Not part of the Act";

const cache = new WeakMap();

function namedRegulation(id, index) {
  let sg = index.subjectGroupById?.get(index.ruleGroupById?.get(id));
  while (sg?.parent) sg = index.subjectGroupById.get(sg.parent);
  return sg && /^Regulation\s/.test(sg.short || "") ? sg.short : "";
}

// Everything the UI needs to show one provision.
// {
//   id, kind: "section" | "rule" | "missing",
//   lead      "§ 5" | "Rule 10b-5"           (bold, the navigation label)
//   altShort  "77e" | "240.10b-5"            (tree rows: the other numbering)
//   altMid    "15 U.S.C. § 77e" | "§ 240.10b-5"
//   altFull   "15 U.S.C. § 77e" | "17 C.F.R. § 240.10b-5"
//   cite      lead · altMid     (search rows)
//   fullCite  lead · altFull    (the book's outline)
//   heading, source, sourceShort, sourceKey, name (rules), part (rules)
//   reserved  true for "[Reserved]" / repealed / empty provisions
//   tag       a short honesty note ("" when none): the Part 239/249 sections
//             are filing rules, not the forms themselves
// }
export function describe(id, index) {
  const item = index.byId.get(id);
  if (!item) {
    return { id, kind: "missing", lead: id, altShort: "", altMid: "", altFull: "", cite: id,
      fullCite: id, heading: "No longer in the corpus", source: "", sourceShort: "", sourceKey: "other" };
  }
  if (cache.has(item)) return cache.get(item);
  const meta = index.corpus?.meta || {};
  let d;
  const act = index.actBySectionId.get(id);
  if (act) {
    const cod = item.codified || { num: id.replace(/^s-/, ""), cite: id };
    const orig = item.original && item.original.num ? item.original : null;
    const lead = orig && !/^\d/.test(orig.num) ? orig.num : `§ ${orig ? orig.num : cod.num}`;   // "Schedules A, B" carries no §
    d = {
      id, kind: "section",
      lead,
      altShort: orig ? cod.num : "",
      altMid: orig ? cod.cite : "",
      altFull: orig ? cod.cite : "",
      cite: orig ? `${lead} · ${cod.cite}` : cod.cite,
      fullCite: orig ? `${lead} · ${cod.cite}` : cod.cite,
      heading: cleanHeading(item),
      source: act.short_title,
      sourceShort: act.original_name_short || act.short_title,
      sourceKey: `act:${act.id}`,
      tag: orig ? "" : NOT_IN_ACT_TAG,
    };
  } else {
    const reg = index.regBySectionId.get(id);
    const { part, num, section, range } = cfrParts(item, meta);
    const name = ruleShortName(item, meta);
    const secCite = `${range ? "§§" : "§"} ${section}`;
    const full = item.cite || secCite;
    const lead = name || secCite;
    d = {
      id, kind: "rule",
      lead,
      altShort: name ? section : "",
      altMid: name ? secCite : "",
      altFull: name ? full : "",
      cite: name ? `${lead} · ${secCite}` : full,
      fullCite: name ? `${lead} · ${full}` : full,
      heading: cleanHeading(item, num),
      source: reg ? `${meta.cfrCitePrefix || "17 C.F.R."} Part ${part}` : "",
      // a rule inside a named regulation is known by it ("Regulation D"), else by its part
      sourceShort: namedRegulation(id, index)
        || (reg && /^Regulation\s\S+$/.test(regulationDisplayTitle(reg)) ? regulationDisplayTitle(reg) : "")
        || (part ? `Part ${part}` : ""),
      sourceKey: reg ? `reg:${reg.id}` : "other",
      name, part,
      tag: reg && /\bforms?\b/i.test(regulationDisplayTitle(reg)) && !/^Regulation/i.test(regulationDisplayTitle(reg)) ? FORMS_TAG : "",
    };
  }
  d.reserved = isReserved(item);
  if (!d.tag) d.tag = "";
  cache.set(item, d);
  return d;
}
