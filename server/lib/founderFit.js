'use strict';
// ══════════════════════════════════════════════════════════════════════════
// founderFit — the founder-quality check Danny asked for, in his own terms.
//
// "I want a founder quality check you can run against candidates to identify,
// select, and prioritize who I should meet. I want to meet pre-seed/stealth/early
// builders who have Chicago/Illinois ties AND: hyperscale experience, or previous
// founding experience, or exited a startup in a good way (which is better to me
// than previous founding experience), they got into or have been in YC, they are
// members of South Park Commons, they got into or have been in a16z speedrun or
// Z Fellows, they have raised venture capital previously, or they went to a
// prestigious Chicago/IL school and have a track record that lends itself to
// building outliers."
//
// The rubric is two GATES and one SCORE, and keeping them separate is the whole
// point — it's the distinction the old caliber scorer collapsed.
//
//   GATE 1 — STAGE (of the CURRENT company). Must be earliest-stage: stealth,
//     pre-seed, just incorporated, building. A company that is clearly PAST that —
//     a Series A, a big priced round, real scale — fails, no matter how strong the
//     founder. This is the Matt Silver / Cargado fix: he's a strong founder, but
//     Cargado is not a company at the stage Danny wants to meet.
//
//   GATE 2 — ILLINOIS TIE. Handled upstream by lib/ilTie + the queue's TIE_CLAUSE;
//     this module trusts a verified tie and never invents one.
//
//   SCORE — the OUTLIER MARKERS, which describe the founder's BACKGROUND, not the
//     current company. "Raised VC previously" and "prior exit" are background wins;
//     they belong here, NOT in the stage gate. This separation is exactly why the
//     old scorer failed: it read "raised institutional capital" off the current
//     company and rewarded it, pulling in companies already underway.
//
// THE CARDINAL RULE, inherited from the honesty gate: a marker only counts if its
// evidence quote is verbatim in the profile text. detect() returns the substring
// that fired, and markersFor() drops any whose quote isn't actually present. The
// "Why they're here" line is built from what survives — which is the fix for
// "some of the descriptions are good, some are bad": a chip cannot appear without
// a receipt.
// ══════════════════════════════════════════════════════════════════════════

const { hasDisqualifyingFlag, parseRedFlags } = require('./redFlags');

// ── Text plumbing ──
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function reWord(w) {
  return new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
}

// Build the searchable blob from a sourced_founders row. Deliberately excludes
// score_rationale and any machine-written narrative — a marker must be grounded in
// the SOURCE material (headline, bio, history, tie text), never in another model's
// prose about the person, or one scorer's guess becomes the next scorer's "fact".
function profileText(row = {}) {
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v) return [];
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
  };
  const parts = [
    row.headline, row.role, row.company, row.company_one_liner,
    row.chicago_connection, row.previous_company_norm,
    ...parseArr(row.pedigree_signals),
    ...parseArr(row.builder_signals),
    ...parseArr(row.tags),
  ];
  // raw_data / enriched_data hold the scraped profile text (bio, experience).
  for (const blob of [row.raw_data, row.enriched_data, row.linkedin_data]) {
    if (typeof blob === 'string' && blob) {
      try {
        const o = JSON.parse(blob);
        for (const k of ['bio', 'summary', 'about', 'headline', 'experience', 'description', 'snippet', 'text']) {
          if (typeof o[k] === 'string') parts.push(o[k]);
        }
        if (Array.isArray(o.experience)) for (const e of o.experience) parts.push(e && (e.title || e.company || e.description));
      } catch { parts.push(blob); }
    }
  }
  // Strip URLs before anything matches against this. A scraped LinkedIn profile is
  // full of "https://www.linkedin.com/…", and the word "linkedin" inside that URL
  // was firing the Hyperscaler:LinkedIn marker on 23 people who never worked there —
  // the URL boundary (the dot) looks like a word boundary to the matcher. Company
  // slugs in URLs (github.com/acme, /company/stripe) pollute every marker the same
  // way. Markers must match human prose, never link plumbing.
  return parts.filter(Boolean).map(String).join(' • ').replace(/https?:\/\/\S+/gi, ' ');
}

// ══════════════════════════════════════════════════════════════════════════
// STRUCTURED employment + education — the ground truth, when we have it.
//
// Danny: "the hyperscale experience tag is hallucinating ... make sure this is
// calibrated to read, understand, and interpret accurately their real LinkedIn
// history." He's right, and the cause is that the old detector matched a company
// NAME anywhere in a text blob — so "AI for Amazon sellers", "backed by
// ex-Googlers", or a customer logo all fired "Hyperscaler: Amazon". A company
// mention is not employment.
//
// The LinkedIn scrape carries a real experiences[] array — {company, title,
// starts_at, ends_at}. That is where someone actually WORKED, and it's un-
// hallucinatable: a product blurb naming Amazon never appears there. When we have
// it, employment markers read it and nothing else. Only when there's no structured
// history do we fall back to free text — and then demand an employment cue next to
// the company, never a bare mention.
// ══════════════════════════════════════════════════════════════════════════
function structuredProfile(row = {}) {
  const employers = []; // { company, title }
  const schools = [];   // school name
  for (const blob of [row.linkedin_data, row.enriched_data]) {
    if (typeof blob !== 'string' || !blob) continue;
    let o; try { o = JSON.parse(blob); } catch { continue; }
    const exp = o.experiences || o.experience || o.positions || [];
    if (Array.isArray(exp)) {
      for (const e of exp) {
        if (e && (e.company || e.title)) employers.push({ company: String(e.company || ''), title: String(e.title || '') });
      }
    }
    const edu = o.education || o.educations || [];
    if (Array.isArray(edu)) {
      for (const e of edu) {
        const s = e && (e.school || e.school_name || e.name);
        if (s) schools.push(String(s));
      }
    }
  }
  return { employers, schools, hasStructured: employers.length > 0 || schools.length > 0 };
}

// ══════════════════════════════════════════════════════════════════════════
// GATE 1 — CURRENT-COMPANY STAGE
//
// Returns { stage, tooLate, evidence }. `tooLate` true means the current company is
// past the earliest stage Danny wants to meet.
//
// The hard part is telling the CURRENT company's stage from the founder's history.
// The rule of thumb encoded here: earliest-stage language ("stealth", "pre-seed",
// "building", "day one") describes NOW; disqualifiers are only counted when they
// aren't clearly flagged as prior/background ("previously", "prior", "ex-", "sold").
// When in doubt this leans PERMISSIVE — it would rather admit a borderline company
// and let the score sort it than wrongly exclude a stealth founder whose bio happens
// to mention a past Series A they left. The LLM pass refines the genuinely ambiguous.
// ══════════════════════════════════════════════════════════════════════════

const EARLIEST_MARKERS = [
  /\bstealth\b/i, /\bpre[- ]?seed\b/i, /\bpre[- ]?launch\b/i, /\bday (one|1|zero|0)\b/i,
  /\bbuilding something\b/i, /\bworking on something\b/i, /\bjust (started|left|incorporated)\b/i,
  /\bnew ?co\b/i, /\bnewco\b/i, /\bexploring what'?s? next\b/i, /\bfounder mode\b/i,
  /\bincorporated\b/i, /\bfounding\b/i, /\b0 ?(to|->|→) ?1\b/i,
];

// Past-earliest markers. Each carries a matcher for "is this about a PRIOR company?"
// so a background mention doesn't disqualify the current one.
// Unconditional disqualifiers: the current company is plainly past the earliest
// stage. Each is background-aware (a "previously" in front is not disqualifying).
const PAST_EARLIEST = [
  { re: /\bseries\s+[a-e]\b/i, label: 'Series A+' },
  { re: /\b(pre[- ]?ipo|post[- ]?ipo|publicly traded|nasdaq|nyse|ipo'?d)\b/i, label: 'public / late-stage' },
  { re: /\b(\d{2,3})\+?\s*employees\b/i, label: 'sizable headcount', min: (m) => parseInt(m[1], 10) >= 50 },
  { re: /\braised\s+\$?\s?(\d+(?:\.\d+)?)\s*(m|mm|million)\b/i, label: 'large round', min: (m) => parseFloat(m[1]) >= 5 },
  { re: /\b(\d{3,})\+?\s*(customers|enterprises|clients)\b/i, label: 'many customers', min: (m) => parseInt(m[1], 10) >= 100 },
];
// Cues that a nearby round/scale marker describes a PRIOR company, not the current
// one. Deliberately excludes "ex-" and "former" — those describe a person's job
// history ("ex-Stripe engineer"), not a funding round's recency, and including them
// let an "ex-Stripe" 30 chars upstream launder a current "Series B" into "prior".
const PRIOR_CUES = /\b(previous|previously|prior|sold|acquired|exited|last (company|startup|venture)|before (that|founding)|first company|earlier)\b/i;

// The Cargado case. A closed institutional SEED (not pre-seed) on the current
// company, PLUS real traction, is past the earliest stage Danny wants — that is
// exactly the Matt Silver / Cargado profile he flagged: strong repeat founder,
// but a seed-funded company already shipping to customers. A pre-seed raise does
// NOT trip this — pre-seed is precisely what he's hunting.
const CURRENT_SEED = /\b(raised|closed|announced)\b[^.]{0,30}\bseed\b/i;
const PRESEED = /\bpre[- ]?seed\b/i;
const TRACTION = /\b(customers|paying|revenue|arr|mrr|users|logos|design partners|profitable|scaled)\b/i;

function classifyStage(text) {
  const t = String(text || '');
  const evidence = [];

  const earliest = EARLIEST_MARKERS.filter((re) => re.test(t)).length;

  let tooLate = false;
  for (const d of PAST_EARLIEST) {
    const m = t.match(d.re);
    if (!m) continue;
    if (d.min && !d.min(m)) continue; // e.g. a $2M raise, or 12 employees — still early
    // Is this disqualifier flagged as background? Look at a TIGHT window right
    // before it — 28 chars, ~4 words. Wider than that and an unrelated "exited"
    // elsewhere in the bio ("Exited a startup, ex-Google. Now raising our Series B")
    // launders a CURRENT round into "prior". The genuine background phrasing puts the
    // cue adjacent: "previously raised our Series A". Immediacy is the signal.
    const idx = m.index || 0;
    const before = t.slice(Math.max(0, idx - 28), idx);
    if (PRIOR_CUES.test(before)) continue; // "previously raised $10M" — that's a WIN, not a stage
    tooLate = true;
    evidence.push(`${d.label}: "${m[0].trim()}"`);
  }

  // Seed-with-traction on the current company (and not merely pre-seed).
  if (!tooLate) {
    const seed = t.match(CURRENT_SEED);
    if (seed && !PRESEED.test(t) && TRACTION.test(t)) {
      const idx = seed.index || 0;
      const before = t.slice(Math.max(0, idx - 60), idx);
      if (!PRIOR_CUES.test(before)) {
        tooLate = true;
        evidence.push(`seed + traction on current co: "${seed[0].trim()}"`);
      }
    }
  }

  let stage;
  if (tooLate) stage = 'past-earliest';
  else if (earliest > 0) stage = 'earliest';
  else stage = 'unknown';
  return { stage, tooLate, earliestMarkers: earliest, evidence };
}

// ══════════════════════════════════════════════════════════════════════════
// THE OUTLIER MARKERS — Danny's list, each an evidence-bearing detector.
//
// weight encodes his stated ranking: a good exit outranks prior founding
// ("better to me than previous founding experience"); the top programs and a prior
// raise sit between. detect(t) returns the verbatim substring that fired, or null.
// ══════════════════════════════════════════════════════════════════════════

const HYPERSCALERS = [
  'google', 'alphabet', 'meta', 'facebook', 'apple', 'amazon', 'aws', 'microsoft',
  'netflix', 'nvidia', 'openai', 'anthropic', 'stripe', 'databricks', 'snowflake',
  'palantir', 'tesla', 'spacex', 'uber', 'airbnb', 'coinbase', 'ramp', 'figma',
  'deepmind', 'salesforce', 'linkedin', 'doordash', 'instacart', 'robinhood',
];
// National elite schools. Kept SEPARATE from the IL list and scored lower, because
// they do a different job: an IL school is both a graduation signal and a live
// network for Danny, a national one is only the former.
const NAT_ELITE_SCHOOLS = [
  'stanford', 'harvard', 'massachusetts institute of technology', 'mit',
  'carnegie mellon', 'uc berkeley', 'university of california, berkeley', 'caltech',
  'california institute of technology', 'princeton', 'yale', 'columbia university',
  'cornell', 'university of pennsylvania', 'wharton', 'university of waterloo',
  'university of oxford', 'university of cambridge',
];
const IL_ELITE_SCHOOLS = [
  'northwestern', 'university of chicago', 'uchicago', 'booth', 'kellogg',
  'university of illinois', 'uiuc', 'illinois institute of technology', 'illinois tech',
];

// The sentence containing `idx`. Attribution ("whose exit is this?") is carried by
// the clause, not by a character radius — see prior_exit.
function sentenceAround(text, idx) {
  const t = String(text);
  const BREAK = /[.!?•|\n]/;
  let start = idx;
  while (start > 0 && !BREAK.test(t[start - 1])) start--;
  let end = idx;
  while (end < t.length && !BREAK.test(t[end])) end++;
  return t.slice(start, end);
}

function firstMatch(t, re) {
  const m = String(t).match(re);
  return m ? m[0].trim() : null;
}

// Does `company` appear as a real EMPLOYER in `text` — not just mentioned? Requires
// an employment cue immediately next to the name, inside a tight window, so
// "AI for Amazon sellers" or "backed by ex-Googlers advising us" cannot fire while
// "SWE at Amazon", "9 years at Amazon", "ex-Amazon", "Amazon engineer" do. Returns
// the matched employment phrase, or null.
const ROLE_WORDS = 'swe|engineer|software engineer|ml engineer|scientist|researcher|research scientist|pm|product manager|designer|architect|developer|intern|analyst|lead|manager|director|vp|vice president|head|founder|cofounder|co-founder|president|officer|cto|ceo|coo|cpo';
// Words that make an adjacent "at COMPANY" mean employment, not location or aim.
// A bare "at COMPANY" is NOT enough — "aimed at Google", "sell at Amazon scale" are
// not jobs. Employment needs a role, a tenure, or a history word right in front.
const HISTORY_WORDS = 'previously|prior|formerly|spent|before|earlier|was';
// Non-employment framings that must VETO a match even when a company name is near a
// cue: the ex-Googler is a backer/advisor, not the founder; the company is a
// customer/partner, not an employer.
const EMPLOYMENT_VETO = /\b(backed by|investors?|investor|advis|angel|customer|client|partner|integrat|acquired by|sold to|competitor|for)\b/i;

function employedAtInText(company, text) {
  const c = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frames = [
    // "<role> at/@/, Amazon"
    new RegExp(`(?:${ROLE_WORDS})\\s+(?:at|@|,)\\s*${c}\\b`, 'i'),
    // "Amazon engineer" (role AFTER the company)
    new RegExp(`\\b${c}\\s+(?:${ROLE_WORDS})\\b`, 'i'),
    // "ex-Amazon", "former(ly) (at) Amazon"
    new RegExp(`\\bex-?\\s*${c}\\b`, 'i'),
    new RegExp(`\\bformer(?:ly)?\\s+(?:at\\s+)?${c}\\b`, 'i'),
    // "joined/worked at/interned at Amazon"
    new RegExp(`\\b(?:joined|worked\\s+at|interned?\\s+at)\\s+${c}\\b`, 'i'),
    // "9 years at Amazon"
    new RegExp(`\\b\\d+\\+?\\s*years?\\s+(?:at|@)\\s+${c}\\b`, 'i'),
    // History word + "at/@ Amazon": "previously at Meta", "spent 4 years... at Meta"
    new RegExp(`\\b(?:${HISTORY_WORDS})\\b[^.]{0,15}?\\b(?:at|@)\\s+${c}\\b`, 'i'),
  ];
  for (const re of frames) {
    const m = String(text).match(re);
    if (!m) continue;
    // Veto if this sits in a backing/advisor/customer frame — look just before it.
    const idx = m.index || 0;
    const before = String(text).slice(Math.max(0, idx - 22), idx);
    if (EMPLOYMENT_VETO.test(before)) continue;
    return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

const cap = (s) => String(s).replace(/\b\w/g, (ch) => ch.toUpperCase());

// A slope whose top repo is content, not a product — used as a read-time tier
// safeguard (mirrors CONTENT_REPO in pipeline/github-activity, checked against the
// stored evidence string like "baoyu-skills: 23982★").
const SLOPE_CONTENT = /\b(awesome|list|dotfiles|tutorial|guide|notes|book|roadmap|interview|cheat-?sheet|skills|prompts?|resources?|handbook|curriculum|course|learn|examples?|demos?|blog|portfolio|papers?|wiki|docs|boilerplate|template|starter|config|design|designs|collection|gallery|showcase|snippets?|reference|gpts?|chatgpt|ai[- ]?tools?)\b/i;

// ══════════════════════════════════════════════════════════════════════════
// FOUNDER-MARKET FIT — "why this person, for this problem." The market red-teamer's
// core point: the old model scored talent with zero market signal. This is the free
// (no-LLM) version — has the founder actually WORKED in the domain they're now
// building in? Deliberately scoped to SPECIFIC verticals where domain tenure is a
// real moat (fintech, health, defense, logistics, security, legal, energy,
// robotics, devtools) — not "AI"/"software", which are too broad to mean anything.
//
// Confidence discipline: the background match must come from a STRUCTURED past
// employer (experiences[].company/title), not bio prose — so "why this person" is
// grounded in where they actually worked, not a self-description.
// ══════════════════════════════════════════════════════════════════════════
const DOMAINS = {
  fintech: /\b(fintech|payments?|banking|lending|insurtech|insurance|trading|brokerage|wealth|capital markets|hedge fund|neobank|underwriting)\b/i,
  health: /\b(health ?tech|healthcare|clinical|medical|biotech|pharma|hospital|patient|medtech|diagnostics|therapeutics|life sciences)\b/i,
  defense: /\b(defen[cs]e|aerospace|military|govtech|national security|intelligence community|dod\b)\b/i,
  logistics: /\b(logistics|supply chain|freight|shipping|warehouse|fulfillment|trucking|last[- ]mile)\b/i,
  security: /\b(cybersecurity|infosec|security|threat|vulnerability|siem|soc\b|zero trust)\b/i,
  legal: /\b(legal ?tech|law firm|litigation|compliance|contracts?|regulatory)\b/i,
  energy: /\b(energy|climate|clean ?tech|solar|grid|battery|carbon|renewables?|utilities)\b/i,
  robotics: /\b(robotics|autonomous|drones?|manufacturing|industrial automation|hardware)\b/i,
  devtools: /\b(developer tools|devtools|infrastructure|observability|database|api platform|devops|compiler)\b/i,
};

// An INTERN title is not domain mastery — a summer isn't an unfair insight. And an
// INVESTOR isn't a founder; a "Partner at X Capital" whose bio trips a vertical
// keyword must not surface as a domain-fit founder (engineering + VC red team F10).
const INTERN_TITLE = /\bintern(ship)?\b/i;
const INVESTOR_ROLE = /\b(partner|principal|associate|analyst|managing director|gp\b|general partner|venture|vc\b) (at|@|,)?\s*[a-z0-9][\w .&-]* (capital|ventures?|partners|fund|vc)\b|\b(investor|venture capitalist|angel investor)\b/i;

function assessMarketFit(text, ctx = {}, row = {}) {
  const current = [row.company, row.headline, row.company_one_liner].filter(Boolean).join(' ') || text.slice(0, 200);
  // Not a founder → no founder-market fit. Skip investors outright.
  if (INVESTOR_ROLE.test(current)) return { fit: false };
  const employerText = (ctx.employers || []).map((e) => `${e.company} ${e.title}`).join(' • ');
  for (const [domain, re] of Object.entries(DOMAINS)) {
    if (re.test(current) && re.test(employerText)) {
      // The corroborating employer must be a substantive role, not an internship.
      const emp = (ctx.employers || []).find((e) => re.test(`${e.company} ${e.title}`) && !INTERN_TITLE.test(e.title || ''));
      if (!emp) continue; // only an intern matched this domain → not mastery
      return { fit: true, domain, evidence: `${domain}: prev ${emp.title} at ${emp.company}` };
    }
  }
  return { fit: false };
}

// ══════════════════════════════════════════════════════════════════════════
// VENTURE-SCALE, NOT LIFESTYLE. Danny: "I don't want to ignore those non-tech
// archetypes in fintech, health, logistics, defense, etc. I just don't want to
// source people who started consulting firms or an agency or something."
//
// So the cut is NOT "non-tech" — a fintech or logistics or defense founder stays.
// The cut is the lifestyle / services business: the café, the marketing agency, the
// consultancy, the franchise. Sreekesh Bompally is the case — his "serial founder"
// tag was true, but his companies were a cake kitchen, a café, and a chocolate-room
// franchise. Real, and not a venture.
//
// Two safety rails, because dropping a genuine founder is far worse than keeping a
// borderline one:
//   1. Any real VENTURE signal overrides — an institutional raise, YC/Speedrun, a
//      SaaS/platform/API/hardware descriptor, a venture vertical. If it's there, the
//      founder is venture-scale regardless of a stray "agency" in the text.
//   2. The lifestyle read must be CLEAR — a founder-title company that is plainly a
//      services/lifestyle business, or a current company that is one with no venture
//      signal at all. Absent clear evidence, assume venture. Conservative on purpose.
// ══════════════════════════════════════════════════════════════════════════
const LIFESTYLE_RE = /\b(consult(ing|ancy|ants?)|advisory (firm|services)|(marketing|creative|digital|ad|branding|design|staffing|recruit(ing|ment)|talent|pr|social media|web design) agency|freelanc(e|er|ing)|solopreneur|independent contractor|(life|business|executive|career) coach(ing)?|franchis(e|ee|or)|restaurant|caf[eé]|bakery|catering|food truck|salon|spa|barbershop|barber|nail\b|gym|fitness studio|personal train(er|ing)|real estate (agent|brokerage|broker)|realtor|law (firm|practice)|accounting (firm|practice)|bookkeeping|photograph(y|er)|videograph(y|er)|event planning|wedding planning|\bdj\b|dropship(ping)?|etsy shop|retail (store|shop)|boutique|e-?commerce store)\b/i;
// Venture verticals + product shapes that KEEP a founder in scope even if a lifestyle
// word appears ("AI for restaurants" is venture; "owns a restaurant" is not).
const VENTURE_KEEP_RE = /\b(fintech|insurtech|health ?tech|biotech|medtech|med ?device|logistics|supply chain|defen[cs]e|aerospace|robotics|climate|clean ?tech|energy|proptech|legal ?tech|ed ?tech|ag ?tech|foodtech|saas|platform|marketplace|\bapi\b|infrastructure|\bai\b|\bml\b|machine learning|\bllm\b|agents?|data (platform|infra|pipeline)|hardware|semiconductor|chips?|devtools?|developer tools|cybersecurity|security|blockchain|crypto|autonomous|drones?|satellite|space|vertical software|b2b software|enterprise software)\b/i;
const VENTURE_SIGNAL_RE = /\b(raised|pre[- ]?seed|seed round|series [a-e]|venture[- ]backed|vc[- ]backed|y[- ]?combinator|\byc\b|speedrun|techstars|angel round|institutional|term sheet|cap table|arr|mrr|users|shipped|launched|beta|waitlist|open source|github)\b/i;

// Returns { lifestyle: bool, evidence }. Uses structured founder-title companies when
// present (most reliable — Sreekesh's cafés live there), else the free-text current co.
function assessVentureScale(text, ctx = {}, row = {}) {
  const t = String(text || '');
  // Override: any venture signal at all → venture, full stop.
  if (VENTURE_KEEP_RE.test(t) || VENTURE_SIGNAL_RE.test(t)) return { lifestyle: false };

  // A TITLE that is itself a lifestyle role — "Franchise Owner", "Restaurateur",
  // "Salon Owner". Venture founders say Founder/CEO; a franchise owner says owner.
  // This is the tell for Sreekesh, whose café company NAMES ("The Cake Kitchen")
  // carry no keyword but whose titles do.
  const LIFESTYLE_TITLE_RE = /\b(franchise (owner|e)|restaurateur|(shop|store|salon|spa|gym|studio|restaurant|cafe|café|boutique|franchise) owner|proprietor|realtor|freelanc)/i;

  // The companies/roles where this person was actually a founder/owner (structured).
  const founderRoles = (ctx.employers || [])
    .filter((e) => /found|ceo|owner|proprietor/i.test(e.title || ''));
  if (founderRoles.length) {
    const lifestyle = founderRoles.filter((e) =>
      (LIFESTYLE_RE.test(e.company || '') || LIFESTYLE_TITLE_RE.test(e.title || '')) && !VENTURE_KEEP_RE.test(e.company || ''));
    // Every founder/owner role is a lifestyle business → not the founder Danny wants.
    if (lifestyle.length && lifestyle.length === founderRoles.length) {
      return { lifestyle: true, evidence: lifestyle.map((e) => `${e.title} @ ${e.company}`).join(', ') };
    }
    return { lifestyle: false };
  }

  // No structured founder history — fall back to the current company / bio, but only
  // fire on an explicit "founded/owns a <lifestyle business>" so a stray word can't
  // drop a real founder. Trigger covers "founder of", "co-founder of", "owns", etc.
  const trigger = '(?:founded|founder of|co-?founder of|owns?|running|started|proprietor of|principal at|owner of)';
  const m = t.match(new RegExp(`\\b${trigger}\\b[^.]{0,25}?${LIFESTYLE_RE.source}`, 'i'));
  if (m && !VENTURE_KEEP_RE.test(m[0])) return { lifestyle: true, evidence: m[0].replace(/\s+/g, ' ').trim() };
  return { lifestyle: false };
}

// ══════════════════════════════════════════════════════════════════════════
// ACADEMIC, NOT OPERATING — the professor gate.
//
// `il_school_discovery` is the highest-yield IL source, and its failure mode is that
// searching "University of Illinois founder" returns the university's most
// distinguished FACULTY. Ken Suslick is the case: 500 papers, 71 patents, elected to
// the National Academy of Sciences, and a `role` field that says "Founder" because
// the connector guessed it.
//
// Deep tech and lab spinouts are explicitly IN scope, so this cannot be "academic →
// out". A professor who actually spun a company out is exactly who Danny wants. The
// cut is academic WITH NO OPERATING EVIDENCE — no company, no venture signal, no
// founding frame anywhere. Same conservative shape as the lifestyle gate: absent
// clear evidence, assume operator.
// ══════════════════════════════════════════════════════════════════════════
const ACADEMIC_RE = /\b(professor|prof\.|faculty|emeritus|department chair|dept chair|postdoc|post[- ]doctoral|principal investigator|dean of|lecturer|academic appointment|tenure[d]?|h-index|published (more than )?\d+ (scientific )?(papers|articles)|national academy of (sciences|engineering|medicine)|research group|my lab\b)\b/i;
// Evidence the person actually operates a company, which overrides the academic read.
const OPERATING_RE = /\b(co[- ]?founder|founder (of|at|and)|founded|ceo|cto|chief executive|raised|pre[- ]?seed|seed round|series [a-e]|y[- ]?combinator|\byc\b|speedrun|stealth|building (a|an|the)|shipped|launched|customers|revenue|arr|mrr|spin[- ]?out|spun out|incorporated)\b/i;

function assessAcademic(text, ctx = {}, row = {}) {
  const t = String(text || '');
  if (!ACADEMIC_RE.test(t)) return { academic: false };
  // A real company on the row is operating evidence on its own.
  if (row && row.company && String(row.company).trim()) return { academic: false };
  // A structured founder/CEO title anywhere in employment history is operating evidence.
  const founderRole = (ctx.employers || []).find((e) => /found|ceo|cto|chief exec/i.test(e.title || ''));
  if (founderRole) return { academic: false };
  if (OPERATING_RE.test(t)) return { academic: false };
  const m = t.match(ACADEMIC_RE);
  return { academic: true, evidence: m ? m[0].trim() : 'academic profile, no operating evidence' };
}

// ══════════════════════════════════════════════════════════════════════════
// DISQUALIFYING FLAGS — the gate the scoring pass already enforces, wired in.
//
// pipeline/sourcing-engine.js's LLM scoring pass computes red_flags[] and checks it
// with hasDisqualifyingFlag() against a fixed list (student, recruiter, consultant,
// service provider, agency, job seeker, no commercial, series a/b, fractional, coach,
// advisor only) — clamping confidence_score/caliber_tier when it fires (STU-34/35).
// That never reached this rubric, so a row the scoring pass had already flagged as
// "not a fundable founder" could still land must-meet here.
//
// red_flags is STRUCTURED and already enforced elsewhere — not narrative prose like
// score_rationale/confidence_rationale, which profileText() deliberately excludes
// (see the comment above profileText). So this is a hard gate, same shape as the
// stage/lifestyle/academic gates, not a text signal fed into a marker.
// ══════════════════════════════════════════════════════════════════════════
function assessDisqualifyingFlags(row = {}) {
  const flags = parseRedFlags(row.red_flags);
  if (!flags.length || !hasDisqualifyingFlag(flags)) return { disqualified: false };
  return { disqualified: true, evidence: flags.join('; ') };
}

const MARKERS = [
  {
    key: 'prior_exit',
    label: 'Exited a startup',
    weight: 10, // "better to me than previous founding experience"
    // ── ATTRIBUTION, not just occurrence ──
    // This is the highest-weighted marker in the rubric and it used to fire on the
    // bare phrase "was acquired" anywhere in the blob. Ken Suslick — a UIUC chemistry
    // professor, h-index 134, National Academy of Sciences, zero operating history —
    // reached MUST-MEET because his bio says he "was the lead consultant for Molecular
    // Biosystems Inc.", which "was acquired". The company exited. He consulted for it.
    //
    // The module already solved this shape once for employment (employedAtInText +
    // EMPLOYMENT_VETO): a company MENTION is not a job. The same rule applies here —
    // an exit mention is not YOUR exit. So an unattributed phrase now needs a
    // first-person/founder frame, and any advisory/consulting/investor framing next to
    // it vetoes the marker outright.
    detect(t) {
      const text = String(t);
      // Self-attributed forms — the subject is unambiguous. These stand alone.
      const OWNED = /\b(sold (my|our|his|her) (company|startup|business)|my (company|startup) was acquired|our (company|startup) was acquired|prior exit|previously exited|successful(ly)? exit(ed)?|founder with (a )?successful exit|\d+x exited founder|founded [a-z0-9][\w .&-]{1,40} \((acquired|exited)[^)]*\)|co[- ]?founded [a-z0-9][\w .&-]{1,40} \((acquired|exited)[^)]*\))/i;
      let m = text.match(OWNED);
      let scope = null;
      if (!m) {
        // Unattributed forms ("was acquired", "acquired by X", "IPO'd"). Only count
        // these when a FOUNDER/OWNER frame appears in the SAME SENTENCE — otherwise the
        // exit may belong to a client, an employer, a portfolio company or a competitor.
        //
        // Sentence scope, not a character window. A fixed lookback of 90 chars dropped
        // Valentin Saportas — "I co-founded Revvin ... a digital mortgage platform that
        // grew to serve more than 150 financial institutions before being acquired by
        // Maxwell in 2023" — where the founding verb and the exit are one clause apart
        // but ~130 characters apart. The sentence is the unit that actually carries
        // attribution; character distance is a proxy that fails on any real bio.
        const LOOSE = /\b(acquired by [a-z0-9][\w .&-]{1,40}|was acquired|got acquired|ipo'?d)\b/i;
        m = text.match(LOOSE);
        if (!m) return null;
        scope = sentenceAround(text, m.index || 0);
        const FOUNDER_FRAME = /\b(founder|co[- ]?founder|founded|started|my|our|i built|built and sold)\b/i;
        if (!FOUNDER_FRAME.test(scope)) return null;
      }
      // Veto frames: the exit belongs to someone the person merely ADVISED, invested
      // in, consulted for, or wrote about. Checked over the same sentence.
      if (scope === null) scope = sentenceAround(text, m.index || 0);
      const EXIT_VETO = /\b(consultant|consulting|advis(or|er|ory|ed|ing)|board member|investor|angel|portfolio (company|co)|client|customer|research(ed|er)?|licensed)\b/i;
      if (EXIT_VETO.test(scope)) return null;
      // Scale is reported as a FACT, not as a better grade. The outcome data says the
      // predictive prior exit is the modest one (~$10M) — 42% of billion-dollar
      // founders vs 24% of a funded control — so a nine-figure exit is not a stronger
      // version of this signal, just a different one.
      const big = /\$\s?\d{2,}\s?(m|mm|million|b|bn|billion)\b/i.test(text) || /\b(unicorn|nine[- ]figure)\b/i.test(text);
      return { quote: m[0].trim(), label: big ? 'Exited a startup (large outcome)' : 'Exited a startup' };
    },
  },
  {
    key: 'yc',
    label: 'YC',
    // 8, and deliberately ABOVE the other programs. YC is the only accelerator with
    // published outcome data that separates it: ~4.5% of YC companies become unicorns
    // vs ~2.5% for comparable venture-backed seed startups, and ~45% raise a Series A
    // against a ~33% baseline (PitchBook). Techstars is 2.2%, MassChallenge 1.8%,
    // 500 Global 1.5%. The Series A number is the one that matters to a pre-seed fund
    // whose return depends on somebody else marking us up.
    // See Brain/02 Frameworks/Sourcing Score — Evidence Check.md.
    weight: 8,
    // Must catch the bare phrasing too — "YC alum", "YC-backed", "(YC S24)" and
    // "Y Combinator" are all the same signal. The cohort-code-only version silently
    // dropped every plain "YC alum", which is the single most common way it's written.
    detect(t) { return firstMatch(t, /\by[- ]?combinator\b|\bycombinator\b|\byc\s?[wsf]?\d{2}\b|\(yc[ .)]|\byc\s+(alum|backed|founder|company|s\d|w\d)|\bbacked by yc\b/i); },
  },
  {
    key: 'speedrun_zfellows',
    label: 'a16z Speedrun / Z Fellows',
    // 6, not 8. These are real filters run by serious people, but neither has
    // published graduation or outcome data. Weighting an unmeasured program equal to
    // YC asserts a lift nobody has demonstrated. Strong signal, honest weight.
    weight: 6,
    detect(t) { return firstMatch(t, /a16z\s+speedrun|andreessen\s+speedrun|\bspeedrun\b|\bz[- ]?fellows?\b|\bzfellows\b/i); },
  },
  {
    key: 'spc',
    label: 'South Park Commons',
    weight: 6, // same reasoning as Speedrun/Z — no published outcome data.

    detect(t) { return firstMatch(t, /south\s+park\s+commons|\bspc\b/i); },
  },
  {
    key: 'prior_raise',
    label: 'Raised VC previously',
    weight: 6,
    // Must be flagged as PRIOR — a raise on the current company is a stage fact, not
    // a background win. This is the exact line the old scorer failed to draw.
    detect(t) {
      const re = /\b(previously|prior|formerly|at (my|his|her) (last|previous|first))\b[^.]{0,50}\b(raised|backed by|venture[- ]backed|vc[- ]backed|seed|series [a-d])\b/i;
      const m = String(t).match(re);
      return m ? m[0].trim() : null;
    },
  },
  {
    key: 'prior_founding',
    label: 'Founded before',
    weight: 6,
    detect(t) { return firstMatch(t, /\b(serial (founder|entrepreneur)|repeat founder|second[- ]time founder|third[- ]time founder|previously (co[- ]?)?founded|prior(ly)? founded|founded [a-z0-9][\w .&-]{1,40} \((19|20)\d{2}\))\b/i); },
  },
  {
    key: 'hyperscale',
    label: 'Hyperscaler background',
    weight: 6,
    // EMPLOYMENT, not a mention. Structured experiences[] first (ground truth); only
    // then free text, and only with an employment cue beside the company name.
    structured: true,
    detect(t, ctx = {}) {
      // 1) Real employment history. A hyperscaler in experiences[].company is a fact.
      for (const emp of ctx.employers || []) {
        const lc = normText(emp.company);
        for (const co of HYPERSCALERS) {
          // Whole-company match, not substring: "Amazon" must be the employer, not
          // "Amazon Web Services Partner Co" — reWord on the normalized company name.
          if (reWord(co).test(lc)) {
            const title = emp.title ? `${emp.title} at ${emp.company}` : emp.company;
            return { quote: title, label: `Hyperscaler: ${cap(co)}`, structured: true };
          }
        }
      }
      // 2) No structured history — demand an employment cue in the prose.
      for (const co of HYPERSCALERS) {
        const phrase = employedAtInText(co, t);
        if (phrase) return { quote: phrase, label: `Hyperscaler: ${cap(co)}` };
      }
      return null;
    },
  },
  {
    // ══════════════════════════════════════════════════════════════════════
    // RECENTLY DEPARTED — the access marker, and the one that is actually ours.
    //
    // This used to live only in the STAGE GATE, where "just left" helped a founder
    // qualify and then contributed nothing to where they ranked. That is backwards
    // for this fund. Everything else in this list is a quality signal that every
    // other firm can also read off the same public profile. The week someone leaves
    // is the week they are reachable and unpriced, and it decays fast.
    //
    // So it ranks. Not because a departure predicts a good company — it does not —
    // but because it predicts that a warm, early conversation is still available.
    // Labelled as timing in the UI so it is never mistaken for a quality read.
    // ══════════════════════════════════════════════════════════════════════
    key: 'recently_departed',
    label: 'Just left — reachable now',
    weight: 5,
    timing: true,
    // MODIFIER on purpose. A departure is not evidence anyone is good, so it must not
    // put a founder on the shortlist by itself, and it must not be one of the two
    // "independent signals" that earn must-meet. It boosts where a qualified founder
    // RANKS, which is the whole point: among people worth meeting, see the reachable
    // ones first.
    modifier: true,
    detect(t, ctx = {}) {
      // Structured first: the ingest taxonomy already types this (builderSignals
      // 'just_departed'), and a typed signal beats a phrase match.
      if (/\bjust_departed\b/i.test(String(t))) {
        return { quote: 'just_departed', label: 'Just left a role — reachable now', structured: true };
      }
      return firstMatch(t, /\b(just left|recently left|just departed|recently departed|last day at|wrapp(ed|ing) up my time at|stepping (away|down) from|after \d+ (great )?years at|departing|left [a-z0-9][\w .&-]{1,30} to (build|start|found))\b/i);
    },
  },
  {
    key: 'nat_elite_school',
    label: 'Elite school',
    weight: 3,
    modifier: true,
    graduation: true,
    structured: true,
    detect(t, ctx = {}) {
      for (const school of ctx.schools || []) {
        const lc = normText(school);
        for (const sname of NAT_ELITE_SCHOOLS) {
          if (lc.includes(normText(sname))) {
            return { quote: school, label: `${cap(sname)} (next-round signal)`, structured: true };
          }
        }
      }
      return null;
    },
  },
  {
    key: 'il_elite_school',
    label: 'Elite Illinois school',
    // ── WHAT THIS WEIGHT MEANS, because it is not what it looks like ──
    // School does NOT predict the company. Founders of billion-dollar companies split
    // roughly 36% top-10 school / 28% middle / 36% outside the top 100 — near flat.
    // But top firms put 60–78% of their money into elite-school founders, so the
    // credential strongly predicts THE NEXT ROUND. For a pre-seed fund that gets paid
    // when somebody else marks us up, that is worth real points and it is a
    // GRADUATION signal, not a quality one. It stays a modifier — it can raise a
    // founder's rank, it can never put one on the shortlist alone.
    // See Brain/02 Frameworks/Sourcing Score — Evidence Check.md.
    weight: 5,
    graduation: true,
    // A MODIFIER, not a qualifier. Danny: "they went to a prestigious Chicago/IL
    // school AND have a track record that lends itself to building outliers." The
    // school boosts priority but never makes the shortlist on its own — a degree is
    // not a track record. meetWorthy requires a core marker; this isn't one.
    modifier: true,
    structured: true,
    detect(t, ctx = {}) {
      // Structured education[] first — the same discipline as employment. "AI for
      // Northwestern students" or "based near the University of Chicago" is a
      // mention, not an alma mater; the education array never contains those.
      for (const school of ctx.schools || []) {
        const lc = normText(school);
        for (const s of IL_ELITE_SCHOOLS) {
          if (lc.includes(normText(s))) return { quote: school, label: cap(s), structured: true };
        }
      }
      // Free-text fallback: require an education cue near the school name.
      const eduCue = /\b(studied|degree|b\.?s\.?|m\.?s\.?|ph\.?d|mba|bachelor|master|alum|alumni|graduate|grad|class of|attended|educated)\b/i;
      for (const s of IL_ELITE_SCHOOLS) {
        const re = new RegExp(`(?:${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
        const m = t.match(re);
        if (m) {
          const idx = m.index || 0;
          const window = t.slice(Math.max(0, idx - 60), idx + s.length + 40);
          if (eduCue.test(window)) return { quote: m[0], label: cap(s) };
        }
      }
      return null;
    },
  },
];

// A marker's evidence must be verbatim in the profile text (whitespace/punct
// normalized). Same gate the pedigree/tie checks use — nothing appears without a
// receipt that's actually in the source.
function verbatimIn(quote, text) {
  const q = normText(quote), t = normText(text);
  if (!q || q.length < 2) return false;
  if (t.includes(q)) return true;
  const words = q.split(' ');
  if (words.length >= 6) {
    const mid = words.slice(1, -1).join(' ');
    return mid.length >= 10 && t.includes(mid);
  }
  return false;
}

function markersFor(row) {
  const text = profileText(row);
  const ctx = structuredProfile(row);
  const out = [];
  for (const m of MARKERS) {
    const hit = m.detect(text, ctx);
    if (!hit) continue;
    const quote = typeof hit === 'string' ? hit : hit.quote;
    const label = typeof hit === 'string' ? m.label : (hit.label || m.label);
    // A structured hit's evidence comes from the LinkedIn experiences[]/education[]
    // arrays — ground truth that need not appear in the flattened prose blob, and
    // often won't (the array is separate from the bio). Only free-text hits face the
    // verbatim gate, which is exactly where invention is possible.
    const isStructured = typeof hit === 'object' && hit.structured;
    if (!isStructured && !verbatimIn(quote, text)) continue; // the receipt has to be real
    out.push({
      key: m.key, label, weight: m.weight, evidence: quote,
      modifier: !!m.modifier, structured: !!isStructured,
      // Kind is carried so the UI can say WHY a marker counts. A graduation signal
      // ("the Series A market likes this") and a quality signal ("this person has
      // done it before") must never render as the same kind of claim.
      kind: m.graduation ? 'graduation' : (m.timing ? 'timing' : 'quality'),
    });
  }
  // ── FOUNDER-MARKET FIT — has this person worked in the domain they're building? ──
  const fmf = assessMarketFit(text, ctx, row);
  if (fmf.fit) {
    out.push({ key: 'founder_market_fit', label: `Domain fit — ${fmf.domain}`, weight: 6, evidence: fmf.evidence, structured: true });
  }

  // ── BUILDER SLOPE — the pre-seed signal, read from the row, not the text ──
  // GitHub trajectory (pipeline/github-activity → github_slope_score). This is the
  // one marker that CANNOT be self-labeled and that a founder with zero pedigree can
  // score high on — the illegible-builder unlock the red team demanded. Weighted
  // above credentials on purpose: at pre-seed, Danny cares most about slope.
  if (row && row.github_slope_score != null && row.github_slope_score >= 3) {
    let evidence = 'GitHub momentum';
    try { const d = JSON.parse(row.github_slope_data || '{}'); if (d.evidence) evidence = d.evidence; } catch { /* keep default */ }
    // IDENTITY CONFIDENCE (engineering red team F2). Slope only drives the tier when we
    // trust the GitHub account IS this founder. High: the GitHub-native source (the
    // account is the person by construction), their OWN profile link (backfill,
    // resolve_reason null), or a resolve with a POSITIVE corroborator ("name +
    // company/IL/site"). Weak: a name-derived handle alone — real enough to SHOW, not
    // to promote to must-meet on its own.
    const reason = row.github_resolve_reason || '';
    // Read-time safeguard: a slope whose headline repo is CONTENT (an awesome-list, a
    // skills/prompts collection) is never trusted to drive the tier — even if the
    // stored score predates the content-exclusion fix. This drops the content-creator
    // (Jim Liu's "baoyu-skills") on read, without waiting for a re-score.
    const contentEvidence = SLOPE_CONTENT.test(evidence);
    const weakIdentity = /^name-derived handle/.test(reason) || contentEvidence;
    out.push({
      key: 'builder_slope',
      label: `Building fast (${evidence})`,
      weight: weakIdentity ? 5 : 9,   // weak identity / content can't outweigh a real credential
      evidence,
      structured: true, // from the GitHub API, not the prose blob
      slopeScore: contentEvidence ? Math.min(row.github_slope_score, 4) : row.github_slope_score,
      weakIdentity,
    });
  }

  // Strongest first, so "Why they're here" leads with the best reason.
  out.sort((a, b) => b.weight - a.weight);
  return { markers: out, text };
}

// ══════════════════════════════════════════════════════════════════════════
// THE TIER — how selective, and WHY. Danny: "get a bit more selective ... cull the
// list down to the very best while making this a repeat-use feature so I can trust
// the engine's judgment."
//
// Trust comes from a named, deterministic, EXPLAINABLE bar — the same founder lands
// in the same tier every run, and the reason is stated. Not a silent threshold.
//
//   MUST-MEET — the very best. A proven builder, not just a credential:
//       · a prior EXIT (his stated #1 signal), OR
//       · a repeat founder WITH real pedigree (hyperscaler / top program / prior
//         raise) — founding again, and not from nowhere, OR
//       · ≥2 independent core markers — corroboration beats a single signal.
//     Measured against the live Illinois inbox: 82 of 1908. A real shortlist.
//
//   STRONG — one solid core marker, earliest-stage, IL tie. Real, worth a look,
//     but a single signal. The 534 that meetWorthy included but "the very best"
//     shouldn't be crowded by.
//
//   (no tier) — didn't clear the gates. Not meet-worthy.
//
// Pedigree here EXCLUDES a bare program badge as the ONLY corroborator on purpose:
// Danny wants to meet builders "before they get into YC/Speedrun or think to apply,"
// so YC-alone or Speedrun-alone is a Strong signal, not a Must-meet one. A repeat
// founder who ALSO did time at a hyperscaler is the profile that earns the top tier.
const PEDIGREE_KEYS = new Set(['hyperscale', 'yc', 'speedrun_zfellows', 'spc', 'prior_raise']);

function tierOf(coreMarkers) {
  const keys = new Set(coreMarkers.map((m) => m.key));
  const pedigree = [...keys].filter((k) => PEDIGREE_KEYS.has(k));

  // BUILDER SLOPE leads. A founder whose output/audience is genuinely accelerating on
  // GitHub is exactly who Danny wants to meet early — pedigree or not. Real velocity
  // (slope ≥ 6: an inflection repo or strong star-velocity) is Must-meet on its own.
  // Slope alone reaches must-meet ONLY with a trusted identity. A name-derived-handle
  // resolve (weakIdentity) might be a same-named stranger; its slope shows as a marker
  // but must corroborate with a second signal before it promotes anyone (F2).
  const slope = coreMarkers.find((m) => m.key === 'builder_slope');
  if (slope && slope.slopeScore >= 6 && !slope.weakIdentity) return { tier: 'must-meet', reason: `Building fast — ${slope.evidence}` };

  if (keys.has('prior_exit')) return { tier: 'must-meet', reason: 'Exited a startup' };
  if (keys.has('prior_founding') && pedigree.length) {
    const p = coreMarkers.find((m) => PEDIGREE_KEYS.has(m.key));
    return { tier: 'must-meet', reason: `Repeat founder + ${p.label.replace(/^Hyperscaler: /, '')}` };
  }
  // Corroboration: two independent signals. Slope + anything counts strongly here.
  if (coreMarkers.length >= 2) return { tier: 'must-meet', reason: `${coreMarkers.length} independent signals` };
  return { tier: 'strong', reason: coreMarkers[0] ? coreMarkers[0].label : 'One signal' };
}

// ══════════════════════════════════════════════════════════════════════════
// THE VERDICT — gates + score + tier, in one call.
//
//   meetWorthy  = earliest-stage (not past it) AND at least one outlier marker.
//   tier        = 'must-meet' | 'strong' | null — the selectivity Danny asked for.
//   priority    = sum of marker weights; a strong-but-too-late founder is cut to a
//                 residual so it can never outrank a genuinely early one.
//   why         = the surviving marker labels — the honest "Why they're here".
// ══════════════════════════════════════════════════════════════════════════
function evaluate(row) {
  const { markers, text } = markersFor(row);
  const ctx = structuredProfile(row);
  const stage = classifyStage(text);
  const markerScore = markers.reduce((s, m) => s + m.weight, 0);

  // The shortlist needs a CORE marker, not just a modifier. A founder whose only
  // signal is "went to Northwestern" is not someone Danny asked to meet — he asked
  // for a school PLUS a track record. Core markers are the track record.
  const coreMarkers = markers.filter((m) => !m.modifier);

  // Venture-scale gate. A lifestyle/services founder (café, agency, consultancy) is
  // not who Danny is sourcing, regardless of how many "serial founder" tags fire.
  const venture = assessVentureScale(text, ctx, row);
  // Academic-with-no-operating-evidence gate. See assessAcademic above.
  const academic = assessAcademic(text, ctx, row);
  // Already-computed disqualifier from the scoring pass. See assessDisqualifyingFlags above.
  const disq = assessDisqualifyingFlags(row);

  const meetWorthy = !stage.tooLate && !venture.lifestyle && !academic.academic && !disq.disqualified && coreMarkers.length > 0;
  // Past-earliest / disqualified founders keep a residual score (so the board can
  // still show them, sorted below), but they can never sit among the earliest-stage
  // names Danny is hunting for. Multiply, don't zero, so ranking within the excluded
  // set is stable.
  const priority = (stage.tooLate || disq.disqualified) ? Math.round(markerScore * 0.1) : markerScore;

  // Tier only applies to meet-worthy founders — the gates come first.
  const { tier, reason } = meetWorthy ? tierOf(coreMarkers) : { tier: null, reason: null };

  return {
    meetWorthy,
    tier,
    tierReason: reason,
    priority,
    stage: stage.stage,
    stageTooLate: stage.tooLate,
    stageEvidence: stage.evidence,
    lifestyle: venture.lifestyle,
    lifestyleEvidence: venture.evidence || null,
    academic: academic.academic,
    academicEvidence: academic.evidence || null,
    disqualified: disq.disqualified,
    disqualifiedEvidence: disq.evidence || null,
    markers,
    coreMarkerCount: coreMarkers.length,
    why: markers.map((m) => m.label),
    markerScore,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// RUBRIC_VERSION — bump this on ANY change to markers, weights, gates or tiers.
//
// Stored verdicts are a CACHE (lib/fitIndex). Staleness was keyed only on the row
// changing — enrichment landing, the slope scorer running. So a change to the RUBRIC
// itself invalidated nothing: every already-scored founder kept the old answer
// forever, and the morning list would have quietly ranked on retired weights while
// the code said otherwise. The version is the missing key. fitIndex.rescoreStale()
// re-scores anything carried at an older version, so a rubric edit self-heals on the
// next nightly scout instead of needing someone to remember.
// ══════════════════════════════════════════════════════════════════════════
const RUBRIC_VERSION = '2026-08-31.red-flag-gate.1';

module.exports = {
  RUBRIC_VERSION,
  evaluate, markersFor, classifyStage, tierOf, profileText, verbatimIn, assessMarketFit,
  assessAcademic, assessVentureScale, assessDisqualifyingFlags,
  MARKERS, HYPERSCALERS, IL_ELITE_SCHOOLS, PEDIGREE_KEYS, DOMAINS,
};
