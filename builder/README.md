# Supplement Studio — builder app

Static web app for composing custom statutory supplements: pick
provisions, generate a print-quality PDF, export an offline annotatable
reader, share the whole setup by URL. Securities corpus today;
multi-domain by design (see `docs/corpus-adapter.md`).

Product identity lives in `config.js` (PRODUCT); design tokens in
`theme.css`; cross-module interfaces in `../docs/contracts.md`.

## Quick start (local)

```bash
# 1. Install Python deps + browsers (one-time)
cd builder
python3 -m venv .venv && source .venv/bin/activate
pip install -r build/requirements-dev.txt
python -m playwright install chromium

# 2. Refresh the corpus (optional — a committed corpus.json is shipped)
python -m builder.build.build_corpus --ecfr-date $(date -I)

# 3. Serve the picker
cd .. && python3 -m http.server 8765
open http://localhost:8765/builder/
```

## How it works

- **Data pipeline (Python, infrequent):** `build/build_corpus.py
  --config build/corpora/securities.json` parses USLM XML
  (`../uscode_xml/usc15.xml`) and fetches 17 CFR from the eCFR
  Versioner API, emitting `corpus.json` (incl. a `meta` block the UI
  reads its labels from). `corpora.json` is the runtime registry;
  `?corpus=` picks an entry.
- **Runtime (static):** `index.html` + `app.js` load the corpus, wire the
  studio UI (see "The studio" below) around the PDF preview, and keep the
  URL fragment a shareable encoding of the current state (`share.js` —
  grammar in `../docs/contracts.md` §5).
- **PDF:** `pdf/document.js` turns the selection into a typesetting
  document (parts, both numberings, subsection anchors, cross-references
  resolved to in-book links or official-source links, Table of Sections);
  `pdf/supplement.typ` lays it out; Typst 0.14.2 compiled to WebAssembly
  (`assets/vendor/typst-0.14.2/`, run by `pdf/typst-core.js` in
  `pdf/typst-worker.js`, main-thread fallback for very long books)
  produces the PDF in the browser. `ui/preview.js` re-typesets on every
  change and draws the real pages with pdf.js; "Download PDF" saves the
  file (no print dialog). The same template and document builder run from
  the CLI: `node ../scripts/pdf/build_pdf.mjs` (needs Typst 0.14.x).
- **Reader export:** `reader/reader-export.js` assembles a manifest
  from the selection and renders a single-file offline annotatable
  reader entirely client-side via `reader/render-section.js` — a JS
  port of `../pipeline/build_reader.py` kept **byte-identical** by
  `tests/test_reader_parity.py` (`PARITY_FULL=1` covers the whole
  corpus). The shared template lives at `reader/template/`.
  Re-exporting with the same supplement title keeps annotations
  (localStorage key = corpus id + slugified title).

## The studio (what the professor sees)

- **First run** (`ui/firstrun.js`): while the book is empty, one screen
  explains the three steps, offers templates, and has a citation search box.
- **Browse** (`ui/tree.js`, `units.js`): Act → division → sections and
  C.F.R. Part → subject group (Regulation D…) → rules. Every act, division,
  part and group has "Add all" / "Remove all" with a tri-state box and a
  count. Adding a whole act keeps it contiguous and in Code order.
- **Your book** (`ui/selected.js`, `model.js`): the selection grouped into
  parts. Each part has an editable title (stored in
  `state.metadata.groupTitles`), a page estimate, "Sort into Code order",
  and moves or goes as a whole. Items reorder by drag or arrows.
- **Search** (`search.js`, `search-aliases.js`, `ui/palette.js`): a citation
  parser runs before fuzzy matching ("Rule 10b-5", "§ 77e", "Securities Act
  § 5", "Reg D", "SOX 302", "accredited investor"). Node-tested in
  `tests/node/search.test.mjs`.
- **Undo/redo** (`store.js`): every change to the selection, part titles,
  options and cover is one undoable step (⌘Z / ⇧⌘Z, capped at 100);
  destructive actions offer Undo in a toast instead of a confirm dialog.
- **Cover & settings**, **Templates** (`presets/*.json`, ids the corpus lacks
  are skipped), **Copy link** (share grammar v2, `../docs/contracts.md` §5).

State (`store.js`): `selection` (flat ordered ids), `metadata` (cover fields +
`groupTitles`), `options` `{trim, numbering, sourceCredits, colophon}`;
`mode` and `metadata.includeColophon` mirror `options.numbering` / `.colophon`.

Corpus fields the UI reads when present, with fallbacks when absent:
`regulation.groups`/`rule.group`, `regulation.display_title`/`.part`,
`act.divisions`/`.usc_range`/`.original_name_short`, `rule.common_name`/
`.short_name`, `source.usc_release_label`.

## Keyboard shortcuts

All shortcuts have a visible button or inline hint. See **More → Keyboard
shortcuts** in the app.

- `⌘K` / `Ctrl-K` — open search (same as the Search button)
- `↑` / `↓` / `Enter` / `Shift+Enter` / `Esc` — move, add, add and close, close
- `⌘Z` / `⇧⌘Z` (`Ctrl` on Windows and Linux) — undo / redo

## Tests

```bash
pytest builder/tests -v -m "not e2e"   # unit + codec + renderer parity
pytest builder/tests/e2e -v            # browser suites: PDF render, share
                                       # URL, reader export, visual goldens
                                       # (REGEN_GOLDENS=1), mobile layout
node builder/tests/node/share_roundtrip.mjs   # codec suite directly
node builder/tests/node/search.test.mjs       # citation search (also: model, store, presets)
E2E_PORT=8772 pytest builder/tests/e2e/test_share_url.py -m e2e   # a second checkout beside port 8765
```

## Data sources

- **U.S. Code Title 15:** `uscode.house.gov` — USLM XML. Fetched by the `refresh-corpus` GitHub Action at each new release point.
- **17 C.F.R. parts 210/229/230/240/243/249/270/275:** `ecfr.gov/api/versioner/v1` — XML. Fetched by the same action.

Corpus is committed to the repo so the app is fully offline-capable.

## Auto-update

`.github/workflows/refresh-corpus.yml` runs weekly; if USC or eCFR has
advanced, it rebuilds the corpus, re-runs full renderer parity and the
deploy packaging, and opens a PR labeled `corpus-refresh`. Review and
merge (apply the `run-e2e` label for a full browser run).

## Deploying the site

`python3 scripts/build_site.py` (repo root, stdlib-only) assembles the
deployable tree — landing page at `/`, this app at `/app/` with a
minified corpus. See `docs/deploy.md` for Cloudflare Pages setup and
sample regeneration (`scripts/gen_samples.py`).

## Structure

See `docs/superpowers/specs/2026-04-14-statutory-supplement-builder-design.md` for the original design and `docs/supplement-studio-plan.md` for the Supplement Studio build-out plan.
