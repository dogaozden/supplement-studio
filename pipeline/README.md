# Reader pipeline

Corpus → manifest → **single-file offline annotatable reader**. `build_reader.py` is the reference
renderer; the studio's in-browser reader export (`builder/reader/render-section.js`) must produce
byte-identical sections (`builder/tests/test_reader_parity.py`).

```bash
python3 pipeline/build_reader.py \
    --corpus builder/corpus.json \
    --manifest pipeline/manifest_secreg.json \
    --out out/secreg-reader.html

builder/.venv/bin/python3 pipeline/smoke_test.py out/secreg-reader.html   # Chromium checks
```

A new reader is a new manifest: `manifest_insider_trading.json` is a hand-written example
('34 Act + the Rule 10b-5 family, 14 provisions); `manifest_secreg.json` covers the '33 Act,
Schedules A–B, 17 C.F.R. Part 230 and Regulation S-K.

| file | role |
|---|---|
| `build_reader.py` | corpus + manifest → reader HTML + `<out>-text.json` text sidecar |
| `smoke_test.py` | Chromium run over a secreg reader: navigation, highlight, note, persistence, search |
| `../builder/reader/template/` | shell.html + reader.css + reader.js, the embedded runtime shared with the studio's reader export |

## Anchor model (why highlights survive edition updates)

Every highlight stores:

```json
{
  "text": "exact canonical text",
  "sectionId": "s-77b",
  "occurrence": 2,
  "textBefore": "...40 chars", "textAfter": "40 chars..."
}
```

Restoration walks the section's DOM text nodes, builds a canonicalized string (curly→straight
quotes, dash unification, whitespace collapse), finds the nth occurrence, and wraps each
intersecting text-node segment. When `occurrence` fails (the text changed), the context strings
break ties; failures surface as orphans in the UI, never silently.
