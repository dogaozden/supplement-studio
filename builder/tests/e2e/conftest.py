import http.server, json, os, socketserver, threading, time, pytest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

# localStorage key of the builder's reactive store (builder/store.js).
STORE_KEY = "stat-supp-builder-v1"


class _Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **kw): pass


@pytest.fixture(scope="session")
def static_server():
    # E2E_PORT lets a second checkout/worktree run the suite alongside this one
    port = int(os.environ.get("E2E_PORT", 8765))
    handler_cls = lambda *a, **kw: _Handler(*a, directory=str(ROOT), **kw)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler_cls) as httpd:
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        time.sleep(0.2)
        yield f"http://127.0.0.1:{port}"
        httpd.shutdown()


# ── shared helpers for the Phase-3 suites (additive; used by
#    test_share_url / test_reader_export / test_pdf_visual /
#    test_mobile_layout) ───────────────────────────────────────────────────

@pytest.fixture(scope="session")
def secreg_preset():
    """The 'Securities Regulation — Standard' built-in template, read from
    disk so test assertions track the shipped file. Ids the checked-in corpus
    does not carry are dropped, as the app drops them when applying it."""
    preset = json.loads((ROOT / "builder" / "presets" / "secreg-standard.json").read_text())
    corpus = json.loads((ROOT / "builder" / "corpus.json").read_text())
    have = {s["id"] for a in corpus["acts"] for s in a["sections"]}
    have |= {r["id"] for g in corpus["regulations"] for r in g["rules"]}
    preset["selection"] = [i for i in preset["selection"] if i in have]
    return preset


@pytest.fixture
def boot_builder(static_server):
    """boot(page): open the builder with a clean localStorage and wait for
    the corpus. The clear+reload mirrors test_pdf_render.py — contexts are
    already isolated, but this also guards against same-context reuse."""
    def _boot(page):
        page.goto(f"{static_server}/builder/index.html",
                  wait_until="domcontentloaded")
        page.wait_for_function("window.__corpus != null", timeout=30_000)
        page.evaluate("localStorage.clear()")
        with page.expect_navigation(wait_until="domcontentloaded", timeout=30_000):
            page.evaluate("location.reload()")
        page.wait_for_function("window.__corpus != null", timeout=30_000)
    return _boot


@pytest.fixture
def apply_preset():
    """apply(page, name): pick a built-in preset card from the Presets
    modal (the e2e selector contract: #btn-presets / .preset-card / .name)."""
    def _apply(page, name="Securities Reg"):
        page.click("#btn-presets")
        page.wait_for_selector(".preset-card")
        page.click(f".preset-card:has(.name:has-text('{name}'))")
    return _apply


def collect_errors(page, sink):
    """Wire pageerror + console-error collection into `sink` (a list)."""
    page.on("pageerror", lambda e: sink.append(f"pageerror: {e}"))
    page.on("console",
            lambda m: sink.append(f"console: {m.text}") if m.type == "error" else None)
