// App toast. aria-live polite, auto-dismiss; enter/leave motion is CSS-only,
// so theme.css's reduced-motion rule neutralizes it.
//
//   toast("Saved")
//   toast("Removed Part 230", { action: { label: "Undo", onClick: () => store.undo() } })
//
// Re-exported by ui/topbar.js (ui/preview.js imports `toast` from there).
const TOAST_MS = 4000;
const TOAST_ACTION_MS = 8000;

function region() {
  let el = document.querySelector("#app-toasts");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toasts";
    el.className = "toasts";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export function toast(message, { action = null, duration } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  const text = document.createElement("span");
  text.className = "toast-text";
  // every toast reads as a sentence: one closing period unless it already ends in punctuation
  text.textContent = /[.!?…:]["”’)]?$/.test(message) ? message : `${message}.`;
  el.appendChild(text);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300);
  };

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { action.onClick(); dismiss(); });
    el.appendChild(btn);
  }
  // one message at a time: a new one replaces what is still on screen, so
  // repeated Undo/Redo doesn't pile up a stack
  for (const old of region().querySelectorAll(".toast:not(.leaving)")) old.remove();
  region().appendChild(el);
  timer = setTimeout(dismiss, duration ?? (action ? TOAST_ACTION_MS : TOAST_MS));
  return { dismiss };
}
