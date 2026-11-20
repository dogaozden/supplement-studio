"""E2E: golden-image regression for the PDF the studio produces.

Applies the Securities Regulation template in the studio, takes the PDF the
Typst engine produced (window.__pdfBytes, identical to "Download PDF"),
rasterizes the cover, the first contents page and the first page of § 77d
(deep (a)(3)(A) nesting) with pdfplumber, and compares each against a
platform-keyed golden (goldens/{name}-{sys.platform}.png): < 1.5% of pixels
may differ.

- Golden missing for this platform -> the test SKIPS with instructions.
- REGEN_GOLDENS=1 regenerates the goldens for this platform.
"""
import base64
import os
import sys
from pathlib import Path

import pdfplumber
import pytest
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

pytestmark = pytest.mark.e2e

GOLDEN_DIR = Path(__file__).resolve().parent / "goldens"
DIFF_RATIO_LIMIT = 0.015
PIXEL_TOLERANCE = 24
RESOLUTION = 90


def _golden(name):
    return GOLDEN_DIR / f"{name}-{sys.platform}.png"


def _diff_ratio(a, b):
    if a.size != b.size:
        return 1.0
    diff = ImageChops.difference(a.convert("L"), b.convert("L"))
    hist = diff.histogram()
    changed = sum(hist[PIXEL_TOLERANCE:])
    return changed / (a.size[0] * a.size[1])


def test_pdf_visual_goldens(static_server, boot_builder, apply_preset, tmp_path):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        boot_builder(page)
        apply_preset(page, "Securities Reg")
        page.wait_for_function("window.__pdfReady === true || window.__pdfError", timeout=180_000)
        assert page.evaluate("window.__pdfError") is None
        b64 = page.evaluate("""() => { const b = window.__pdfBytes; let s = '';
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
            return btoa(s); }""")
        prov_pages = page.evaluate("window.__pdfProvPages")
        browser.close()

    pdf_path = tmp_path / "supp.pdf"
    pdf_path.write_bytes(base64.b64decode(b64))
    targets = {"cover": 1, "toc": 3, "interior": prov_pages.get("s-77d", 12)}
    regen = os.environ.get("REGEN_GOLDENS") == "1"
    missing, failures = [], []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for name, num in targets.items():
            img = pdf.pages[num - 1].to_image(resolution=RESOLUTION).original.convert("RGB")
            golden = _golden(name)
            if regen:
                GOLDEN_DIR.mkdir(exist_ok=True)
                img.save(golden)
                continue
            if not golden.exists():
                missing.append(golden.name)
                continue
            ratio = _diff_ratio(img, Image.open(golden).convert("RGB"))
            if ratio >= DIFF_RATIO_LIMIT:
                img.save(tmp_path / f"{name}-actual.png")
                failures.append(f"{name}: {ratio:.2%} of pixels differ (limit {DIFF_RATIO_LIMIT:.1%}); "
                                f"actual saved to {tmp_path / (name + '-actual.png')}")
    if regen:
        pytest.skip("goldens regenerated")
    if missing:
        pytest.skip(f"no goldens for {sys.platform}: {missing}; run with REGEN_GOLDENS=1")
    assert not failures, "\n".join(failures)
