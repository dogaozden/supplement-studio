#!/usr/bin/env python3
"""Browser smoke test for the generated reader.

Drives the real file in headless Chromium: boot, TOC nav, search,
highlight creation, note, persistence round-trip, export payload.

Usage: builder/.venv/bin/python3 pipeline/smoke_test.py READER.html
(a reader built from pipeline/manifest_secreg.json)
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise SystemExit(__doc__)
TARGET = Path(sys.argv[1])

fails = []


def check(name, cond, extra=""):
    status = "ok " if cond else "FAIL"
    print(f"  [{status}] {name}{(' — ' + str(extra)) if extra and not cond else ''}")
    if not cond:
        fails.append(name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(TARGET.resolve().as_uri())
        page.wait_for_timeout(800)

        print("== boot ==")
        check("no js errors on boot", not errors, errors[:3])
        n_prov = page.evaluate(
            "() => JSON.parse(document.getElementById('docMeta').textContent).provisions")
        check("sections rendered", page.locator("section.prov").count() == n_prov,
              page.locator("section.prov").count())
        check("toc items rendered", page.locator(".toc-item").count() == n_prov,
              page.locator(".toc-item").count())
        check("first section is § 1", page.locator(".toc-item").first.inner_text().startswith("§ 1"))

        print("== toc navigation ==")
        page.locator('.toc-item[data-sec="r-230-144"]').click()
        page.wait_for_timeout(900)
        in_view = page.evaluate(
            "() => { const r = document.getElementById('r-230-144').getBoundingClientRect();"
            " return r.top > -100 && r.top < 400; }")
        check("clicking Rule 144 scrolls to it", in_view)
        crumb = page.locator("#crumb").inner_text()
        check("crumb tracks current provision", "144" in crumb, crumb)

        print("== highlight creation ==")
        # The shipped reader boots with seeded annotations (989 highlights,
        # ~199 noted), so every store/mark assertion below diffs against
        # this baseline and scopes to the newly created highlight's id.
        store_key = page.evaluate(
            "() => 'supplementAnnotations.v2.' + "
            "JSON.parse(document.getElementById('docMeta').textContent).name")
        base_ids = set(page.evaluate(
            "(k) => { const raw = localStorage.getItem(k);"
            " return raw ? JSON.parse(raw).highlights.map(h => h.id) : []; }",
            store_key))
        created = page.evaluate(
            """() => {
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
        )
        page.wait_for_timeout(300)
        check("selection produced", created == "sel-ok", created)
        check("toolbar visible", page.locator("#hlToolbar.visible").count() == 1)
        page.locator('#hlToolbar .cbtn[data-c="green"]').click()
        page.wait_for_timeout(700)  # outlast the 400ms persist debounce
        n_marks = page.locator("mark.hl").count()
        check("mark created", n_marks >= 1, n_marks)

        stored = page.evaluate(
            "(k) => JSON.parse(localStorage.getItem(k))", store_key)
        new_ids = [h["id"] for h in (stored or {}).get("highlights", [])
                   if h["id"] not in base_ids]
        check("autosaved to localStorage",
              stored and len(stored["highlights"]) == len(base_ids) + 1
              and len(new_ids) == 1,
              f"{len((stored or {}).get('highlights', []))} stored, "
              f"{len(base_ids)} baseline, new={new_ids[:3]}")
        new_id = new_ids[0] if new_ids else ""
        hl = next((h for h in stored["highlights"] if h["id"] == new_id), {})
        check("anchor fields present",
              all(k in hl for k in ("sectionId", "occurrence", "textBefore", "textAfter")),
              list(hl.keys()))

        print("== note flow ==")
        new_mark = f'mark.hl[data-hid="{new_id}"]'
        page.locator(new_mark).first.click()
        page.wait_for_timeout(250)
        page.locator("#noteBtn").click()
        page.wait_for_timeout(250)
        ta = page.locator(".card-note-edit")
        check("note editor opened", ta.count() == 1)
        ta.fill("Howey is the lodestar.")
        page.locator('[data-act="save"]').click()
        page.wait_for_timeout(700)  # outlast persist debounce
        check("note saved to store", page.evaluate(
            "(args) => JSON.parse(localStorage.getItem(args[0]))"
            ".highlights.find(h => h.id === args[1])?.note",
            [store_key, new_id]) == "Howey is the lodestar.")
        check("note dot on mark", page.locator(f"{new_mark} .ndot").count() == 1)
        page.wait_for_timeout(300)  # outlast placeTicksSoon debounce
        check("tick appears once noted",
              page.locator(f'.tick[data-hid="{new_id}"]').count() == 1)

        print("== rail auto-center ==")
        page.evaluate("() => { document.getElementById('rail').scrollTop = 999999; }")
        page.wait_for_timeout(200)
        main_y_before = page.evaluate("() => scrollY")
        page.locator(new_mark).first.click()
        page.wait_for_timeout(150)
        check("card pulses on mark click", page.evaluate(
            """(hid) => document.querySelector(`.card[data-hid="${hid}"]`)
                ?.classList.contains('spot')""",
            new_id))
        page.wait_for_timeout(650)  # outlast the smooth rail scroll (~800ms total)
        centered = page.evaluate(
            """(hid) => {
              const rail = document.getElementById('rail');
              const card = document.querySelector(`.card[data-hid="${hid}"]`);
              if (!rail || !card) return null;
              const rr = rail.getBoundingClientRect();
              const cr = card.getBoundingClientRect();
              return {
                inView: cr.top >= rr.top - 1 && cr.bottom <= rr.bottom + 1,
                offset: Math.abs((cr.top + cr.height / 2) - (rr.top + rr.height / 2)),
                tolerance: rr.height * 0.4,
              };
            }""",
            new_id)
        check("mark click centers its rail card",
              bool(centered) and centered["inView"] and centered["offset"] <= centered["tolerance"],
              centered)
        main_y_after = page.evaluate("() => scrollY")
        check("rail auto-center does not scroll the main viewport",
              abs(main_y_after - main_y_before) <= 4,
              f"{main_y_before} -> {main_y_after}")

        print("== persistence round-trip ==")
        page.reload()
        page.wait_for_timeout(900)
        check("highlight restored after reload", page.locator(new_mark).count() >= 1,
              page.locator(new_mark).count())
        check("restored with note dot", page.locator(f"{new_mark} .ndot").count() == 1)
        check("no js errors after reload", not errors, errors[:3])

        print("== search ==")
        page.keyboard.press("Meta+k")
        page.wait_for_timeout(200)
        check("search opens", page.locator(".search-overlay.open").count() == 1)
        page.locator("#searchInput").fill("preliminary prospectus")
        page.wait_for_timeout(600)
        count_txt = page.locator("#searchCount").inner_text()
        check("search finds hits", "hit" in count_txt, count_txt)
        page.keyboard.press("Enter")
        page.wait_for_timeout(700)
        check("search hit marked", page.locator("mark.shit.cur").count() == 1)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("escape clears search marks", page.locator("mark.shit").count() == 0)

        print("== gutter ==")
        page.evaluate("() => document.querySelector('mark.hl').scrollIntoView({block:'center'})")
        page.wait_for_timeout(400)
        n_ticks = page.locator(".tick").count()
        check("gutter tick exists", n_ticks >= 1)
        n_noted_placed = page.evaluate(
            """(k) => {
              const raw = localStorage.getItem(k);
              const highlights = raw ? JSON.parse(raw).highlights : [];
              let n = 0;
              for (const h of highlights) {
                if (!h.note) continue;
                if (document.querySelector(`mark.hl[data-hid="${h.id}"]`)) n++;
              }
              return n;
            }""",
            store_key)
        check("gutter ticks == noted, placed highlights", n_ticks == n_noted_placed,
              f"{n_ticks} ticks vs {n_noted_placed} noted")

        print("== display prefs ==")
        # Theme-agnostic: older readers open dark and toggle to 'paper'; the
        # current template opens light ('paper') and toggles to 'dark'.
        theme_js = "() => document.documentElement.dataset.theme || ''"
        theme_before = page.evaluate(theme_js)
        page.locator("#themeBtn").click()
        page.wait_for_timeout(200)
        theme_after = page.evaluate(theme_js)
        check("theme toggle switches theme",
              theme_after != theme_before and theme_after in ("paper", "dark"),
              f"{theme_before!r} -> {theme_after!r}")
        page.locator("#typeBtn").click()
        page.wait_for_timeout(200)
        page.locator("#fsPlus").click()
        page.wait_for_timeout(200)
        check("font size steps up", page.evaluate(
            "() => getComputedStyle(document.querySelector('.content')).fontSize") == "18px")
        page.keyboard.press("Escape")
        page.reload()
        page.wait_for_timeout(900)
        check("prefs persist across reload", page.evaluate(
            "(t) => (document.documentElement.dataset.theme || '') === t && "
            "getComputedStyle(document.querySelector('.content')).fontSize === '18px'",
            theme_after))
        page.locator("#themeBtn").click()  # back to defaults
        page.locator("#typeBtn").click()
        page.wait_for_timeout(150)
        page.locator("#fsMinus").click()
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

        print("== toc filter ==")
        n_all = page.locator(".toc-item").count()
        page.locator("#tocFilter").fill("registration")
        page.wait_for_timeout(300)
        n_vis = page.locator(".toc-item:not(.filtered-out)").count()
        check("toc filter narrows list", 0 < n_vis < n_all, f"{n_vis}/{n_all}")
        page.locator("#tocFilterClear").click()
        page.wait_for_timeout(250)
        check("toc filter clears",
              page.locator(".toc-item:not(.filtered-out)").count() == n_all)

        print("== xref peek ==")
        opened = page.evaluate("""() => {
            const links = [...document.querySelectorAll('#content a.xref')];
            const hit = links.find(l => document.getElementById((l.getAttribute('href')||'').slice(1)));
            if (!hit) return false;
            hit.scrollIntoView({block: 'center', behavior: 'instant'});
            hit.click();
            return true;
        }""")
        page.wait_for_timeout(400)
        check("xref click opens peek",
              opened and page.locator("#xrefPeek.open").count() == 1)
        check("peek shows target body", page.locator("#peekBody .t").count() >= 1)
        y_before = page.evaluate("() => scrollY")
        page.locator("#peekGo").click()
        page.wait_for_timeout(400)
        check("open § closes peek", page.locator("#xrefPeek.open").count() == 0)
        check("return pill appears", page.locator("#returnPill.visible").count() == 1)
        page.locator("#returnPill").click()
        page.wait_for_timeout(400)
        check("return pill goes back",
              abs(page.evaluate("() => scrollY") - y_before) < 4)
        check("return pill hides after use",
              page.locator("#returnPill.visible").count() == 0)

        ext_info = page.evaluate("""() => {
            const ext = document.querySelector('#content a.xref.xref-ext');
            if (!ext) return null;
            const target = (ext.getAttribute('href') || '').slice(1);
            ext.scrollIntoView({block: 'center', behavior: 'instant'});
            ext.click();
            return { target };
        }""")
        page.wait_for_timeout(300)
        check("xref-ext refs exist", ext_info is not None)
        check("xref-ext click does not open peek",
              page.locator("#xrefPeek.open").count() == 0)
        check("xref-ext click does not jump to the dead target",
              page.evaluate("() => location.hash.slice(1)") != (ext_info or {}).get("target"))

        print("== orphan triage ==")
        page.locator("#orphanStatBtn").click()
        page.wait_for_timeout(400)
        check("orphan panel opens", page.locator("#orphanOverlay.open").count() == 1)
        n_orph = page.evaluate(
            "() => parseInt(document.getElementById('orphanStat').textContent)")
        rows = page.locator("#orphanList .orow").count()
        check("panel lists all unplaced", rows == n_orph, f"{rows} rows vs stat {n_orph}")
        if rows:
            page.locator('#orphanList .orow [data-act="dismiss"]').first.click()
            page.wait_for_timeout(400)
            check("dismiss removes a row",
                  page.locator("#orphanList .orow").count() == rows - 1)
            undo = page.locator(".toast button")
            check("undo offered", undo.count() == 1)
            undo.first.click()
            page.wait_for_timeout(400)
            check("undo restores the orphan",
                  page.locator("#orphanList .orow").count() == rows)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        check("esc closes orphan panel",
              page.locator("#orphanOverlay.open").count() == 0)

        print("== annotation hop ==")
        y0 = page.evaluate("() => scrollY")
        page.locator("#hopNext").click()
        page.wait_for_timeout(800)  # smooth scroll settles
        check("hop next moves viewport",
              abs(page.evaluate("() => scrollY") - y0) > 40)

        print("== position restore ==")
        page.evaluate(
            "() => document.getElementById('r-230-144').scrollIntoView({block: 'start', behavior: 'instant'})")
        page.wait_for_timeout(1000)  # outlast the 600ms save debounce
        page.reload()
        page.wait_for_timeout(1200)
        check("position restored without hash", page.evaluate(
            "() => { const r = document.getElementById('r-230-144').getBoundingClientRect();"
            " return r.top > -300 && r.top < 300; }"))
        check("no js errors in new-feature flows", not errors, errors[:3])

        print("== export payload ==")
        payload = page.evaluate(
            "(k) => JSON.parse(localStorage.getItem(k))", store_key)
        check("payload v2", payload["version"] == 2)
        check("payload doc tag",
              payload["doc"] == store_key.removeprefix("supplementAnnotations.v2."),
              payload["doc"])

        browser.close()

    print()
    if fails:
        print(f"SMOKE TEST: {len(fails)} FAILURES: {fails}")
        return 1
    print("SMOKE TEST: all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
