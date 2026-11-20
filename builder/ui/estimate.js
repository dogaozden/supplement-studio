// "≈ 212 pages · US Letter" beside the Download button, live as the book grows;
// "212 pages · US Letter" (no ≈) once the preview has typeset the book and
// told us the real count (window event `ss:pdf`), until the next change.
// Also keeps the preview buttons honest: nothing to download until the book
// has something in it.
import { estimatePages } from "../pdf/engine.js";
import { fmt, plural } from "./dom.js";

export const TRIM_LABEL = { letter: "US Letter", "7x10": "7 × 10 in.", "6x9": "6 × 9 in." };

export function init({ corpus, index, store }) {
  const el = document.querySelector("#page-estimate");
  const generate = document.querySelector("#btn-generate");
  const reader = document.querySelector("#btn-export-reader");
  let timer = null;
  let real = null;   // the typeset page count for the current book, or null while it is pending

  const trimLabel = state => TRIM_LABEL[state.options?.trim] || TRIM_LABEL.letter;

  function update(state) {
    const n = state.selection.length;
    generate.disabled = n === 0;
    reader.disabled = n === 0;
    if (!n) { el.textContent = "Nothing selected yet"; el.title = ""; return; }
    if (real !== null) {
      el.textContent = `${plural(real, "page")} · ${trimLabel(state)}`;
      el.title = `${plural(real, "page")} for ${plural(n, "provision")}, as typeset.`;
      return;
    }
    const { pages } = estimatePages(state, { corpus, index });
    el.textContent = `≈ ${plural(pages, "page")} · ${trimLabel(state)}`;
    el.title = `About ${plural(pages, "page")} for ${plural(n, "provision")}. The exact count shows once the preview is typeset.`;
  }

  // any change makes the real count stale at once; the estimate stands in
  // until the preview finishes typesetting the new book
  store.subscribe(() => {
    real = null;
    clearTimeout(timer);
    timer = setTimeout(() => update(store.get()), 60);   // collapse bursts (Add all)
  });
  window.addEventListener("ss:pdf", e => {
    const pages = Number(e.detail?.pages);
    if (!Number.isFinite(pages) || pages < 1) return;
    clearTimeout(timer);   // a pending estimate would overwrite the real count
    real = pages;
    update(store.get());
  });
  update(store.get());
}
