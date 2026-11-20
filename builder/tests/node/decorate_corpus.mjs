// Test fixture: adds the corpus fields the corpus lane is introducing
// (subject groups, common/short names, display titles, divisions, split acts,
// Sarbanes-Oxley) onto a corpus that predates them, so the studio's code paths
// for those fields are exercised no matter which corpus is checked in.
// A field the corpus already carries is never overwritten.

const para = text => [{ type: "p", text }];

export function decorateCorpus(input) {
  const corpus = structuredClone(input);

  // ── split acts out of their U.S.C. chapters ────────────────────────────
  const act2A = corpus.acts.find(a => a.id === "act-ch2A");
  const act2D = corpus.acts.find(a => a.id === "act-ch2D");
  if (act2A && !corpus.acts.some(a => /trust indenture/i.test(a.short_title))) {
    const tiaIds = act2A.sections.filter(s => /^77(aaa|bbb|ccc|ddd|eee|fff|ggg|hhh|iii|jjj|kkk|lll|mmm|nnn|ooo|ppp|qqq|rrr|sss|ttt)/.test(s.codified.num));
    act2A.sections = act2A.sections.filter(s => !tiaIds.includes(s));
    corpus.acts.splice(corpus.acts.indexOf(act2A) + 2, 0, {
      id: "act-ch2A–tia", short_title: "Trust Indenture Act of 1939", original_name_short: "Trust Indenture Act",
      usc_chapter: "15/2A", usc_range: "15 U.S.C. §§ 77aaa–77bbbb", sections: tiaIds,
    });
  }
  if (act2D && !corpus.acts.some(a => /advisers act/i.test(a.short_title))) {
    const iaa = act2D.sections.filter(s => /^80b/.test(s.codified.num));
    act2D.sections = act2D.sections.filter(s => !iaa.includes(s));
    act2D.divisions = [{ id: "ica-sub1", label: "Subchapter I—Investment Companies",
      sections: act2D.sections.map(s => s.id) }];
    corpus.acts.push({
      id: "act-ch2D–iaa", short_title: "Investment Advisers Act of 1940", original_name_short: "Advisers Act",
      usc_chapter: "15/2D", usc_range: "15 U.S.C. §§ 80b–1–80b–21", sections: iaa,
    });
  }
  // sections whose source credit did not map to an original number
  const pslra = corpus.acts.flatMap(a => a.sections).find(s => s.id === "s-78u–4");
  if (pslra && !pslra.original) {
    pslra.original = { num: "21D", cite: "Securities Exchange Act of 1934 § 21D" };
  }
  for (const a of corpus.acts) {
    a.original_name_short ||= a.short_title.replace(/ of \d{4}$/, "").replace("Securities Exchange Act", "Exchange Act");
  }

  // ── Sarbanes-Oxley (new in the corpus) ─────────────────────────────────
  if (!corpus.acts.some(a => /sarbanes/i.test(a.short_title))) {
    const sox = [
      ["7241", "302", "Corporate responsibility for financial reports"],
      ["7243", "304", "Forfeiture of certain bonuses and profits"],
      ["7245", "307", "Rules of professional responsibility for attorneys"],
      ["7262", "404", "Management assessment of internal controls"],
    ];
    corpus.acts.push({
      id: "act-ch98", short_title: "Sarbanes-Oxley Act of 2002", original_name_short: "Sarbanes-Oxley Act",
      usc_chapter: "15/98", usc_range: "15 U.S.C. §§ 7201–7266",
      sections: sox.map(([cod, orig, heading]) => ({
        id: `s-${cod}`, codified: { num: cod, cite: `15 U.S.C. § ${cod}` },
        original: { num: orig, cite: `Sarbanes-Oxley Act of 2002 § ${orig}` },
        heading, status: "active", content: para(`${heading}. (Fixture text for tests.)`),
      })),
    });
  }

  // ── regulations: part, display title, subject groups, names ────────────
  const DISPLAY = {
    "cfr-17-p230": "General Rules and Regulations, Securities Act of 1933",
    "cfr-17-p240": "General Rules and Regulations, Securities Exchange Act of 1934",
    "cfr-17-p229": "Regulation S-K",
    "cfr-17-p210": "Regulation S-X",
    "cfr-17-p243": "Regulation FD",
  };
  const inRange = (id, a, b) => {
    const m = id.match(/^r-\d+-(\d+)([A-Za-z]*)$/);
    return !!m && +m[1] >= a && +m[1] <= b;
  };
  const GROUPS = {
    "cfr-17-p230": [
      ["cfr-17-p230-rega", "Regulation A—Conditional Small Issues Exemption", "Regulation A", id => inRange(id, 251, 263)],
      ["cfr-17-p230-regd", "Regulation D—Rules Governing the Limited Offer and Sale of Securities Without Registration Under the Securities Act of 1933", "Regulation D", id => inRange(id, 500, 508)],
      ["cfr-17-p230-regs", "Regulation S—Rules Governing Offers and Sales Made Outside the United States", "Regulation S", id => inRange(id, 901, 905)],
    ],
    "cfr-17-p240": [
      ["cfr-17-p240-14a", "Regulation 14A: Solicitations of Proxies", "Regulation 14A", id => /^r-240-14a-/.test(id)],
    ],
  };
  const SHORT = {
    "r-240-10b-5": ["Rule 10b-5", "Rule 10b-5"],
    "r-229-404": ["Item 404 of Regulation S-K", "Item 404"],
    "r-249-310": ["Form 10-K", "Form 10-K"],
  };
  for (const reg of corpus.regulations) {
    reg.part ??= Number(String(reg.title).match(/Part (\d+)/)?.[1]);
    if (DISPLAY[reg.id]) reg.display_title ??= DISPLAY[reg.id];
    if (!reg.groups && GROUPS[reg.id]) {
      reg.groups = [];
      for (const [gid, label, short, test] of GROUPS[reg.id]) {
        const rules = reg.rules.filter(r => test(r.id)).map(r => r.id);
        if (!rules.length) continue;
        reg.groups.push({ id: gid, label, short, rules });
        for (const r of reg.rules) if (rules.includes(r.id)) r.group ??= gid;
      }
    }
    for (const r of reg.rules) {
      const s = SHORT[r.id];
      if (s) { r.common_name = s[0]; r.short_name = s[1]; }
    }
  }
  return corpus;
}
