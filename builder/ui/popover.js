// Tiny popover/menu behaviour: a trigger button toggles a panel that closes
// on Esc, on an outside click, or when another popover opens. The panel is a
// sibling of the trigger inside a `.pop-anchor` (CSS positions it).
const all = new Set();

export function closeAll(except = null) {
  for (const p of all) if (p !== except) p.close();
}

// onTrigger(api): replaces the default "click toggles" (the share button
// copies the link first, then opens).
export function popover(trigger, panel, { onOpen, onTrigger } = {}) {
  const api = {
    get isOpen() { return !panel.hidden; },
    open() {
      closeAll(api);
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      onOpen?.();
    },
    close() {
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    },
    toggle() { api.isOpen ? api.close() : api.open(); },
  };
  all.add(api);
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", e => {
    e.stopPropagation();
    if (onTrigger) onTrigger(api); else api.toggle();
  });
  panel.addEventListener("click", e => e.stopPropagation());
  panel.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); api.close(); trigger.focus(); }
  });
  return api;
}

document.addEventListener("click", () => closeAll());
document.addEventListener("keydown", e => { if (e.key === "Escape") closeAll(); });
