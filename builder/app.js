import { PRODUCT } from "./config.js";
import { store, defaultState, defaultOptions } from "./store.js";
import { indexCorpus, loadCorpus } from "./corpus.js";
import { decodeState, encodeState, makeNaming } from "./share.js";
import { coalesce } from "./model.js";
import { toast } from "./ui/topbar.js";

document.title = PRODUCT.name;
document.querySelector(".app-title").textContent = PRODUCT.name;

function setCorpusLoading(on) {
  const skeleton = document.querySelector("#corpus-loading");
  if (skeleton) skeleton.hidden = !on;
}

// Share-URL boot (lane 2A): a decodable location.hash wins over
// localStorage. Decoded selection/mode/options REPLACE the stored ones;
// metadata fields (and part titles) present in the hash merge over the
// DEFAULTS (absent fields reset to defaults, not to whatever was stored).
// Malformed hashes decode to null and fall back to localStorage untouched.
// The load is one undo step, so a recipient can get their own book back.
function applySharedState(naming) {
  const decoded = decodeState(location.hash, naming);
  if (!decoded) return false;
  // An empty-selection hash would wipe the recipient's stored work for
  // nothing — treat it like a malformed hash (the app's own hash sync
  // clears the fragment when the selection empties, so legitimate links
  // always carry ids).
  if (!Array.isArray(decoded.selection) || decoded.selection.length === 0) return false;
  const had = store.get().selection.length > 0;
  store.set(s => ({
    ...s,
    selection: [...decoded.selection],
    mode: decoded.mode,
    // v1 links carry no options: defaults, with the link's numbering/colophon
    options: {
      ...defaultOptions(), ...(decoded.options || {}),
      numbering: decoded.mode,
      colophon: decoded.options ? decoded.options.colophon : decoded.metadata?.includeColophon !== false,
    },
    metadata: { ...defaultState().metadata, ...(decoded.metadata || {}) },
  }), { label: "Opened a shared link" });
  toast("Loaded shared supplement", had
    ? { action: { label: "Undo", onClick: () => store.undo() } }
    : {});
  return true;
}

// Live hash sync: keep the fragment a shareable encoding of the current
// state (debounced; replaceState so history doesn't grow). An empty
// selection clears the fragment — decodeState("") is null, so reloading
// a hashless URL falls back to localStorage, keeping encode/decode
// symmetric from the app's point of view.
function initHashSync(corpusId, naming) {
  let timer = null;
  store.subscribe(state => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.selection.length === 0) {
        if (location.hash) {
          history.replaceState(null, "", location.pathname + location.search);
        }
        return;
      }
      const hash = encodeState(state, corpusId, naming);
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }, 300);
  });
}

async function main() {
  // the phone panel tabs work while the corpus is still downloading
  (await import("./ui/tabs.js")).init();
  setCorpusLoading(true);
  let corpus;
  try {
    corpus = await loadCorpus();
  } finally {
    setCorpusLoading(false);
  }
  const meta = corpus.meta || {};
  // A shared link names provisions by Act section and rule number, so it is
  // read once the corpus (its vocabulary) is here; it wins over localStorage.
  const naming = makeNaming(corpus);
  applySharedState(naming);
  document.querySelector("#supp-title").value = store.get().metadata.title;
  if (meta.label) document.title = `${PRODUCT.name} — ${meta.label}`;
  // Default-title backfill: the store default is empty (domain-agnostic).
  // Titles from a share hash (applied above — hash wins) or from
  // localStorage are non-empty and therefore left alone. Runs before the
  // UI modules init so ui/topbar.js shows it, and before initHashSync so
  // nothing is written into the fragment prematurely.
  if (!store.get().metadata.title && meta.defaultTitle) {
    store.set(s => ({ ...s, metadata: { ...s.metadata, title: meta.defaultTitle } }), { undo: false });
  }
  const index = indexCorpus(corpus);
  console.log("loaded corpus", {
    acts: corpus.acts.length,
    sections: corpus.acts.reduce((n, a) => n + a.sections.length, 0),
    rules: corpus.regulations.reduce((n, r) => n + r.rules.length, 0),
  });

  // Keep the stored book coalesced (one run per part): older saved states and
  // links from before parts were contiguous may interleave them.
  const tidy = coalesce(store.get().selection, index);
  if (tidy.some((id, i) => id !== store.get().selection[i])) {
    store.set(s => ({ ...s, selection: tidy }), { undo: false });
  }

  // Initialize UI modules. actions.js first (the others call into it), and
  // presets before firstrun (the first-run screen lists the templates).
  const modules = await Promise.all([
    import("./ui/actions.js"),
    import("./ui/presets.js"),
    import("./ui/tree.js"),
    import("./ui/selected.js"),
    import("./ui/topbar.js"),
    import("./ui/palette.js"),
    import("./ui/firstrun.js"),
    import("./ui/estimate.js"),
    import("./ui/preview.js"),
  ]);
  for (const mod of modules) mod.init({ corpus, index, store, naming });

  initHashSync(meta.id, naming);
  window.__naming = naming;

  // Readiness signal for tests and scripts (docs/contracts.md §4): set only
  // once every UI module is wired, so waiting for it means the UI is usable.
  window.__corpus = corpus;
  window.__index = index;
}

main().catch(e => {
  console.error(e);
  const detail = String(e).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  document.body.innerHTML = `
    <div class="load-error" role="alert">
      <div class="load-error-card">
        <h1>Couldn’t load the statute data</h1>
        <p>Something went wrong while fetching the corpus. Check your
           connection and reload the page — your selection is saved locally
           and will still be here.</p>
        <pre>${detail}</pre>
        <button id="load-error-reload" type="button" class="btn btn-primary">Reload page</button>
      </div>
    </div>`;
  document.querySelector("#load-error-reload")
    .addEventListener("click", () => location.reload());
});
