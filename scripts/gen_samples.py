#!/usr/bin/env python3
"""Generate the committed sample artifacts under site/samples/.

Run on a dev machine (or CI) with the builder venv — this script needs
Playwright + Chromium and Node, none of which exist in the Cloudflare
Pages build environment. scripts/build_site.py (stdlib-only) just copies
the committed results into deploy/samples/.

    builder/.venv/bin/python3 scripts/gen_samples.py

Produces:
  site/samples/sample-reader.html      — pipeline/build_reader.py over
                                         pipeline/manifest_insider_trading.json
  site/samples/sample-supplement.pdf   — the "Securities Regulation — Standard"
                                         template with a demo cover, typeset by
                                         the studio's own Typst engine in Chromium
  site/samples/share-link.txt          — the same supplement as a share link
                                         (encoded by builder/share.js)
  site/assets/hero-detail.png          — the landing hero detail (§ 77d)
"""
import base64
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "site" / "samples"
PORT = 8881  # ad-hoc dev port; the e2e suite owns 8765

class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        pass


def build_sample_reader() -> Path:
    manifest = ROOT / "pipeline" / "manifest_insider_trading.json"
    if not manifest.exists():
        raise SystemExit(f"missing manifest: {manifest}")
    out = SAMPLES / "sample-reader.html"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "pipeline" / "build_reader.py"),
            "--corpus", str(ROOT / "builder" / "corpus.json"),
            "--manifest", str(manifest),
            "--out", str(out),
        ],
        check=True,
    )
    # build_reader.py always writes an <out-stem>-text.json anchor sidecar;
    # it's a migration-tooling artifact, not part of the shipped samples.
    sidecar = out.with_name(out.stem + "-text.json")
    if sidecar.exists():
        sidecar.unlink()
    size = out.stat().st_size
    # The insider-trading manifest is intentionally small (14 provisions);
    # the inlined reader runtime alone is ~250 KB, so anything below that
    # means the template substitution failed.
    if size < 200_000:
        raise SystemExit(f"sample reader suspiciously small: {size} bytes")
    print(f"  sample-reader.html      {size:>12,} bytes")
    return out


DEMO_METADATA = {
    "title": "Securities Regulation",
    "subtitle": "Selected Statutes, Rules and Forms",
    "course": "Securities Regulation",
    "term": "Fall 2027",
    "professor": "Prof. A. Example",
    "school": "Example University School of Law",
}
PRESET = ROOT / "builder" / "presets" / "secreg-standard.json"


def demo_share_fragment() -> str:
    """The Securities Regulation template + demo cover, encoded by builder/share.js."""
    preset = json.loads(PRESET.read_text())
    share_js = (ROOT / "builder" / "share.js").as_uri()
    state = {"selection": preset["selection"], "mode": "original",
             "metadata": {**DEMO_METADATA, "groupTitles": preset.get("groupTitles", {})},
             "options": {"trim": "letter", "numbering": "original", "sourceCredits": True, "colophon": True}}
    script = (f"import {{ encodeState, makeNaming }} from {json.dumps(share_js)};\n"
              f"import {{ readFileSync }} from 'node:fs';\n"
              f"const corpus = JSON.parse(readFileSync({json.dumps(str(ROOT / 'builder' / 'corpus.json'))}, 'utf8'));\n"
              f"process.stdout.write(encodeState({json.dumps(state)}, 'securities', makeNaming(corpus)));\n")
    frag = subprocess.run(["node", "--input-type=module", "-e", script],
                          check=True, capture_output=True, text=True).stdout.strip()
    if not frag.startswith("#v="):
        raise SystemExit(f"unexpected share fragment: {frag[:80]}")
    return frag


def build_sample_pdf(base_url: str) -> Path:
    """Open the studio from the demo share link and take the PDF the Typst
    engine produced (window.__pdfBytes is exactly what "Download PDF" saves).
    Also renders the landing hero spread (two facing pages of § 77d)."""
    out = SAMPLES / "sample-supplement.pdf"
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(f"{base_url}/builder/{demo_share_fragment()}", wait_until="domcontentloaded")
        page.wait_for_function("window.__corpus != null", timeout=60_000)
        page.wait_for_function("window.__pdfReady === true || window.__pdfError", timeout=300_000)
        if page.evaluate("window.__pdfError"):
            raise SystemExit(f"typesetting failed: {page.evaluate('window.__pdfError')}")
        b64 = page.evaluate("""() => { const b = window.__pdfBytes; let s = '';
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
            return btoa(s); }""")
        prov_pages = page.evaluate("window.__pdfProvPages")
        browser.close()
    out.write_bytes(base64.b64decode(b64))
    import pdfplumber
    with pdfplumber.open(str(out)) as pdf:
        n = len(pdf.pages)
        text = pdf.pages[prov_pages["s-77d"] - 1].extract_text() or ""
        if "77d" not in text:
            raise SystemExit("sample PDF: § 77d not where the engine says it is")
        # landing hero: the top of § 77d's first page, cropped from just above its
        # heading, at 2x for a 640-CSS-px slot (actual size on a Letter page)
        page = pdf.pages[prov_pages["s-77d"] - 1]
        hit = page.search(r"(?:77d|§ ?4)\.\s*Exempted transactions", regex=True)[0]   # Act or Code numbering
        top = max(0, hit["top"] - 9)

        def block(pg):   # the page's own text block (verso or recto), below the running head
            ws = [w for w in pg.extract_words() if w["top"] > 62]
            return (min(w["x0"] for w in ws) - 18, max(w["x1"] for w in ws) + 18,
                    min(w["top"] for w in ws), max(w["bottom"] for w in ws))

        x0, x1, _, bottom = block(page)
        width_pt = x1 - x0
        height_pt = width_pt * 1010 / 1280
        res = round(1280 / width_pt * 72)
        from PIL import Image
        first_h = min(height_pt, bottom + 2 - top)
        img = page.crop((x0, top, x1, top + first_h)).to_image(resolution=res).original.convert("RGB")
        if first_h < height_pt - 1:
            # § 77d starts low on its page: carry on from the top of the next page's text,
            # as a reader turning the page would, at the same scale and line pitch, and
            # stop after the last whole line
            nxt = pdf.pages[prov_pages["s-77d"]]
            nx0, _, ntop, _ = block(nxt)
            limit = ntop - 1 + height_pt - first_h
            end = max(w["bottom"] for w in nxt.extract_words() if ntop <= w["top"] and w["bottom"] <= limit) + 1.2
            more = nxt.crop((nx0, ntop - 1, nx0 + width_pt, end))
            rest = more.to_image(resolution=res).original.convert("RGB")
            joined = Image.new("RGB", (img.width, round(img.width * 1010 / 1280)), "white")
            joined.paste(img, (0, 0))
            joined.paste(rest.resize((img.width, rest.height)), (0, img.height))
            img = joined
        img = img.resize((1280, 1010))
        img.save(ROOT / "site" / "assets" / "hero-detail.png", optimize=True)
    print(f"  sample-supplement.pdf   {out.stat().st_size:>12,} bytes ({n} pages)")
    print(f"  site/assets/hero-detail.png  § 77d, page {prov_pages['s-77d']}")
    # the landing page's sample is the product's shop window: the same book checks the
    # tests run (heads and folios, rectos, overprint, designators, rhythm) must pass
    sys.path.insert(0, str(ROOT / "builder" / "tests"))
    from pdf_checks import check_book
    print(f"  checked: {check_book(out)}")
    return out


def build_share_link() -> Path:
    """The demo share link (path-absolute; prepend the site's origin)."""
    out = SAMPLES / "share-link.txt"
    url = f"/app/{demo_share_fragment()}"
    out.write_text(url + "\n")
    print(f"  share-link.txt          {url[:90]}…")
    return out


def main():
    SAMPLES.mkdir(parents=True, exist_ok=True)
    print(f"Generating samples into {SAMPLES}")
    build_sample_reader()
    build_share_link()

    socketserver.TCPServer.allow_reuse_address = True
    handler = lambda *a, **kw: _QuietHandler(*a, directory=str(ROOT), **kw)
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        time.sleep(0.2)
        try:
            build_sample_pdf(f"http://127.0.0.1:{PORT}")
        finally:
            httpd.shutdown()
    print("Done. Commit site/samples/ — build_site.py only copies these files.")


if __name__ == "__main__":
    main()
