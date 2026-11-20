# Coverage: what the next courses need

Supplement Studio's corpus adapter is generic (`builder/build/corpora/*.json` → `corpus.json`, schema in
`docs/corpus-adapter.md`): a U.S. Code title from OLRC's USLM XML plus C.F.R. parts from the eCFR Versioner API.
Securities regulation (15 U.S.C. ch. 2A, 2B, 2B-1, 2D, 98; 17 C.F.R.) is the only corpus built today. This note
records what each likely next course needs, where its official text comes from, whether that text may be reused,
and how hard it is. None of these is built yet.

Research date: November 2026. Items marked *(verified)* were fetched and checked by hand; the rest is from the
cited pages.

## Summary

| course | source | reuse | effort | verdict |
|---|---|---|---|---|
| Federal Rules (Civ. P., Evid., App. P., Crim. P.) | OLRC USLM: Title 28 and 18 Appendices | public domain | small: one new adapter element (`courtRule`) | **best next course** |
| Federal income tax (26 U.S.C. + 26 C.F.R. Part 1) | OLRC USLM title 26; eCFR title 26 | public domain | moderate: deeper hierarchy, tables, images, size | good, pick-sections only for regs |
| Delaware General Corporation Law (8 Del. C. ch. 1) | delcode.delaware.gov HTML/PDF | text likely public domain, but see § 397 | moderate parsing; **legal risk** | ask Delaware first |
| Other state law | per-state official sites/APIs | varies by state | one adapter per state | on demand |
| UCC, MBCA official text and comments | ALI/ULC, ABA | **copyrighted** | — | blocked; use enacted state versions |

## Federal Rules of Civil Procedure, Evidence, Appellate and Criminal Procedure (easy)

- **Source.** OLRC publishes the rules inside the USLM release-point zips: `xml_usc28a` (Title 28 Appendix: FRAP, FRCP,
  FRE; ~1.1 MB zip) and `xml_usc18a` (Title 18 Appendix: FRCrP; ~0.5 MB zip), from
  <https://uscode.house.gov/download.html>. The bankruptcy rules appear to be in `xml_usc11a` (not checked).
- **Structure.** `courtRules > title/article > courtRule`, with stable identifiers such as
  `/us/usc/t28a/courtRules/Civil/rule26`; about 114 FRCP rule elements (with forms), 69 FRE, 55 FRAP, 77 FRCrP.
  Inside a rule the subdivision markup matches what `parse_uslm.py` already handles.
- **Committee notes.** Advisory Committee Notes are included and make up ~83% of the FRCP text; they need a
  per-supplement toggle (most professors want the rules alone, some want the notes).
- **Reuse.** Federal government works: no copyright (17 U.S.C. § 105, <https://www.law.cornell.edu/uscode/text/17/105>).
  The Appendix is "not enacted as part of the title" (positive-law status note on the download page), which does not
  affect reuse.
- **Currency.** The release point carries the rules as amended; December 1 amendments appear in the first release
  point after they take effect, so the currency line needs the rule-amendment date as well as the release point.
- **Work.** Add a `courtRule` element (ids `fr-civ-26` etc.), a corpus config per rule set, citation forms
  ("Fed. R. Civ. P. 26(b)(1)", "FRE 403") for search and headings, and the notes toggle.

## Federal income tax (moderate)

- **Statute.** `xml_usc26@<release>.zip` from OLRC (~8.3 MB zipped, ~56 MB XML; 2,162 sections under 11 subtitles,
  72 chapters, 165 subchapters, 185 parts, 103 subparts; 241 repealed). Title 26 is not positive law (no asterisk on
  the download page) but is the official prima facie text.
  - The parser currently gathers sections per chapter; tax needs the subtitle → chapter → subchapter → part → subpart
    hierarchy for browsing and one-click selection ("Subchapter K").
  - Statutory notes are ~53% of the text (effective-date and amendment notes); keep them optional (they are already
    stripped from the deployed corpus).
  - 75 statutory tables (e.g. § 1 rate tables) — the PDF engine already sets tables.
  - Very long sections (§ 401 ~394k characters with notes, § 168, § 6103) are fine for the engine.
  - Title 26 changed in 4 of the last 10 release points, so the weekly refresh matters.
- **Regulations.** 26 C.F.R. Part 1 via the eCFR Versioner API: ~70 MB XML, 3,779 sections, ~2,500 tables, 295
  `<img>` graphics and 161 `MATH` elements. Too big to ship whole: build a pick-list corpus (or lazy per-section
  fetch at build time) and inline images as data URIs. The eCFR API requires `Accept-Encoding: gzip`.
- **Reuse.** Public domain (§ 105); Federal Register/C.F.R. text may be reproduced without restriction
  (1 C.F.R. § 2.6).

## Delaware General Corporation Law (moderate parsing, legal risk)

- **Source.** delcode.delaware.gov: per-subchapter HTML (`/title8/c001/sc01/index.html` …; ~204 sections in 18
  subchapters; flat `p.subsection` / `p.indent-N` markup, so nesting must be inferred from the indent class) and an
  authenticated PDF of Title 8 stating its currency (e.g. "through 85 Del. Laws c. 550", October 2026). No XML or
  bulk download. The official HTML has no annotations.
- **Reuse.** *Georgia v. Public.Resource.Org, Inc.*, 590 U.S. 255 (2020), holds that officials with lawmaking authority
  cannot be "authors" of the works they create in that capacity, which places the enacted text outside copyright
  (<https://www.law.cornell.edu/supremecourt/text/18-1150>). **But** 8 Del. C. § 397 provides: "Whoever prints or
  publishes this chapter without the authority of the Secretary of State of this State, shall be fined not more than
  $500 or imprisoned not more than 3 months, or both." No reported decision tests § 397 against the federal
  copyright/edicts doctrine, and it is a criminal statute; Public.Resource.Org has posted Title 8 since 2014 without a
  reported response.
- **Recommendation.** Write to the Delaware Secretary of State (Division of Corporations) for authorization before
  shipping a DGCL corpus; it is a small, reasonable ask for a free educational tool. Build the adapter only after that.

## State law generally (hard: bespoke per state)

- No common format. Some states publish structured text (secondary report, Oct 2026: Virginia JSON/XML API
  *(verified: JSON responds)*, Utah XML, New York JSON (free key), Michigan and Iowa XML per chapter, California's
  `pubinfo` zip (1.3 GB) with code tables *(verified size)*); most publish HTML only.
- Copyright: after *Georgia v. PRO* the statutory text itself is not copyrightable when written by legislators, but
  some states historically asserted rights in their compilations or annotations (e.g. Mississippi, Idaho; Oregon
  dropped its claim in 2008). Check each state's site terms before building.
- Avoid third-party compilations as sources: Cornell LII's markup is CC BY-NC-SA (<https://about.law.cornell.edu/terms/>);
  Public.Resource.Org bulk copies are mostly 2013–2017 and stale.
- Approach: one adapter per state on demand (HTML scraper → corpus.json), with a verification step like
  `builder/build/verify_corpus.py` comparing against the official source.

## Uniform and model acts (blocked)

- The UCC (ALI and ULC) and the Model Business Corporation Act (ABA) are copyrighted; reprinting requires permission and
  usually a fee (<https://ali.org/publications/reprint-permission>). LII's UCC is licensed only for study, teaching
  and research and omits the official comments.
- Workaround: a state's **enacted** version (e.g. a state's Article 9) is that state's statute and comes in through the
  state route — without the official comments.

## Checklist for adding a corpus

1. Config in `builder/build/corpora/<id>.json` (source, divisions, citation prefixes, act or rule-set names, common
   names) and a registry entry in `builder/corpora.json`.
2. Permanent ids (`docs/corpus-adapter.md`): never renamed after release, because share links and reader annotations
   depend on them.
3. `verify_corpus.py` must re-derive every provision from the source and match word for word.
4. Search: citation grammar for the new body of law (e.g. "Fed. R. Civ. P. 26(b)(1)", "I.R.C. § 1031", "8 Del. C.
   § 141(a)").
5. A template (`builder/presets/`) for the standard course.
6. The weekly refresh workflow learns the new source's currency marker.
