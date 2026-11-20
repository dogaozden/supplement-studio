# corpus.json — the adapter interface for new domains

`corpus.json` is the seam between domain-specific ingestion and
everything downstream (the builder UI, the PDF composer, the reader
renderer, share URLs, annotation anchoring). To add a new body of law —
another USC title + CFR chapter, or a state code — you write an
**adapter** that emits this schema. Nothing downstream changes.

The securities corpus is built by `builder/build/build_corpus.py` from
a per-corpus config:

```
builder/.venv/bin/python3 builder/build/build_corpus.py \
    --config builder/build/corpora/securities.json --ecfr-date YYYY-MM-DD
```

Running with no `--config` uses the securities config (back-compat).
The runtime registry `builder/corpora.json` lists shipped corpora:

```jsonc
{"version": 1, "default": "securities",
 "corpora": [{"id": "securities", "label": "Federal Securities Laws",
              "path": "./corpus.json"}]}
```

## 1 · Top-level schema

```jsonc
{
  "version": "1",
  "generated_at": "2026-04-15T16:03:07Z",     // ISO-8601 UTC
  "source": {                                  // provenance / currency line
    "usc_release_point": "119-134",
    "usc_generated": "2026-10-23",
    "usc_release_label": "Public Law 119-134 (October 20, 2026)",  // for the currency line
    "ecfr_date": "2026-10-29"
  },
  "meta": { … },                               // § 5 below
  "acts": [ … ],                               // statutes, grouped by act
  "regulations": [ … ],                        // CFR parts (may be [])
  "presets": []                                // reserved; presets ship separately
}
```

### acts

```jsonc
{
  "id": "act-ch2A",                 // stable, see § 4
  "short_title": "Securities Act of 1933",
  "usc_chapter": "15/2A",           // "<title>/<chapter>"
  "pub_law": "", "stat_cite": "",   // reserved
  "original_name_short": "Securities Act",   // for compact labels ("Securities Act § 5")
  "order": 1,                       // display order of the acts (the array is sorted by it)
  "usc_range": "15 U.S.C. §§ 77a–77aa",      // first–last codified section ("… to …" when
                                             // an endpoint itself contains a dash)
  "usc_subchapter": "schIII",       // only on acts split out of a chapter (see below)
  "divisions": [                    // only when the act has 2+ subchapters/parts; a
    {"id": "act-ch98-schI",         // partition of `sections` in order
     "label": "Subchapter I—Public Company Accounting Oversight Board",
     "sections": ["s-7211", "s-7212"]}   // sections before the first subchapter go in a
  ],                                     // leading {"id": "…-general", "label": "General provisions"}
  "sections": [{
    "id": "s-77a",                                          // stable
    "codified": {"num": "77a", "cite": "15 U.S.C. § 77a"},  // codified mode
    "original": {"num": "1", "cite": "Securities Act of 1933 § 1"},  // or null
    "heading": "Short title",
    "status": "active",             // or "repealed"
    "content": [ … ],               // node tree, § 2
    "source_credit": "(May 27, 1933, ch. 38, title I, § 1, 48 Stat. 74.)",
    "notes": [{"heading": "…", "blocks": [{"type": "p", "text": "…"}]}]
  }]
}
```

Both citation modes hang off the section: `codified` (e.g. U.S.C.) and
`original` (the enacted act's own numbering, derived from the source
credit; `null` when unmappable). Adapters for domains without a dual
numbering set `original: null` everywhere and offer only one mode.

**Acts are not always one per chapter.** Some subchapters are separate acts:
chapter 2A subchapter III is the Trust Indenture Act of 1939, subchapter II the
Corporation of Foreign Bondholders Act, 1933; chapter 2D subchapter II is the
Investment Advisers Act of 1940. `uslm.split_acts` in the config carves them out
under new ids (`act-ch2A-schIII`, `act-ch2A-schII`, `act-ch2D-schII`); the
chapter's own act keeps its id (`act-ch2A`) and the remaining sections, so their
original cites read "Trust Indenture Act of 1939 § 301", not "Securities Act of
1933 § 301". Section ids never change.

**`original` is only given when the enacting statute is the act's own.** The
first citation of a source credit names the section's number in the statute that
enacted it. A section enacted as a free-standing part of some other law
(Dodd-Frank § 961, the FCPA, the 1936 amendment act) is not "Exchange Act § 961",
so it gets `original: null` rather than a wrong cite. Config per act:
`original_statute_chapters` (Statutes at Large chapter numbers, e.g. `["404"]`)
or `original_pub_laws` (e.g. `["107-204"]`, for acts enacted by public law). A
section holding schedules (§ 77aa) gets `{"num": "Schedules A, B", "cite":
"Securities Act of 1933 Schedules A, B"}`. Renderers should not prefix such a
number with "Sec.".

### regulations

```jsonc
{
  "id": "cfr-17-p230",              // stable
  "title": "17 CFR Part 230",
  "heading": "PART 230—GENERAL RULES AND REGULATIONS, SECURITIES ACT OF 1933",  // as eCFR prints it
  "part": 230,
  "display_title": "General Rules and Regulations, Securities Act of 1933",     // title-cased
  "short_title": "Rules under the Securities Act of 1933",  // curated default part title
                                                            // (config ecfr.part_short_titles;
                                                            // falls back to display_title)
  "authority_act": "act-ch2A",      // links a part to its enabling act ("" if none)
  "groups": [{                      // one-click selections, in reading order
    "id": "cfr-17-p230-regd",       // stable slug: "reg<id>" for "Regulation X", else the label
    "label": "Regulation D—Rules Governing the Limited Offer and Sale of Securities …",
    "short": "Regulation D",
    "parent": "",                   // id of the enclosing group, "" for top level
    "rules": ["r-230-500", …]       // ALL rules in the group, incl. those of its sub-groups
  }],
  "rules": [{
    "id": "r-230-144",                          // stable
    "cite": "17 C.F.R. § 230.144",
    "common_name": "Rule 144",                  // "" for [Reserved] placeholders
    "short_name": "Rule 144",
    "heading": "Persons deemed not to be engaged in a distribution…",
    "group": "cfr-17-p230-general",             // the most specific group ("" if none)
    "aliases": ["144A"],                        // optional search nicknames (config ecfr.aliases)
    "content": [ … ]                            // same node tree, § 2
  }]
}
```

**Groups.** eCFR's hierarchy is only partly nested (a "Regulation 12B" heading can
be an empty element followed by its sections and sub-headings as siblings), so
groups are derived in document order: a nested subject group owns its sections; a
section sitting directly under the part belongs to the last "flat" marker (empty
subject group, HED1 center heading, subpart); a non-"Regulation" subject group
that follows a flat top-level marker becomes its sub-group while its rules share
the marker's rule-number family (Regulation 12B takes 12b-1…12b-37, not 12d1-1).
Subparts are groups only when the part has two or more real subparts (or the
subpart is itself a "Regulation …", like Regulation SCI). Groups without rules are
dropped.

**Names** (`ecfr.name_style[<part>]` in the config): `kind` `rule` ("Rule 144",
"Rule 4-01 of Regulation S-X"), `item` ("Item 404 of Regulation S-K") or `form`
(the form named in the heading: "Form S-1"); `of` the regulation the rule belongs
to; `use_group` takes "of Regulation SHO/NMS/AB…" from the subject group's name;
`schedules` names "Schedule 13D/14A" rules by their schedule. `common_names`
overrides any of it; `short_name` is the same without "of …".

## 2 · Content node grammar

`content` is a tree of typed nodes. The PDF composer and both reader
renderers (`pipeline/build_reader.py` ⇄ `builder/reader/render-section.js`)
understand exactly this grammar — emit nothing else.

**Containers** (`subsection` → `paragraph` → `subparagraph` → `clause`
→ `subclause` → `item`):

```jsonc
{
  "type": "paragraph",
  "num": "1",            // marker without parens; "" allowed
  "heading": "…",        // "" when absent
  "text": "…",           // leaf-style body (optional)
  "children": [ … ]      // nested nodes (optional)
}
```

A container carries `text`, or `children`, or both (text first, then
children). The canonical order above is conventional, not enforced —
renderers nest whatever order the source uses (CFR paragraphs often
skip levels). Render depth clamps at 6 (`MAX_DEPTH`).

**C.F.R. nesting (`fetch_ecfr.py`).** C.F.R. paragraphs have six levels:
`(a)` / `(1)` / `(i)` / `(A)` / italic `(1)` / italic `(i)`. eCFR marks the last
two with italics (`(<I>1</I>)`, `<I>(1)</I>`), and the parser reads them: an
italic digit is the fifth level, an italic letter the sixth (an italic capital the
seventh), so the items under an `(A)` nest under it instead of falling to root
level. A marker never resets the nesting; only an unmarked paragraph or an HD
subheading does. A plain `(2)` that is the next number after an open `(1)`
continues that list wherever the stack has grown to. `(i)`, `(v)`, `(x)`, `(ii)`,
`(xx)` are letters or numerals depending on context (an open list they continue,
then what follows them, then what leads into them), and numerals run to `(xlix)`.
A run-in heading ended by an em dash that introduces the next marker
(`(c) <I>Summary compensation table</I>—(1) <I>General.</I> …`) becomes `(c)`'s
`heading` plus a nested `(1)` with its own heading; the dash is dropped (renderers
print the period), and `verify_corpus.py` reads exactly that dash as the period
and counts it (`heading_dash` in `verify_report.json`). A plain-text lead-in before
such a dash, and an unmarked paragraph, keep their dash and text unchanged.

**Leaves** (always `{"type": …, "text": …}`):

- `p` — plain paragraph (also the only type valid inside `notes` blocks
  together with other pass-through note tags). An optional extra key
  `"role"` says what the paragraph is, so a renderer can set it apart; renderers
  that don't know a role print it as an ordinary paragraph (the reader renderers
  ignore unknown keys, which is what keeps them byte-identical):

  | role | meaning |
  |---|---|
  | `note-heading` | heading of a regulation NOTE / cross reference / example ("Note 1 to paragraph (a)(5):") |
  | `note` | a paragraph of such a note, or a note-like unnumbered paragraph ("Instruction to paragraph …") |
  | `heading` | a section-level subheading (HD1–3: "Preliminary Notes") or a table caption |
  | `footnote` | a footnote body; text starts with its marker (below) |
  | `omitted` | placeholder for an image/equation the corpus cannot carry |

  Notes attach where they belong: a note whose heading names a paragraph ("Note to
  paragraph (a)(5)", "Note to § 230.144(d)(3)(ii)") is a child of that paragraph;
  an unaddressed "Note:" follows the paragraph it appears after; a note to the whole
  rule sits at root level. A note never resets the nesting of the paragraphs after it.

- **Footnote markers.** A reference spot in running text is a run of Unicode
  superscript digits ("¹", "⁷⁷") glued to the preceding word, and the footnote
  paragraph (`role: "footnote"`) starts with the same run followed by a space
  ("¹ So in original."). It sits right after the paragraph that carried it (as that
  paragraph's first child when it is a container). Headings never carry a marker.
  Superscript digits survive both reader renderers untouched (all text is
  HTML-escaped) and a composer can turn them into `<sup>` with one regex
  (`textutil.FOOTNOTE_MARK_RE`); EB Garamond regular/medium/semibold have the
  glyphs (the italic faces do not).
- **Run-in headings.** On a numbered container, an italic run-in heading
  ("(a) *Definitions.*") is stored in `heading` without its trailing period, like
  statute headings. Unnumbered `p` nodes keep such words inside `text` (readers
  only render `heading` on containers). Statute run-in headings keep the
  source's own trailing "—" where it has one ("Funding portal.—").
- `chapeau` — introductory text of a subdivided provision; renders at
  its parent's depth.
- `continuation` — "flush" text resuming after nested items; renders at
  `depth − 1`.
- `signature` — signature line (appears in presidential-message notes).

**Tables**:

```jsonc
{"type": "table", "html": "<table><thead>…</thead><tbody>…</tbody></table>"}
```

`html` is sanitized table markup only (`table/thead/tbody/tr/th/td`; the
only attributes are `colspan`/`rowspan`; no inline styles; cell text is
HTML-escaped). Table captions come out as a `role: "heading"` paragraph just
before the table. Tables pass through verbatim and contribute **no** annotation
anchor text.

## 3 · Cross-reference markup

Inside any `text` value, internal cross-references are pre-resolved
anchors:

```html
<a class="xref" data-to="s-77j">section 77j of this title</a>
```

- `data-to` is a corpus id (§ 4). It is the **only** attribute besides
  `class="xref"`.
- All other markup in `text` is forbidden — text is otherwise plain
  (HTML-escaped at render time; the xref tags are recognized and
  re-emitted by the renderers).
- Renderers translate the link text for citation mode and drop/keep the
  anchor depending on whether the target is in the document. Adapters
  only resolve targets to ids; presentation is downstream's job.

**Resolvability guarantee.** After statute parsing and eCFR linkification
both run, `build_corpus.py`'s final pass walks every `content` tree (acts
and regulations) and unwraps any xref anchor whose `data-to` base id isn't
a section/rule id present in that build, keeping the inner text. A built
corpus therefore contains **only** xref anchors that resolve within
itself — a USC ref into another title, or a CFR ref into an unfetched
part, degrades to plain text by construction, not by luck.

The eCFR adapter (`fetch_ecfr.py`) linkifies rule text on the way in, so
regulations get the same treatment as statutes: CFR `§`/`§§`/`N CFR X.Y`
refs resolve to rule ids when their target part is among the ones fetched;
`section N of the Act` / `section N of the <act short_title>` refs resolve
via the original↔codified section table, with subsection parens riding
along as `/`-separated `data-to` path segments, same as the statute-side
convention above. A capitalized shorthand of an act's own name (e.g. "the
Exchange Act" for "Securities Exchange Act of 1934" — its last two words,
or its full name minus a trailing " of \<year\>") resolves the same way;
a shorthand more than one act's name would derive is ambiguous and left
unresolved rather than guessed. Both linkifiers are conservative — an
ambiguous or unresolvable reference is left as plain text rather than
guessed.

## 4 · Id stability — the one hard rule

**Ids are permanent.** Share URLs (`docs/contracts.md` § 5) serialize
selections as ids, and reader annotations re-anchor by section id +
anchor text. Renaming an id silently breaks every existing share link
and orphans users' annotations.

- An adapter may **add** ids in new builds; it must **never rename or
  reuse** one.
- Repealed/removed provisions keep their id with `status: "repealed"`
  rather than disappearing, when feasible.
- Mint ids from official, immutable citations, not from headings or
  ordering:
  - USC sections: `s-<sectionNum>` (e.g. `s-77a`, `s-78u–4` — note the
    **en-dash** that USLM uses in section numbers; it survives into ids
    and is `~`-escaped in share URLs).
  - Acts: `act-ch<chapter>` (e.g. `act-ch2B–1`).
  - CFR parts: `cfr-<title>-p<part>`; rules: `r-<part>-<suffix>`
    (e.g. `r-230-144`, suffix = section number after the `<part>.`).
- New corpora live in separate corpus files, so ids only need to be
  unique **within** a corpus; still, keep the prefixes (`s-`, `r-`,
  `act-`, `cfr-`) so downstream heuristics keep working.

## 5 · `meta` schema

Emitted from the config's `meta` object (contract: `docs/contracts.md`
§ 8). Downstream UI reads all display strings from here — no hardcoded
domain strings.

```jsonc
"meta": {
  "id": "securities",                  // == registry id; [a-z0-9-]
  "label": "Federal Securities Laws",  // picker / topbar label
  "defaultTitle": "Federal Securities Laws — Statutory Supplement",
  "uscCitePrefix": "15 U.S.C.",        // statute cite prefix to strip/show
  "cfrCitePrefix": "17 C.F.R.",        // regulation cite prefix
  "modes": {                           // citation-mode toggle labels
    "codified": "Codified (U.S.C.)",
    "original": "Original acts"
  }
}
```

Consumers shim missing `meta` (corpus files predating it) with the
securities values.

## 6 · Checklist — adding a new federal corpus

1. **Config**: copy `builder/build/corpora/securities.json` →
   `corpora/<id>.json`. Set `id`; `uslm.title`, `xml_path`,
   `target_chapters`, `cite_prefix`, `act_names` (chapter-id →
   popular-name map; drives `original` cites and act `short_title`s);
   `ecfr.title`, `chapter`, `parts`, `cite_prefix`, `common_names`,
   `authority_map` (part → act id); `meta` (must satisfy
   `corpus_config.validate_config` — `meta.id == id`, both mode labels).
   Optional per-act config: `uslm.act_meta[<title>/<chapter>]`
   (`original_name_short`, `order`, `original_statute_chapters` |
   `original_pub_laws`), `uslm.split_acts` (subchapters that are separate acts),
   `ecfr.name_style`, `ecfr.aliases`, `ecfr.acronyms` (kept upper-case when
   title-casing headings). Set `act_names` for every chapter that should get
   `original` cites; unnamed chapters get none.
2. **Source XML**: download the title's USLM XML release point to
   `uslm.xml_path`. `python -m builder.build.check_releases` prints the newest
   **downloadable** one: OLRC sometimes lists a release point (119-136) whose zip
   404s, so it HEAD-checks the zip and falls back to the newest prior release point
   that downloads, recording which and why in `usc_release_note`. The weekly
   `.github/workflows/refresh-corpus.yml` does exactly this.
3. **Build**: `build_corpus.py --config builder/build/corpora/<id>.json
   --ecfr-date <date> --release-info release.json` (the checker's JSON; supplies
   `source.usc_release_label` and the manifest's `usc_release_note`) — verify
   section/rule counts against the official source. The raw eCFR XML is cached
   in `builder/build/.cache/ecfr/` (self-gitignored). eCFR requires
   `Accept-Encoding: gzip`; `builder/build/net.py` sends it. A part that can't
   be fetched fails the build.
4. **Spot-check the grammar**: deep nesting, chapeau/continuation,
   tables, xref `data-to` resolution (unresolvable refs should degrade
   to plain text, not bad ids).
5. **Sourcecredit coverage**: `map_sourcecredit.py` parses the federal
   credit shapes (old-style, Pub. L., "as added" / "as added and amended",
   "§ 1(a)" subdivisions, "formerly § 7" renumbering, "schedules A, B").
   Inspect sections where `original` is null (they are either sections
   enacted by some other law, or a credit shape not yet covered); extend
   patterns if the title uses other shapes.
6. **Verify**: `python -m builder.build.verify_corpus` must exit 0 and
   writes `builder/verify_report.json` (see § 8).
7. **Register**: add `{id, label, path}` to `builder/corpora.json`
   (one corpus file per domain; don't merge corpora).
8. **Tests**: add a small USLM/eCFR fixture + golden for the new config
   (pattern: `builder/tests/test_corpus_config.py`,
   `test_build_corpus_golden.py`).
9. **Parity**: run the reader-renderer parity suite over the new corpus
   (`PARITY_FULL=1`) before shipping a reader export for it.

## 7 · State-law adapters (no USLM)

State codes don't ship USLM XML, so skip `parse_uslm` entirely and
write a parser that emits the schema directly:

- **Map structure onto the node grammar.** Whatever the state calls its
  subdivisions (sections/subdivisions/paragraphs…), express nesting with
  the container types in § 2 in order of depth — the type names drive
  indentation/numbering style, not legal semantics. Use `chapeau` /
  `continuation` for split-flow text and `p` for undivided bodies.
- **Mint ids from official citations**: e.g. Delaware General
  Corporation Law § 141(a) → section id `s-degcl-141` (pick one scheme
  per corpus, document it in the config, never change it). Prefix with
  a corpus-unique slug so ids stay unmistakable.
- **Citation modes**: most state codes have a single numbering — set
  `original: null` and label only `modes.codified` appropriately (e.g.
  `"8 Del. C."`). The `modes` object still needs both keys; reuse the
  codified label for `original` until the UI grows single-mode support.
- **`regulations`**: state administrative codes fit the regulations
  shape (`authority_act` linking rule → statute where known); otherwise
  emit `"regulations": []`.
- **Currency**: populate `source` with whatever provenance the state
  publishes (session-law cutoff, last-amended date) — the cover/colophon
  currency line reads from it.
- The build entry point can be a sibling script (`build_corpus_<id>.py`)
  reusing `corpus_config.load_config` + the same JSON emission; the
  config file and output schema are the contract, not the script.

## 8 · Verification — proof that the text is the official text

`python -m builder.build.verify_corpus` re-derives, for **every** provision,
the word sequence straight from the source XML with an extractor that shares no
code with the parsers, and compares it with the corpus text as a reader sees it
(xref anchors and footnote markers removed). It writes `builder/verify_report.json`
and exits 1 on any non-whitespace mismatch.

```jsonc
{
  "usc_release_point": "119-134", "ecfr_date": "2026-10-29",
  "corpus_generated_at": "…",   // ties the report to one build of corpus.json
  "generated_at": "…",
  "checked": 1905, "exact": 1884, "whitespace_only": 21,
  "by_kind": {"usc": {"checked": 309, "exact": 309}, "ecfr": {"checked": 1596, "exact": 1575}},
  "mismatches": [{"id": "…", "ratio": 0.99, "first_diff": {"corpus": "…", "source": "…"}}],
  "whitespace_only_detail": [{"id": "…", "ratio": 1.0, "first_diff": {…}}],  // explained residuals
  "image_placeholders_in": ["r-275-205-1", …],   // rules where an image became a placeholder
  "method": "…"
}
```

What counts as source text is stated in the module docstring: statutes exclude the
section's own number and heading, source credit, notes and footnotes (footnote
bodies and headings are checked separately); rules exclude HEAD, CITA, SECAUTH,
EDNOTE (editorial note) and XREF, and include notes, extracts, subheadings,
footnotes and table cells. `whitespace_only` means identical characters with
different spacing: today that is a reserved range like "(a)-(b) [Reserved]"
(rendered "(a) -(b)", because a marker is always followed by a space), a marker
the source glues to its text, and a footnote digit that sat between two spaces.
The weekly refresh runs verify after the build and fails before opening the PR
on any mismatch; `test_verify_corpus.py` fails if the committed report doesn't
match the committed corpus.
