/* ════════════════════════════════════════════════════════════════
   Interactive Statutory Supplement — reader runtime
   Embedded into every generated reader — the source lives at
   builder/reader/template/reader.js; edit it there, not in the
   generated HTML.

   Anchor model: each highlight = { sectionId, text, occurrence,
   textBefore, textAfter }. Restoration walks the section's text
   nodes, builds a whitespace-normalized string with a char map back
   to (node, offset), finds the nth occurrence, and wraps every
   intersecting text-node segment. Context strings break ties when
   occurrence is unknown (legacy imports) or text has shifted.
   ════════════════════════════════════════════════════════════════ */
'use strict';

const DOC = JSON.parse(document.getElementById('docMeta').textContent);
const TOC = JSON.parse(document.getElementById('tocData').textContent);
const STORAGE_NS = 'supplementAnnotations.v2.' + DOC.name;
const LEGACY_KEYS = ['statutorySupplementHighlights'];
const COLORS = ['yellow', 'green', 'blue', 'purple', 'orange'];

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

/* ── normalization ──
   Only 1:1 char mappings before whitespace collapse, so the
   char-index maps in buildIndex stay valid. */
function canonChar(s) {
  return s
    .replace(/[\u2018\u2019\u201A\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
}
function norm(s) {
  return canonChar(s).replace(/\s+/g, ' ');
}

/* Curly quotes and apostrophes for display, as the PDF sets them (the eCFR's
   text has straight ones). One character for one, and canonChar folds them
   back, so every annotation anchor and search still matches. */
function smartQuotes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const OPENERS = /[\s([{\u2014\u2018\u201c]/;
  let prev = ' ';
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue;
    if (!/['"]/.test(t)) { if (t) prev = t[t.length - 1]; continue; }
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      const next = t[i + 1] || ' ';
      if (ch === '"') out += OPENERS.test(prev) ? '\u201c' : '\u201d';
      else if (ch === "'") out += OPENERS.test(prev) && /[A-Za-z]/.test(next) ? '\u2018' : '\u2019';
      else out += ch;
      prev = ch;
    }
    n.nodeValue = out;
  }
}

/* ════════ text index: section → normalized string + char map ════ */
function buildIndex(sectionEl) {
  const body = $('.prov-body', sectionEl);
  if (!body) return null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.parentElement.closest('.tbl')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let raw = '';
  const map = []; // map[i] = {node, off} for raw[i]
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) map.push({ node: n, off: i });
    raw += t;
  }
  // canonical string + normIdx -> rawIdx (canonChar is 1:1 per char)
  let normStr = '';
  const n2r = [];
  let lastWasSpace = true; // trims leading space
  for (let i = 0; i < raw.length; i++) {
    const ch = canonChar(raw[i]);
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normStr += ' ';
        n2r.push(i);
        lastWasSpace = true;
      }
    } else {
      normStr += ch;
      n2r.push(i);
      lastWasSpace = false;
    }
  }
  return { normStr, n2r, map, raw };
}

function nthIndexOf(hay, needle, k) {
  let i = -1;
  for (let c = 0; c <= k; c++) {
    i = hay.indexOf(needle, i + 1);
    if (i === -1) return -1;
  }
  return i;
}
function countOccurrences(hay, needle) {
  let c = 0, i = -1;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) c++;
  return c;
}

/* Find a Range for the k-th occurrence (0-based) of normalized text. */
function rangeForOccurrence(idx, normText, k) {
  const start = nthIndexOf(idx.normStr, normText, k);
  if (start === -1) return null;
  return rangeFromNorm(idx, start, normText.length);
}
function rangeFromNorm(idx, normStart, normLen) {
  const rawStart = idx.n2r[normStart];
  const rawEndIncl = idx.n2r[normStart + normLen - 1];
  const a = idx.map[rawStart];
  const b = idx.map[rawEndIncl];
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.off);
  r.setEnd(b.node, b.off + 1);
  return r;
}

/* Score occurrences by surrounding context; returns best k or -1. */
function bestOccurrenceByContext(idx, normText, before, after) {
  const total = countOccurrences(idx.normStr, normText);
  if (total === 0) return -1;
  if (total === 1) return 0;
  const nb = norm(before || '').trim();
  const na = norm(after || '').trim();
  let bestK = 0, bestScore = -1;
  for (let k = 0; k < total; k++) {
    const s = nthIndexOf(idx.normStr, normText, k);
    const pre = idx.normStr.slice(Math.max(0, s - 60), s);
    const post = idx.normStr.slice(s + normText.length, s + normText.length + 60);
    let score = 0;
    score += overlapScore(pre, nb, true);
    score += overlapScore(post, na, false);
    if (score > bestScore) { bestScore = score; bestK = k; }
  }
  return bestK;
}
function overlapScore(have, want, fromEnd) {
  if (!want) return 0;
  const max = Math.min(have.length, want.length, 40);
  let best = 0;
  for (let len = max; len >= 4; len--) {
    const frag = fromEnd ? want.slice(-len) : want.slice(0, len);
    if (fromEnd ? have.endsWith(frag) : have.startsWith(frag)) { best = len; break; }
  }
  return best;
}

/* Wrap every text-node segment intersecting the range. */
function wrapRange(range, hl) {
  const marks = [];
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === 1 ? root : root.parentElement;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node)) continue;
    let s = 0, e = node.nodeValue.length;
    if (node === range.startContainer) s = range.startOffset;
    if (node === range.endContainer) e = range.endOffset;
    if (e > s) targets.push({ node, s, e });
  }
  for (const t of targets) {
    let seg = t.node;
    if (t.s > 0) seg = seg.splitText(t.s);
    if (t.e - t.s < seg.nodeValue.length) seg.splitText(t.e - t.s);
    if (!seg.nodeValue.trim()) continue;
    const mark = document.createElement('mark');
    mark.className = 'hl c-' + hl.color;
    mark.dataset.hid = hl.id;
    seg.parentNode.insertBefore(mark, seg);
    mark.appendChild(seg);
    marks.push(mark);
  }
  if (marks.length && hl.note) {
    const d = document.createElement('span');
    d.className = 'ndot';
    marks[marks.length - 1].appendChild(d);
  }
  return marks;
}

function unwrapHighlight(id) {
  for (const m of $$(`mark.hl[data-hid="${id}"]`)) {
    const p = m.parentNode;
    $('.ndot', m)?.remove();
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    m.remove();
    p.normalize();
  }
}

/* ════════ store ════════ */
/* Earlier builds let corpus xref markup leak into highlight texts;
   stored data may still carry it. Heal on the way in. */
function sanitizeStored(h) {
  const strip = (s) => (s || '').replace(/<a class="xref"[^>]*>(.*?)<\/a>/gs, '$1');
  h.text = strip(h.text);
  h.textBefore = strip(h.textBefore);
  h.textAfter = strip(h.textAfter);
  return h;
}

const store = {
  map: new Map(),
  orphans: new Map(), // id → reason
  load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_NS) || 'null');
      if (d && Array.isArray(d.highlights)) {
        for (const h of d.highlights) this.map.set(h.id, sanitizeStored(h));
        this.seedTag = d.seedTag || null;
        this.userEdited = !!d.userEdited;
      }
    } catch (e) { console.warn('store.load', e); }
  },
  persist: debounce(function () {
    localStorage.setItem(STORAGE_NS, JSON.stringify(store.payload()));
  }, 400),
  seedTag: null,
  userEdited: false,
  payload() {
    return {
      version: 2,
      doc: DOC.name,
      savedAt: new Date().toISOString(),
      seedTag: this.seedTag,
      userEdited: this.userEdited,
      highlights: Array.from(this.map.values()),
    };
  },
};
function debounce(fn, ms) {
  let t;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
let idSeq = Date.now();
const newId = () => 'hl_' + (idSeq++).toString(36);

/* ════════ section registry ════════ */
const sections = $$('.prov');
const sectionById = new Map(sections.map((s) => [s.id, s]));
const sectionByOldId = new Map(
  sections.filter((s) => s.dataset.oldId).map((s) => [s.dataset.oldId, s])
);
const indexCache = new Map();
function idxFor(sectionEl) {
  let idx = indexCache.get(sectionEl.id);
  if (!idx) { idx = buildIndex(sectionEl); indexCache.set(sectionEl.id, idx); }
  return idx;
}
function invalidateIdx(sectionEl) { indexCache.delete(sectionEl.id); }

/* ════════ restore ════════ */
function resolveAndWrap(h) {
  const sec = sectionById.get(h.sectionId) || sectionByOldId.get(h.sectionId);
  if (!sec) return { ok: false, reason: 'section-missing' };
  if (sectionByOldId.get(h.sectionId)) h.sectionId = sectionByOldId.get(h.sectionId).id;
  const idx = idxFor(sec);
  if (!idx) return { ok: false, reason: 'empty-section' };
  const nt = norm(h.text).trim();
  if (!nt) return { ok: false, reason: 'empty-text' };
  let k = Number.isInteger(h.occurrence) ? h.occurrence : -1;
  let range = k >= 0 ? rangeForOccurrence(idx, nt, k) : null;
  if (!range) {
    const bk = bestOccurrenceByContext(idx, nt, h.textBefore, h.textAfter);
    if (bk === -1) return { ok: false, reason: 'text-not-found' };
    k = bk;
    range = rangeForOccurrence(idx, nt, k);
    if (!range) return { ok: false, reason: 'range-failed' };
  }
  h.occurrence = k;
  const marks = wrapRange(range, h);
  if (!marks.length) return { ok: false, reason: 'wrap-failed' };
  invalidateIdx(sec); // DOM changed (text nodes split)
  return { ok: true };
}

function restoreAll() {
  let ok = 0;
  store.orphans.clear();
  for (const h of store.map.values()) {
    const res = resolveAndWrap(h);
    if (res.ok) ok++;
    else store.orphans.set(h.id, res.reason);
  }
  return { ok, orphans: store.orphans.size };
}

/* ════════ legacy import (old reader format) ════════ */
function importLegacy(data) {
  const out = { ok: 0, orphan: 0 };
  for (const oh of data.highlights || []) {
    const h = {
      id: oh.id || newId(),
      text: oh.text || '',
      color: COLORS.includes(oh.color) ? oh.color : (oh.color === 'pink' ? 'purple' : 'yellow'),
      note: oh.note || '',
      sectionId: oh.sectionId || '',
      occurrence: null,
      textBefore: oh.textBefore || '',
      textAfter: oh.textAfter || '',
      createdAt: oh.createdAt || new Date().toISOString(),
    };
    store.map.set(h.id, h);
    const res = resolveAndWrap(h);
    if (res.ok) out.ok++;
    else { store.orphans.set(h.id, res.reason); out.orphan++; }
  }
  store.persist();
  return out;
}

/* ════════ TOC ════════ */
function renderToc() {
  const wrap = $('#tocScroll');
  wrap.innerHTML = '';
  for (const g of TOC) {
    const act = document.createElement('div');
    act.className = 'toc-act';
    const label = document.createElement('div');
    label.className = 'toc-act-label';
    label.innerHTML = `<span class="tw" aria-hidden="true"></span><span>${escHtml(g.label)}</span>`;
    label.addEventListener('click', () => act.classList.toggle('collapsed'));
    act.appendChild(label);
    if (g.sublabel) {
      const sub = document.createElement('div');
      sub.className = 'toc-act-sub';
      sub.textContent = g.sublabel;
      act.appendChild(sub);
    }
    const list = document.createElement('div');
    list.className = 'toc-list';
    for (const item of g.items) {
      if (item.subhead) {
        const sh = document.createElement('div');
        sh.className = 'toc-subhead';
        sh.innerHTML = scHtml(item.subhead);
        list.appendChild(sh);
        continue;
      }
      const a = document.createElement('a');
      a.className = 'toc-item';
      a.href = '#' + item.id;
      a.dataset.sec = item.id;
      // citation on its own line, heading beneath it (never run together)
      a.innerHTML =
        `<span class="toc-num" title="${escAttr(item.display)}">${escHtml(item.display)}</span>` +
        `<span class="toc-name" title="${escAttr(item.heading)}">${escHtml(item.heading)}</span>` +
        `<span class="toc-count" data-count="${item.id}"></span>`;
      a.addEventListener('click', (e) => {
        // instant jump — smooth scroll across a huge document is disorienting
        e.preventDefault();
        const sec = sectionById.get(item.id);
        if (!sec) return;
        sec.scrollIntoView({ behavior: 'instant', block: 'start' });
        history.replaceState(null, '', '#' + item.id);
        setCurrent(sec);
        closePanels();
      });
      list.appendChild(a);
    }
    act.appendChild(list);
    wrap.appendChild(act);
  }
  $('#sbSections').textContent = plural(DOC.provisions, 'provision');
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
/* Text for a small-caps label that can hold digits. EB Garamond's small-cap
   figures read as letters ("229.IOO", "LAW 642I"), so each digit run is set
   as small lining figures (.fig) and the rest stays small caps. */
function scHtml(s) {
  return escHtml(s).replace(/\d+(?:[.,]\d+)*/g, '<span class="fig">$&</span>');
}
function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function updateCounts() {
  const per = new Map();
  let notes = 0;
  for (const h of store.map.values()) {
    per.set(h.sectionId, (per.get(h.sectionId) || 0) + 1);
    if (h.note) notes++;
  }
  for (const el of $$('[data-count]')) {
    const c = per.get(el.dataset.count) || 0;
    el.textContent = c || '';
  }
  $('#bHl').textContent = store.map.size;
  $('#bNotes').textContent = notes;
  const unplaced = store.orphans.size + unplacedCount();
  $('#bOrphans').textContent = unplaced;
  $('#orphanStat').textContent = unplaced;
  $('#orphanWord').textContent = unplaced === 1 ? 'unplaced highlight' : 'unplaced highlights';
  // the notes panel only mentions unplaced highlights when there are some
  $('#orphanStatBtn').hidden = unplaced === 0;
  $('#apUnplacedRow').classList.toggle('ap-row-hidden', unplaced === 0);
  const okN = store.map.size - store.orphans.size;
  $('#anchorStat').textContent = `${okN} of ${store.map.size}`;
  $('#anchorDot').classList.toggle('warn', unplaced > 0);
  $('#sbCounts').textContent = store.map.size
    ? `${plural(store.map.size, 'highlight')} · ${plural(notes, 'note')}`
    : 'No highlights yet';
}

/* ════════ scroll spy + crumb + progress ════════ */
let currentSection = null;
const spy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { setCurrent(e.target); break; }
    }
  },
  { rootMargin: '-45% 0px -50% 0px' }
);
sections.forEach((s) => spy.observe(s));

function setCurrent(sec) {
  if (currentSection === sec) return;
  currentSection = sec;
  $$('.toc-item.active').forEach((el) => el.classList.remove('active'));
  const item = $(`.toc-item[data-sec="${sec.id}"]`);
  if (item) {
    item.classList.add('active');
    item.scrollIntoView({ block: 'nearest' });
  }
  $('#crumb').innerHTML =
    `<span>${escHtml(sec.dataset.group)}</span>` +
    `<span class="crumb-sep">/</span>` +
    `<span class="crumb-active">${escHtml(sec.dataset.display)} · ${escHtml($('.prov-name', sec)?.textContent || '')}</span>`;
  renderRail();
}
window.addEventListener('scroll', debounce(() => {
  const h = document.documentElement;
  const p = Math.min(100, Math.round((h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100));
  $('#progressPill').textContent = p + '%';
}, 80), { passive: true });

/* ════════ unplaced migration orphans (adopt-by-selection) ════════ */
const ORPHANS = (() => {
  try { return JSON.parse(document.getElementById('orphanData')?.textContent || 'null') || []; }
  catch (_) { return []; }
})();
let orphanResolved = new Set();
let pendingOrphan = null;
function loadOrphanState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_NS + '.orphans') || '[]');
    orphanResolved = new Set(d);
  } catch (_) { /* fresh */ }
}
function persistOrphanState() {
  localStorage.setItem(STORAGE_NS + '.orphans', JSON.stringify([...orphanResolved]));
}
function orphansForSection(secId) {
  return ORPHANS.filter((o) => o.near === secId && !orphanResolved.has(o.oid));
}
function unplacedCount() {
  return ORPHANS.filter((o) => !orphanResolved.has(o.oid)).length;
}
function armOrphan(o, card) {
  pendingOrphan = o;
  $$('.card.armed').forEach((c) => c.classList.remove('armed'));
  if (card) card.classList.add('armed');
  toast('Now select the text this highlight belongs to (Esc to cancel)');
}
function disarmOrphan() {
  pendingOrphan = null;
  $$('.card.armed').forEach((c) => c.classList.remove('armed'));
}

/* ════════ rail — cards track their highlights' positions ════════
   Cards are absolutely positioned at the viewport Y of their first
   <mark>, collision-stacked downward, refreshed as you scroll. */
let railFilter = 'all';
let editingHid = null;
$('#railFilters').addEventListener('click', (e) => {
  const b = e.target.closest('.rail-chip');
  if (!b) return;
  railFilter = b.dataset.f;
  $$('.rail-chip').forEach((c) => c.classList.toggle('active', c === b));
  renderRail();
});

const VIEW_PAD_BELOW = 400; // upcoming text gets cards early
const VIEW_PAD_ABOVE = 40;  // cards fall away with their text

function visibleAnnotations(filter = railFilter) {
  const out = [];
  const vh = innerHeight;
  for (const h of store.map.values()) {
    if (filter === 'notes' && !h.note) continue;
    if (filter === 'marks' && h.note) continue;
    if (store.orphans.has(h.id)) continue;
    const m = $(`mark.hl[data-hid="${h.id}"]`);
    if (!m) continue;
    const r = m.getBoundingClientRect();
    if (r.bottom < -VIEW_PAD_ABOVE || r.top > vh + VIEW_PAD_BELOW) continue;
    out.push({ h, y: r.top + scrollY });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}

/* Rebuild card DOM (store/filter/section changes). */
function renderRail() {
  if (editingHid && $(`.card[data-hid="${editingHid}"] .card-note-edit`)) return;
  editingHid = null;
  const cardsEl = $('#railCards');
  const items = visibleAnnotations();
  const want = new Set(items.map((it) => it.h.id));

  // drop stale cards, add missing ones (reuse keeps hover/edit stable)
  for (const el of Array.from(cardsEl.children)) {
    if (el.classList.contains('card') && !want.has(el.dataset.hid)) el.remove();
  }
  for (const it of items) {
    if (!cardsEl.querySelector(`.card[data-hid="${it.h.id}"]`)) {
      cardsEl.appendChild(buildCard(it.h));
    }
  }

  // unplaced migration orphans near the current section — pinned block
  $('#railOrphanBlock')?.remove();
  const sec = currentSection;
  const orphans = sec && railFilter === 'all' ? orphansForSection(sec.id) : [];
  if (orphans.length) {
    const block = document.createElement('div');
    block.id = 'railOrphanBlock';
    const head = document.createElement('button');
    head.className = 'rail-orphan-head';
    head.innerHTML = `<span>Unplaced from the PDF · ${orphans.length}</span><span class="tw" aria-hidden="true"></span>`;
    head.addEventListener('click', () => block.classList.toggle('open'));
    block.appendChild(head);
    const body = document.createElement('div');
    body.className = 'rail-orphan-body';
    for (const o of orphans) body.appendChild(buildOrphanCard(o));
    block.appendChild(body);
    cardsEl.parentElement.insertBefore(block, cardsEl);
  }

  const secLabel = sec ? sec.dataset.display : '';
  $('#railCount').textContent = secLabel ? `${secLabel} · ${items.length} in view` : `${items.length} in view`;
  const empty = $('#railEmpty');
  empty.style.display = items.length || orphans.length ? 'none' : 'block';
  if (!items.length) {
    // an empty tab says where the rest is, never "nothing here" while a
    // highlight sits in the text next to it
    const [lead, more] = railEmptyCopy();
    empty.textContent = lead;
    const sub = document.createElement('span');
    sub.textContent = more;
    empty.appendChild(sub);
  }
  layoutRail();
}
function railEmptyCopy() {
  if (railFilter === 'all') {
    return ['Nothing highlighted in view.', 'Select text to highlight it.'];
  }
  const other = railFilter === 'notes' ? 'marks' : 'notes';
  const n = visibleAnnotations(other).length;
  if (railFilter === 'notes') {
    return ['No notes in view.', n
      ? 'Your highlights without a note are under Marks.'
      : 'Select text to highlight it, then add a note.'];
  }
  return ['No plain highlights in view.', n
    ? 'Your highlights with a note are under Notes.'
    : 'Select text to highlight it.'];
}

/* Position cards without rebuilding them (scroll/resize).
   Aligned mode (notes): card tops track their marks' viewport Y.
   List mode (all/marks): simple document-order stack — dozens of
   plain marks per viewport can't physically align. */
function alignedMode() { return railFilter === 'notes'; }

let layingOut = false;
function layoutRail() {
  if (editingHid || layingOut) return;
  const cardsEl = $('#railCards');
  cardsEl.classList.toggle('listmode', !alignedMode());
  const items = visibleAnnotations();
  const ids = items.map((it) => it.h.id);
  const have = $$('.card', cardsEl).map((c) => c.dataset.hid);
  if (ids.length !== have.length || ids.some((id, i) => id !== have[i])) {
    // set changed — rebuild synchronously (renderRail re-enters here once)
    layingOut = true;
    try { renderRail(); } finally { layingOut = false; }
    if (editingHid) return;
  }
  if (!alignedMode()) {
    for (const card of $$('.card', cardsEl)) card.style.top = '';
    cardsEl.style.height = '';
    return;
  }
  const cardsTop = cardsEl.getBoundingClientRect().top;
  let cursor = 0;
  let maxBottom = 0;
  for (const it of visibleAnnotations()) {
    const card = cardsEl.querySelector(`.card[data-hid="${it.h.id}"]`);
    if (!card) continue;
    const markViewportY = it.y - scrollY;
    const wantY = markViewportY - cardsTop; // align card top to mark top
    const y = Math.max(wantY, cursor, 0);
    card.style.top = y + 'px';
    cursor = y + card.offsetHeight + 10;
    maxBottom = Math.max(maxBottom, y + card.offsetHeight);
  }
  cardsEl.style.height = maxBottom + 60 + 'px';
}
/* throttle leading edge + trailing settle; no rAF (throttled in
   background/headless contexts) */
let lastLayout = 0;
let layoutTimer = null;
window.addEventListener('scroll', () => {
  const now = performance.now();
  if (now - lastLayout > 50) {
    lastLayout = now;
    layoutRail();
  }
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(layoutRail, 90);
}, { passive: true });

function buildOrphanCard(o) {
  const card = document.createElement('article');
  card.className = `card orphan c-${o.color}`;
  card.innerHTML =
    `<div class="card-head"><span class="card-tag">unplaced</span>` +
    `<span class="card-loc">from the PDF</span></div>` +
    `<div class="card-quote">${escHtml(o.text.slice(0, 160))}</div>` +
    (o.note ? `<div class="card-note">${escHtml(o.note)}</div>` : '') +
    `<div class="card-actions"><button data-act="place">Place in text</button>` +
    `<button data-act="dismiss" class="danger">Dismiss</button></div>`;
  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'place') { e.stopPropagation(); armOrphan(o, card); }
    if (act === 'dismiss') {
      e.stopPropagation();
      orphanResolved.add(o.oid);
      persistOrphanState();
      updateCounts(); renderRail();
    }
  });
  return card;
}

function buildCard(h, editNote) {
  const card = document.createElement('article');
  card.className = `card c-${h.color}` + (store.orphans.has(h.id) ? ' orphan' : '');
  card.dataset.hid = h.id;
  const tag = store.orphans.has(h.id) ? 'orphan' : h.note ? 'note' : 'mark';
  card.innerHTML =
    `<div class="card-head"><span class="card-tag">${tag}</span>` +
    `<span class="card-loc">${escHtml(sectionById.get(h.sectionId)?.dataset.display || h.sectionId)}</span></div>` +
    `<div class="card-quote">${escHtml(h.text.slice(0, 160))}</div>` +
    (editNote
      ? `<textarea class="card-note-edit" placeholder="Write a note (⌘↵ to save)">${escHtml(h.note || '')}</textarea>`
      : `<div class="card-note">${escHtml(h.note || '')}</div>`) +
    `<div class="card-actions">` +
    (editNote
      ? `<button data-act="save">Save</button><button data-act="cancel">Cancel</button>`
      : `<button data-act="note">${h.note ? 'Edit note' : 'Add note'}</button>`) +
    `<button data-act="del" class="danger">Delete</button></div>`;

  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'note') { e.stopPropagation(); renderRailWithEdit(h.id); return; }
    if (act === 'save') {
      e.stopPropagation();
      h.note = $('.card-note-edit', card).value.trim();
      h.updatedAt = new Date().toISOString();
      store.userEdited = true;
      refreshNoteDot(h);
      store.persist(); updateCounts(); closeEditor(h.id); placeTicksSoon();
      return;
    }
    if (act === 'cancel') { e.stopPropagation(); closeEditor(h.id); return; }
    if (act === 'del') {
      e.stopPropagation();
      if (card.dataset.confirm) { deleteHighlight(h.id); }
      else {
        card.dataset.confirm = '1';
        e.target.textContent = 'Sure?';
        setTimeout(() => { delete card.dataset.confirm; try { e.target.textContent = 'Delete'; } catch (_) {} }, 2200);
      }
      return;
    }
    // click body → jump to mark
    const m = $(`mark.hl[data-hid="${h.id}"]`);
    if (m) {
      m.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashMark(h.id);
    }
  });
  card.addEventListener('mouseenter', () => {
    const m = $(`mark.hl[data-hid="${h.id}"]`);
    if (m) { drawLeader(m, card, h.color); setTickActive(h.id, true); m.classList.add('hover'); }
  });
  card.addEventListener('mouseleave', () => {
    clearLeader(); setTickActive(h.id, false);
    $$(`mark.hl[data-hid="${h.id}"]`).forEach((m) => m.classList.remove('hover'));
  });
  if (editNote) {
    const ta = $('.card-note-edit', card);
    setTimeout(() => ta.focus(), 30);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('[data-act="save"]', card).click();
      if (e.key === 'Escape') closeEditor(h.id);
    });
  }
  return card;
}
/* renderRail() reuses cards that already exist, so closing an editor has
   to swap the card itself back to its plain form (else the textarea stays
   up after Save or Cancel). */
function closeEditor(hid) {
  editingHid = null;
  const h = store.map.get(hid);
  const card = $(`.card[data-hid="${hid}"]`);
  if (h && card && $('.card-note-edit', card)) {
    const fresh = buildCard(h);
    fresh.style.top = card.style.top;
    card.replaceWith(fresh);
  }
  renderRail();
}
function renderRailWithEdit(hid) {
  editingHid = null;
  renderRail();
  const h = store.map.get(hid);
  if (!h) return;
  let card = $(`.card[data-hid="${hid}"]`);
  const edit = buildCard(h, true);
  if (card) {
    edit.style.top = card.style.top;
    card.replaceWith(edit);
  } else {
    // mark not in the visible set (filtered out) — pin at the top
    edit.style.top = '0px';
    $('#railCards').appendChild(edit);
  }
  editingHid = hid;
}
function refreshNoteDot(h) {
  const marks = $$(`mark.hl[data-hid="${h.id}"]`);
  marks.forEach((m) => $('.ndot', m)?.remove());
  if (h.note && marks.length) {
    const d = document.createElement('span');
    d.className = 'ndot';
    marks[marks.length - 1].appendChild(d);
  }
}
function flashMark(hid) {
  $$(`mark.hl[data-hid="${hid}"]`).forEach((m) => {
    m.classList.add('is-focused');
    setTimeout(() => m.classList.remove('is-focused'), 1100);
  });
}

/* center a mark's rail card in the rail's own scroll viewport — never
   the document, which the person is mid-reading — and pulse it so
   the eye finds it. Silent no-op if the rail is hidden (narrow
   viewport) or the card isn't currently rendered (e.g. filtered out). */
function centerRailCard(hid) {
  const rail = $('#rail');
  if (!rail || rail.clientHeight <= 0) return;
  const card = $(`.card[data-hid="${hid}"]`);
  if (!card) return;
  const railRect = rail.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const top = Math.max(0, rail.scrollTop + (cardRect.top - railRect.top) -
    (rail.clientHeight / 2 - cardRect.height / 2));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  rail.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  card.classList.add('spot');
  setTimeout(() => card.classList.remove('spot'), 1200);
}

function deleteHighlight(id) {
  unwrapHighlight(id);
  const h = store.map.get(id);
  if (h) {
    const sec = sectionById.get(h.sectionId);
    if (sec) invalidateIdx(sec);
  }
  store.map.delete(id);
  store.orphans.delete(id);
  store.userEdited = true;
  store.persist();
  updateCounts(); renderRail(); placeTicksSoon();
  hideToolbar();
}

/* ════════ whole-word selections ════════
   A drag that ends mid-word ("…to the person pur|chasing") would anchor a
   highlight to half a word. snapToWords() moves each end of the range out to
   the nearest word edge, walking across text nodes (links, marks), and
   returns the new Range — or null when nothing needed to move. A word is
   letters and digits, with an apostrophe between letters ("person's"); a
   hyphen ends one, so half a compound can still be picked. Only ends that
   sit in text nodes of the section body are touched. */
const isLN = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const isApos = (c) => c === "'" || c === '\u2019' || c === '\u02BC';

/* up to n characters from (node, off) going dir (-1 back, +1 forward);
   each carries the position just past it */
function scanChars(body, node, off, dir, n) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  const out = [];
  let o = off;
  let nd = node;
  while (out.length < n) {
    const t = nd.nodeValue;
    if (dir < 0 ? o > 0 : o < t.length) {
      const ch = dir < 0 ? t[o - 1] : t[o];
      o += dir;
      out.push({ ch, node: nd, off: o });
    } else {
      nd = dir < 0 ? walker.previousNode() : walker.nextNode();
      if (!nd) break;
      o = dir < 0 ? nd.nodeValue.length : 0;
    }
  }
  return out;
}
function insideWord(back, fwd) {
  const [b0, b1] = back.map((x) => x.ch);
  const [f0, f1] = fwd.map((x) => x.ch);
  return (isLN(b0) && isLN(f0)) ||
    (isLN(b0) && isApos(f0) && isLN(f1)) ||
    (isApos(b0) && isLN(b1) && isLN(f0));
}
function snapToWords(range, body) {
  if (!body) return null;
  let { startContainer: sn, startOffset: so, endContainer: en, endOffset: eo } = range;
  // table cells are not part of the anchor text and sit flush against each other
  if (range.commonAncestorContainer.parentElement?.closest('.tbl') ||
      sn.parentElement?.closest('.tbl') || en.parentElement?.closest('.tbl')) return null;
  let moved = false;
  if (sn.nodeType === 3 && body.contains(sn)) {
    for (let i = 0; i < 80; i++) {
      const back = scanChars(body, sn, so, -1, 2);
      const fwd = scanChars(body, sn, so, 1, 2);
      if (!insideWord(back, fwd)) break;
      sn = back[0].node; so = back[0].off; moved = true;
    }
  }
  if (en.nodeType === 3 && body.contains(en)) {
    for (let i = 0; i < 80; i++) {
      const back = scanChars(body, en, eo, -1, 2);
      const fwd = scanChars(body, en, eo, 1, 2);
      if (!insideWord(back, fwd)) break;
      en = fwd[0].node; eo = fwd[0].off; moved = true;
    }
  }
  if (!moved) return null;
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  return r;
}

/* ════════ toolbar (selection + existing highlight) ════════ */
const toolbar = $('#hlToolbar');
let tbMode = null; // {type:'sel', range} | {type:'edit', hid}

document.addEventListener('mouseup', (e) => {
  if (toolbar.contains(e.target)) return;
  const mark = e.target.closest?.('mark.hl');
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      let range = sel.getRangeAt(0);
      const sec = range.commonAncestorContainer.parentElement?.closest?.('.prov');
      if (sec && $('.prov-body', sec).contains(range.commonAncestorContainer)) {
        // never cut a word: pull both ends out to the word edges, and show it
        const snapped = snapToWords(range, $('.prov-body', sec));
        if (snapped) {
          sel.removeAllRanges();
          sel.addRange(snapped);
          range = snapped;
        }
        if (pendingOrphan) {
          // adopting an unplaced PDF highlight onto this selection
          const o = pendingOrphan;
          disarmOrphan();
          const made = createFromSelection(range.cloneRange(), o.color, o.note);
          if (made) {
            orphanResolved.add(o.oid);
            persistOrphanState();
            updateCounts(); renderRail();
            toast('Placed — highlight adopted from PDF');
          }
          return;
        }
        tbMode = { type: 'sel', range: range.cloneRange() };
        showToolbar(range.getBoundingClientRect(), false);
        return;
      }
    }
    if (mark) {
      tbMode = { type: 'edit', hid: mark.dataset.hid };
      showToolbar(mark.getBoundingClientRect(), true);
      centerRailCard(mark.dataset.hid);
      return;
    }
    hideToolbar();
  }, 0);
});

function showToolbar(rect, isEdit) {
  toolbar.classList.add('visible');
  toolbar.classList.remove('confirming');
  toolbar.classList.toggle('sel', !isEdit);
  $('#noteBtn').style.display = isEdit ? '' : 'none';
  $('#delBtn').style.display = isEdit ? '' : 'none';
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
  let x = rect.left + rect.width / 2 - tw / 2;
  let y = rect.top - th - 8;
  x = Math.max(8, Math.min(x, innerWidth - tw - 8));
  if (y < var2px('--topbar-h') + 8) y = rect.bottom + 8;
  y = Math.max(var2px('--topbar-h') + 8, Math.min(y, innerHeight - th - 8));
  toolbar.style.left = x + 'px';
  toolbar.style.top = y + 'px';
}
function var2px(name) {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue(name)) || 46;
}
function hideToolbar() {
  toolbar.classList.remove('visible', 'confirming');
  tbMode = null;
}

toolbar.addEventListener('click', (e) => {
  const cbtn = e.target.closest('.cbtn');
  if (cbtn) {
    const color = cbtn.dataset.c;
    if (tbMode?.type === 'sel') createFromSelection(tbMode.range, color);
    else if (tbMode?.type === 'edit') recolor(tbMode.hid, color);
    return;
  }
  if (e.target.id === 'noteBtn' && tbMode?.type === 'edit') {
    const h = store.map.get(tbMode.hid);
    if (h) {
      const sec = sectionById.get(h.sectionId);
      if (sec && currentSection !== sec) setCurrent(sec);
      renderRailWithEdit(h.id);
    }
    hideToolbar();
  }
  if (e.target.id === 'delBtn') toolbar.classList.add('confirming');
  if (e.target.id === 'delConfirmBtn' && tbMode?.type === 'edit') deleteHighlight(tbMode.hid);
});

function createFromSelection(range, color, note) {
  const sec = range.commonAncestorContainer.parentElement?.closest?.('.prov');
  if (!sec) { hideToolbar(); return false; }
  range = snapToWords(range, $('.prov-body', sec)) || range; // also for ⌘H
  const idx = idxFor(sec);
  // compute normalized offsets of the selection inside the section
  const pre = document.createRange();
  pre.selectNodeContents($('.prov-body', sec));
  pre.setEnd(range.startContainer, range.startOffset);
  const preLen = norm(pre.toString()).replace(/^ /, '').length;
  const selText = norm(range.toString()).trim();
  if (!selText) { hideToolbar(); return false; }
  const occBefore = countOccurrences(idx.normStr.slice(0, preLen + Math.floor(selText.length / 2)), selText);
  const h = {
    id: newId(),
    text: selText,
    color,
    note: note || '',
    sectionId: sec.id,
    occurrence: Math.max(0, occBefore),
    textBefore: idx.normStr.slice(Math.max(0, preLen - 40), preLen),
    textAfter: idx.normStr.slice(preLen + selText.length, preLen + selText.length + 40),
    createdAt: new Date().toISOString(),
  };
  // verify resolution agrees; fall back to context
  const r = rangeForOccurrence(idx, selText, h.occurrence);
  if (!r || norm(r.toString()).trim() !== selText) {
    h.occurrence = bestOccurrenceByContext(idx, selText, h.textBefore, h.textAfter);
    if (h.occurrence === -1) {
      toast('Could not anchor that selection');
      hideToolbar();
      return false;
    }
  }
  store.map.set(h.id, h);
  const res = resolveAndWrap(h);
  if (!res.ok) {
    store.map.delete(h.id);
    toast('Could not anchor that selection');
    hideToolbar();
    return false;
  }
  window.getSelection()?.removeAllRanges();
  store.userEdited = true;
  store.persist(); updateCounts(); renderRail(); placeTicksSoon();
  hideToolbar();
  return true;
}

function recolor(hid, color) {
  const h = store.map.get(hid);
  if (!h) return;
  h.color = color;
  h.updatedAt = new Date().toISOString();
  store.userEdited = true;
  $$(`mark.hl[data-hid="${hid}"]`).forEach((m) => {
    m.className = 'hl c-' + color;
  });
  refreshNoteDot(h);
  store.persist(); renderRail(); placeTicksSoon();
}

/* keyboard: ⌘H highlight selection with default color */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doExport(); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#importFile').click(); }
  if (mod && e.key.toLowerCase() === 'h') {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      e.preventDefault();
      createFromSelection(sel.getRangeAt(0).cloneRange(), 'yellow');
    }
  }
  if (e.key === 'Escape') {
    hideToolbar(); closeSearch(); disarmOrphan();
    closePeek(); closeOrphanPanel();
    $('#typePop').classList.remove('open');
    closeAbout(); closePanels();
  }
  if (!mod && (e.key === '[' || e.key === ']') && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    hopAnnotation(e.key === ']' ? 1 : -1);
  }
});

/* ════════ gutter ticks + leader lines ════════ */
const gutter = $('#gutter');
const leaderPath = $('.leader-path');

function placeTicks() {
  gutter.querySelectorAll('.tick').forEach((t) => t.remove());
  const gRect = gutter.getBoundingClientRect();
  if (gRect.width === 0) return; // hidden on small screens
  const gTop = gRect.top + scrollY;
  const seen = new Set();
  for (const h of store.map.values()) {
    if (store.orphans.has(h.id) || seen.has(h.id)) continue;
    if (!h.note) continue;
    seen.add(h.id);
    const m = $(`mark.hl[data-hid="${h.id}"]`);
    if (!m) continue;
    const r = m.getBoundingClientRect();
    const tick = document.createElement('div');
    tick.className = 'tick c-' + h.color;
    tick.style.top = r.top + r.height / 2 + scrollY - gTop + 'px';
    tick.dataset.hid = h.id;
    tick.addEventListener('mouseenter', () => {
      const mm = $(`mark.hl[data-hid="${h.id}"]`);
      const card = $(`.card[data-hid="${h.id}"]`);
      if (mm) drawLeader(mm, card || tick, h.color);
      tick.classList.add('is-active');
    });
    tick.addEventListener('mouseleave', () => { clearLeader(); tick.classList.remove('is-active'); });
    tick.addEventListener('click', () => {
      const mm = $(`mark.hl[data-hid="${h.id}"]`);
      if (mm) { mm.scrollIntoView({ behavior: 'smooth', block: 'center' }); flashMark(h.id); }
    });
    gutter.appendChild(tick);
  }
}
const placeTicksSoon = debounce(placeTicks, 120);
window.addEventListener('resize', placeTicksSoon);

function drawLeader(fromEl, toEl, color) {
  if (!fromEl || !toEl) return clearLeader();
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  const gr = gutter.getBoundingClientRect();
  if (gr.width === 0) return;
  let x1, y1, x2, y2;
  if (fr.left < tr.left) {
    x1 = fr.right + 2; y1 = fr.top + fr.height / 2;
    x2 = tr.left - 2;  y2 = tr.top + tr.height / 2;
  } else {
    x1 = tr.right + 2; y1 = tr.top + tr.height / 2;
    x2 = fr.left - 2;  y2 = fr.top + fr.height / 2;
  }
  const gx = gr.left + gr.width / 2;
  const gy = fromEl.tagName === 'MARK' ? y1 : y2;
  const c1x = (x1 + gx) / 2, c2x = (gx + x2) / 2;
  leaderPath.setAttribute('d',
    `M ${x1} ${y1} C ${c1x} ${y1}, ${c1x} ${gy}, ${gx} ${gy} C ${c2x} ${gy}, ${c2x} ${y2}, ${x2} ${y2}`);
  leaderPath.classList.remove('c-yellow', 'c-green', 'c-blue', 'c-purple', 'c-orange');
  if (color) leaderPath.classList.add('c-' + color);
  leaderPath.classList.add('visible');
}
function clearLeader() { leaderPath.classList.remove('visible'); }
function setTickActive(hid, on) {
  const t = gutter.querySelector(`.tick[data-hid="${hid}"]`);
  if (t) t.classList.toggle('is-active', on);
}

/* hover a mark → leader to its card */
document.addEventListener('mouseover', (e) => {
  const m = e.target.closest?.('mark.hl');
  if (!m) return;
  const hid = m.dataset.hid;
  const card = $(`.card[data-hid="${hid}"]`);
  const h = store.map.get(hid);
  if (card && h) drawLeader(m, card, h.color);
  setTickActive(hid, true);
});
document.addEventListener('mouseout', (e) => {
  const m = e.target.closest?.('mark.hl');
  if (!m) return;
  clearLeader();
  setTickActive(m.dataset.hid, false);
});

/* ════════ search ════════ */
const sOverlay = $('#searchOverlay');
const sInput = $('#searchInput');
const sResults = $('#searchResults');
let sectionTexts = null;
let sMatches = [];
let sCur = -1;

function buildSectionTexts() {
  if (sectionTexts) return;
  sectionTexts = sections.map((sec) => {
    const idx = idxFor(sec);
    return {
      id: sec.id,
      display: sec.dataset.display,
      normStr: idx ? idx.normStr : '',
      raw: idx ? idx.raw : '',    // the text as displayed (curly quotes, em dashes)
      n2r: idx ? idx.n2r : [],    // normalized index -> index into raw
    };
  });
}
function openSearch() {
  sOverlay.classList.add('open');
  sInput.value = '';
  sResults.innerHTML = '<div class="search-hint">Type at least two characters. Enter jumps to the next hit; click a row to go there.</div>';
  $('#searchCount').textContent = '';
  setTimeout(() => sInput.focus(), 30);
}
function closeSearch() {
  if (!sOverlay.classList.contains('open')) return;
  sOverlay.classList.remove('open');
  clearSearchMarks();
}
$('#searchOpenBtn').addEventListener('click', openSearch);
$('#searchClose').addEventListener('click', closeSearch);
sOverlay.addEventListener('click', (e) => { if (e.target === sOverlay) closeSearch(); });

sInput.addEventListener('input', debounce(runSearch, 160));
sInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); gotoMatch(sCur + 1); }
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); gotoMatch(sCur - 1); }
});
$('#searchNext').addEventListener('click', () => gotoMatch(sCur + 1));
$('#searchPrev').addEventListener('click', () => gotoMatch(sCur - 1));

function runSearch() {
  clearSearchMarks(); // before building texts — it invalidates the cache
  buildSectionTexts();
  const q = norm(sInput.value).trim();
  sMatches = []; sCur = -1;
  if (q.length < 2) {
    sResults.innerHTML = '<div class="search-hint">Type at least two characters.</div>';
    $('#searchCount').textContent = '';
    return;
  }
  const ql = q.toLowerCase();
  for (const st of sectionTexts) {
    const hay = st.normStr.toLowerCase();
    let i = -1, perSec = 0;
    while ((i = hay.indexOf(ql, i + 1)) !== -1 && sMatches.length < 500) {
      sMatches.push({ sec: st.id, display: st.display, normIdx: i, occ: perSec++ });
    }
    if (sMatches.length >= 500) break;
  }
  $('#searchCount').textContent = sMatches.length
    ? (sMatches.length === 1 ? '1 hit' : `${sMatches.length}${sMatches.length >= 500 ? '+' : ''} hits`)
    : 'No hits';
  sResults.innerHTML = '';
  const frag = document.createDocumentFragment();
  sMatches.slice(0, 120).forEach((m, i) => {
    const st = sectionTexts.find((s) => s.id === m.sec);
    // Matching runs on the canonicalized string (straight quotes, hyphens),
    // but the snippet is cut from the displayed text through n2r, so a
    // result reads the way the law is set: “accredited investor”, em dashes.
    const a = Math.max(0, m.normIdx - 46);
    const e = m.normIdx + q.length;                       // end of the hit
    const b = Math.min(st.normStr.length, e + 60);
    const rawStart = st.n2r[a];
    const hitStart = st.n2r[m.normIdx];
    const hitEnd = st.n2r[e - 1] + 1;
    const rawEnd = b > e ? st.n2r[b - 1] + 1 : hitEnd;
    const flat = (x) => escHtml(x.replace(/\s+/g, ' '));
    const pre = flat(st.raw.slice(rawStart, hitStart));
    const hit = flat(st.raw.slice(hitStart, hitEnd));
    const post = flat(st.raw.slice(hitEnd, rawEnd));
    const row = document.createElement('div');
    row.className = 'sres';
    row.innerHTML = `<span class="loc">${escHtml(m.display)}</span><span class="ctx">…${pre}<b>${hit}</b>${post}…</span>`;
    row.addEventListener('click', () => gotoMatch(i));
    frag.appendChild(row);
  });
  sResults.appendChild(frag);
}

let searchMarkSecs = new Set();
function clearSearchMarks() {
  for (const secId of searchMarkSecs) {
    const sec = sectionById.get(secId);
    if (!sec) continue;
    $$('mark.shit', sec).forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove();
      p.normalize();
    });
    invalidateIdx(sec);
  }
  searchMarkSecs.clear();
  sectionTexts = null; // node maps changed
}
function gotoMatch(i) {
  if (!sMatches.length) return;
  sCur = ((i % sMatches.length) + sMatches.length) % sMatches.length;
  const m = sMatches[sCur];
  const sec = sectionById.get(m.sec);
  const q = norm(sInput.value).trim();
  // mark all hits in this section if not already
  if (!searchMarkSecs.has(m.sec)) {
    const idx = idxFor(sec);
    const hayL = idx.normStr.toLowerCase();
    const ql = q.toLowerCase();
    let j = -1; const ranges = [];
    while ((j = hayL.indexOf(ql, j + 1)) !== -1) ranges.push(j);
    // wrap from last to first so earlier offsets stay valid
    for (let r = ranges.length - 1; r >= 0; r--) {
      const range = rangeFromNorm(idx, ranges[r], q.length);
      if (!range) continue;
      for (const mm of wrapRange(range, { id: 'search', color: 'search' })) {
        mm.className = 'shit';
        delete mm.dataset.hid;
      }
    }
    invalidateIdx(sec);
    searchMarkSecs.add(m.sec);
  }
  const hits = $$('mark.shit', sec);
  $$('mark.shit.cur').forEach((x) => x.classList.remove('cur'));
  const target = hits[m.occ] || hits[0];
  if (target) {
    target.classList.add('cur');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('#searchCount').textContent = `${sCur + 1} / ${sMatches.length}`;
  $$('.sres').forEach((r, ri) => r.classList.toggle('sel', ri === sCur));
}

/* ════════ export / import ════════ */
function doExport() {
  const payload = store.payload();
  payload.orphans = Object.fromEntries(store.orphans);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${DOC.name}-annotations-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${store.map.size} annotations`);
}
$('#exportBtn').addEventListener('click', doExport);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      importData(JSON.parse(rd.result));
    } catch (err) {
      toast('Import failed: ' + err.message);
    }
  };
  rd.readAsText(f);
});

function importData(data, isSeed) {
  if (!data || !Array.isArray(data.highlights)) throw new Error('no highlights array');
  // wipe current marks
  for (const id of Array.from(store.map.keys())) unwrapHighlight(id);
  store.map.clear(); store.orphans.clear();
  indexCache.clear();
  const isV2 = data.version === 2;
  if (isV2) {
    for (const h of data.highlights) store.map.set(h.id || newId(), sanitizeStored(h));
    if (isSeed) {
      store.seedTag = data.savedAt || 'seed';
      store.userEdited = false;
    } else {
      store.userEdited = true;
    }
    const res = restoreAll();
    store.persist();
    toast(`${isSeed ? 'Loaded' : 'Imported'} ${res.ok} annotations` +
      (res.orphans ? ` · ${res.orphans} need review` : ''));
  } else {
    store.userEdited = true;
    const res = importLegacy(data);
    toast(`Imported ${res.ok} from legacy format` + (res.orphan ? ` · ${res.orphan} need review` : ''));
  }
  updateCounts(); renderRail(); placeTicksSoon();
}

/* ════════ toast ════════ */
function toast(msg, actionLabel, actionFn) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.addEventListener('click', () => { actionFn(); t.remove(); });
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), actionLabel ? 12000 : 4200);
}

/* ════════ provision credits expand ════════ */
document.addEventListener('click', (e) => {
  const cr = e.target.closest?.('.prov-credit');
  if (cr) cr.classList.toggle('open');
});

/* ════════ cross-references — peek, don't jump ════════
   Click (or a 450ms hover) opens a floating preview of the target
   provision cloned from the already-rendered DOM. "open §" performs
   the old full jump and leaves a return pill, since replaceState
   gives the browser back-button nothing to go back to. */
document.addEventListener('click', (e) => {
  const x = e.target.closest?.('a.xref');
  if (!x) return;
  e.preventDefault();
  if (x.classList.contains('xref-ext')) return; // dead ref — plain text
  clearTimeout(peekTimer);
  openPeek(x, true);
});
function jumpToSection(id) {
  const sec = sectionById.get(id);
  if (!sec) return;
  sec.scrollIntoView({ behavior: 'instant', block: 'start' });
  history.replaceState(null, '', '#' + id);
  setCurrent(sec);
  $('.prov-title', sec)?.animate(
    [{ opacity: 0.4 }, { opacity: 1 }],
    { duration: 700, easing: 'ease-out' }
  );
}

/* ════════ boot ════════ */
function boot() {
  // meta
  // a dash ends the line it breaks (as on the PDF cover); a "·" starts the next
  $('#tocTitle').textContent = (DOC.title || '').replace(/ \u2014 /g, '\u00a0\u2014 ');
  $('#tocSub').textContent = DOC.subtitle;
  $('#tocEyebrow').innerHTML = scHtml((DOC.edition || '').replace(/ \u00b7 /g, ' \u00b7\u00a0'));
  // regulation sub-heads in the text ("Subpart 229.100 — Business") are small
  // caps too; they sit outside every .prov-body, so annotations never see them
  for (const el of $$('.reg-subhead')) el.innerHTML = scHtml(el.textContent);
  for (const el of $$('section.prov')) smartQuotes(el);
  // table cells: a short cell ("8-K", "ABS-EE", "N/A") never breaks; the first column
  // (the row labels) stays in view when a wide table scrolls sideways. Tables are not
  // part of the annotation text, so nothing here touches anchoring.
  for (const c of $$('.tbl th, .tbl td')) if (c.textContent.trim().length <= 8) c.classList.add('nw');
  for (const table of $$('.tbl table')) {   // mark the cells that really sit in column 0
    let covered = 0;                        // rows still spanned by a column-0 cell above
    for (const tr of table.rows) {
      if (covered > 0) { covered--; continue; }
      const c = tr.cells[0];
      if (!c) continue;
      c.classList.add('c0');
      covered = (c.rowSpan || 1) - 1;
    }
  }
  fillAbout();
  renderToc();

  store.load();
  loadOrphanState();
  let seed = null;
  try {
    seed = JSON.parse(document.getElementById('seedData')?.textContent || 'null');
  } catch (_) { /* no seed */ }
  const seedVer = seed?.savedAt || 'seed';
  if (!store.map.size) {
    // first open: seed annotations baked into the file (PDF migration)
    if (seed?.highlights?.length) {
      for (const h of seed.highlights) store.map.set(h.id || newId(), sanitizeStored(h));
      store.seedTag = seedVer;
      store.persist();
    }
  } else if (seed?.highlights?.length && store.seedTag && store.seedTag !== seedVer) {
    if (!store.userEdited) {
      // never touched by hand — upgrade to the new migration silently
      setTimeout(() => importData(seed, true), 50);
    } else {
      toast('A newer migration build is baked into this file', 'load it', () => {
        importData(seed, true);
      });
    }
  }
  const res = restoreAll();
  if (store.map.size) {
    toast(`Restored ${res.ok} annotations` + (res.orphans ? ` · ${res.orphans} need review` : ''));
  } else {
    // fresh state: legacy localStorage? offer import
    for (const k of LEGACY_KEYS) {
      try {
        const legacy = JSON.parse(localStorage.getItem(k) || 'null');
        if (legacy?.highlights?.length) {
          toast(`Found ${legacy.highlights.length} annotations from the previous reader`, 'import', () => {
            const r = importLegacy(legacy);
            updateCounts(); renderRail(); placeTicksSoon();
            toast(`Imported ${r.ok}` + (r.orphan ? ` · ${r.orphan} need review` : ''));
          });
          break;
        }
      } catch (_) { /* ignore */ }
    }
  }
  updateCounts();
  if (sections.length) setCurrent(sections[0]);
  placeTicks();
  if (document.fonts?.ready) document.fonts.ready.then(placeTicksSoon);
}
boot();

/* ════════ xref classification — mute dead cross-references ════════
   Classify once, synchronously right after boot() and before the
   event loop can process any click/hover: xrefs to provisions absent
   from this file get .xref-ext so they read as plain text instead of
   dead links. Ordering matters — openPeek() (below) clones a
   .prov-body via cloneNode(true), which copies this class along, so
   running classification first is what keeps peek-preview xrefs
   muted too. */
for (const x of $$('#content a.xref')) {
  const t = (x.getAttribute('href') || '').slice(1);
  if (!sectionById.has(t)) x.classList.add('xref-ext');
}

/* ════════ display preferences — theme · type ════════
   Stored under a reader-global key (not per-document) so the choice
   follows the person across every supplement they open. The shell
   applies the same key pre-paint to avoid a theme flash. */
const PREFS_KEY = 'supplementReader.prefs';
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; }
  catch (_) { return {}; }
})();
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
function applyPrefs() {
  const d = document.documentElement;
  d.dataset.theme = prefs.theme === 'dark' ? 'dark' : 'paper';
  d.style.setProperty('--content-fs', (prefs.fs || 17) + 'px');
  if (prefs.measure === 'wide') d.dataset.measure = 'wide';
  else delete d.dataset.measure;
  $('#fsVal').textContent = prefs.fs || 17;
  $('#measureNormal').classList.toggle('active', prefs.measure !== 'wide');
  $('#measureWide').classList.toggle('active', prefs.measure === 'wide');
  const dark = prefs.theme === 'dark';
  $('#themeBtn').textContent = dark ? 'Light' : 'Dark';
  $('#themeBtn').title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  placeTicksSoon();
  layoutRail();
}
$('#themeBtn').addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'paper' : 'dark';
  savePrefs(); applyPrefs();
});
const typePop = $('#typePop');
$('#typeBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeAbout();
  if (typePop.classList.toggle('open')) {
    const r = $('#typeBtn').getBoundingClientRect();
    typePop.style.top = r.bottom + 8 + 'px';
    typePop.style.left = Math.min(r.left, innerWidth - typePop.offsetWidth - 10) + 'px';
  }
});
document.addEventListener('click', (e) => {
  if (typePop.classList.contains('open') && !typePop.contains(e.target)) {
    typePop.classList.remove('open');
  }
});
function setFs(v) {
  prefs.fs = Math.max(15, Math.min(21, v));
  savePrefs(); applyPrefs();
}
$('#fsMinus').addEventListener('click', () => setFs((prefs.fs || 17) - 1));
$('#fsPlus').addEventListener('click', () => setFs((prefs.fs || 17) + 1));
$('#measureNormal').addEventListener('click', () => { prefs.measure = 'normal'; savePrefs(); applyPrefs(); });
$('#measureWide').addEventListener('click', () => { prefs.measure = 'wide'; savePrefs(); applyPrefs(); });
applyPrefs();

/* ════════ about this file ════════
   Where the build facts (currency, build date) and the annotation
   bookkeeping (placed / unplaced highlights) live, out of the chrome. */
/* (no module-level consts here: fillAbout() runs from boot(), which comes
   before this section in the file, so a const would still be in its
   temporal dead zone) */
function longDate(iso) { // a calendar date ('2026-10-29'), shown as written
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function localDate(iso) { // a build timestamp, shown in the reader's own timezone
  const d = new Date(iso || '');
  return isNaN(d) ? '' : d.toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' });
}
function fillAbout() {
  const src = DOC.source || {};
  $('#apContents').textContent = plural(DOC.provisions, 'provision');
  // non-breaking hyphens keep 'Public Law 119-134' from splitting across lines
  const usc = (src.usc_label || (src.usc_release ? 'release point ' + src.usc_release : ''))
    .replace(/(\d)-(\d)/g, '$1\u2011$2');
  $('#apUsc').textContent = usc ? 'Current through ' + usc : '–';
  $('#apUscRow').classList.toggle('ap-row-hidden', !usc);
  const ecfr = longDate(src.ecfr_date);
  $('#apEcfr').textContent = ecfr ? 'Current as of ' + ecfr : '–';
  $('#apEcfrRow').classList.toggle('ap-row-hidden', !ecfr);
  $('#apBuilt').textContent = localDate(DOC.generated) || '–';
}
const aboutPop = $('#aboutPop');
const aboutBtn = $('#aboutBtn');
function closeAbout() {
  aboutPop.classList.remove('open');
  aboutBtn.setAttribute('aria-expanded', 'false');
}
aboutBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = aboutPop.classList.toggle('open');
  aboutBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) return;
  typePop.classList.remove('open');
  const r = aboutBtn.getBoundingClientRect();
  const pw = aboutPop.offsetWidth, ph = aboutPop.offsetHeight;
  aboutPop.style.left = Math.max(10, Math.min(r.left, innerWidth - pw - 10)) + 'px';
  aboutPop.style.top = Math.max(var2px('--topbar-h') + 8, r.top - ph - 10) + 'px';
});
document.addEventListener('click', (e) => {
  if (aboutPop.classList.contains('open') && !aboutPop.contains(e.target)) closeAbout();
});
$('#apReview').addEventListener('click', () => { closeAbout(); openOrphanPanel(); });

/* ════════ narrow screens: contents and notes slide over the text ════════ */
function setPanel(which) {
  document.body.classList.toggle('toc-open', which === 'toc');
  document.body.classList.toggle('rail-open', which === 'rail');
  $('#tocToggle').setAttribute('aria-expanded', String(which === 'toc'));
  $('#notesToggle').setAttribute('aria-expanded', String(which === 'rail'));
  if (which === 'rail') layoutRail();
}
function closePanels() { setPanel(null); }
$('#tocToggle').addEventListener('click', () => setPanel(document.body.classList.contains('toc-open') ? null : 'toc'));
$('#notesToggle').addEventListener('click', () => setPanel(document.body.classList.contains('rail-open') ? null : 'rail'));
$('#scrim').addEventListener('click', closePanels);

/* ════════ xref peek ════════ */
const peek = $('#xrefPeek');
let peekPinned = false;
let peekTimer = null;
function openPeek(link, pin) {
  const targetId = (link.getAttribute('href') || '').slice(1);
  const dataTo = link.dataset.to || targetId;
  const subPath = dataTo.includes('/') ? dataTo.split('/').slice(1) : [];
  const sec = sectionById.get(targetId);
  peekPinned = !!pin;
  const body = $('#peekBody');
  body.innerHTML = '';
  if (sec) {
    $('#peekNum').textContent = sec.dataset.display || '';
    $('#peekCite').textContent = $('.prov-cite', sec)?.textContent || '';
    $('#peekTitle').textContent = $('.prov-name', sec)?.textContent || '';
    const clone = $('.prov-body', sec).cloneNode(true);
    // strip ids + highlight bindings so document-wide queries and
    // annotation logic never touch popup clones
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
    for (const el of clone.querySelectorAll('mark.hl')) el.removeAttribute('data-hid');
    body.appendChild(clone);
    $('#peekGo').style.display = '';
    peek.dataset.target = targetId;
    body.scrollTop = 0;
    if (subPath.length) {
      const want = '(' + subPath[0] + ')';
      const n = Array.from(clone.querySelectorAll('.t > .n'))
        .find((el) => el.textContent.trim().startsWith(want));
      let row = n?.closest('.t');
      // a run-in head is two inline <p>s in a .ri block: mark the block
      if (row?.parentElement?.classList.contains('ri')) row = row.parentElement;
      if (row) {
        row.classList.add('peek-focus');
        // measured from the scroller itself (offsetTop is relative to the
        // nearest positioned ancestor, which sits above the peek's heading)
        setTimeout(() => {
          const top = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
          body.scrollTop = Math.max(0, top - 12);
        }, 0);
      }
    }
  } else {
    $('#peekNum').textContent = link.textContent;
    $('#peekCite').textContent = '';
    $('#peekTitle').textContent = 'Not in this supplement';
    body.innerHTML = '<div class="peek-missing">This provision isn’t part of the current selection.</div>';
    $('#peekGo').style.display = 'none';
    delete peek.dataset.target;
  }
  positionPeek(link);
  peek.classList.add('open');
}
function positionPeek(link) {
  const r = link.getBoundingClientRect();
  peek.style.visibility = 'hidden';
  peek.classList.add('open');
  const pw = peek.offsetWidth, ph = peek.offsetHeight;
  const x = Math.max(12, Math.min(r.left, innerWidth - pw - 12));
  let y = r.bottom + 10;
  if (y + ph > innerHeight - 12) y = r.top - ph - 10;
  y = Math.max(var2px('--topbar-h') + 8, y);
  peek.style.left = x + 'px';
  peek.style.top = y + 'px';
  peek.style.visibility = '';
}
function closePeek() {
  peek.classList.remove('open');
  peekPinned = false;
  clearTimeout(peekTimer);
}
document.addEventListener('mouseover', (e) => {
  const x = e.target.closest?.('a.xref');
  if (!x || peekPinned || x.classList.contains('xref-ext')) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => openPeek(x, false), 450);
});
document.addEventListener('mouseout', (e) => {
  const x = e.target.closest?.('a.xref');
  if (!x) return;
  clearTimeout(peekTimer);
  if (!peekPinned && peek.classList.contains('open')) {
    peekTimer = setTimeout(() => { if (!peek.matches(':hover')) closePeek(); }, 250);
  }
});
peek.addEventListener('mouseenter', () => { if (!peekPinned) clearTimeout(peekTimer); });
peek.addEventListener('mouseleave', () => {
  if (!peekPinned) peekTimer = setTimeout(closePeek, 250);
});
document.addEventListener('mousedown', (e) => {
  if (peek.classList.contains('open') && !peek.contains(e.target) && !e.target.closest?.('a.xref')) {
    closePeek();
  }
});
$('#peekClose').addEventListener('click', closePeek);
$('#peekGo').addEventListener('click', () => {
  const id = peek.dataset.target;
  if (!id) return;
  setReturnPoint();
  closePeek();
  jumpToSection(id);
});

/* ════════ return pill ════════ */
const returnPill = $('#returnPill');
let returnPoint = null;
function setReturnPoint() {
  returnPoint = {
    y: scrollY,
    label: currentSection ? currentSection.dataset.display : 'where you were',
  };
  $('#returnLabel').textContent = 'Back to ' + returnPoint.label;
  returnPill.classList.add('visible');
}
returnPill.addEventListener('click', () => {
  if (!returnPoint) return;
  markAutoScroll();
  scrollTo({ top: returnPoint.y, behavior: 'instant' });
  returnPill.classList.remove('visible');
  returnPoint = null;
});

/* ════════ toc filter ════════ */
const tocFilterEl = $('#tocFilter');
function applyTocFilter() {
  const q = tocFilterEl.value.trim().toLowerCase();
  $('#tocFilterClear').classList.toggle('visible', !!q);
  for (const act of $$('.toc-act')) {
    let any = false;
    for (const it of $$('.toc-item', act)) {
      const hit = !q || it.textContent.toLowerCase().includes(q);
      it.classList.toggle('filtered-out', !hit);
      if (hit) any = true;
    }
    // subheads lose their grouping meaning mid-filter — hide them
    for (const sh of $$('.toc-subhead', act)) sh.classList.toggle('filtered-out', !!q);
    act.classList.toggle('filtered-out', !any);
    if (q && any) act.classList.remove('collapsed');
  }
}
tocFilterEl.addEventListener('input', debounce(applyTocFilter, 80));
tocFilterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    tocFilterEl.value = '';
    applyTocFilter();
    tocFilterEl.blur();
  }
});
$('#tocFilterClear').addEventListener('click', () => {
  tocFilterEl.value = '';
  applyTocFilter();
  tocFilterEl.focus();
});

/* ════════ annotation hop ════════ */
function hopAnnotation(dir) {
  const seen = new Set();
  const marks = [];
  for (const m of $$('#content mark.hl')) {
    const hid = m.dataset.hid;
    if (!hid || seen.has(hid)) continue;
    seen.add(hid);
    marks.push({ m, y: m.getBoundingClientRect().top + scrollY });
  }
  if (!marks.length) { toast('No annotations to jump to'); return; }
  marks.sort((a, b) => a.y - b.y);
  const mid = scrollY + innerHeight / 2;
  const target = dir > 0
    ? marks.find((x) => x.y > mid + 8)
    : [...marks].reverse().find((x) => x.y < mid - 8);
  if (!target) { toast(dir > 0 ? 'No annotations below' : 'No annotations above'); return; }
  target.m.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashMark(target.m.dataset.hid);
}
$('#hopPrev').addEventListener('click', () => hopAnnotation(-1));
$('#hopNext').addEventListener('click', () => hopAnnotation(1));

/* ════════ reading-position restore ════════
   Saves the current section + offset as you read; a URL hash always
   wins. Re-applied once on fonts.ready (layout can shift) unless the
   person has scrolled themselves in the meantime. */
const POS_KEY = STORAGE_NS + '.pos';
let userScrolled = false;
let lastAutoScroll = 0;
function markAutoScroll() { lastAutoScroll = performance.now(); }
addEventListener('scroll', () => {
  if (performance.now() - lastAutoScroll > 400) userScrolled = true;
}, { passive: true });
addEventListener('scroll', debounce(() => {
  if (!currentSection || !userScrolled) return;
  const dy = scrollY - (currentSection.getBoundingClientRect().top + scrollY);
  localStorage.setItem(POS_KEY, JSON.stringify({ sec: currentSection.id, dy: Math.round(dy) }));
}, 600), { passive: true });
(function restorePosition() {
  if (location.hash) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (_) { /* fresh */ }
  const sec = pos && sectionById.get(pos.sec);
  if (!sec) return;
  const apply = () => {
    if (userScrolled) return;
    markAutoScroll();
    const top = sec.getBoundingClientRect().top + scrollY + (pos.dy || 0);
    scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    setCurrent(sec);
  };
  const targetTop = sec.getBoundingClientRect().top + scrollY + (pos.dy || 0);
  if (targetTop < 120) return; // top of the document — nothing to resume
  apply();
  toast('Resumed at ' + (sec.dataset.display || 'your last spot'));
  if (document.fonts?.ready) document.fonts.ready.then(() => setTimeout(apply, 60));
})();

/* ════════ orphan triage panel ════════ */
const orphanOverlay = $('#orphanOverlay');
function openOrphanPanel() {
  renderOrphanPanel();
  orphanOverlay.classList.add('open');
}
function closeOrphanPanel() { orphanOverlay.classList.remove('open'); }
$('#orphanStatBtn').addEventListener('click', openOrphanPanel);
$('#orphanClose').addEventListener('click', closeOrphanPanel);
orphanOverlay.addEventListener('click', (e) => { if (e.target === orphanOverlay) closeOrphanPanel(); });
function renderOrphanPanel() {
  const list = $('#orphanList');
  list.innerHTML = '';
  const items = ORPHANS.filter((o) => !orphanResolved.has(o.oid));
  const orderOf = (o) => {
    const s = sectionById.get(o.near);
    return s ? sections.indexOf(s) : Number.MAX_SAFE_INTEGER;
  };
  items.sort((a, b) => orderOf(a) - orderOf(b));
  $('#orphanRemaining').textContent = items.length ? items.length + ' remaining' : 'All clear';
  if (!items.length) {
    list.innerHTML = '<div class="orphan-empty">Nothing left to place. Every highlight is anchored or dismissed.</div>';
    return;
  }
  for (const o of items) {
    const near = sectionById.get(o.near);
    const row = document.createElement('article');
    row.className = 'orow c-' + (COLORS.includes(o.color) ? o.color : 'yellow');
    row.innerHTML =
      `<div class="orow-head"><span class="orow-tag">${escHtml(o.color || 'yellow')}</span>` +
      `<span class="orow-near">${near ? 'near ' + escHtml(near.dataset.display) : 'location unknown'}</span></div>` +
      `<div class="orow-quote">${escHtml((o.text || '').slice(0, 220))}</div>` +
      (o.note ? `<div class="orow-note">${escHtml(o.note)}</div>` : '') +
      `<div class="orow-actions"><button data-act="place">Find its place</button>` +
      `<button data-act="dismiss" class="danger">Dismiss</button></div>`;
    row.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'place') {
        closeOrphanPanel();
        if (near) {
          markAutoScroll();
          near.scrollIntoView({ behavior: 'instant', block: 'start' });
          setCurrent(near);
        }
        armOrphan(o);
      } else if (act === 'dismiss') {
        orphanResolved.add(o.oid);
        persistOrphanState();
        updateCounts(); renderRail(); renderOrphanPanel();
        toast('Highlight dismissed', 'Undo', () => {
          orphanResolved.delete(o.oid);
          persistOrphanState();
          updateCounts(); renderRail();
          if (orphanOverlay.classList.contains('open')) renderOrphanPanel();
        });
      }
    });
    list.appendChild(row);
  }
}
