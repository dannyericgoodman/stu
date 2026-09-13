'use strict';
// ══════════════════════════════════════════════════════════════════════════
// networkProfile.js — what a person IS, read deterministically from the two
// fields LinkedIn actually exports: Position and Company.
//
// ── WHY DETERMINISTIC ──
// The obvious build is to send all 2,691 contacts to an LLM and let it write a
// profile. Danny scoped this the other way on purpose: no model in the ingest
// path. That has a cost (we cannot know what someone did five jobs ago) and a
// benefit that matters more here — a title is a FACT, and a match built only on
// facts can show its receipts. Every classification this module makes carries
// the substring that produced it, so a match can say "Head of Partnerships at
// Cresset" rather than "seems like a good fit."
//
// The rule that follows from that: when the title does not say it, we do not
// claim it. `functions: []` is the honest answer for "Founder" with no domain
// in the string, and the matcher treats an empty read as unknown, not as zero.
//
// ── THE TRAP THIS MODULE EXISTS TO AVOID ──
// The first pass at this was substring matching, and on Scaylor's real ask
// ("intro to industrial PE funds") it returned, at rank 1, an Assistant
// Professor of Industrial-Organizational Psychology at DePaul. Two independent
// bugs in one row: "industrial" matched inside a hyphenated psychology term,
// and nothing knew that an academic is not a source of PE intros.
//
// So: every term is matched on WORD BOUNDARIES against a normalized string,
// multi-word terms are matched as phrases, and personas gate sectors —
// an academic or a student does not read as a commercial operator no matter
// what nouns appear in their title. `test/network-profile.test.js` pins the
// professor, and pins the real PE people who must survive the fix.
// ══════════════════════════════════════════════════════════════════════════

// ── Vocabulary ────────────────────────────────────────────────────────────
// Each entry is [canonical, ...surface forms]. Order inside a list does not
// matter; order BETWEEN lists does, for seniority only (first match wins).

// What a person does. A title can carry more than one.
const FUNCTIONS = {
  engineering: ['engineer', 'engineering', 'developer', 'swe', 'software', 'devops', 'sre',
    'infrastructure', 'backend', 'frontend', 'full stack', 'fullstack', 'architect', 'cto', 'technical'],
  data_ai: ['data scientist', 'data science', 'machine learning', 'ml engineer', 'ai engineer',
    'artificial intelligence', 'data engineer', 'analytics', 'nlp', 'research scientist'],
  product: ['product manager', 'product management', 'product lead', 'product owner', 'cpo',
    'head of product', 'product design', 'product marketing'],
  design: ['designer', 'design', 'ux', 'ui', 'creative director', 'brand'],
  sales: ['sales', 'account executive', 'account manager', 'business development', 'bd',
    'gtm', 'go to market', 'revenue', 'cro', 'quota', 'enterprise sales', 'commercial'],
  marketing: ['marketing', 'cmo', 'demand generation', 'demand gen', 'content', 'seo',
    'communications', 'pr', 'public relations', 'brand marketing'],
  growth: ['growth', 'user acquisition', 'lifecycle', 'performance marketing'],
  partnerships: ['partnerships', 'partner manager', 'channel', 'alliances', 'business partnerships'],
  finance: ['finance', 'cfo', 'controller', 'accounting', 'accountant', 'fp&a', 'treasurer',
    'financial', 'audit', 'tax'],
  operations: ['operations', 'coo', 'chief of staff', 'bizops', 'business operations',
    'supply chain', 'logistics', 'program manager', 'project manager'],
  people: ['recruiter', 'recruiting', 'hiring', 'talent acquisition', 'people operations',
    'human resources', 'hr', 'chro', 'head of people', 'talent partner'],
  legal: ['legal', 'attorney', 'lawyer', 'counsel', 'general counsel', 'paralegal', 'compliance'],
  clinical: ['physician', 'doctor', 'md', 'nurse', 'clinical', 'surgeon', 'pharmacist', 'therapist'],
  investing: ['investor', 'venture', 'venture capital', 'private equity', 'investment',
    'portfolio manager', 'limited partner', 'angel', 'buyout', 'growth equity'],
};

// What a person IS. Personas gate what a match may claim about them.
const PERSONAS = {
  founder: ['founder', 'co-founder', 'cofounder', 'founding', 'ceo', 'chief executive',
    'owner', 'entrepreneur', 'president & ceo'],
  investor: ['venture capital', 'venture partner', 'private equity', 'investor', 'angel investor',
    'general partner', 'managing partner', 'investment partner', 'portfolio manager',
    'limited partner', 'family office', 'buyout', 'growth equity', 'investment director'],
  advisor: ['advisor', 'adviser', 'board member', 'board director', 'mentor', 'operating partner'],
  recruiter: ['recruiter', 'recruiting', 'talent acquisition', 'executive search', 'headhunter'],
  service_provider: ['consultant', 'consulting', 'attorney', 'lawyer', 'counsel', 'accountant',
    'cpa', 'investment banker', 'banker', 'advisory services', 'agency'],
  academic: ['professor', 'lecturer', 'postdoc', 'post-doc', 'phd candidate', 'researcher at',
    'dean', 'faculty', 'teaching'],
  student: ['student', 'intern', 'mba candidate', 'undergraduate', 'graduate student',
    'summer analyst', 'teaching assistant', 'research assistant'],
};

// The industry a person sits in. Multi-word entries are matched as phrases,
// which is what keeps "industrial-organizational psychology" out of `industrial`.
const SECTORS = {
  healthcare: ['healthcare', 'health care', 'health system', 'hospital', 'payer', 'provider network',
    'digital health', 'health plan', 'medicaid', 'medicare', 'clinical', 'patient', 'health tech'],
  biotech: ['biotech', 'pharma', 'pharmaceutical', 'life sciences', 'therapeutics', 'genomics', 'drug discovery'],
  fintech: ['fintech', 'payments', 'banking', 'lending', 'credit', 'financial services',
    'financial technology', 'neobank', 'treasury'],
  wealth: ['wealth management', 'wealth', 'registered investment advisor', 'ria', 'financial advisor',
    'financial planning', 'family office', 'private client', 'asset management', 'portfolio management'],
  insurance: ['insurance', 'insurtech', 'underwriting', 'actuary', 'actuarial', 'broker',
    'reinsurance', 'claims', 'benefits administration', 'tpa'],
  construction: ['construction', 'contractor', 'general contractor', 'built environment',
    'architecture', 'engineering firm', 'infrastructure projects'],
  real_estate: ['real estate', 'proptech', 'commercial real estate', 'cre', 'property management', 'brokerage'],
  legal_industry: ['law firm', 'legal services', 'legaltech', 'litigation'],
  manufacturing: ['manufacturing', 'manufacturer', 'factory', 'plant operations', 'production'],
  // "distribution" is deliberately NOT here on its own. In a founder's ask it
  // almost always means go-to-market distribution ("channel-partner GTM /
  // distribution"), and reading that as the industrial sector put a spurious
  // "no industrial signal" gap on every candidate for a marketing ask.
  industrial: ['industrial', 'industrials', 'heavy equipment', 'machinery',
    'industrial distribution', 'wholesale distribution', 'field service', 'fabrication'],
  logistics: ['logistics', 'freight', 'trucking', 'shipping', 'warehouse', 'fleet', 'last mile'],
  energy: ['energy', 'oil', 'gas', 'utilities', 'renewables', 'solar', 'grid', 'mining'],
  retail: ['retail', 'ecommerce', 'e-commerce', 'consumer goods', 'cpg', 'restaurant', 'hospitality'],
  media: ['media', 'publishing', 'advertising', 'entertainment', 'gaming', 'sports'],
  education: ['education', 'edtech', 'university', 'school', 'k-12', 'higher education'],
  govtech: ['government', 'public sector', 'govtech', 'civic', 'defense', 'municipal'],
  security: ['cybersecurity', 'security', 'infosec', 'fraud', 'identity', 'risk management'],
  professional_services: ['professional services', 'staffing', 'accounting firm', 'audit', 'tax services'],
  agriculture: ['agriculture', 'agtech', 'farming', 'food production'],
};

// Seniority, most senior first — the first list that matches wins, so a
// "VP of Engineering" reads as exec rather than being caught by a later rung.
const SENIORITY_LADDER = [
  ['founder', ['founder', 'co-founder', 'cofounder', 'founding partner', 'founding team',
    'owner', 'ceo', 'chief executive']],
  ['exec', ['chief', 'cto', 'cfo', 'coo', 'cmo', 'cro', 'cpo', 'chro', 'cio', 'ciso',
    'president', 'partner', 'managing director', 'general partner', 'evp',
    'svp', 'senior vice president', 'vice president', 'vp', 'head of', 'general counsel']],
  ['director', ['director', 'principal']],
  ['manager', ['manager', 'lead', 'supervisor', 'team lead']],
  ['senior_ic', ['senior', 'staff', 'sr.', 'sr ']],
  ['junior', ['analyst', 'associate', 'coordinator', 'assistant', 'intern', 'student',
    'entry level', 'junior', 'apprentice', 'fellow']],
];

// Titles that mean "cannot act on a commercial ask." These do not delete a
// person; they stop the matcher from reading them as an operator or a source of
// capital, which is the professor bug.
const NON_COMMERCIAL_PERSONAS = new Set(['academic', 'student']);

// Company strings that carry no information. Matching on these would cluster
// hundreds of unrelated people under one "employer."
const GENERIC_COMPANY = /^(-+|n\/?a|none|self|self[- ]employed|freelance|independent|unknown|tbd|stealth|stealth startup|stealth mode|stealth ai startup|confidential|various|retired|student|unemployed|looking|open to work)$/i;

// ── Matching primitives ───────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize a title for matching. Hyphens and slashes become spaces so that
 * "Industrial-Organizational" tokenizes as two words and cannot be matched as
 * a bare "industrial" phrase boundary; "&" becomes "and"; punctuation goes.
 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[/\-–—_,.()[\]|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `term` appear in `text` as a whole word (or whole phrase)? The word
 * boundaries are what stop "bd" matching inside "bdo" and "hr" inside "chro".
 * Returns the matched substring (for the receipt) or null.
 */
function phraseHit(text, term) {
  const re = new RegExp(`(?:^|\\s)${escapeRe(term)}(?=\\s|$)`, 'i');
  const m = re.exec(text);
  return m ? m[0].trim() : null;
}

/**
 * Scan a vocabulary map against normalized text. Returns canonical keys plus
 * the exact term that fired for each — the receipt.
 */
function scanVocab(text, vocab) {
  const keys = [];
  const evidence = {};
  for (const [key, terms] of Object.entries(vocab)) {
    for (const term of terms) {
      if (phraseHit(text, normalize(term))) {
        keys.push(key);
        evidence[key] = term;
        break;
      }
    }
  }
  return { keys, evidence };
}

// ── The classifier ────────────────────────────────────────────────────────

/**
 * Read a person from whatever text we hold about them.
 *
 * @param {object} p
 * @param {string} p.title     LinkedIn "Position" — the highest-signal field.
 * @param {string} p.company   LinkedIn "Company".
 * @param {string} p.expertise Airtable Advisor Network "Expertise", when present.
 *                             Hand-entered by Danny, so it OUTRANKS a parsed title.
 * @param {string} p.extra     Any other text (Airtable notes, industry focus).
 * @returns {{
 *   functions: string[], personas: string[], sectors: string[], seniority: string|null,
 *   company: string|null, is_commercial: boolean, evidence: object, signal: 'none'|'thin'|'good'
 * }}
 */
function classify({ title = '', company = '', expertise = '', extra = '' } = {}) {
  const rawCompany = String(company || '').trim();
  const namedCompany = rawCompany && !GENERIC_COMPANY.test(rawCompany) ? rawCompany : null;

  // Personas and seniority read from the TITLE only. A person is not a founder
  // because the word appears in their employer's name ("Founders Fund").
  const titleText = normalize(title);

  // Sectors and functions may read from company and hand-entered expertise too:
  // "Cresset" is where the wealth signal lives, not in "Managing Director".
  const wideText = normalize([title, namedCompany, expertise, extra].filter(Boolean).join(' . '));

  const personaScan = scanVocab(titleText, PERSONAS);
  const personas = personaScan.keys;

  // An academic or student cannot also be read as a commercial operator. This
  // is the gate; without it "Private Equity Summer Analyst" is a PE contact.
  const isCommercial = !personas.some((p) => NON_COMMERCIAL_PERSONAS.has(p));

  const functionScan = scanVocab(wideText, FUNCTIONS);
  const sectorScan = isCommercial ? scanVocab(wideText, SECTORS) : { keys: [], evidence: {} };

  let seniority = null;
  let seniorityTerm = null;
  for (const [rung, terms] of SENIORITY_LADDER) {
    const hit = terms.find((t) => phraseHit(titleText, normalize(t)));
    if (hit) { seniority = rung; seniorityTerm = hit; break; }
  }

  // "Principal" is a senior investor at a fund and a senior IC everywhere else.
  // Only reclassify when an investor persona is actually present.
  if (seniority === 'director' && seniorityTerm === 'principal' && personas.includes('investor')) {
    seniority = 'exec';
  }

  // How much we actually learned. The matcher needs to know the difference
  // between "this person is not a fit" and "we know nothing about this person."
  const learned = functionScan.keys.length + sectorScan.keys.length + personas.length;
  const signal = learned === 0 ? (seniority ? 'thin' : 'none') : (learned >= 2 ? 'good' : 'thin');

  return {
    functions: functionScan.keys,
    personas,
    sectors: sectorScan.keys,
    seniority,
    company: namedCompany,
    is_commercial: isCommercial,
    evidence: {
      functions: functionScan.evidence,
      personas: personaScan.evidence,
      sectors: sectorScan.evidence,
      seniority: seniorityTerm,
    },
    signal,
  };
}

/**
 * A short, honest description of a person built only from what we read.
 * Used as the receipt line under a match, so it must never assert more than
 * the title said.
 */
function describe(profile, { title, company } = {}) {
  const bits = [];
  if (title) bits.push(String(title).trim());
  if (company && profile.company) bits.push(`at ${profile.company}`);
  return bits.join(' ') || 'No title on the record';
}

module.exports = {
  classify, describe, normalize, phraseHit, scanVocab,
  FUNCTIONS, PERSONAS, SECTORS, SENIORITY_LADDER, GENERIC_COMPANY, NON_COMMERCIAL_PERSONAS,
};
