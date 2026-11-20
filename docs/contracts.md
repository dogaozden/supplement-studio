# Supplement Studio — cross-lane contracts

Frozen interfaces for the Phase-1 lanes of `docs/supplement-studio-plan.md`.
A lane may **read** anything but may only **write** files it owns (table at
the bottom). Changing a contract requires editing this file in the same
commit and checking every consumer listed.

## 1 · Product identity

`builder/config.js` exports `PRODUCT = { name, tagline, repoUrl }`.
`repoUrl` is empty until a public URL exists; every consumer must print
nothing (no dangling link) when it is empty.
Every user-visible product string (app title, landing hero, PDF imprint,
reader colophon) must read it. The static `<title>` in `builder/index.html`
and `site/index.html` are the only permitted hardcoded fallbacks (boot JS
overwrites the app one).

## 2 · Design tokens

`builder/theme.css` is the single token source (light-academic palette,
type scale, focus ring, reduced-motion). `app.css` and `site/site.css`
must not introduce raw hex colors — use the variables. The annotation hue
tokens (`--hi-*`) mirror the reader palette and must stay in sync with
`builder/reader/template/reader.css`.

## 3 · index.html stubs (who un-hides what)

Stubbed in Phase 0 with the `hidden` attribute; the owning lane removes
`hidden` when it wires behavior. Nobody else touches these nodes.

| node | wired by |
|---|---|
| `#btn-share` (topbar) | 2A |
| `#btn-export-reader` (preview head) | 2B |
| `.workspace-tabs` + `#corpus-loading` skeleton | 1A (`ui/tabs.js`, app.js load states) |
| `#confirm-modal`, `#preset-save-modal` dialogs | 1A (`ui/presets.js` rewiring) |

## 4 · Selector stability (e2e contract)

`builder/tests/e2e/test_pdf_render.py` and the future suites depend on
these — never rename them:

`#btn-presets` (label "Templates"), `.preset-card`, `.preset-card .name`,
`#btn-generate` ("Download PDF"), `#supp-title`, `#toggle-original`,
`window.__corpus`.

New stable ids introduced by this plan: `#btn-share`, `#btn-export-reader`,
`.workspace-tabs .tab[data-panel]`, `#confirm-modal`, `#preset-save-modal`,
`#corpus-loading`.

Studio rebuild (Phase B) changes and additions:

- `#toggle-original` is now the "Original act numbering first" **radio**
  (its sibling `#toggle-codified`) inside the Cover & settings dialog
  (`#btn-metadata` opens `#metadata-modal`; `#metadata-form`, with fields
  `title`, `subtitle`, `course`, `term`, `professor`, `school`, `trim`,
  `numbering`, `sourceCredits`, `includeColophon`). Every control there
  applies at once; the submit button reads "Done" and only closes. Tests
  open the dialog first, then `check("#toggle-original")`.
- `#preview-col` = `.col-head` (`#page-estimate`, `#btn-export-reader`,
  `#btn-generate`), `#first-run` (shown while the book is empty), and
  `#preview-pane` (PDF lane). While the selection is empty `#preview-pane`
  is hidden and `body[data-empty="true"]`.
- `#btn-share` ("Copy link") copies the link, flashes "Copied" and opens
  `#share-pop`. `#btn-undo`, `#btn-redo`, `#btn-more` (menu `#more-menu`:
  `#btn-export-json`, `#btn-import-json`, `#btn-save-preset`,
  `#btn-sort-all`, `#btn-help`), `#btn-clear`, `#selected-count` (the plain
  number of provisions), `#tree-filter`, `#palette` / `#palette-input`.
- Outline: `#selected .part[data-key]` (key = `act:<id>` | `reg:<id>`),
  `.part-title` (a textarea; change commits the rename), `.item[data-id]`.
  Tree: `#tree .unit[data-key]` with `.unit-action` ("Add all"), `.tree-item`.
- Templates keep the e2e hooks above; the first-run template rows are
  `.fr-template`, never `.preset-card`.
- `window.__corpus` (and `window.__index`) are set **after** every UI module
  is wired, so waiting for them means the UI is ready. The PDF lane's hooks
  (`window.__pdfReady`, `window.__pdfPages`, `window.__pdfError`) replace
  `__printReady` / `__printError`.

## 5 · Share-hash grammar (lane 1C ↔ 2A)

A link names the book the way lawyers read it, Act sections and rule numbers:

```
#v=3&c=securities&b=SecuritiesAct:2,5,11,12;ExchangeAct:10,16;Part230:144,506;Part240:10b-5
  [&n=code][&t=<title>&st=…&co=…&te=…&pr=…&sc=…][&g=<partKey>=<title>]…[&tr=7x10|6x9][&cr=0][&col=0]
```

The encoder writes `v=3`. The decoder also reads `v=1` and `v=2` (corpus ids
in `s`, `m=o` for Act numbering, U.S. Code numbering when `m` is absent). Any
other version, a missing `v`/`c`/book, a bad escape or a bad option value
decodes to `null` and the studio keeps its stored book.

- `b` — the book in the user's order: runs of `<group>:<token>,<token>,…`
  joined by `;`. `makeNaming(corpus)` (`builder/share.js`) is the vocabulary:
  - `<share_key>:<Act section>` for a Code section an Act section enacted;
    `share_key` is a permanent per-act field set in the corpus config
    (`SecuritiesAct`, `ExchangeAct`, `SOX`, `InvestmentCompanyAct`,
    `InvestmentAdvisersAct`, `TrustIndentureAct`, `SIPA`, `ForeignBondholdersAct`);
  - `USC:<section>` for a Code section no Act section enacted (`USC:77r-1`);
  - `Part<nnn>:<section number>` for a C.F.R. section (`Part240:10b-5`);
  - `id:<corpus id>` for anything else (en-dash as `~`).
  Tokens use `[0-9A-Za-z().-]`, en-dashes written as hyphens. A name two
  provisions would share is never used; both fall back to `id:`. A token the
  corpus no longer has decodes to the id `missing:<group>:<token>`, which the
  studio lists as not in the corpus.
- `n` — numbering: absent = Act sections first (a new book), `code` = U.S. Code
  sections first.
- `g` — one custom part title per param: `<partKey>=<title>` (`act:<actId>` or
  `reg:<regulationId>`, en-dash as `~`; split at the first `=`).
- `tr` trim (`7x10`, `6x9`; absent = US Letter), `cr=0` no source credits,
  `col=0` no colophon, `t`/`st`/`co`/`te`/`pr`/`sc` cover fields. Absent means
  a new book's value, so every setting that differs must travel in the link.

The encoder relaxes `%2C %3A %3B %7E %28 %29` back to `, : ; ~ ( )` (all legal
in a fragment) so links stay readable. Because a link needs the corpus to be
read, the studio decodes it after the corpus loads, before the UI starts.

API (`builder/share.js`, pure ESM, no DOM): `makeNaming(corpus)`,
`encodeState(state, corpusId, naming) -> "#…"`, `decodeState(hash, naming) -> state|null`.

Store state (`builder/store.js`): `state.options = {trim, numbering:
"original"|"codified", sourceCredits, colophon}`; `state.mode` mirrors
`options.numbering`, `metadata.includeColophon` mirrors `options.colophon`.

## 6 · Reader manifest schema (lane 1E ↔ 2B)

Mirrors `pipeline/manifest_secreg.json`:

```jsonc
{
  "name": "securities-my-supplement",   // keys reader localStorage
  "title": "…", "subtitle": "…", "edition": "…",
  "groups": [{
    "label": "…", "sublabel": "…", "kind": "usc" | "cfr",
    "items": [
      {"corpus_id": "s-77a", "old_id": "", "display": "§ 1"},
      {"subhead": "Regulation C"}          // optional divider rows
    ]
  }],
  "unmapped_legacy_ids": []
}
```

`name` determines the reader's localStorage key — exporting the same
titled supplement twice shares annotations and re-anchors them.

## 7 · Renderer parity (lane 1E — the load-bearing contract)

`builder/reader/render-section.js` must produce **byte-identical** output
to `pipeline/build_reader.py`'s `build_provision()` for every provision:
the section HTML string and the `texts` array (annotation anchor text).
Enforced by `builder/tests/test_reader_parity.py` (secreg manifest by
default, `PARITY_FULL=1` = entire corpus). Notable Python behaviors the
port must mirror exactly:

- `html.escape(s, quote=False)` — `& < >` only, **not** quotes; but the
  `href`/`data-to` attribute values use `quote=True`.
- `XREF_RE` and `CODIFIED_REF_RE` use the **en-dash** `–` in ids.
- heading gets a `.` suffix; `continuation` renders at `depth - 1`;
  depth clamps at `MAX_DEPTH = 6`; tables pass `html` through and emit
  no anchor text.
- `build_provision` joins body paragraphs with `"\n"` — that newline is a
  DOM text node and part of the anchoring contract. Never change it.
- **Run-in heads.** A numbered/headed division with no words of its own whose
  first child is a chapeau (or an unroled `p`) is emitted as
  `<div class="ri dN"><p class="t dN">(a) <span class="nh">Definitions.</span> </p>\n<p class="t dN+1">When used…</p></div>`.
  The wrapper is tags only: the same two `<p>`s, the same `"\n"` text node,
  the same `texts` entries. The reader CSS sets the pair inline, so it reads
  "(a) *Definitions.* When used…" with a hanging indent, as the PDF does
  (`builder/pdf/document.js` runs a leading chapeau in the same way). Both
  renderers must apply the same rule; `test_reader_parity.py` covers it.

## 8 · Corpus `meta` schema (lane 1F ↔ 2C)

`build_corpus.py` emits a `meta` object into `corpus.json` (payload —
`acts`/`regulations` — stays byte-identical):

```jsonc
"meta": {
  "id": "securities",
  "label": "Federal Securities Laws",
  "defaultTitle": "Federal Securities Laws — Statutory Supplement",
  "uscCitePrefix": "15 U.S.C.",
  "cfrCitePrefix": "17 C.F.R.",
  "modes": {"codified": "Codified (U.S.C.)", "original": "Original acts"}
}
```

`builder/corpora.json` is the runtime registry:
`{"version": 1, "default": "securities", "corpora": [{"id", "label", "path"}]}`.
2C consumes `meta` with a fallback shim (corpus files predating `meta`).
Corpus/provision **ids are permanent** — share URLs and annotation
re-anchoring depend on them; an adapter may add ids, never rename.

## 9 · Reader template location

`builder/reader/template/{shell.html,reader.css,reader.js}` — moved from
`pipeline/template` in Phase 0. Both `pipeline/build_reader.py`
(TEMPLATE_DIR) and the client-side exporter (2B, fetch + cache) read it.
Placeholder contract in shell.html: `/*__CSS__*/`, `__TITLE__`,
`__DOC_META__`, `__TOC__`, `__SEED__`, `__ORPHANS__`, `__CONTENT__`,
`//__JS__` — replaced in exactly that order (see build_reader.py main()).

## 10 · Per-lane file ownership (Phase 1, historical)

Phase 1's 1D lane (Paged.js print path) is retired; its files are deleted
and §11 replaces it.

| lane | owns (writes) |
|---|---|
| 1A | `builder/app.css` (rewrite), `builder/index.html` styling/un-hiding, `builder/ui/*.js` presentation, `builder/ui/tabs.js` (new), `builder/app.js` load states, `builder/assets/vendor/axe.min.js` (vendor) |
| 1B | `site/index.html`, `site/site.css`, `site/assets/` (incl. `site/assets/theme.css`, a build-refreshed copy of `builder/theme.css`) |
| 1C | `builder/share.js`, `builder/tests/node/share_roundtrip.mjs`, `builder/tests/test_share_codec.py` |
| 1D | `builder/pdf/{paged.css,template.js,composer.js}`, `builder/print.html`, `builder/print.js` |
| 1E | `builder/reader/render-section.js`, `builder/tests/node/dump_render.mjs`, `builder/tests/test_reader_parity.py`, additive `--dump-render` in `pipeline/build_reader.py` |
| 1F | `builder/build/*.py`, `builder/build/corpora/securities.json`, `builder/corpora.json`, `builder/corpus.json` (regen), `docs/corpus-adapter.md`, new tests under `builder/tests/` (corpus-config only) + corpus-build golden fixtures (`builder/tests/fixtures/expected_corpus.json` meta block) |


Shared read-only for all lanes: `theme.css`, `config.js`, `corpus.json`
payload, this file.

## 11 · PDF engine (Phase B; replaces the Paged.js print path)

- **Pipeline.** `builder/pdf/document.js` `buildDocument(state, {corpus, index}, opts)`
  → typesetting document (JSON; shape documented at the top of
  `document.js`) → `builder/pdf/supplement.typ` (reads `/data.json`) →
  Typst. `document.js` owns every editorial decision (parts, numbering
  mode, anchors, link targets, Table of Sections, currency/colophon lines);
  the template never interprets legal text. Change the shape on both sides
  in one commit; `builder/tests/node/document.test.mjs` and
  `builder/tests/test_pdf_typst.py` guard it.
- **Typst version.** The browser compiler is typst.ts 0.7.0 bundling
  **Typst 0.14.2**, vendored under `builder/assets/vendor/typst-0.14.2/`
  (wasm gzipped; versioned directory because `/app/assets/vendor/*` is
  cached immutable). The CLI used by `scripts/pdf/build_pdf.mjs` and the
  tests must be 0.14.x. Upgrading = new vendor dir + matching CLI + rerun
  the PDF tests.
- **API** (`builder/pdf/engine.js`): `estimatePages(state, ctx) → {pages,
  words}`, `generatePdf(state, ctx, {onStage}) → {bytes, pages, provPages,
  ms, filename, doc}`, `warmEngine()`, `isBigBook()`. Compiles run in a
  module worker (`typst-worker.js` → `typst-core.js`); a worker stack
  overflow on very long books retries on the main thread.
- **Labels.** Provision label = corpus id (`s-77e`, `r-240-10b-5`);
  subdivision anchors = id + `/` + the numbers (`s-77e/b/1`,
  `r-230-502/a`); first occurrence wins when the enacted text repeats a
  number. Part labels `part-N`. Internal links only target labels that
  exist in the book; anything else links to the official text: govinfo.gov's
  U.S. Code link service (`/link/uscode/{title}/{section}`; uscode.house.gov's
  old `view.xhtml` links 404) and `ecfr.gov/current/…` down to the paragraph.
- **Checks.** `builder/tests/pdf_checks.py`: `check_book(pdf)` (no document
  JSON needed: folios against `/PageLabels`, recto part openers, blank pages
  only before openers, no overprinted words, no ".—.", no designator broken
  at its hyphen, no one-word line in a part title, an even body rhythm) and
  `check_pdf(pdf, doc, provPages)` (that, plus tagging, fonts, bookmarks,
  contents links, cross-references landing on their provision, official
  external links). Run by the Typst CLI test, the browser e2e,
  `scripts/gen_samples.py`, and `test_sample_pdf.py` on the committed
  landing sample.
- **Hooks** (`builder/ui/preview.js`): `window.__pdfReady`,
  `__pdfPages`, `__pdfError`, `__pdfBytes`, `__pdfDoc`, `__pdfProvPages`;
  `.pdf-page` per drawn page; dispatch `ss:goto` `{detail: {id}}` to scroll
  the preview to a provision; the preview emits `ss:pdf` after each build.
