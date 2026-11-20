"""E2E: share-by-URL roundtrip across fresh browser contexts.

Context A builds a supplement through the UI (template + title + a part
title + Cover & settings: numbering, page size, colophon, course), waits for
the debounced hash sync, copies the link via #btn-share (real clipboard,
permissions granted), and context B — a fresh context with empty storage —
opens it: selection/mode/options/title/metadata/part titles must round-trip
and the "Loaded shared supplement" toast must show.
Also: a malformed hash must fall back to localStorage without wiping it.
"""
import json

import pytest
from playwright.sync_api import sync_playwright

from .conftest import STORE_KEY

pytestmark = pytest.mark.e2e

TITLE = "Shared Roundtrip Supplement"
COURSE = "Securities Regulation"
PART_TITLE = "The ’33 Act, annotated"


def test_share_roundtrip_across_fresh_contexts(
    static_server, secreg_preset, boot_builder, apply_preset
):
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ── context A: build the supplement, copy the share link ─────────
        ctx_a = browser.new_context(
            permissions=["clipboard-read", "clipboard-write"]
        )
        page = ctx_a.new_page()
        boot_builder(page)
        apply_preset(page)

        page.fill("#supp-title", TITLE)

        # Cover & settings dialog (changes apply at once): U.S. Code
        # numbering first, a course, 6 x 9 pages, no colophon page; rename a part.
        page.click("#btn-metadata")
        page.check("#toggle-codified")
        page.fill('#metadata-form [name="course"]', COURSE)
        page.select_option('#metadata-form [name="trim"]', "6x9")
        page.uncheck('#metadata-form [name="includeColophon"]')
        page.click('#metadata-form button[type="submit"]')
        part_title = page.locator("#selected .part-title").first
        part_title.fill(PART_TITLE)
        part_title.press("Enter")

        # hash sync is debounced (app.js initHashSync); wait for the final
        # state — Code numbering + colophon opt-out — to land in the fragment
        page.wait_for_function(
            "() => location.hash.includes('n=code') && location.hash.includes('col=0')"
            " && location.hash.includes('g=')",
            timeout=10_000,
        )
        hash_ = page.evaluate("() => location.hash")
        assert "v=3" in hash_ and "c=securities" in hash_
        assert "b=SecuritiesAct:" in hash_, f"book not named by Act section: {hash_}"
        assert "n=code" in hash_, f"numbering missing from hash: {hash_}"
        assert "col=0" in hash_, f"colophon opt-out missing from hash: {hash_}"
        assert "co=" in hash_, f"course metadata missing from hash: {hash_}"
        assert "tr=6x9" in hash_, f"page size missing from hash: {hash_}"
        assert "g=" in hash_, f"part title missing from hash: {hash_}"

        page.click("#btn-share")
        page.wait_for_selector("#btn-share:has-text('Copied')", timeout=5_000)
        clipboard = page.evaluate("() => navigator.clipboard.readText()")
        expected_url = page.evaluate(
            "() => location.origin + location.pathname + location.search + location.hash"
        )
        assert clipboard == expected_url, (
            f"clipboard does not match the page URL:\n"
            f"  clipboard: {clipboard}\n  url:       {expected_url}"
        )

        # ── context B: fresh profile opens the copied link ────────────────
        ctx_b = browser.new_context()
        page_b = ctx_b.new_page()
        page_b.goto(clipboard, wait_until="domcontentloaded")

        # the toast fires once the link is read (right after the corpus loads) and lives ~4s
        toast = page_b.wait_for_selector(".toast", timeout=10_000)
        assert "Loaded shared supplement" in toast.inner_text()

        page_b.wait_for_function("window.__corpus != null", timeout=30_000)

        stored = json.loads(
            page_b.evaluate(f"() => localStorage.getItem('{STORE_KEY}')")
        )
        assert stored["selection"] == secreg_preset["selection"], (
            f"selection did not round-trip: {len(stored['selection'])} ids vs "
            f"{len(secreg_preset['selection'])} in the preset"
        )
        assert stored["mode"] == "codified"
        assert stored["metadata"]["title"] == TITLE
        assert stored["metadata"]["course"] == COURSE
        assert stored["metadata"]["includeColophon"] is False
        assert stored["options"]["trim"] == "6x9"
        assert stored["options"]["numbering"] == "codified"
        assert PART_TITLE in stored["metadata"]["groupTitles"].values()

        # the UI reflects the decoded state
        assert page_b.input_value("#supp-title") == TITLE
        assert page_b.is_checked("#toggle-codified")
        assert page_b.locator("#selected .part-title").first.input_value() == PART_TITLE
        assert page_b.inner_text("#selected-count").strip() == str(
            len(secreg_preset["selection"])
        )

        browser.close()


def test_malformed_hash_falls_back_to_localstorage(
    static_server, secreg_preset, boot_builder, apply_preset
):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        boot_builder(page)
        apply_preset(page)

        # wait for the debounced hash sync — proves the store persisted too
        page.wait_for_function(
            "() => location.hash.includes('v=3')", timeout=10_000
        )

        # full reload with an undecodable hash (%ZZ is an invalid percent
        # escape -> decodeState returns null -> boot falls back to storage)
        page.goto("about:blank")
        page.goto(
            f"{static_server}/builder/index.html#v=1&c=securities&s=%ZZ",
            wait_until="domcontentloaded",
        )
        page.wait_for_function("window.__corpus != null", timeout=30_000)

        stored = json.loads(
            page.evaluate(f"() => localStorage.getItem('{STORE_KEY}')")
        )
        assert stored["selection"] == secreg_preset["selection"], (
            "malformed hash wiped the stored selection"
        )
        assert page.inner_text("#selected-count").strip() == str(
            len(secreg_preset["selection"])
        )

        browser.close()
