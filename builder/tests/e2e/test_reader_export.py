"""E2E: client-side reader export (lane 2B) produces a working offline
annotatable reader.

Preset -> #btn-export-reader download -> open the file as file:// in a new
page: provision count matches the preset, zero console errors, TOC click
navigates. Then create a real highlight (synthetic text selection, same JS
as pipeline/smoke_test.py), reload the file:// page, and assert the
highlight restores from localStorage.
"""
import json

import pytest
from playwright.sync_api import sync_playwright

from .conftest import collect_errors

pytestmark = pytest.mark.e2e

# Synthetic text-selection + mouseup, lifted from pipeline/smoke_test.py:
# selects the first occurrence of "security" inside s-77b's body text.
HIGHLIGHT_JS = """() => {
  const sec = document.getElementById('s-77b');
  sec.scrollIntoView({block: 'start', behavior: 'instant'});
  let tn = null;
  for (const p of sec.querySelectorAll('.prov-body .t')) {
    tn = Array.from(p.childNodes).find(
      n => n.nodeType === 3 && n.nodeValue.includes('security'));
    if (tn) break;
  }
  if (!tn) return 'no-text';
  const start = tn.nodeValue.indexOf('security');
  const r = document.createRange();
  r.setStart(tn, start); r.setEnd(tn, start + 8);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  return 'sel-ok';
}"""


def test_reader_export_roundtrip(
    static_server, secreg_preset, boot_builder, apply_preset, tmp_path
):
    n_expected = len(secreg_preset["selection"])

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        boot_builder(page)
        apply_preset(page)

        with page.expect_download(timeout=60_000) as dl_info:
            page.click("#btn-export-reader")
        reader_path = tmp_path / "exported-reader.html"
        dl_info.value.save_as(reader_path)
        assert reader_path.stat().st_size > 100_000, (
            f"exported reader suspiciously small: {reader_path.stat().st_size} bytes"
        )

        # ── open the export as a local file in a NEW page ─────────────────
        reader = ctx.new_page()
        errors = []
        collect_errors(reader, errors)
        reader.goto(reader_path.resolve().as_uri())
        # generous waits — exported readers can be very large documents
        reader.wait_for_selector("section.prov", timeout=60_000)
        reader.wait_for_timeout(2_000)

        doc_meta = json.loads(reader.locator("#docMeta").text_content())
        assert doc_meta["provisions"] == n_expected
        n_prov = reader.locator("section.prov").count()
        assert n_prov == n_expected, (
            f"expected {n_expected} section.prov, got {n_prov}"
        )
        assert reader.locator(".toc-item").count() == n_expected

        # ── TOC navigation ────────────────────────────────────────────────
        reader.locator('.toc-item[data-sec="r-230-144"]').click()
        reader.wait_for_timeout(1_200)
        in_view = reader.evaluate(
            "() => { const r = document.getElementById('r-230-144')"
            ".getBoundingClientRect(); return r.top > -100 && r.top < 400; }"
        )
        assert in_view, "clicking the Rule 144 TOC item did not scroll to it"

        # ── create a highlight via synthetic selection ────────────────────
        created = reader.evaluate(HIGHLIGHT_JS)
        assert created == "sel-ok", f"selection failed: {created}"
        reader.wait_for_timeout(400)
        assert reader.locator("#hlToolbar.visible").count() == 1, (
            "highlight toolbar did not appear after selection"
        )
        reader.locator('#hlToolbar .cbtn[data-c="green"]').click()
        reader.wait_for_timeout(1_000)  # outlast the 400ms persist debounce
        marks = reader.locator("mark.hl")
        assert marks.count() >= 1, "no mark.hl created"
        assert marks.first.inner_text() == "security"

        ls_key = f"supplementAnnotations.v2.{doc_meta['name']}"
        stored = reader.evaluate(
            f"() => JSON.parse(localStorage.getItem({json.dumps(ls_key)}))"
        )
        assert stored and len(stored["highlights"]) == 1, (
            f"highlight not persisted under {ls_key}"
        )

        # ── reload: the highlight must restore from localStorage ──────────
        reader.reload()
        reader.wait_for_selector("section.prov", timeout=60_000)
        reader.wait_for_timeout(2_000)
        restored = reader.locator("mark.hl")
        assert restored.count() >= 1, "highlight did not restore after reload"
        assert restored.first.inner_text() == "security"

        assert not errors, f"console errors in exported reader: {errors[:5]}"

        browser.close()
