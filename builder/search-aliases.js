// Domain vocabulary for the citation-aware search (search.js): what a
// securities-law professor types for an act, a regulation or an idea.
// Kept apart from the search logic so another corpus can supply its own
// (corpus.meta.searchAliases takes precedence over this default).
//
// All names are matched case-insensitively after the query is normalized
// (curly quotes straightened, dashes unified, "U.S.C." -> "usc").

export const SECURITIES_ALIASES = {
  // Acts. `is` tests act.short_title (+ original_name_short) in the corpus.
  acts: [
    { id: "securities", is: /securities act of 1933/i,
      names: ["securities act of 1933", "securities act", "'33 act", "33 act", "1933 act"] },
    { id: "exchange", is: /securities exchange act of 1934/i,
      names: ["securities exchange act of 1934", "securities exchange act", "exchange act", "'34 act", "34 act", "1934 act"] },
    { id: "tia", is: /trust indenture act/i,
      names: ["trust indenture act of 1939", "trust indenture act", "tia", "'39 act", "39 act", "1939 act"] },
    { id: "ica", is: /investment company act/i,
      names: ["investment company act of 1940", "investment company act", "ica"] },
    { id: "iaa", is: /investment advisers act/i,
      names: ["investment advisers act of 1940", "investment advisers act", "advisers act", "iaa"] },
    { id: "sipa", is: /investor protection act/i,
      names: ["securities investor protection act of 1970", "securities investor protection act", "sipa"] },
    { id: "sox", is: /sarbanes/i,
      names: ["sarbanes-oxley act of 2002", "sarbanes-oxley act", "sarbanes-oxley", "sarbanes oxley", "sarbox", "sox"] },
  ],
  // Names that point at more than one act ("'40 Act" is two statutes).
  actGroups: [
    { acts: ["ica", "iaa"], names: ["'40 act", "40 act", "1940 act"] },
  ],

  // Whole regulations (a C.F.R. part) known by name. Regulations that are a
  // SUBJECT GROUP inside a part (Reg D, Reg S, Reg A, Reg M…) come from the
  // corpus (regulation.groups) instead.
  regulations: [
    { names: ["s-k", "sk"], part: "229", label: "Regulation S-K" },
    { names: ["s-x", "sx"], part: "210", label: "Regulation S-X" },
    { names: ["fd"], part: "243", label: "Regulation FD" },
    { names: ["s-t"], part: "232", label: "Regulation S-T" },
    { names: ["g"], part: "244", label: "Regulation G" },
    { names: ["cf", "crowdfunding"], part: "227", label: "Regulation Crowdfunding" },
  ],
  // Regulation names that may stand alone (no "Reg"/"Regulation" in front).
  bareRegulationNames: ["s-k", "sk", "s-x", "sx", "s-t"],

  // Act section numbers that, typed without an act name, mean the Exchange
  // Act ("Section 10(b)", "Section 16(b)", "Section 18"). Every other bare
  // number stays with the Securities Act first (Section 5, 11, 12(a)(2)).
  // When a subsection is typed, only sections that HAVE it rank first
  // (13(d) is the Exchange Act: Securities Act § 13 has no subsections).
  exchangeFirst: { act: "exchange", nums: ["9", "10", "14", "16", "18", "20", "21", "21a", "21d", "21e", "21f"] },

  // Popular names for a group of provisions. A row "Add all N" for each.
  //   pubL      every section whose source credit cites this public law
  //   ids       explicit members (kept only if they also cite pubL, when given)
  //   unitKeys  a whole part or subject group of the browse tree
  //   featured  the members listed under the row (default: the first dozen)
  bundles: [
    { id: "jobs", names: ["jobs act", "jobs act of 2012", "jumpstart our business startups act"],
      label: "JOBS Act", pubL: "112–106",
      desc: "Sections of the U.S. Code the JOBS Act (2012) enacted or amended",
      featured: ["s-77d–1", "s-77b", "s-77c", "s-77d", "s-77r", "s-78l"] },
    { id: "dodd-frank", names: ["dodd-frank", "dodd frank", "dodd-frank act", "dodd frank act", "doddfrank"],
      label: "Dodd-Frank Act", pubL: "111–203",
      desc: "Sections of the U.S. Code the Dodd-Frank Act (2010) enacted or amended",
      featured: ["s-78u–6", "s-78n–1", "s-78j–4", "s-78o–11", "s-78o–10", "s-78j–3"] },
    { id: "slusa", names: ["slusa", "securities litigation uniform standards act"],
      label: "SLUSA", pubL: "105–353",
      desc: "State class-action preemption (Securities Litigation Uniform Standards Act of 1998)",
      ids: ["s-77p", "s-78bb", "s-77z–1", "s-78u–4", "s-77v"] },
    { id: "crowdfunding", names: ["crowdfunding", "crowd funding"],
      label: "Crowdfunding", range: "Securities Act § 4(a)(6) · Regulation Crowdfunding",
      desc: "Section 4(a)(6), Section 4A and the Commission’s Regulation Crowdfunding",
      ids: ["s-77d", "s-77d–1"], unitKeys: ["reg:cfr-17-p227"] },
  ],

  // A small curated map from ideas to the provisions that define them.
  // Ids missing from the corpus are skipped.
  concepts: [
    { match: /\baccredited investors?\b/, why: "Defined in Rule 501(a)",
      ids: ["r-230-501", "r-230-506", "r-230-504"] },
    { match: /\binsider trading\b/, why: "Insider trading",
      ids: ["r-240-10b-5", "r-240-10b5-1", "r-240-10b5-2", "s-78t–1", "s-78u–1", "s-78p", "r-240-14e-3"] },
    { match: /\bpslra\b|private securities litigation reform/, why: "Private Securities Litigation Reform Act of 1995",
      ids: ["s-78u–4", "s-77z–1"] },
    { match: /\bsafe harbou?rs?\b.*\bforward|\bforward[- ]looking\b/, why: "Forward-looking statements safe harbor",
      ids: ["s-77z–2", "s-78u–5"] },
    { match: /\bshort[- ]swing\b/, why: "Section 16(b)",
      ids: ["s-78p", "r-240-16b-3", "r-240-16a-1"] },
    { match: /\bblue sky\b/, why: "State preemption",
      ids: ["s-77r"] },
    { match: /\bprivate placements?\b/, why: "Private offering exemptions",
      ids: ["s-77d", "r-230-506", "r-230-504"] },
    // the JOBS Act by title (its sections are not numbered in the Code)
    { match: /\bjobs act\b.*\b(?:101|102|103|104|105|106|107|108|title i|emerging growth)\b/, why: "JOBS Act Title I: emerging growth companies",
      ids: ["s-77b", "s-77e", "s-77g"] },
    { match: /\bjobs act\b.*\b(?:201|202|title ii|general solicitation)\b/, why: "JOBS Act § 201: general solicitation, Securities Act § 4(b) and Rule 506(c)",
      ids: ["s-77d", "r-230-506"] },
    { match: /\bjobs act\b.*\b(?:301|302|303|304|305|306|title iii)\b/, why: "JOBS Act Title III: crowdfunding, Securities Act § 4(a)(6) and § 4A",
      ids: ["s-77d–1", "s-77d", "r-227-100"] },
    { match: /\bjobs act\b.*\b(?:401|402|title iv)\b/, why: "JOBS Act § 401: Regulation A+, Securities Act § 3(b)(2)",
      ids: ["s-77c", "r-230-251"] },
    { match: /\bjobs act\b.*\b(?:501|502|title v)\b/, why: "JOBS Act Title V: the Exchange Act § 12(g) thresholds",
      ids: ["s-78l"] },
    // Dodd-Frank by section (the whistleblower program is its § 922)
    { match: /\bdodd[- ]?frank\b.*\b922\b|\bwhistle ?blowers?\b/, why: "Exchange Act § 21F (Dodd-Frank § 922)",
      ids: ["s-78u–6", "r-240-21F-1", "r-240-21F-2", "r-240-21F-4"] },
    { match: /\bdodd[- ]?frank\b.*\b(?:951|say[- ]on[- ]pay)\b|\bsay[- ]on[- ]pay\b/, why: "Exchange Act § 14A (Dodd-Frank § 951)",
      ids: ["s-78n–1"] },
    { match: /\bdodd[- ]?frank\b.*\b954\b|\bclawbacks?\b/, why: "Exchange Act § 10D (Dodd-Frank § 954)",
      ids: ["s-78j–4"] },
    { match: /\bmd&a\b|\bmda\b|management'?s discussion/, why: "Management's discussion and analysis",
      ids: ["r-229-303"] },
    { match: /\bexecutive compensation\b/, why: "Regulation S-K Item 402",
      ids: ["r-229-402"] },
    { match: /\brisk factors?\b/, why: "Regulation S-K Item 105",
      ids: ["r-229-105"] },
    // Sarbanes-Oxley by its own section numbers (the codified sections
    // carry no "Section 302" in their headings).
    { match: /\b(?:sox|sarbanes[- ]oxley)\b.*\b302\b/, why: "Sarbanes-Oxley Act § 302", ids: ["s-7241"] },
    { match: /\b(?:sox|sarbanes[- ]oxley)\b.*\b304\b/, why: "Sarbanes-Oxley Act § 304", ids: ["s-7243"] },
    { match: /\b(?:sox|sarbanes[- ]oxley)\b.*\b307\b/, why: "Sarbanes-Oxley Act § 307", ids: ["s-7245"] },
    { match: /\b(?:sox|sarbanes[- ]oxley)\b.*\b404\b/, why: "Sarbanes-Oxley Act § 404", ids: ["s-7262"] },
  ],
};
