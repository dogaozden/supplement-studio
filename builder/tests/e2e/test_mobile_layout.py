"""E2E: mobile layout smoke at 390x844 (iPhone-ish viewport).

Below 900px the builder collapses to a tab-switched single panel
(ui/tabs.js + app.css): the .workspace-tabs bar is visible, exactly one of
the three panels shows, aria-pressed tracks the active tab, and the typeset
PDF preview fits the narrow panel. #btn-share is disabled until a selection
exists. Zero console errors throughout.
"""
import pytest
from playwright.sync_api import sync_playwright

from .conftest import collect_errors

pytestmark = pytest.mark.e2e


def _pressed_map(page):
    return page.evaluate(
        """() => Object.fromEntries(
             [...document.querySelectorAll('.workspace-tabs .tab[data-panel]')]
               .map(b => [b.dataset.panel, b.getAttribute('aria-pressed')]))"""
    )


def _assert_panel(page, active):
    cols = {"tree": "#tree-col", "selected": "#selected-col", "preview": "#preview-col"}
    pressed = _pressed_map(page)
    for panel, sel in cols.items():
        if panel == active:
            assert pressed[panel] == "true", f"{panel} tab not aria-pressed"
            assert page.is_visible(sel), f"{sel} hidden while its tab is active"
        else:
            assert pressed[panel] == "false", f"{panel} tab still aria-pressed"
            assert not page.is_visible(sel), f"{sel} visible under panel '{active}'"


def test_mobile_tabbed_layout(static_server, secreg_preset, boot_builder, apply_preset):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        errors = []
        collect_errors(page, errors)

        boot_builder(page)

        # tab bar visible, tree panel active by default
        assert page.is_visible(".workspace-tabs")
        _assert_panel(page, "tree")

        # share is pointless with nothing selected
        assert page.is_visible("#btn-share")
        assert page.is_disabled("#btn-share"), "#btn-share enabled with empty selection"

        apply_preset(page)
        assert not page.is_disabled("#btn-share"), "#btn-share still disabled after preset"

        # activate the preview tab: the typeset PDF is shown, scaled to the
        # narrow panel (no horizontal overflow)
        page.click(".workspace-tabs .tab[data-panel='preview']")
        _assert_panel(page, "preview")

        page.wait_for_function("window.__pdfReady === true", timeout=180_000)
        assert page.evaluate("() => window.__pdfError") is None
        assert page.evaluate("() => window.__pdfPages") > 10
        assert page.evaluate(
            "() => document.querySelector('#preview-pane').scrollWidth"
            " <= document.querySelector('#preview-pane').clientWidth + 1"
        ), "preview pane overflows horizontally on a phone"
        assert page.is_visible("#btn-generate")

        # the other two panels switch cleanly
        page.click(".workspace-tabs .tab[data-panel='selected']")
        _assert_panel(page, "selected")
        assert page.inner_text("#selected-count").strip() == str(
            len(secreg_preset["selection"])
        )

        page.click(".workspace-tabs .tab[data-panel='tree']")
        _assert_panel(page, "tree")

        assert not errors, f"console errors during mobile session: {errors[:5]}"

        browser.close()
