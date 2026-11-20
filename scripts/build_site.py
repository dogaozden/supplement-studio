#!/usr/bin/env python3
"""Assemble the deployable static tree into deploy/.

STDLIB ONLY — this runs as the Cloudflare Pages build command
(`python3 scripts/build_site.py`, output directory `deploy`) where there
is no browser and no pip. Anything that needs Chromium or Node (the
sample PDF / reader / share link) is generated beforehand by
scripts/gen_samples.py and committed under site/samples/; this script
just copies them.

Layout produced:
  deploy/            = site/*  (landing page, samples, _headers,
                       assets/theme.css refreshed from builder/theme.css;
                       index.html has its {{PLACEHOLDERS}} filled from
                       builder/corpus.json: release point, eCFR date,
                       provision count)
  deploy/app/        = builder/* minus dev-only files
  deploy/app/corpus.json = minified, per-section "notes" stripped
                       (verified unused: nothing under
                       builder/{*.js,ui,pdf,reader} reads section.notes —
                       the only "note" code in reader/template/reader.js
                       is the annotation-note UI, unrelated to the corpus)
"""
import json
import re
import shutil
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
BUILDER = ROOT / "builder"
DEPLOY = ROOT / "deploy"

# Builder entries that never ship (dev/test/build-time only).
APP_EXCLUDE_TOP = {
    "build", "tests", ".venv", "__init__.py", "package.json",
    "README.md", "build_manifest.json",
    "corpus.json",  # packaged separately (minified, notes stripped)
}
# Junk excluded at any depth, in both trees.
EXCLUDE_ANYWHERE = {"__pycache__", ".pytest_cache", ".DS_Store", "node_modules"}
# Test-only files (paths relative to builder/) that must not ship.
APP_EXCLUDE_FILES = {Path("assets/vendor/axe.min.js")}  # a11y scanner, 553KB

THEME_PROVENANCE = (
    "/* Copied from builder/theme.css (source of truth). "
    "scripts/build_site.py refreshes this copy at package time. */"
)


def refresh_site_theme() -> None:
    """Sync site/assets/theme.css from builder/theme.css, keeping the
    provenance header. Updates the SOURCE copy (committed) so the repo
    never drifts from what ships."""
    source = (BUILDER / "theme.css").read_text()
    target = SITE / "assets" / "theme.css"
    content = f"{THEME_PROVENANCE}\n\n{source}"
    if not target.exists() or target.read_text() != content:
        target.write_text(content)
        print(f"refreshed {target.relative_to(ROOT)} from builder/theme.css")


def _long_date(iso: str) -> str:
    """'2026-08-06' -> 'August 6, 2026'."""
    d = date.fromisoformat(iso)
    return f"{d:%B} {d.day}, {d.year}"


def landing_facts(corpus: dict) -> dict:
    """Values for the {{PLACEHOLDERS}} in site/index.html, read from the
    corpus so the landing page can never state a different currency than
    the PDFs do. Raises if the corpus has no source stamp: shipping a page
    that claims a currency it cannot back up is worse than a failed build."""
    source = corpus.get("source") or {}
    release, ecfr = source.get("usc_release_point"), source.get("ecfr_date")
    if not release or not ecfr:
        raise SystemExit("corpus.json has no source.usc_release_point / "
                         "source.ecfr_date; cannot fill the landing page")
    provisions = (sum(len(a.get("sections", [])) for a in corpus.get("acts", []))
                  + sum(len(r.get("rules", [])) for r in corpus.get("regulations", [])))
    ecfr_long = _long_date(ecfr)
    label = source.get("usc_release_label") or f"Public Law {release}"
    return {
        "USC_RELEASE": release,
        "ECFR_DATE": ecfr_long,
        # the same phrase as the PDF cover and the studio footer
        # (builder/pdf/document.js currencyLine)
        # month and day never part at a line end ("October / 29, 2026")
        "CURRENCY": re.sub(r"\b([A-Z][a-z]+) (\d{1,2},)", "\\1\u00a0\\2",
                           f"Statutes current through {label}; regulations current as of {ecfr_long}."),
        "PROVISION_COUNT": f"{provisions:,}",
        "STATUTE_LIST": _catalog(
            (a.get("short_title", ""), (a.get("usc_range") or "").replace("15 U.S.C. ", ""))
            for a in sorted(corpus.get("acts", []), key=lambda a: a.get("order", 99))),
        "REGULATION_LIST": _catalog(
            (r.get("short_title") or r.get("display_title") or r.get("title", ""), f"Part {r.get('part', '')}")
            for r in corpus.get("regulations", [])),
    }


def _catalog(rows) -> str:
    """<li> rows for the landing page's coverage catalog, read from the corpus."""
    from html import escape
    return "\n".join(
        f'          <li><span class="name">{escape(name)}</span><span class="leader" aria-hidden="true">'
        f'</span><span class="cite">{escape(cite)}</span></li>' for name, cite in rows)


def fill_landing(facts: dict) -> None:
    """Replace {{NAME}} placeholders in deploy/index.html. An unknown
    placeholder is an error (a typo would otherwise ship as literal braces)."""
    page = DEPLOY / "index.html"

    def sub(match):
        name = match.group(1)
        if name not in facts:
            raise SystemExit(f"site/index.html: unknown placeholder {{{{{name}}}}}")
        return facts[name]

    page.write_text(re.sub(r"\{\{([A-Z_]+)\}\}", sub, page.read_text()))


def _ignore(top_level_exclude):
    def ignore(directory, names):
        ignored = {n for n in names if n in EXCLUDE_ANYWHERE}
        if top_level_exclude is not None and Path(directory) == BUILDER:
            ignored |= {n for n in names if n in top_level_exclude}
        if top_level_exclude is not None:
            try:
                rel = Path(directory).relative_to(BUILDER)
                ignored |= {n for n in names if rel / n in APP_EXCLUDE_FILES}
            except ValueError:
                pass  # directory outside builder/ (the site tree)
        return ignored
    return ignore


def package_corpus() -> tuple[int, int]:
    """Minify builder/corpus.json into deploy/app/corpus.json, dropping the
    per-section USC "notes" field (unused by the runtime — see module
    docstring). Returns (original_bytes, packaged_bytes)."""
    source = BUILDER / "corpus.json"
    original_bytes = source.stat().st_size
    corpus = json.loads(source.read_text())
    for act in corpus.get("acts", []):
        for section in act.get("sections", []):
            section.pop("notes", None)
    out = DEPLOY / "app" / "corpus.json"
    out.write_text(json.dumps(corpus, ensure_ascii=False, separators=(",", ":")))
    return original_bytes, out.stat().st_size


def summarize() -> tuple[int, int]:
    files = [p for p in DEPLOY.rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def main():
    global DEPLOY
    import sys
    if "--out" in sys.argv:   # optional: package somewhere other than ./deploy
        DEPLOY = Path(sys.argv[sys.argv.index("--out") + 1]).resolve()
    refresh_site_theme()

    if DEPLOY.exists():
        shutil.rmtree(DEPLOY)

    shutil.copytree(SITE, DEPLOY, ignore=_ignore(None))
    shutil.copytree(BUILDER, DEPLOY / "app", ignore=_ignore(APP_EXCLUDE_TOP))

    corpus_before, corpus_after = package_corpus()
    facts = landing_facts(json.loads((BUILDER / "corpus.json").read_text()))
    fill_landing(facts)

    headers = DEPLOY / "_headers"
    if not headers.exists():  # site/* copy already brings it; belt and braces
        shutil.copy2(SITE / "_headers", headers)

    count, total = summarize()
    print(f"corpus.json: {corpus_before:,} -> {corpus_after:,} bytes "
          f"({corpus_before - corpus_after:,} saved; minified, notes stripped)")
    print(f"landing: {facts['PROVISION_COUNT']} provisions; {facts['CURRENCY']}")
    print(f"deploy/: {count} files, {total:,} bytes total")


if __name__ == "__main__":
    main()
