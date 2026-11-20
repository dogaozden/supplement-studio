# Deploying Supplement Studio

The product ships as a fully static tree assembled by
`scripts/build_site.py` (stdlib-only Python — no browser, no pip
installs), so it builds anywhere `python3` exists, including the
Cloudflare Pages build image.

## Packaged layout

```
deploy/
├── index.html            # landing page (from site/; currency + counts filled from corpus.json)
├── _headers              # Cloudflare Pages cache headers (from site/_headers)
├── assets/               # landing assets (Latin-subset fonts, hero spread, theme.css copy)
├── samples/              # committed artifacts from scripts/gen_samples.py
│   ├── sample-supplement.pdf   # "Securities Regulation — Standard", demo cover
│   ├── sample-reader.html
│   └── share-link.txt    # path-absolute share URL (prepend your domain)
└── app/                  # the studio (builder/ minus build/, tests/, dev files)
    ├── corpus.json       # minified, USC statutory "notes" stripped (19.1 MB -> ~12.8 MB)
    ├── verify_report.json  # word-for-word verification summary (printed in the colophon)
    ├── pdf/              # document.js, supplement.typ, engine + worker
    └── assets/
        ├── fonts/typst/  # EB Garamond TTFs used by the PDF engine (OFL)
        └── vendor/
            ├── typst-0.14.2/   # typst.ts compiler; the 27 MiB wasm ships gzipped (10.7 MB)
            └── pdfjs-6.5.438-legacy/  # draws the live preview
```

Sizes: about 100 files and ~33 MB; the largest file is the gzipped compiler
(10.7 MB), well under Pages' 25 MiB per-file cap. Browsers fetch the compiler
and fonts once (~13 MB, cached immutable); the corpus is cached for an hour.
Vendor directories carry their version in the name because
`/app/assets/vendor/*` is cached immutable: an upgrade must use a new
directory.

Only `site/` and `builder/` ship: `build_site.py` copies those two trees and
nothing else (`pipeline/`, `docs/` and `scripts/` stay out of `deploy/`).

## Cloudflare Pages setup

Create a Pages project connected to this repo with:

| setting | value |
|---|---|
| Framework preset | None |
| Build command | `python3 scripts/build_site.py` |
| Build output directory | `deploy` |

That's the whole setup — no environment variables, no Node toolchain.
Cache behavior (hourly corpus refresh with stale-while-revalidate,
immutable vendor/fonts, uncached HTML) lives in `site/_headers`.

## Regenerating the samples

The sample PDF/reader/share-link are **committed** artifacts under
`site/samples/` because generating them needs Chromium + Node, which the
Pages build env doesn't have. Regenerate on a dev machine whenever the
corpus, the PDF pipeline, or the reader template changes:

```sh
builder/.venv/bin/python3 scripts/gen_samples.py
git add site/samples && git commit
```

The script builds the sample reader via `pipeline/build_reader.py`
(insider-trading manifest), opens the studio in Chromium from a share link
for the "Securities Regulation — Standard" template with a demo cover and
takes the PDF the studio's own Typst engine produced, renders the landing
hero detail (`site/assets/hero-detail.png`, the top of § 77d at 2×) from it, and writes
the share link (encoded with `builder/share.js`). It serves the repo on
port 8881 while it runs.

## Local preview

```sh
python3 scripts/build_site.py && python3 -m http.server -d deploy
```

Then open <http://localhost:8000/> for the landing page and
<http://localhost:8000/app/> for the builder. To try the shared-link
sample, append the contents of `deploy/samples/share-link.txt` to the
origin.

`deploy/` is a build artifact (gitignored) — never commit it; rerunning
`build_site.py` rebuilds it from scratch.
