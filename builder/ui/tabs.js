// Mobile (<900px) panel switcher. Wires the .workspace-tabs buttons to
// show exactly one of #tree-col / #selected-col / #preview-col by setting
// body[data-panel]; all visibility rules live in app.css (the tab bar and
// the single-panel layout only apply below 900px — desktop shows all
// three columns regardless of data-panel).
const PANELS = ["tree", "selected", "preview"];

let buttons = [];

function setPanel(name) {
  if (!PANELS.includes(name)) name = "tree";
  document.body.dataset.panel = name;
  for (const btn of buttons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.panel === name));
  }
  // preview.js defers Paged.js renders while its panel is display:none
  // (Paged cannot lay out in a hidden container) and catches up on this
  window.dispatchEvent(new Event("ss:panelchange"));
}

export function init({ corpus, index, store } = {}) {
  const nav = document.querySelector(".workspace-tabs");
  if (!nav) return;
  buttons = [...nav.querySelectorAll(".tab[data-panel]")];
  nav.addEventListener("click", e => {
    const btn = e.target.closest(".tab[data-panel]");
    if (btn) setPanel(btn.dataset.panel);
  });
  setPanel("tree");
}
