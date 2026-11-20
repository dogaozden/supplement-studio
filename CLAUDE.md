# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Supplement Studio** is a free, static website where a law professor builds their own statutory supplement from
official public sources and downloads a book-quality PDF ("Your students shouldn't pay $250 for public law").
Securities regulation (15 U.S.C. + 17 C.F.R.) is the flagship course. The professor flow and the PDF are the product;
everything else is secondary.

**The product (primary):**
- `site/` — the landing page, the single entry point; leads into the studio.
- `builder/` — the studio (deployed at `/app/`): browse tree with one-click acts/parts/regulations (`ui/tree.js`,
  `units.js`), citation-aware search (`search.js`, `search-aliases.js`), the book outline with part titles, drag,
  undo (`ui/selected.js`, `store.js`, `model.js`), cover & settings, share links (`share.js`, grammar v2), and the
  PDF engine (`pdf/`): `document.js` builds the typesetting document, `supplement.typ` lays it out, Typst 0.14.2
  compiled to WebAssembly (`assets/vendor/typst-0.14.2/`, run by `typst-core.js` in `typst-worker.js`) produces the
  PDF, and `ui/preview.js` shows it with pdf.js and downloads it.
- `builder/build/` — the data pipeline: USLM XML (uscode.house.gov) + eCFR Versioner API → `builder/corpus.json`,
  `check_releases.py` (weekly Action), `verify_corpus.py` → `builder/verify_report.json` (every provision re-derived
  from the source and compared word for word).
- `scripts/` — `build_site.py` (Cloudflare Pages packaging → `deploy/`), `gen_samples.py` (committed samples +
  landing hero images), `pdf/build_pdf.mjs` (same engine from the CLI), `demo/` (demo screenshots + recording).

**Secondary (keep working, don't expand):**
- `builder/reader/` — the student reader export (single offline HTML with highlights/notes).
- `pipeline/` — the Python reader generator (`build_reader.py`) and its manifests; the reference renderer the JS port
  in `builder/reader/` is checked against.

Cross-module interfaces are FROZEN in `docs/contracts.md` — read it before touching share.js, the PDF document shape
(§11), the reader template, corpus meta, or any e2e selector. `AGENTS.md` mirrors this file — update both together.

## Critical invariants

- **Official text:** `verify_corpus.py` must report 0 non-whitespace mismatches; the corpus build keeps notes,
  instructions, footnotes and tables. Never paraphrase or "clean up" statutory text in the PDF path.
- **Corpus/provision ids are permanent** — share URLs, PDF anchors and annotation re-anchoring depend on them
  (`docs/corpus-adapter.md`).
- **PDF engine version:** browser Typst (typst.ts bundle) and the CLI used by tests must both be 0.14.x; vendor dirs
  are versioned because `/app/assets/vendor/*` is cached immutable (`docs/contracts.md` §11).
- **Renderer parity:** `builder/reader/render-section.js` must stay byte-identical to `pipeline/build_reader.py`'s
  renderer — `builder/tests/test_reader_parity.py` (`PARITY_FULL=1`: every provision).
- **Offline/private:** generated readers make zero network requests; the PDF engine compiles without network (fonts
  and compiler are self-hosted). Only `site/` and `builder/` go into `deploy/`.

## Development

- **Setup:** `uv venv builder/.venv --python 3.11 && uv pip install --python builder/.venv/bin/python3 -r
  builder/build/requirements-dev.txt && builder/.venv/bin/python3 -m playwright install chromium`. For the PDF CLI
  and its tests, a Typst 0.14.x binary as `TYPST_BIN` (CI downloads 0.14.2).
- **Studio:** `python3 -m http.server 8765` at the repo root, open `/builder/`.
- **Tests:** `builder/.venv/bin/python3 -m pytest builder/tests -m "not e2e"` (fast: corpus, verification, search,
  model, share, document builder, PDF structure via Typst CLI) and `-m e2e` (browser: studio → template → Download
  PDF with link/bookmark checks, share links, reader export, mobile, visual goldens; `REGEN_GOLDENS=1`).
  Pipeline: `pipeline/smoke_test.py`.
- **Deploy preview:** `python3 scripts/build_site.py && python3 -m http.server -d deploy` (`--out DIR` to package
  elsewhere).
- **Samples:** `site/samples/*` and `site/assets/hero-detail.png` are committed artifacts — regenerate with
  `builder/.venv/bin/python3 scripts/gen_samples.py` after any corpus / PDF / reader-template change. The script
  runs `pdf_checks.check_book` on the sample PDF, and `test_sample_pdf.py` re-checks the committed file.
- **CI:** `test.yml` (fast suite + Typst CLI, every push), `e2e.yml` (weekly + `run-e2e`/`corpus-refresh` labels,
  `PARITY_FULL=1`), `refresh-corpus.yml` (weekly USC/eCFR release check → rebuild + verify → auto-PR).
