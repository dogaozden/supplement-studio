#!/usr/bin/env python3
"""Re-recordable demo assets for Supplement Studio (privacy-safe: public-domain
statute text and invented demo metadata only).

    builder/.venv/bin/python3 scripts/demo/record_demo.py --out DIR [--shots] [--video] [--pdf]

--shots  full-size PNG screenshots (1440x900 viewport, 2x device scale):
         landing hero, studio with the template loaded, search for "Rule 10b-5",
         the PDF preview/cover, a typeset spread (contents + a deep '33 Act page),
         the share link popover.
--pdf    the demo PDF (the "Securities Regulation — Standard" template with a
         demo cover, from the studio's own engine) and PNG renders of its cover,
         contents and two interior pages.
--video  a ~25 s screen recording (MP4, H.264, 1440x900, 30 fps, no audio) of
         the core flow: land -> search and add Rule 10b-5 -> add the Securities
         Regulation template -> reorder -> Download PDF -> flip through pages.
Builds the deployable site into a temp dir and serves it (landing at /,
studio at /app/), exactly as Cloudflare Pages would. Needs ffmpeg for --video.
"""
import argparse
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PORT = 8810
DEMO = {
    "title": "Securities Regulation",
    "subtitle": "Selected Statutes, Rules and Forms",
    "course": "Securities Regulation",
    "term": "Fall 2027",
    "professor": "Prof. A. Example",
    "school": "Example University School of Law",
}

# A visible cursor for recordings (headless video has none).
CURSOR_JS = """
(() => {
  const add = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;'
      + 'border-radius:50%;background:rgba(26,25,22,.28);border:2px solid rgba(255,255,255,.9);'
      + 'box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none;transition:transform .12s ease;';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();
"""


def share_fragment(preset_path):
    preset = json.loads(Path(preset_path).read_text())
    state = {"selection": preset["selection"], "mode": "original",
             "metadata": {**DEMO, "groupTitles": preset.get("groupTitles", {})},
             "options": {"trim": "letter", "numbering": "original", "sourceCredits": True, "colophon": True}}
    script = (f"import {{ encodeState, makeNaming }} from {json.dumps((ROOT / 'builder' / 'share.js').as_uri())};\n"
              f"import {{ readFileSync }} from 'node:fs';\n"
              f"const corpus = JSON.parse(readFileSync({json.dumps(str(ROOT / 'builder' / 'corpus.json'))}, 'utf8'));\n"
              f"process.stdout.write(encodeState({json.dumps(state)}, 'securities', makeNaming(corpus)));\n")
    return subprocess.run(["node", "--input-type=module", "-e", script], check=True,
                          capture_output=True, text=True).stdout.strip()


def build_site(dest):
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_site.py"), "--out", str(dest)], check=True,
                   capture_output=True)


def glide(page, selector, steps=18):
    """Move the (visible) cursor smoothly onto an element, then return its center."""
    box = page.locator(selector).first.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y, steps=steps)
    return x, y


def click(page, selector, pause=250):
    glide(page, selector)
    page.wait_for_timeout(120)
    page.locator(selector).first.click()
    page.wait_for_timeout(pause)


def wait_pdf(page, timeout=300_000):
    page.wait_for_function("window.__pdfReady === true || window.__pdfError", timeout=timeout)
    err = page.evaluate("window.__pdfError")
    if err:
        raise SystemExit(f"typesetting failed: {err}")


def wait_drawn(page, page_no, timeout=15_000):
    """Wait until pdf.js has drawn page N of the preview (lazy rendering)."""
    try:
        page.wait_for_function("n => !!document.querySelector(`.pdf-page[data-page=\"${n}\"].is-rendered`)",
                               arg=page_no, timeout=timeout)
    except Exception:
        pass


def goto_prov(page, pid, settle=900):
    n = page.evaluate("id => (window.__pdfProvPages || {})[id] || 0", pid)
    page.evaluate("id => window.dispatchEvent(new CustomEvent('ss:goto', {detail: {id}}))", pid)
    page.wait_for_timeout(450)
    if n:
        wait_drawn(page, n)
    page.wait_for_timeout(settle)


def scroll_preview(page, page_no, settle=700):
    page.evaluate("""n => { const s = document.querySelector('.pv-scroll');
        const el = document.querySelector(`.pdf-page[data-page="${n}"]`);
        if (s && el) s.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' }); }""", page_no)
    page.wait_for_timeout(450)
    wait_drawn(page, page_no)
    page.wait_for_timeout(settle)


# ── screenshots ─────────────────────────────────────────────────────────────
def shots(base, out, frag):
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2,
                            permissions=["clipboard-read", "clipboard-write"])
        pg = ctx.new_page()
        pg.goto(f"{base}/", wait_until="networkidle")
        pg.wait_for_timeout(500)
        pg.screenshot(path=str(out / "01-landing-hero.png"))

        pg.goto(f"{base}/app/{frag}", wait_until="domcontentloaded")
        pg.wait_for_function("window.__corpus != null", timeout=60_000)
        wait_pdf(pg)
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(out / "02-studio-template-loaded.png"))

        pg.keyboard.press("Meta+k" if sys.platform == "darwin" else "Control+k")
        pg.wait_for_selector("#palette[open]")
        pg.type("#palette-input", "Rule 10b-5", delay=40)
        pg.wait_for_timeout(600)
        pg.screenshot(path=str(out / "03-search-rule-10b-5.png"))
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(300)

        scroll_preview(pg, 1, 600)
        pg.screenshot(path=str(out / "04-pdf-preview-cover.png"))
        scroll_preview(pg, 3, 800)
        pg.screenshot(path=str(out / "05-pdf-preview-contents.png"))
        goto_prov(pg, "s-77d", 1200)
        pg.screenshot(path=str(out / "06-pdf-preview-deep-nesting.png"))

        click(pg, "#btn-share", 700)
        pg.screenshot(path=str(out / "07-share-link.png"))
        b.close()


# ── demo PDF + page renders ─────────────────────────────────────────────────
def demo_pdf(base, out, frag):
    import pdfplumber
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(f"{base}/app/{frag}", wait_until="domcontentloaded")
        pg.wait_for_function("window.__corpus != null", timeout=60_000)
        wait_pdf(pg)
        b64 = pg.evaluate("""() => { const b = window.__pdfBytes; let s = '';
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
            return btoa(s); }""")
        prov = pg.evaluate("window.__pdfProvPages")
        b.close()
    pdf = out / "securities-regulation-fall-2027.pdf"
    pdf.write_bytes(base64.b64decode(b64))
    pages = {"pdf-page-cover": 1, "pdf-page-contents": 3,
             "pdf-page-securities-act-s77d": prov["s-77d"], "pdf-page-rule-10b-5": prov["r-240-10b-5"]}
    with pdfplumber.open(str(pdf)) as doc:
        for name, n in pages.items():
            doc.pages[n - 1].to_image(resolution=150).save(str(out / f"{name}.png"))
        count = len(doc.pages)
    print(f"demo PDF: {pdf} ({count} pages)")


# ── video ───────────────────────────────────────────────────────────────────
def video(base, out):
    out.mkdir(parents=True, exist_ok=True)
    raw = Path(tempfile.mkdtemp(prefix="demo-video-"))
    with sync_playwright() as p:
        b = p.chromium.launch()
        # warm the HTTP cache (compiler wasm, fonts, corpus) so the take has no dead loading time
        warm = b.new_context(viewport={"width": 1440, "height": 900})
        wp = warm.new_page()
        wp.goto(f"{base}/app/", wait_until="domcontentloaded")
        wp.wait_for_function("window.__corpus != null", timeout=60_000)
        wp.wait_for_timeout(2500)
        state = warm.storage_state()
        warm.close()

        ctx = b.new_context(viewport={"width": 1440, "height": 900}, record_video_dir=str(raw),
                            record_video_size={"width": 1440, "height": 900}, accept_downloads=True)
        ctx.add_init_script(CURSOR_JS)
        t_ctx = time.time()
        cuts = []
        pg = ctx.new_page()
        pg.goto(f"{base}/", wait_until="networkidle")
        t_start = time.time() - t_ctx
        pg.mouse.move(700, 450)
        pg.wait_for_timeout(1700)                       # read the hero line
        click(pg, "a[href='./app/']", 300)              # Open the studio
        pg.wait_for_function("window.__corpus != null", timeout=60_000)
        pg.wait_for_timeout(1300)                       # first run explains itself

        click(pg, "#supp-title", 100)                   # name the book
        pg.keyboard.press("Meta+a" if sys.platform == "darwin" else "Control+a")
        pg.keyboard.type("Securities Regulation · Fall 2027", delay=40)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(250)
        click(pg, "#fr-search", 150)                    # find a provision by citation
        pg.keyboard.type("Rule 10b-5", delay=75)
        pg.wait_for_timeout(700)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(1000)

        click(pg, "#btn-presets", 700)                  # templates
        card = ".preset-card:has(.name:has-text('Securities Regulation'))"
        merge = f"{card} [data-act='merge']"
        click(pg, merge if pg.locator(merge).count() else card, 1100)

        # reorder: bring the Exchange Act rules part up one place, twice
        part = "#selected .part:has(.part-title:text-matches('Exchange Act', 'i'))"
        for _ in range(2):
            up = f"{part} [data-act='part-up']"
            if pg.locator(up).count() and pg.locator(up).first.is_enabled():
                pg.locator(up).first.scroll_into_view_if_needed()
                click(pg, up, 450)
        # typesetting a 500-page book takes a few seconds: keep 1 s of the
        # "Typesetting…" state in the take and cut the rest in the edit
        t_wait = time.time() - t_ctx
        wait_pdf(pg)
        cuts.append((t_wait + 1.0, time.time() - t_ctx - 0.2))
        pg.wait_for_timeout(500)

        with pg.expect_download(timeout=120_000) as dl:
            click(pg, "#btn-generate", 300)
        dl.value.save_as(str(raw / "demo-download.pdf"))
        pg.wait_for_timeout(500)

        glide(pg, ".pv-scroll")                          # flip through the typeset book
        for n in (1, 3):
            scroll_preview(pg, n, 1000)
        for pid in ("s-77d", "r-230-501", "r-240-10b-5"):
            goto_prov(pg, pid, 1300)
        t_end = time.time() - t_ctx
        webm = pg.video.path()
        ctx.close()
        b.close()

    mp4 = out / "supplement-studio-demo.mp4"
    keep = [f"between(t,{max(0, t_start - 0.1):.2f},{t_end:.2f})"]
    drop = [f"between(t,{a:.2f},{b:.2f})" for a, b in cuts if b > a]
    expr = keep[0] + ("*not(" + "+".join(drop) + ")" if drop else "")
    subprocess.run(["/opt/homebrew/bin/ffmpeg", "-y", "-loglevel", "error", "-i", str(webm),
                    "-vf", f"fps=30,select='{expr}',setpts=N/(30*TB),scale=1440:900:flags=lanczos", "-r", "30",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "18", "-an",
                    "-movflags", "+faststart", str(mp4)], check=True)
    cut = sum(b - a for a, b in cuts if b > a)
    print(f"video: {mp4} ({t_end - t_start - cut:.1f} s after cutting {cut:.1f} s of typesetting wait)")
    shutil.rmtree(raw, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--video", action="store_true")
    ap.add_argument("--pdf", action="store_true")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    site = Path(tempfile.mkdtemp(prefix="demo-site-")) / "deploy"
    build_site(site)
    frag = share_fragment(ROOT / "builder" / "presets" / "secreg-standard.json")
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "-d", str(site)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    base = f"http://127.0.0.1:{PORT}"
    try:
        if args.shots:
            shots(base, out, frag)
        if args.pdf:
            demo_pdf(base, out, frag)
        if args.video:
            video(base, out)
    finally:
        srv.terminate()
        shutil.rmtree(site.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
