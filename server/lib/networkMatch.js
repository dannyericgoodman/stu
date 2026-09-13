'use strict';
// ══════════════════════════════════════════════════════════════════════════
// networkMatch.js — a founder's ask in, a ranked shortlist of Danny's people out.
//
// Input is a NEED (Airtable's Founder Asks vocabulary: Capital / Advice / Intro /
// Hire / Customer, plus the ask in Danny's own words). Output is people, each with
// the receipts that put them there.
//
// ── THE LAW THIS FILE ENFORCES: FIT GATES, WARMTH RANKS ──
// The tempting scorer is `fit + warmth`, and it is wrong in a way that would
// quietly destroy trust in the tool. Danny's warmest contacts are warm about
// everything, so a blended sum floats the same twenty friends to the top of every
// ask, and the fifth one is always a stretch. That is precisely the failure Raab
// described avoiding — his 4-10 were people he would not have thought of.
//
// So relevance is a GATE, not a term: a person with no evidence of relevance to
// this ask scores zero and is dropped, no matter how well Danny knows them.
// Warmth only orders the people who already cleared the bar. The output is
// therefore "relevant people, warmest first" — never "friends, loosely sorted."
//
// ── WHY NAMED ORGANIZATIONS ARE THE STRONGEST SIGNAL ──
// Real asks name names. Prizm's live ask reads "tech-enabled RIAs (Compound,
// Savvy, Facet, Range) + aggregators (Hightower, Focus Financial, Dynasty)."
// Against a book of 2,691 people whose employer is the one field LinkedIn always
// exports, "who works there" is both the highest-precision query available and
// the one Danny cannot run in his head. It outranks every inferred signal.
//
// ── WHAT THIS DELIBERATELY CANNOT DO ──
// It reads current title and current employer. It does not know what someone did
// five jobs ago, and it never guesses. A person whose title says nothing scores
// on nothing, appears with `signal: none`, and is ranked last rather than
// invented into a fit. Danny scoped ingest as deterministic; this is the honest
// shape of that constraint, not a gap to paper over.
// ══════════════════════════════════════════════════════════════════════════

const np = require('./networkProfile');

// ── Need types, and who can plausibly serve each ──────────────────────────
// `primary` personas are the real answer to the ask. `secondary` are adjacent —
// they still qualify, at a discount. Anyone outside both is gated out entirely.
const TYPE_RULES = {
  capital: {
    label: 'Capital',
    primary: ['investor'],
    secondary: ['founder', 'advisor'],          // angels are usually founders on paper
    sector_boost: ['wealth', 'fintech'],        // capital-adjacent employers
    allow_non_commercial: false,
    seniority_floor: 'director',
  },
  intro: {
    label: 'Intro',
    primary: [],                                 // an intro is about WHERE someone is
    secondary: [],
    allow_non_commercial: false,
    seniority_floor: null,
    org_led: true,                               // named-org matching does the work
  },
  advice: {
    label: 'Advice',
    primary: ['founder', 'advisor', 'investor'],
    secondary: ['service_provider'],
    allow_non_commercial: false,
    seniority_floor: 'manager',
    needs_function: true,                        // advice on WHAT — function must match
  },
  hire: {
    label: 'Hire',
    primary: [],                                 // a hire is about function + level
    secondary: [],
    allow_non_commercial: true,                  // a strong student can be a real hire
    seniority_floor: null,
    needs_function: true,
  },
  customer: {
    label: 'Customer',
    primary: [],
    secondary: [],
    allow_non_commercial: false,
    seniority_floor: 'manager',                  // a buyer has to be able to buy
    org_led: true,
  },
};

const SENIORITY_RANK = { founder: 5, exec: 5, director: 4, manager: 3, senior_ic: 2, junior: 1 };

// ── Ask shorthand → the vocabulary people are classified with ─────────────
// Danny writes asks the way he talks: "industrial PE funds", "fintech/wealth
// angels", "tech-enabled RIAs". None of those strings appear in a LinkedIn title,
// so the ask has to be expanded into the same words people are indexed on.
//
// This expansion applies to the ASK ONLY, never to a person's title, and that
// asymmetry is deliberate. "PE" in an ask means private equity; "PE" in a job
// title is as likely to mean physical education. Expanding one side keeps the
// ask expressive without putting a gym teacher in a buyout shortlist.
const ASK_SYNONYMS = [
  [/\bp\.?e\.?\b(?=\s*(fund|funds|firm|firms|shop|shops|investor|investors|group))/gi, 'private equity'],
  [/\bpe\s+(fund|funds|firm|firms)\b/gi, 'private equity $1'],
  [/\bvc'?s?\b/gi, 'venture capital'],
  [/\bangels?\b/gi, 'angel investor'],
  [/\bfamily offices\b/gi, 'family office'],
  [/\bria'?s\b/gi, 'registered investment advisor'],
  [/\bport\s?cos?\b/gi, 'portfolio company founder'],
  [/\blp'?s\b/gi, 'limited partner'],
  [/\bgp'?s\b/gi, 'general partner'],
  [/\bm&a\b/gi, 'mergers and acquisitions'],
  [/\bib\b/gi, 'investment banker'],
];

function expandAsk(text) {
  let out = String(text || '');
  for (const [re, to] of ASK_SYNONYMS) out = out.replace(re, to);
  return out;
}

// Words that look like organizations but are not, when capitalized mid-sentence.
const ORG_STOPWORDS = new Set([
  'intro', 'intros', 'introduction', 'introductions', 'help', 'looking', 'need', 'needs',
  'want', 'wants', 'seeking', 'anyone', 'someone', 'people', 'folks', 'connections',
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'with', 'at', 'in', 'on', 'of', 'from',
  'we', 'our', 'us', 'i', 'my', 'their', 'they', 'who', 'that', 'this',
  'series', 'seed', 'safe', 'round', 'raise', 'arr', 'gtm', 'ceo', 'cto', 'vp',
  'q1', 'q2', 'q3', 'q4', 'us', 'usa', 'ai', 'saas', 'b2b', 'rias', 'ria',
]);

// ── Parsing the ask ───────────────────────────────────────────────────────

/**
 * Pull explicitly named organizations out of an ask.
 *
 * Two harvests, because real asks write org lists both ways:
 *   · parenthetical lists — "(Compound, Savvy, Facet, Range)"
 *   · capitalized runs    — "Focus Financial", "Hightower"
 */
// Every term in the shared vocabulary, so a capitalized common noun in an ask
// ("Marketing / content-strategy help") is not mistaken for a company name.
const VOCAB_TERMS = new Set(
  [np.FUNCTIONS, np.SECTORS, np.PERSONAS]
    .flatMap((v) => Object.values(v).flat())
    .map((t) => np.normalize(t))
);

/** A candidate org string that is really a category word, an initialism, or noise. */
function isNotAnOrg(candidate) {
  const raw = String(candidate);
  const n = np.normalize(candidate);
  if (!n || n.length < 3) return true;              // "PE", "AI" — never company matches
  if (ORG_STOPWORDS.has(n)) return true;
  if (VOCAB_TERMS.has(n)) return true;              // "Marketing", "Private Equity"
  // Deal terms, not companies. "$1M SAFE / seed ($18M post-money)" is written
  // in exactly the parenthetical shape an org list uses, and it produced the
  // nonsense line "you know nobody at $18M post-money".
  if (/[$%]|\d/.test(raw)) return true;
  return false;
}

function extractOrgs(text) {
  const raw = String(text || '');
  const orgs = new Set();

  // Parenthetical and post-colon lists: every comma-separated item is an org.
  for (const m of raw.matchAll(/[([]([^)\]]+)[)\]]/g)) {
    for (const part of m[1].split(/[,;/]|\band\b|\+/)) {
      const t = part.trim();
      if (!isNotAnOrg(t)) orgs.add(t);
    }
  }

  // Capitalized runs outside parentheses.
  const outside = raw.replace(/[([][^)\]]*[)\]]/g, ' ');
  for (const m of outside.matchAll(/\b([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*)*)/g)) {
    const tokens = m[1].trim().split(/\s+/);
    // Drop runs that are entirely stopwords (sentence-initial "Intros to ...").
    const meaningful = tokens.filter((x) => !ORG_STOPWORDS.has(x.toLowerCase()));
    if (!meaningful.length) continue;
    const candidate = meaningful.join(' ');
    if (!isNotAnOrg(candidate)) orgs.add(candidate);
  }

  return [...orgs];
}

/**
 * Turn a need into the structured query the scorer runs.
 * Sectors and functions are read with the SAME vocabulary used on people, so
 * the two sides of the match always speak one language.
 */
function parseNeed(need = {}) {
  const type = String(need.type || 'advice').toLowerCase();
  const rule = TYPE_RULES[type] || TYPE_RULES.advice;

  // ── The ask and the company context are read DIFFERENTLY, on purpose. ──
  // Both used to go through one scan. Feeding Prizm's 4,000-character investor
  // update through it read the ask as eight functions and five sectors — the
  // update happens to mention SOC 2, engineering, marketing and growth — so
  // every candidate came back carrying eleven "no X signal" gaps and the whole
  // honesty feature turned into noise.
  //
  // The ask states what is NEEDED and is the only thing that can create a
  // requirement. The company blob only says what industry the company is in:
  // it may add sectors that earn a small bonus, and it may never add a function
  // or a gap. A requirement nobody typed is not a requirement.
  const askNorm = np.normalize(expandAsk(need.text || ''));
  const functions = np.scanVocab(askNorm, np.FUNCTIONS).keys;
  const sectors = np.scanVocab(askNorm, np.SECTORS).keys;

  const ctxNorm = np.normalize(String(need.company_context || ''));
  const context_sectors = [
    ...np.scanVocab(ctxNorm, np.SECTORS).keys,
    ...(need.company_sectors || []),
  ].filter((s) => !sectors.includes(s));

  // ── Who the ask is FOR, read from the ask's own words. ──
  // The type rule says who can serve a category of ask; this says who THIS ask
  // named. "Intro to industrial PE funds" is typed Intro, but it is asking for
  // investors, and without this read the one person in the book who runs a PE
  // practice scores zero while a founder of an industrial company outranks him.
  const asked = np.scanVocab(askNorm, np.PERSONAS).keys;
  const target_personas = [...new Set([...rule.primary, ...asked])]
    .filter((p) => !np.NON_COMMERCIAL_PERSONAS.has(p) || rule.allow_non_commercial);

  return {
    type, rule, text: String(need.text || ''),
    functions, sectors, context_sectors, target_personas,
    orgs: extractOrgs(need.text || ''),
  };
}

/**
 * A positive integer count, or the default. Shared by the matcher and the browse
 * route so "what does limit=-5 mean" has exactly one answer.
 */
function clampCount(value, fallback, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** "an advice ask" / "a capital ask" — small thing, but the UI prints it. */
function article(word) {
  return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
}

// ── Organization matching ─────────────────────────────────────────────────

/**
 * Does this person's employer match a named organization from the ask?
 *
 * Single-token orgs demand an exact employer match. That rule exists because the
 * ask "…Facet, Range" against a substring matcher hits "Range Rover of Naperville";
 * requiring equality keeps the real Range employee and drops the dealership.
 * Multi-token orgs may match as a phrase, since "Focus Financial" is specific
 * enough that "Focus Financial Partners" is the same company.
 */
function orgMatch(companyName, orgs) {
  if (!companyName) return null;
  const c = np.normalize(companyName);
  if (!c) return null;
  for (const org of orgs) {
    const o = np.normalize(org);
    if (!o) continue;
    const multi = o.includes(' ');
    if (multi ? np.phraseHit(c, o) : c === o) return org;
  }
  return null;
}

// ── Scoring one person against one need ───────────────────────────────────

/**
 * @param person  a network_people row, already carrying a parsed profile
 * @param q       the output of parseNeed
 * @returns {{fit:number, reasons:string[], gaps:string[], gated:string|null}}
 *          `gated` non-null means excluded outright, and says why.
 */
function scoreFit(person, q) {
  const prof = person.profile || {};
  const reasons = [];
  let fit = 0;

  // ── Gate 1: non-commercial personas. ──
  if (!prof.is_commercial && !q.rule.allow_non_commercial) {
    return { fit: 0, reasons: [], gated: `${(prof.personas || []).join('/') || 'non-commercial'} — cannot serve a ${q.rule.label.toLowerCase()} ask` };
  }

  // ── The strongest signal: they work at a company the ask named. ──
  const org = orgMatch(prof.company, q.orgs);
  if (org) {
    fit += 60;
    reasons.push(`Works at ${prof.company} — named in the ask`);
  }

  // ── Persona fit, against who the ask actually asked for. ──
  const personas = prof.personas || [];
  const label = q.rule.label.toLowerCase();
  const primaryHits = q.target_personas.filter((p) => personas.includes(p));
  const secondaryHits = q.rule.secondary.filter((p) => personas.includes(p) && !primaryHits.includes(p));
  if (primaryHits.length) {
    fit += 30;
    reasons.push(`${primaryHits.join(', ')} — the right kind of person for ${article(label)} ${label} ask`);
  } else if (secondaryHits.length) {
    fit += 14;
    reasons.push(`${secondaryHits.join(', ')} — adjacent to the ask`);
  }

  // ── Sector overlap. ──
  // One sector alone is deliberately not enough to qualify (the floor is 20):
  // being in healthcare does not make someone the answer to a healthcare ask.
  // Two sectors, or one plus any other signal, does.
  const sectorHits = (prof.sectors || []).filter((s) => q.sectors.includes(s));
  if (sectorHits.length) {
    fit += Math.min(28, 16 * sectorHits.length);
    reasons.push(`${sectorHits.join(', ')} — matches the sector in the ask`);
  } else if ((q.rule.sector_boost || []).some((s) => (prof.sectors || []).includes(s))) {
    fit += 10;
    const hit = (q.rule.sector_boost || []).filter((s) => (prof.sectors || []).includes(s));
    reasons.push(`${hit.join(', ')} — capital-adjacent employer`);
  }

  // ── The company's own industry: a bonus, never a requirement. ──
  // Sharing the company's industry is worth something, but nobody asked for it,
  // so it earns points and never creates a gap.
  const ctxHits = (prof.sectors || []).filter((s) => (q.context_sectors || []).includes(s));
  if (ctxHits.length && !sectorHits.length) {
    fit += 8;
    reasons.push(`${ctxHits.join(', ')} — same industry as the company`);
  }

  // ── Function overlap. ──
  // Weighted to clear the qualifying floor on its own: for a hire or an advice
  // ask, showing the requested discipline IS the match, and a junior engineer
  // who matches the discipline should appear rather than be silently dropped.
  const fnHits = (prof.functions || []).filter((f) => q.functions.includes(f));
  if (fnHits.length) {
    fit += Math.min(34, 22 * fnHits.length);
    reasons.push(`${fnHits.join(', ')} — matches what the ask needs`);
  } else if (q.rule.needs_function && q.functions.length && !org) {
    // The ask specifies a discipline and this person shows none of it.
    return { fit: 0, reasons: [], gated: `no ${q.functions.join('/')} signal in their title` };
  }

  // ── Seniority floor: can this person actually act? ──
  const floor = q.rule.seniority_floor;
  if (floor) {
    const rank = SENIORITY_RANK[prof.seniority] || 0;
    const need = SENIORITY_RANK[floor] || 0;
    if (rank && rank < need) {
      fit -= 12;
      reasons.push(`${prof.seniority} level — may not be the decision-maker`);
    } else if (rank >= need && rank >= 4) {
      fit += 8;
    }
  }

  // ── We know nothing about them. Say so rather than scoring it. ──
  if (prof.signal === 'none' && !org) {
    return { fit: 0, reasons: [], gated: 'no title on the record — nothing to match on' };
  }

  // ── Name what the ask wanted and this person does not show. ──
  // Without this, an ask for "industrial PE" against a book holding no industrial
  // PE returns the warmest generic investors, silently dropping the qualifier —
  // the same "warmth decides" failure the fit gate exists to prevent, one level
  // down. Every unmet dimension costs points AND is printed, so a partial match
  // is visibly partial rather than quietly promoted.
  // Only dimensions the ASK named can be missing. Context sectors are excluded —
  // nobody asked for them — which is what keeps this list short enough to read.
  const gaps = [];
  for (const s of q.sectors) if (!(prof.sectors || []).includes(s)) gaps.push(`no ${s} signal`);
  for (const f of q.functions) if (!(prof.functions || []).includes(f)) gaps.push(`no ${f} signal`);
  if (gaps.length) fit -= Math.min(18, 8 * gaps.length);

  return { fit: Math.max(0, fit), reasons, gaps, gated: null };
}

/**
 * Rank a book of people against one need.
 *
 * @param need   { type, text, company_context, company_sectors }
 * @param people array of rows: { id, name, title, company, linkedin_url, profile, relationship }
 * @param opts   { limit = 10, minFit = 20, includeGated = false }
 * @returns { need, results, considered, gated_count }
 */
function matchNeed(need, people, opts = {}) {
  // Clamped, not trusted: a negative limit reaches Array.slice(0, -n), which
  // silently drops the BEST matches off the end instead of erroring. Nonsense
  // input falls back to the default rather than to 1 — a caller that sends -5
  // has a bug, and answering with a single name hides it.
  const limit = clampCount(opts.limit, 10, 200);
  const minFit = opts.minFit ?? 20;
  const q = parseNeed(need);

  const scored = [];
  let gatedCount = 0;

  // Which dimensions of the ask anyone in the book actually meets. Reported
  // whether or not it is flattering — "nobody you know is in construction" is
  // a real answer to a founder's ask, and a more useful one than a padded list.
  const coverage = {};
  for (const s of q.sectors) coverage[s] = 0;
  for (const f of q.functions) coverage[f] = 0;
  for (const org of q.orgs) coverage[org] = 0;

  for (const person of people) {
    const prof = person.profile || {};
    for (const s of q.sectors) if ((prof.sectors || []).includes(s)) coverage[s]++;
    for (const f of q.functions) if ((prof.functions || []).includes(f)) coverage[f]++;
    const om = orgMatch(prof.company, q.orgs);
    if (om) coverage[om]++;

    const { fit, reasons, gaps, gated } = scoreFit(person, q);
    if (gated || fit < minFit) { gatedCount++; continue; }

    const rel = person.relationship || {};
    const warmth = Number(rel.warmth || 0);

    // Fit gates; warmth ranks. The weighting keeps a strong fit ahead of a
    // weak one, but among comparable fits the person Danny actually knows wins.
    const total = Math.round(fit + warmth * 0.55);

    scored.push({
      person_id: person.id,
      name: person.name,
      title: person.title || null,
      company: person.company || null,
      linkedin_url: person.linkedin_url || null,
      email: person.email || null,
      score: total,
      fit,
      warmth,
      warmth_tier: rel.tier || 'name_only',
      months_since: rel.months_since ?? null,
      staleness: rel.staleness || null,
      why: reasons,
      gaps: gaps || [],
      how_you_know_them: rel.receipt || 'In the network, no direct contact on record',
      signal: prof.signal || 'none',
    });
  }

  scored.sort((a, b) => b.score - a.score || b.fit - a.fit || b.warmth - a.warmth);

  return {
    need: {
      type: q.type,
      label: q.rule.label,
      text: need.text || '',
      read_as: { functions: q.functions, sectors: q.sectors, orgs: q.orgs, personas: q.target_personas,
        company_industry: q.context_sectors || [] },
    },
    results: scored.slice(0, limit),
    considered: people.length,
    qualified: scored.length,
    gated_count: gatedCount,
    coverage,
    // The dimensions of the ask that NOBODY in the book meets. This is the
    // honest headline when a shortlist looks plausible but misses the point.
    //
    // Split because the two read differently to a human: a missing ORG means
    // "you know nobody at Hightower", a missing attribute means "nobody you
    // know works in industrials." Collapsing them produces the nonsense line
    // "nobody in your network shows Focus Financial."
    unmet: Object.entries(coverage).filter(([, n]) => n === 0).map(([k]) => k),
    unmet_orgs: q.orgs.filter((o) => !coverage[o]),
    unmet_attributes: [...q.sectors, ...q.functions].filter((k) => !coverage[k]),
  };
}

module.exports = {
  matchNeed, parseNeed, scoreFit, extractOrgs, orgMatch, clampCount,
  TYPE_RULES, SENIORITY_RANK,
};
