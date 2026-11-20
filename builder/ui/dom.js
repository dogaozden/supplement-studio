// Small DOM helpers shared by the studio's UI modules.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Escape, and keep hyphenated names ("S-X", "10b-5") from breaking at the hyphen.
export function nb(s) {
  return escapeHtml(s).replace(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g, m => `<span class="nb">${m}</span>`);
}

export const fmt = n => Number(n).toLocaleString("en-US");

export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

// 1.5px line glyphs (DESIGN.md: never emoji). Each takes no arguments and
// returns an inline SVG string that inherits currentColor.
const svg = (d, w = 14) =>
  `<svg class="glyph" width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const glyph = {
  caret: svg('<path d="M6 4l4 4-4 4"/>', 12),
  up: svg('<path d="M4 10l4-4 4 4"/>'),
  down: svg('<path d="M4 6l4 4 4-4"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  grip: svg('<path d="M6 4v0M6 8v0M6 12v0M10 4v0M10 8v0M10 12v0" stroke-width="2.2"/>'),
};

// True while the user is typing text (so ⌘Z means "undo my typing").
export function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type);
}
