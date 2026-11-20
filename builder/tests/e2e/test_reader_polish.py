"""E2E: the student reader after design round 2.

Exports a reader from the studio (course with digits in it), opens the file
and checks, in a real browser: the law is set with hanging indents and run-in
heads like the PDF; source credits carry a "Source" label; small-caps labels
set digits as lining figures; search snippets keep curly quotes and em dashes;
the notes rail opens on All and never says a section has no annotations while
a highlight sits in it; selections snap to whole words; the selection toolbar
has no orphan divider.
"""
import pytest
from playwright.sync_api import sync_playwright

from .conftest import collect_errors

pytestmark = pytest.mark.e2e

# select from inside one word to inside another with a synthetic selection and
# the same mouseup the reader listens for (as in pipeline/smoke_test.py)
SELECT_MID_WORD = """([secId, startNeedle, startInner, endNeedle, endInner]) => {
  const sec = document.getElementById(secId);
  sec.scrollIntoView({block: 'start', behavior: 'instant'});
  const find = (needle) => {
    const w = document.createTreeWalker(sec.querySelector('.prov-body'), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(needle); if (i >= 0) return [n, i]; }
    return null;
  };
  const a = find(startNeedle), b = find(endNeedle);
  if (!a || !b) return 'no-text';
  const r = document.createRange();
  r.setStart(a[0], a[1] + startInner);
  r.setEnd(b[0], b[1] + endInner);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  return 'sel-ok';
}"""


@pytest.fixture
def exported_reader(static_server, boot_builder, apply_preset, tmp_path):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        boot_builder(page)
        apply_preset(page)
        page.wait_for_timeout(1000)
        page.click("#btn-metadata")
        page.wait_for_selector("#metadata-form")
        page.fill("#metadata-form [name=course]", "Securities Regulation (LAW 6421)")
        page.fill("#metadata-form [name=term]", "Spring 2027")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        with page.expect_download(timeout=60_000) as dl:
            page.click("#btn-export-reader")
        path = tmp_path / "reader.html"
        dl.value.save_as(path)

        reader = ctx.new_page()
        errors = []
        collect_errors(reader, errors)
        reader.goto(path.resolve().as_uri())
        reader.wait_for_selector("section.prov", timeout=60_000)
        reader.wait_for_timeout(1500)
        yield reader, errors
        browser.close()


def test_law_is_set_like_the_pdf(exported_reader):
    reader, errors = exported_reader
    reader.evaluate("document.getElementById('s-77b').scrollIntoView({block:'start', behavior:'instant'})")
    reader.wait_for_timeout(300)
    geo = reader.evaluate("""() => {
      const sec = document.getElementById('s-77b');
      // (a) Definitions. When used in this subchapter...  one run-in block
      const ri = sec.querySelector('.ri');
      const nh = ri.querySelector('.nh').getBoundingClientRect();
      const rg = document.createRange(); rg.selectNodeContents(ri.children[1]);
      const chapeauTop = rg.getClientRects()[0].top;
      // (1) The term "security" ... : one number column, every text line on one edge
      const p1 = Array.from(sec.querySelectorAll('.prov-body > p.t.d2')).find(p => p.querySelector('.n'));
      const num = p1.querySelector('.n').getBoundingClientRect();
      const tn = Array.from(p1.childNodes).find(x => x.nodeType === 3);
      const rr = document.createRange(); rr.selectNodeContents(tn);
      const lefts = Array.from(rr.getClientRects()).map(q => Math.round(q.left));
      const textEdge = p1.getBoundingClientRect().left + parseFloat(getComputedStyle(p1).paddingLeft);
      return { headTop: nh.top, chapeauTop, numRight: num.right, textEdge,
               distinctLefts: [...new Set(lefts)], lineCount: lefts.length };
    }""")
    assert abs(geo["headTop"] - geo["chapeauTop"]) <= 3, geo     # heading runs in with its text
    assert geo["lineCount"] > 3, geo                              # (1) really wraps
    assert len(geo["distinctLefts"]) == 1, geo                    # wrapped lines align with the text
    assert geo["numRight"] <= geo["textEdge"] + 1, geo            # the number stays in its own column

    credit = reader.evaluate("getComputedStyle(document.querySelector('#s-77a .prov-credit'), '::before').content")
    assert credit == '"Source"'
    assert not errors, errors[:3]


def test_small_caps_digits_are_lining_figures(exported_reader):
    reader, _ = exported_reader
    fig = reader.locator(".toc-eyebrow .fig")
    assert fig.count() >= 1
    assert "6421" in reader.locator(".toc-eyebrow .fig").all_inner_texts()
    caps = reader.evaluate("getComputedStyle(document.querySelector('.toc-eyebrow .fig')).fontVariantCaps")
    assert caps == "normal"
    # the helper every small-caps label goes through
    html = reader.evaluate("scHtml('Subpart 229.100\\u2014Business & Co.')")
    assert html == 'Subpart <span class="fig">229.100</span>—Business &amp; Co.'


def test_search_snippets_use_the_displayed_text(exported_reader):
    reader, _ = exported_reader
    reader.keyboard.press("Meta+k")
    reader.locator("#searchInput").fill("accredited investor")
    reader.wait_for_timeout(700)
    ctx_text = " ".join(reader.locator(".sres .ctx").all_inner_texts())
    assert "“" in ctx_text or "”" in ctx_text, ctx_text[:300]
    assert '"' not in ctx_text
    reader.locator("#searchInput").fill("shall be liable")
    reader.wait_for_timeout(700)
    dashes = " ".join(reader.locator(".sres .ctx").all_inner_texts())
    reader.locator("#searchInput").fill("requirement.")
    reader.wait_for_timeout(700)
    dashes += " ".join(reader.locator(".sres .ctx").all_inner_texts())
    assert "—" in dashes and "-." not in dashes


def test_highlight_flow_rail_snap_and_toolbar(exported_reader):
    reader, errors = exported_reader
    assert reader.evaluate("document.querySelector('.rail-chip.active').dataset.f") == "all"

    # a drag that starts in "pur|chasing" and ends in "sec|urity" takes whole words
    res = reader.evaluate(SELECT_MID_WORD, ["s-77l", "purchasing such", 3, "security from him", 3])
    assert res == "sel-ok"
    reader.wait_for_timeout(300)
    assert reader.evaluate("getSelection().toString()") == "purchasing such security"
    tb = reader.evaluate("""() => {
      const t = document.getElementById('hlToolbar');
      const shown = Array.from(t.children).filter(c => getComputedStyle(c).display !== 'none');
      return { visible: t.classList.contains('visible'), last: shown[shown.length - 1].className };
    }""")
    assert tb["visible"] and "cbtn" in tb["last"], tb              # no orphan divider

    reader.locator('#hlToolbar .cbtn[data-c="yellow"]').click()
    reader.wait_for_timeout(700)
    assert " ".join(reader.locator("mark.hl").all_inner_texts()) == "purchasing such security"

    # the rail shows the highlight on its default tab instead of denying it
    rail = reader.locator("#rail").inner_text()
    assert "1 in view" in rail and "No annotations" not in rail and "Nothing highlighted" not in rail
    # and the Notes tab points to Marks rather than saying there is nothing
    reader.locator('.rail-chip[data-f="notes"]').click()
    reader.wait_for_timeout(300)
    assert "under Marks" in reader.locator("#rail").inner_text()
    assert not errors, errors[:3]
