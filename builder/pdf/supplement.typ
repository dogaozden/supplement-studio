// Supplement Studio: book template (Typst 0.14).
// Renders /data.json produced by builder/pdf/document.js. The template never
// interprets legal text: it lays out parts, provisions and paragraphs, and
// turns the precomputed link targets into PDF links.

#let data = json("/data.json")
#let M = data.meta

// ── trim, measure, type ──────────────────────────────────────────────────
#let trims = (
  "letter": (w: 8.5in, h: 11in, size: 11pt, inside: 1.1in, outside: 1.8in, top: 1in, bottom: 0.95in),
  "7x10":   (w: 7in,   h: 10in, size: 10.2pt, inside: 0.85in, outside: 1.05in, top: 0.85in, bottom: 0.8in),
  "6x9":    (w: 6in,   h: 9in,  size: 9.6pt,  inside: 0.78in, outside: 0.72in, top: 0.78in, bottom: 0.72in),
)
#let T = trims.at(M.trim, default: trims.at("letter"))

#let ink = rgb("#1A1916")
#let ink2 = rgb("#45423B")
#let ink3 = rgb("#77736A")
#let rule-c = rgb("#CFC9BC")
#let accent = rgb("#8A2A1E")
#let link-int = 0.45pt + rgb("#A39B8C")
#let link-ext = (paint: rgb("#A39B8C"), thickness: 0.6pt, dash: "loosely-dotted")

#let serif = ("EB Garamond", "Libertinus Serif")
#let step = 1.35em     // indent per nesting level
#let hang = 2.05em     // width of the hanging number column

#set document(
  title: M.title,
  author: if M.professor != "" { M.professor } else { M.product },
  keywords: ("statutory supplement", "securities regulation"),
)
#set text(font: serif, size: T.size, lang: "en", region: "us", fill: ink,
  hyphenate: true, costs: (widow: 1000%, orphan: 1000%, hyphenation: 55%, runt: 300%))
// Body rhythm: a paragraph break is exactly one line (1.2 em baseline to baseline, as within a
// paragraph), so the subsections of a statute sit on an even grid.
// Justification: Typst leaves a line short of the margin when it would need more than the maximum
// word space. Letting spaces shrink to 65% and hyphenating a little more readily (the costs above)
// gives the line breaker room to avoid that. Measured on the Standard template (Letter): short
// mid-paragraph lines 101 -> 45 of 22,700, tight lines unchanged (2.9%), hyphens 11% of lines.
// (A 60% floor left visibly tight lines; letter-spacing suppressed hyphenation and made it worse.)
// A paragraph ending on a lone hyphenated fragment ("Prin- / ciples.") costs three times the usual
// runt: 105 -> 75 of them on 6x9, 59 -> 47 on Letter.
#set par(justify: true, leading: 0.55em, spacing: 0.55em, linebreaks: "optimized",
  justification-limits: (spacing: (min: 65% + 0pt, max: 150% + 0pt)),
  first-line-indent: 0pt)
#show heading: it => none
// A designator never breaks at its hyphen: "Form 8-/K", "Regulation S-/K".
// Typst already keeps a hyphen with a following digit ("10b-5", "13d-1"), and
// a box would let a line break at its edge ("13d-1" / "(a)"), so only a hyphen
// before a letter is boxed. Plain text stays in the PDF, so search finds "8-K".
// (The box gets its measured width: an auto box would still wrap inside a narrow table column.)
// Acronyms ("NASDAQ", "EDGAR") and "N/A" are never broken either.
#show regex("\b(?:[0-9A-Z][0-9A-Za-z.]{0,9}-[A-Z][A-Za-z]{0,4}|N/A|[A-Z]{4,})\b"): it => context box(width: measure(it).width, it)
// An em dash never starts a line: document.js glues it to the word before with U+2060; the word
// and its dash are set as one box and the joiner is dropped, so it never reaches the text layer.
#show regex("[^\s\u{2060}]*\u{2060}\u{2014}"): it => context box(width: measure(it).width, it.text.replace("\u{2060}", ""))
#set footnote.entry(separator: line(length: 22%, stroke: 0.4pt + rule-c), gap: 0.4em, clearance: 0.9em)
#show footnote.entry: set text(size: 0.8em, fill: ink2)   // headings exist for the PDF outline; visible titles are set by hand

// Small caps — but EB Garamond's small-cap digits read as letters ("229.IOO"),
// so digit runs inside a small-caps string are set as small lining figures.
// Display titles break into lines of even length ("Rules under the Securities / Exchange Act of
// 1934", not "… Exchange Act of / 1934"): the narrowest width that keeps the same line count.
#let balanced(body) = layout(size => {
  let full = measure(block(width: size.width, body)).height
  if full <= measure(body).height * 1.2 { return body }
  let (lo, hi) = (size.width * 0.4, size.width)
  for _ in range(10) {
    let mid = (lo + hi) / 2
    if measure(block(width: mid, body)).height > full { lo = mid } else { hi = mid }
  }
  block(width: hi, body)
})
// A heading's last line holds at least two words (no lone "cases").
#let tie(s) = {
  let w = s.split(" ")
  if w.len() < 4 { s } else { w.slice(0, -2).join(" ") + " " + w.at(-2) + "\u{a0}" + w.last() }
}

#let sc(body) = {
  if type(body) != str { return text(tracking: 0.04em, smallcaps(all: true, body)) }
  text(tracking: 0.04em, {
    for m in body.matches(regex("[0-9]+|[^0-9]+")) {
      if m.text.at(0) in "0123456789" { text(size: 0.8em, number-type: "lining", m.text) }
      else { smallcaps(all: true, m.text) }
    }
  })
}
#let lining(body) = text(number-type: "lining", body)

// ── runs -> content ──────────────────────────────────────────────────────
#let run(x) = {
  if type(x) == str { x }
  else if "l" in x { link(label(x.l), underline(stroke: link-int, offset: 1.6pt, evade: false, x.t)) }
  else if "u" in x { link(x.u, underline(stroke: link-ext, offset: 1.6pt, evade: false, x.t)) }
  else if x.at("i", default: false) { emph(x.t) }
  else if x.at("sup", default: false) { super(size: 0.7em, x.t) }
  else if "fn" in x { footnote(x.fn.map(y => if type(y) == str { y } else { y.t }).join()) }
  else { x.t }
}
#let runs(rs) = { for x in rs { run(x) } }

// ── paragraphs ───────────────────────────────────────────────────────────
#let anchor(a) = if a != none { [#metadata(a)#label(a)] }

#let head-run(hd) = {
  if hd == none { return }
  let tail = if hd.ends-with(".") or hd.ends-with("—") or hd.ends-with(":") or hd.ends-with("-") { "" } else { "." }
  emph(hd + tail)
  if not hd.ends-with("—") { h(0.35em) }
}

#let para(p) = {
  let l = p.l
  let s = p.at("s", default: none)
  let small = s in ("fn", "omit")
  let noteish = s in ("note", "noteh")
  let size = if small { 0.9em } else if noteish { 0.94em } else { 1em }
  if s == "subh" {
    let plain = p.r.map(x => if type(x) == str { x } else { x.at("t", default: "") }).join()
    let cites = plain.contains(regex("\\([a-z]{1,5}\\)"))
    block(above: 0.9em, below: 0.45em, sticky: true,
      align(center, if cites { text(size: 0.95em, style: "italic", runs(p.r)) } else { text(size: 0.95em, sc(runs(p.r))) }))
    return
  }
  if s == "noteh" {
    block(above: 0.75em, below: 0.25em, sticky: true,
      pad(left: calc.max(0, l - 1) * step + (if l > 0 { hang } else { 0pt }) + 0.9em,
        text(size: size, style: "italic", runs(p.r))))
    return
  }
  if s == "omit" {
    block(above: 0.5em, below: 0.5em, pad(left: calc.max(0, l - 1) * step + (if l > 0 { hang } else { 0pt }),
      text(size: 0.88em, fill: ink3, style: "italic", runs(p.r))))
    return
  }
  let body = {
    anchor(p.a)
    for x in p.at("a2", default: ()) { anchor(x) }
    if p.h != none { head-run(p.h) }
    runs(p.r)
  }
  if p.n != none {
    // numbered division: number hangs in its own column
    let num = text(number-type: "lining", p.n)
    let lead = if p.n.len() <= 5 { box(width: hang, num) } else { box(num + h(0.45em)) }
    block(width: 100%, above: 0.55em, below: 0.55em,
      pad(left: (l - 1) * step,
        par(hanging-indent: hang, first-line-indent: 0pt, lead + body)))
  } else {
    let inset = (if l > 0 { (l - 1) * step + hang } else { 0pt }) + (if noteish { 0.9em } else { 0pt })
    block(width: 100%, above: 0.55em, below: 0.55em,
      pad(left: inset, text(size: size, fill: if small { ink2 } else { ink },
        par(body))))
  }
}

#let tbl(t) = {
  let cols = t.at("cols", default: calc.max(..t.rows.map(r => r.map(c => c.at("cs", default: 1)).sum())))
  let wide = cols >= 6
  // a wide table takes the full measure, as its caption does (the list indent would cost
  // Item 402's tables a tenth of their width); narrow tables sit at their paragraph's indent
  let inset = if t.l > 0 and not wide { (t.l - 1) * step + hang } else { 0pt }
  let xin = if wide { 2.2pt } else { 4pt }
  let is-head = r => r.all(c => c.at("h", default: false) or c.at("hr", default: false))
  let body-rows = t.rows.filter(r => not is-head(r)).len()
  block(above: 0.7em, below: 0.7em, pad(left: inset,
    // cells hyphenate only a word that can't fit its column; never for a ragged look
    text(size: if wide { 0.72em } else { 0.86em }, number-type: "lining",
      hyphenate: true, costs: (hyphenation: 100000%), {
      set par(justify: false)
      // Column plan for a given width. Wide tables: every column gets at least its longest
      // word (measured; header words in the header's weight) and the room left over goes by
      // content (document.js colWeights), so a prose header takes the width an empty numeric
      // column doesn't need. If the words don't fit, the type is set a little smaller, then long
      // header words may hyphenate (designators and numbers never), then smaller again, never
      // below 80%. Returns (columns, scale); auto columns when even that fails.
      // (upright: the short heads of "X" columns are set rotated and need no width.)
      let upright-col = t.lw.map(p => p.at(3, default: "") != "")
      let plan = (width, upright: false) => {
        if not (wide and t.at("w", default: ()).len() == cols and t.at("lw", default: ()).len() == cols) {
          return (cols, 1.0)
        }
        let hw = (i, w) => if upright and upright-col.at(i) { 0pt } else { measure(text(weight: 600, w)).width }
        let head = range(cols).map(i => hw(i, t.lw.at(i).at(0)))
        let stiff = range(cols).map(i => hw(i, t.lw.at(i).at(2, default: t.lw.at(i).at(0))))
        let body = t.lw.map(p => measure(p.at(1)).width)
        let fixed = cols * (2 * xin + 1pt)
        let scale = 1.0
        let words = range(cols).map(i => calc.max(head.at(i), body.at(i)))
        if words.sum() + fixed > width {
          // whole words a little smaller (to 88%) before any header word breaks; a broken
          // word still needs about three quarters of its width ("Thresh-" of "Threshold")
          let whole = (width - fixed) / words.sum() * 0.98
          if whole >= 0.88 { scale = whole } else {
            words = range(cols).map(i => calc.max(head.at(i) * 0.75, stiff.at(i), body.at(i)))
            if words.sum() + fixed > width { scale = calc.max(0.8, (width - fixed) / words.sum() * 0.98) }
          }
        }
        let mins = words.map(w => w * scale + 2 * xin + 1pt)
        let room = width - mins.sum()
        if room < 0pt { return (cols, scale) }
        let total = t.w.sum()
        (range(cols).map(i => mins.at(i) + room * t.w.at(i) / total), scale)
      }
      let make = (spec, scale, upright: false) => {
        set text(size: scale * 1em)
        table(
          columns: spec,
          stroke: (x, y) => (top: if y == 0 { 0.7pt + ink3 } else { 0.35pt + rule-c }, bottom: 0.7pt + ink3),
          inset: (x: xin, y: 3.2pt),
          align: (x, y) => if x == 0 { left } else { right },
          ..{
            // a head spanning several columns is centred over them, with a rule beneath
            let span = c => c.at("h", default: false) and c.at("cs", default: 1) > 1
            // a row never splits across pages (no "collateral-" / [header] / "ize securities")
            let up = c => upright and c.at("v", default: false)
            let cell(c) = table.cell(colspan: c.at("cs", default: 1), rowspan: c.at("rs", default: 1),
              align: if span(c) or up(c) { center + bottom } else { auto },
              stroke: if span(c) { (bottom: 0.4pt + ink3) } else { (:) },
              breakable: false,
              if up(c) { rotate(-90deg, reflow: true, text(weight: 600, runs(c.r))) }
              else if c.at("h", default: false) { text(weight: 600, runs(c.r)) } else { runs(c.r) })
            let nh = 0
            for r in t.rows { if is-head(r) { nh += 1 } else { break } }
            let head = t.rows.slice(0, nh).flatten().map(cell)
            let body = t.rows.slice(nh).flatten().map(cell)
            if nh > 0 { (table.header(repeat: true, ..head), ..body) } else { body }
          },
        )
      }
      layout(size => {
        let (spec, scale) = plan(size.width)
        // a table that would shrink first sets the heads of its "X" columns upright
        if scale < 1.0 and upright-col.any(x => x) {
          let (spec3, scale3) = plan(size.width, upright: true)
          if scale3 > scale and type(spec3) == array {
            return block(breakable: body-rows > 12, make(spec3, scale3, upright: true))
          }
        }
        // a short table (Item 402's: a header and five rows) never splits across pages, so no
        // row is left alone under a repeated header; long tables break between rows
        block(breakable: body-rows > 12, make(spec, scale))
      })
    })))
}

#let run-state = state("run", none)
// ── one provision ────────────────────────────────────────────────────────
#let provision(it, part, first: false) = {
  if it.at("sub", default: none) != none {
    block(above: if first { 0.4em } else { 1.6em }, below: 0.8em, sticky: true, width: 100%,
      {
        heading(level: 2, outlined: true, bookmarked: true, it.at("subShort", default: it.sub).replace("\u{2060}", ""))
        [#metadata(it.lab + "#sub")#label(it.lab + "#sub")]
        align(center, {
          if not first { line(length: 18%, stroke: 0.4pt + rule-c); v(0.35em) }
          text(size: 1.02em, sc(it.sub))
        })
      })
  }
  block(above: 1.35em, below: 0.55em, sticky: true, width: 100%, {
    heading(level: 3, outlined: true, bookmarked: true, (it.num + "  " + it.head).replace("\u{2060}", ""))
    run-state.update((run: it.run, part: part.title, short: it.short))
    [#metadata((run: it.run, part: part.title, short: it.short))<runmark>]
    [#metadata(it.lab)#label(it.lab)]
    context [#metadata((l: it.lab, p: here().page()))<provpage>]
    set par(justify: false, hanging-indent: 0pt)
    grid(columns: (auto, 1fr), column-gutter: 0.6em,
      text(weight: 600, number-type: "lining", it.num + "."),
      text(weight: 600, hyphenate: false, tie(it.head)),
    )
    if it.num2 != "" {
      v(0.15em)
      text(size: 0.82em, fill: ink3, number-type: "lining", link(it.url, it.num2))
    }
  })
  for b in it.body {
    if b.k == "t" { tbl(b) } else { para(b) }
  }
  if it.at("credit", default: none) != none and M.sourceCredits {
    block(above: 0.5em, below: 0.2em,
      text(size: 0.74em, fill: ink3, hyphenate: false,
        par(justify: false, [#sc[Source] #h(0.3em) #it.credit])))
  }
}

// ── running heads ────────────────────────────────────────────────────────
#let range-text(a, b) = {
  for (one, many) in (("§ ", "§§ "), ("Sec. ", "Secs. "), ("Rule ", "Rules "), ("Item ", "Items ")) {
    if a.starts-with(one) and b.starts-with(one) {
      let x = a.slice(one.len())
      let y = b.slice(one.len())
      // section numbers can contain en dashes themselves (77d–1): space the range dash then
      return many + x + (if x.contains("–") or y.contains("–") { " – " } else { "–" }) + y
    }
  }
  a + " – " + b
}
#let head-rule = line(length: 100%, stroke: 0.4pt + rule-c)
// Running heads: verso = the part, recto = the section at the top of the page
// (the one continuing from the previous page, or the one that starts right at
// the top). Tracked with state rather than querying every section marker on
// every page: the query version needed ~3x the memory on 1,000-page books.
#let running-head() = context {
  let pg = here().page()
  if query(selector(<partmark>).after(here())).any(m => m.location().page() == pg) { return }
  // A blank verso left by "start on a recto" lies between a part's end and the
  // next opener: the last part marker before this page is an end, and it sits on
  // an earlier page. (Inside a part the last marker is that part's opener.)
  let last-marker = query(selector(<partmark>).or(<partend>).before(here())).at(-1, default: none)
  if last-marker != none and last-marker.value == none and last-marker.location().page() < pg { return }
  let cur = run-state.get()
  let after = query(selector(<runmark>).after(here()))
  let nxt = after.at(0, default: none)
  if nxt != none and nxt.location().page() == pg and nxt.location().position().y < T.top + 40pt { cur = nxt.value }
  if cur == none { return }
  // the last section that starts on this page (stop at the first mark on a later page)
  let last = none
  for m in after { if m.location().page() != pg { break }; last = m.value }
  let num = counter(page).display()
  let left-page = calc.even(counter(page).get().first())
  set text(size: 0.78em, fill: ink2)
  let span = if last != none and cur.at("short", default: none) != none and last.short != cur.short {
    range-text(cur.short, last.short)
  } else { cur.at("short", default: none) }
  if left-page {
    grid(columns: (auto, 1fr), lining(num),
      align(right, [#sc(cur.part)#if span != none and span != cur.part [ #h(0.5em)·#h(0.5em) #lining(span)]]))
  } else {
    let head = if last != none and cur.at("short", default: none) != none and last.short != cur.short {
      range-text(cur.short, last.short)
    } else { cur.run }
    grid(columns: (1fr, auto), align(left, lining(head)), lining(num))
  }
  v(-0.35em)
  head-rule
}

#set page(
  width: T.w, height: T.h,
  margin: (inside: T.inside, outside: T.outside, top: T.top, bottom: T.bottom),
  header-ascent: 38%,
  footer: [],
)

// ── cover ────────────────────────────────────────────────────────────────
#page(numbering: none, header: none, margin: (inside: T.inside, outside: T.inside, top: T.top, bottom: T.bottom))[
  #set par(justify: false, leading: 0.5em)
  #v(16%)
  #align(center)[
    #if not lower(M.title).contains("supplement") {
      text(size: 0.82em, fill: accent, tracking: 0.12em, sc[Statutory Supplement]); v(1.3em)
    }
    #text(size: 3.1em, weight: 500, hyphenate: false, tracking: -0.01em, M.title)
    #if M.subtitle != "" { v(0.7em); text(size: 1.32em, style: "italic", fill: ink2, M.subtitle) }
    #v(2.2em)
    #line(length: 3.2em, stroke: 0.6pt + accent)
    #v(2.2em)
    #if M.course != "" { text(size: 1.18em, M.course) }
    #if M.term != "" { linebreak(); v(0.15em); text(size: 1.05em, style: "italic", fill: ink2, M.term) }
    #if M.professor != "" { v(1.3em); text(size: 1.12em, M.professor) }
    #if M.school != "" { linebreak(); v(0.1em); text(size: 0.9em, fill: ink2, tracking: 0.06em, sc(M.school)) }
  ]
  #v(1fr)
  #align(center, block(width: 74%)[
    #set par(justify: false, leading: 0.55em)
    #line(length: 100%, stroke: 0.4pt + rule-c)
    #v(0.6em)
    #text(size: 0.76em, fill: ink3, hyphenate: false, M.currency.split("; ").join(";" + linebreak()))
    #v(0.7em)
    #text(size: 0.72em, fill: ink3, tracking: 0.1em, sc(M.product))
  ])
]

// ── colophon (verso of the cover) ─────────────────────────────────────────
#if M.colophon {
  page(numbering: none, header: none)[
    #set par(justify: false, leading: 0.55em, spacing: 0.6em)
    #set text(size: 0.8em, fill: ink2, hyphenate: false)
    #v(1fr)
    #let row(label, body) = (text(fill: ink3, tracking: 0.06em, sc(label)), body)
    #text(weight: 600, fill: ink, M.title) \
    #if M.subtitle != "" { text(style: "italic", M.subtitle) }
    #v(0.4em)
    #if M.course != "" or M.term != "" or M.professor != "" [
      #(M.course, M.term).filter(x => x != "").join(", ")#if M.professor != "" [. Compiled by #M.professor#if M.school != "" [, #M.school]].
    ]
    #v(1.1em)
    #grid(columns: (7.5em, 1fr), column-gutter: 1em, row-gutter: 0.85em,
      ..row([Currency], M.currencyDetail),
      ..row([Sources], M.sources.join(linebreak())),
      ..if M.verification != "" { row([Verified], M.verification) } else { () },
      ..row([Numbering], M.numberingNote),
      ..row([Links], M.linkNote),
      ..row([Public domain], [The statutes and regulations reproduced here are works of the United States Government and are not subject to copyright (17 U.S.C. § 105). This compilation contains #M.counts.provisions provisions in #M.counts.parts parts.]),
    )
    #v(1.4em)
    #text(fill: ink3)[Typeset by #M.product with Typst on #M.generated.]
  ]
}

// ── contents ─────────────────────────────────────────────────────────────
#let pnum(lab) = context lining(str(counter(page).at(locate(label(lab))).first()))
#let leaders = box(width: 1fr, inset: (x: 0.25em), repeat(gap: 0.32em, text(fill: ink3, ".")))

#counter(page).update(1)
#set page(numbering: "i", header: context {
  let pg = here().page()
  let start = query(<contentsstart>).at(0, default: none)
  let end = query(<contentsend>).at(0, default: none)
  if start != none and start.location().page() == pg { return }
  if end != none and pg > end.location().page() { return }
  set text(size: 0.78em, fill: ink2)
  if calc.even(counter(page).get().first()) { grid(columns: (auto, 1fr), lining(counter(page).display("i")), align(right, sc[Contents])) }
  else { grid(columns: (1fr, auto), sc[Contents], lining(counter(page).display("i"))) }
  v(-0.35em); head-rule
})
#heading(level: 1, bookmarked: true)[Contents]
#metadata(none)<contentsstart>
#text(size: 1.6em, weight: 500)[Contents]
#v(0.9em)
#{
  set par(justify: false, hanging-indent: 0pt)
  set text(hyphenate: false)
  for part in data.parts {
    block(above: 1.1em, below: 0.45em, sticky: true,
      link(label(part.lab), grid(columns: (8.2em, 1fr, auto), column-gutter: 0.5em,
        align: (left + bottom, left + top, right + bottom),
        text(size: 0.86em, fill: ink3, sc(part.kicker)),
        par(hanging-indent: 1em)[#text(weight: 600, part.title) #leaders],
        text(weight: 600, pnum(part.lab)))))
    for it in part.items {
      if it.at("sub", default: none) != none {
        block(above: 0.7em, below: 0.3em, sticky: true,
          link(label(it.lab + "#sub"), grid(columns: (8.2em, 1fr), column-gutter: 0.5em, [],
            text(size: 0.9em, fill: ink2, sc(it.at("subShort", default: it.sub))))))
      }
      block(above: 0.42em, below: 0.42em,
        // "§ 2 · 77b": the name, then the other numbering small; the page number
        // stays on the heading's last line however the label column wraps
        link(label(it.lab), grid(columns: (8.2em, 1fr), column-gutter: 0.5em,
          par(hanging-indent: 0.8em, {
            text(number-type: "lining", it.toc.a)
            if it.toc.b != "" { text(size: 0.74em, fill: ink3, number-type: "lining", [ · #it.toc.b]) }
          }),
          grid(columns: (1fr, auto), column-gutter: 0.5em, align: (left + top, right + bottom),
            par(hanging-indent: 1em)[#it.head #leaders],
            pnum(it.lab)))))
    }
  }
}

#metadata(none)<contentsend>

// ── body ─────────────────────────────────────────────────────────────────
// The text starts at folio 1 on a recto (blank verso if needed), so odd
// folios are always rectos and the mirrored margins put the gutter inside.
#pagebreak(to: "odd", weak: true)
#set page(numbering: "1", header: running-head())
#counter(page).update(1)
#for part in data.parts {
  pagebreak(to: "odd", weak: true)
  heading(level: 1, bookmarked: true, (part.kicker + ". " + part.title).replace("\u{2060}", ""))
  [#metadata(part.lab)#label(part.lab)]
  [#metadata(part.title)<partmark>]
  block(width: 100%, below: 2.4em, {
    set par(justify: false)
    v(0.9in)
    align(center, {
      text(size: 0.9em, fill: accent, sc(part.kicker))
      v(0.55em)
      balanced(text(size: 1.95em, weight: 500, hyphenate: false, part.title))
      if part.sub != "" { v(0.5em); text(size: 0.9em, fill: ink3, number-type: "lining", part.sub) }
      v(0.9em)
      line(length: 16%, stroke: 0.5pt + rule-c)
    })
  })
  for (i, it) in part.items.enumerate() { provision(it, part, first: i == 0) }
  [#metadata(none)<partend>]
}

// ── Table of Sections ────────────────────────────────────────────────────
#if data.index.statutes.len() + data.index.rules.len() > 0 {
  pagebreak(to: "odd", weak: true)
  heading(level: 1, bookmarked: true)[Table of Sections]
  [#metadata("Table of Sections")<partmark>]
  run-state.update((run: "Table of Sections", part: "Table of Sections", short: none))
  align(center, {
    v(0.4in)
    text(size: 1.7em, weight: 500)[Table of Sections]
    v(1em)
  })
  let cols = (6.6em, 1fr, 2.4em)
  let group(g, caption) = {
    block(above: 1.3em, below: 0.35em, sticky: true, {
      set par(hanging-indent: 1em)
      text(weight: 600, hyphenate: false, g.title)
      linebreak()
      text(size: 0.82em, fill: ink3, caption)
    })
    grid(columns: cols, column-gutter: 0.6em, row-gutter: 0.42em,
      ..g.rows.map(r => (
        link(label(r.lab), lining(r.a)),
        link(label(r.lab), [#lining(r.b) #leaders]),
        link(label(r.lab), align(right, pnum(r.lab))),
      )).flatten())
  }
  columns(2, gutter: 2em, {
    set par(justify: false)
    set text(size: 0.92em)
    for g in data.index.statutes { group(g, [Act section · U.S.C. section · page]) }
    for g in data.index.rules {
      let k = g.at("kind", default: "rule")
      group(g, if k == "item" [Item · C.F.R. section · page] else if k == "form" [Form · C.F.R. section · page] else [Rule · C.F.R. section · page])
    }
  })
}

#context [#metadata(here().page())<lastpage>]
