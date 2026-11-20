"""E2E: studio fixes from critic round 2.

- small-caps labels never set digits in small capitals ("SUBPART 229.IOO"):
  every small-caps text node with a digit sits in a normal-caps span
- the outline's part meta states what the part holds by Act section ("§ 5",
  "§§ 5–12"; "Whole Act · 15 U.S.C. §§ 77a–77aa" only when the whole act is in; "≈ 1 p.")
- removing an item, removing a part and moving a part each raise the toast
  with Undo, and Undo brings a part's own title back
- search: a pinpoint citation lists only provisions that have the subsection;
  a form item ("Item 1.01") says it is not in the C.F.R.
"""
import json

import pytest
from playwright.sync_api import sync_playwright

from .conftest import STORE_KEY

pytestmark = pytest.mark.e2e

# small-caps text nodes (computed) that hold a digit
SMALLCAPS_DIGITS = """() => {
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!/\\d/.test(n.nodeValue)) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,template')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || (el.offsetParent === null && cs.position !== 'fixed')) continue;
    if (/small-caps/.test(cs.fontVariantCaps)) bad.push(`${el.className}: ${n.nodeValue.trim().slice(0, 50)}`);
  }
  return bad;
}"""


def _open(p, boot_builder):
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    boot_builder(page)
    return browser, page, errors


def _state(page):
    return json.loads(page.evaluate(f"localStorage.getItem('{STORE_KEY}')"))


def _select(page, ids):
    """Put ids in the book as the app would after a click: through the store's
    storage, then a reload (no UI path adds exactly these provisions)."""
    st = _state(page)
    st["selection"] = ids
    page.evaluate(f"localStorage.setItem('{STORE_KEY}', {json.dumps(json.dumps(st))})")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("window.__corpus != null", timeout=30_000)
    page.wait_for_selector("#selected .part")


def _search(page, q):
    if not page.locator("#palette[open]").count():
        page.click("#btn-search")
    page.wait_for_selector("#palette[open]")
    page.fill("#palette-input", q)
    page.wait_for_timeout(300)


def _toast(page):
    live = page.locator(".toast:not(.leaving) .toast-text")   # a dismissed toast lingers 300 ms
    live.last.wait_for(timeout=3_000)
    return live.last.inner_text()


def test_small_caps_labels_never_set_digits_in_small_caps(static_server, secreg_preset, boot_builder, apply_preset):
    with sync_playwright() as p:
        browser, page, errors = _open(p, boot_builder)
        apply_preset(page)
        page.wait_for_selector("#selected .part")
        # an arabic part number puts digits in the kicker too
        title = page.locator("#selected .part-title").first
        title.fill("Part 1. Securities Act")
        title.press("Enter")
        page.wait_for_timeout(200)
        kick = page.locator("#selected .part-kicker").first.inner_text()
        assert kick.lower() == "part 1", kick
        assert page.evaluate(SMALLCAPS_DIGITS) == []
        # the S-K subpart heads carry numbers ("Subpart 229.100")
        assert "229.100" in page.locator("#selected .subhead").all_inner_texts().__str__()
        # search rows: source labels such as "Part 240"
        _search(page, "Rule 13e-1")   # not in the template, so the label is its part
        assert page.evaluate(SMALLCAPS_DIGITS) == []
        assert page.locator("#palette-results .r-source").first.inner_text().lower() == "part 240"
        assert page.locator("#palette-results .r-source").first.locator(".fig").count() == 1
        assert errors == []
        browser.close()


def test_part_meta_states_what_the_part_holds(static_server, boot_builder):
    with sync_playwright() as p:
        browser, page, errors = _open(p, boot_builder)
        # the "·" is glued to the next piece with a no-break space
        meta = lambda: [t.replace("\xa0", " ") for t in page.locator("#selected .part .part-meta").all_inner_texts()]  # noqa: E731
        _select(page, ["s-77e"])
        assert meta() == ["§ 5 · 1 section"]
        _select(page, ["s-77l", "s-77e", "s-77g"])
        assert meta()[0].startswith("§§ 5–12 · 3 sections")
        # the whole act: the act's own range
        corpus = page.evaluate("window.__corpus.acts[0].sections.map(s => s.id)")
        _select(page, corpus)
        assert meta()[0].startswith("Whole Act · 15 U.S.C. §§ 77a–77aa · 36 sections")
        # a part that adds one page says "p.", not "pp."
        _select(page, ["s-77a", "r-240-10b-5"])
        texts = meta()
        assert len(texts) == 2, texts
        assert all(" 1 p." in t or "pp." in t for t in texts), texts
        assert any(t.endswith("≈ 1 p.") for t in texts), texts
        assert not any("1 pp." in t for t in texts), texts
        assert errors == []
        browser.close()


def test_removing_and_moving_are_never_silent(static_server, boot_builder):
    with sync_playwright() as p:
        browser, page, errors = _open(p, boot_builder)
        _select(page, ["s-77e", "s-77l", "r-230-506"])
        # a title the professor typed
        title = page.locator("#selected .part-title").first
        title.fill("My custom title")
        title.press("Enter")
        page.wait_for_timeout(200)
        parts = lambda: page.locator("#selected .part").evaluate_all("els => els.map(e => e.dataset.key)")  # noqa: E731
        assert parts() == ["act:act-ch2A", "reg:cfr-17-p230"]

        # moving a part
        page.locator("#selected .part").first.locator('[data-act="part-down"]').click()
        assert _toast(page) == "Moved My custom title down."
        assert parts() == ["reg:cfr-17-p230", "act:act-ch2A"]
        page.locator(".toast:not(.leaving) .toast-action").click()
        assert parts() == ["act:act-ch2A", "reg:cfr-17-p230"]

        # removing an item
        first = page.locator("#selected .part").first.locator(".item").first
        first.hover()
        first.locator('[data-act="item-rm"]').click()
        assert _toast(page) == "Removed § 5."
        page.locator(".toast:not(.leaving) .toast-action").click()
        assert _state(page)["selection"][:2] == ["s-77e", "s-77l"]

        # removing the only item of a part says its part went too
        last = page.locator("#selected .part").last.locator(".item").first
        last.hover()
        last.locator('[data-act="item-rm"]').click()
        assert _toast(page) == "Removed Rule 506 and its part."
        page.locator(".toast:not(.leaving) .toast-action").click()
        assert parts() == ["act:act-ch2A", "reg:cfr-17-p230"]

        # removing a whole part keeps its own title for Undo
        page.locator("#selected .part").first.locator('[data-act="remove"]').click()
        assert _toast(page) == "Removed “My custom title” (2 provisions)."
        assert _state(page)["selection"] == ["r-230-506"]
        page.locator(".toast:not(.leaving) .toast-action").click()
        assert _state(page)["selection"] == ["s-77e", "s-77l", "r-230-506"]
        assert _state(page)["metadata"]["groupTitles"].get("act:act-ch2A") == "My custom title"
        assert page.locator("#selected .part-title").first.input_value() == "My custom title"
        assert errors == []
        browser.close()


def test_search_pinpoint_and_form_items(static_server, boot_builder):
    with sync_playwright() as p:
        browser, page, errors = _open(p, boot_builder)
        _search(page, "Section 12(a)(2)")
        rows = page.locator("#palette-results li.result")
        assert 1 <= rows.count() <= 2
        assert "has no subsection" not in page.locator("#palette-results").inner_text()
        assert page.locator("#palette-results li.result").first.get_attribute("data-id") == "s-77l"

        # a form item has no row, and says why
        _search(page, "Item 1.01")
        assert page.locator("#palette-results li.result").count() == 0
        none = page.locator("#palette-hint .palette-none")
        assert none.is_visible()
        assert "Form 8-K items are not in the C.F.R.; the form is published by the SEC" in none.inner_text()
        # ...and the ordinary "nothing matches" help comes back for other queries
        _search(page, "zzzzzzzz")
        assert "Nothing matches" in none.inner_text()
        # the first-run box says the same
        page.keyboard.press("Escape")
        page.fill("#fr-search", "Item 5.02")
        page.wait_for_timeout(300)
        assert page.locator("#fr-results li").count() == 0
        assert "not in the C.F.R." in page.locator("#fr-none").inner_text()
        assert errors == []
        browser.close()
