"""E2E: the professor flow in a real browser, end to end through the Typst
WebAssembly engine: load the studio, apply the Securities Regulation template,
wait for the live preview (the real PDF, drawn with pdf.js), click
"Download PDF", and verify the downloaded file: bookmarks, contents links,
cross-references landing on the right pages, official-source links, tagging,
embedded fonts (builder/tests/pdf_checks.py)."""
import pytest
from playwright.sync_api import sync_playwright

from builder.tests.pdf_checks import check_pdf

pytestmark = pytest.mark.e2e


def test_download_pdf_from_template(static_server, boot_builder, apply_preset, tmp_path):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        boot_builder(page)
        apply_preset(page, "Securities Reg")
        page.wait_for_function("window.__pdfReady === true || window.__pdfError", timeout=180_000)
        assert page.evaluate("window.__pdfError") is None
        pages = page.evaluate("window.__pdfPages")
        assert pages > 60, pages
        # the preview draws real pages
        page.locator(".pdf-page canvas").first.wait_for(timeout=30_000)
        assert page.locator(".pdf-page").count() == pages

        doc = page.evaluate("window.__pdfDoc")
        prov_pages = page.evaluate("window.__pdfProvPages")
        with page.expect_download(timeout=120_000) as dl:
            page.click("#btn-generate")
        out = tmp_path / dl.value.suggested_filename
        dl.value.save_as(str(out))
        assert out.suffix == ".pdf" and out.stat().st_size > 200_000
        browser.close()

    assert not errors, errors
    stats = check_pdf(out, doc, prov_pages)
    assert stats["pages"] == pages
    assert stats["xrefs_verified"] >= 10
