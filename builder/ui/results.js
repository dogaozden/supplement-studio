// Search result rows, shared by the ⌘K palette and the first-run search box.
//
// Row anatomy (DESIGN.md: citation first, then the heading, then the source):
//   § 5 · 15 U.S.C. § 77e                          Securities Act      <- cite, source
//   Prohibitions relating to interstate commerce…                       <- heading
//   Subsection (a)(2) is part of this section…                          <- optional note
import { describe, scHtml } from "../labels.js";
import { escapeHtml, plural } from "./dom.js";

// "§ 5" -> the § in the accent colour
const lead = text => escapeHtml(text).replace(/^§/, '<span class="sec">§</span>');

// Words on a unit's button, given how much of it is already in the book.
export function unitCaption(unit, selSet) {
  const have = unit.ids.filter(id => selSet.has(id)).length;
  if (have === unit.ids.length) return { text: `All ${unit.ids.length} in your book`, done: true };
  if (have > 0) return { text: `Add remaining ${unit.ids.length - have}`, done: false };
  const noun = unit.noun === "rules" ? "rule" : unit.noun === "provisions" ? "provision" : "section";
  return { text: `Add all ${plural(unit.ids.length, noun)}`, done: false };
}

function unitRow(r, i, selSet, prefix, active) {
  const cap = unitCaption(r, selSet);
  const head = r.unitType === "group" ? r.desc || plural(r.count, "rule")
    : r.unitType === "bundle" ? r.desc
    : r.unitType === "act" ? `The whole act: ${plural(r.count, "section")}`
    : r.unitType === "part" ? `The whole part: ${plural(r.count, "rule")}`
    : `${plural(r.count, "section")}`;
  const cite = r.unitType === "act" || r.unitType === "bundle" ? r.label
    : r.unitType === "part" ? `${r.short} · ${r.label}` : r.short;
  const range = r.range && r.unitType !== "part" ? ` · ${escapeHtml(r.range)}` : "";
  return `<li id="${prefix}-opt-${i}" role="option" aria-selected="${i === active}" data-i="${i}" data-type="unit"
      class="result result-unit${i === active ? " active" : ""}${cap.done ? " in-book" : ""}">
    <div class="r-line"><span class="r-cite">${escapeHtml(cite)}<span class="r-alt">${range}</span></span>
      <span class="r-add${cap.done ? " done" : ""}">${escapeHtml(cap.text)}</span></div>
    <div class="r-heading">${escapeHtml(head)}</div>
  </li>`;
}

function provisionRow(r, i, index, selSet, prefix, active) {
  const d = describe(r.id, index);
  const inBook = selSet.has(r.id);
  const note = r.note || r.why || "";
  return `<li id="${prefix}-opt-${i}" role="option" aria-selected="${i === active}" data-i="${i}" data-type="provision"
      data-id="${escapeHtml(r.id)}"
      class="result${i === active ? " active" : ""}${inBook ? " in-book" : ""}">
    <div class="r-line"><span class="r-cite">${lead(d.lead)}${d.altMid ? `<span class="r-alt"> · ${escapeHtml(d.altMid)}</span>` : ""}</span>
      <span class="r-source">${inBook ? "In your book" : scHtml(d.sourceShort)}</span></div>
    <div class="r-heading">${escapeHtml(d.heading)}</div>
    ${d.tag ? `<div class="r-tag">${escapeHtml(d.tag)}</div>` : ""}
    ${note ?`<div class="r-note">${escapeHtml(note)}</div>` : ""}
  </li>`;
}

export function renderResults(listEl, results, { index, selSet, active = 0, prefix = "res" }) {
  listEl.innerHTML = results.map((r, i) =>
    r.type === "unit"
      ? unitRow(r, i, selSet, prefix, active)
      : provisionRow(r, i, index, selSet, prefix, active)).join("");
}

// Move the highlight without re-rendering; returns the new index.
export function setActive(listEl, results, next, inputEl) {
  const rows = listEl.querySelectorAll("li.result");
  if (!rows.length) return 0;
  const active = (next + rows.length) % rows.length;
  rows.forEach((el, i) => {
    el.classList.toggle("active", i === active);
    el.setAttribute("aria-selected", String(i === active));
  });
  inputEl?.setAttribute("aria-activedescendant", rows[active].id);
  rows[active].scrollIntoView({ block: "nearest" });
  return active;
}
