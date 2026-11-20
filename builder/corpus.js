export const REGISTRY_URL = "./corpora.json";
export const CORPUS_URL = "./corpus.json";

// FALLBACK SHIM for corpus files that predate the `meta` block
// (docs/contracts.md § 8). This is the ONLY place in the builder where
// domain strings may stay hardcoded — everything else reads corpus.meta.
const FALLBACK_META = {
  id: "securities",
  label: "Federal Securities Laws",
  defaultTitle: "Federal Securities Laws — Statutory Supplement",
  uscCitePrefix: "15 U.S.C.",
  cfrCitePrefix: "17 C.F.R.",
  modes: { codified: "Codified (U.S.C.)", original: "Original acts" },
};

// Pick a registry entry: the requested id when it exists, else the
// registry default (warning, not a crash — gate for ?corpus=bogus).
export function resolveCorpusEntry(registry, requestedId) {
  const corpora = Array.isArray(registry?.corpora) ? registry.corpora : [];
  if (requestedId) {
    const hit = corpora.find(c => c.id === requestedId);
    if (hit) return hit;
    console.warn(`Unknown corpus "${requestedId}" — falling back to the default corpus.`);
  }
  return corpora.find(c => c.id === registry?.default) || corpora[0] || null;
}

// Guarantee corpus.meta exists so consumers never re-hardcode strings.
export function applyMetaShim(corpus, id) {
  if (!corpus.meta) corpus.meta = { ...FALLBACK_META, id: id || FALLBACK_META.id };
  return corpus;
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json();
}

// No-arg call: resolve the corpus through the registry, honoring a
// ?corpus= URL param. Explicit url bypasses the registry (back-compat).
export async function loadCorpus(url) {
  if (url) return applyMetaShim(await fetchJson(url, url));

  let registry = null;
  try {
    registry = await fetchJson(REGISTRY_URL, "corpora.json");
  } catch (e) {
    console.warn("Corpus registry unavailable — loading the default corpus.", e);
  }
  const requested = new URLSearchParams(globalThis.location?.search || "").get("corpus");
  const entry = registry ? resolveCorpusEntry(registry, requested) : null;
  const corpus = await fetchJson(entry?.path || CORPUS_URL, "corpus.json");
  return applyMetaShim(corpus, entry?.id);
}

export function indexCorpus(corpus) {
  const byId = new Map();
  const actById = new Map();
  const actBySectionId = new Map();
  const regBySectionId = new Map();

  for (const act of corpus.acts) {
    actById.set(act.id, act);
    for (const section of act.sections) {
      byId.set(section.id, section);
      actBySectionId.set(section.id, act);
    }
  }

  const regById = new Map();
  const subjectGroupById = new Map();   // "Regulation D" etc. (regulation.groups)
  const ruleGroupById = new Map();      // rule id -> subject group id
  for (const regulation of corpus.regulations) {
    regById.set(regulation.id, regulation);
    for (const g of regulation.groups || []) {
      subjectGroupById.set(g.id, { ...g, regulationId: regulation.id });
    }
    for (const rule of regulation.rules) {
      byId.set(rule.id, rule);
      regBySectionId.set(rule.id, regulation);
      if (rule.group) ruleGroupById.set(rule.id, rule.group);
    }
  }

  return {
    corpus, byId, actById, actBySectionId, regBySectionId,
    regById, subjectGroupById, ruleGroupById,
  };
}
