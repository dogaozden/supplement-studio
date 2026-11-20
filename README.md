# Supplement Studio

A static website for building a custom statutory supplement from official public sources and
downloading it as a print-ready PDF. Securities regulation (15 U.S.C. and 17 C.F.R.) is the first
corpus.

Pick provisions by citation or common name ("Rule 10b-5", "Securities Act § 5", "Reg D"), add whole
acts, parts or regulations, arrange and title the parts, fill in the cover, and download. The PDF is
typeset in the browser by [Typst](https://typst.app) compiled to WebAssembly: clickable contents,
bookmarks, live cross-references, running heads and a table of sections. A share link encodes only
the outline, and the studio can also export an offline annotatable HTML reader. Everything runs in
the browser; nothing is uploaded.

Every provision in `builder/corpus.json` is checked word for word against the source XML from
uscode.house.gov and ecfr.gov when the data is built (`builder/verify_report.json`).

## Run it

| what | command |
|---|---|
| setup | `uv venv builder/.venv --python 3.11 && uv pip install --python builder/.venv/bin/python3 -r builder/build/requirements-dev.txt && builder/.venv/bin/python3 -m playwright install chromium` |
| studio locally | `python3 -m http.server 8765`, then open <http://localhost:8765/builder/> |
| deployable static site | `python3 scripts/build_site.py` (writes `deploy/`: landing at `/`, studio at `/app/`), preview with `python3 -m http.server -d deploy` |
| fast tests | `builder/.venv/bin/python3 -m pytest builder/tests -m "not e2e"` (set `TYPST_BIN` to a Typst 0.14.x binary to include the PDF structure tests) |
| browser tests | `builder/.venv/bin/python3 -m pytest builder/tests -m e2e` |
| PDF from the command line | `node scripts/pdf/build_pdf.mjs --preset builder/presets/secreg-standard.json --out supplement.pdf` (needs Typst 0.14.x) |
| refresh the data | `builder/.venv/bin/python3 -m builder.build.build_corpus --config builder/build/corpora/securities.json`, then `builder/.venv/bin/python3 -m builder.build.verify_corpus` |

## Layout

| path | what |
|---|---|
| `site/` | landing page and committed samples (`site/samples/`) |
| `builder/` | the studio: search, selection model, PDF engine (`pdf/`), share links, reader export (`reader/`) |
| `builder/build/` | data pipeline: USLM XML + eCFR → `corpus.json`, release checks, verification |
| `pipeline/` | Python reference renderer for the offline reader |
| `scripts/` | site packaging, sample generation, CLI PDF build, demo capture |
| `docs/` | interface contracts, corpus adapter, deployment notes, coverage of other subjects |

## Licensing notes

Statutory and regulatory text is a work of the U.S. Government and in the public domain
(17 U.S.C. § 105). Bundled third-party components keep their own licenses: EB Garamond (SIL OFL),
Typst and typst.ts (Apache-2.0), pdf.js (Apache-2.0), Fuse.js (Apache-2.0), axe-core (MPL-2.0, tests
only).

Built by Doğa Özden and Claude.
