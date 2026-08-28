/**
 * Superior Studios — Founder Sourcing Engine v2
 * ================================================
 * Daily-recurring discovery engine that finds the best pre-seed builders
 * with Chicago/Illinois ties using Exa AI semantic search + Claude scoring.
 *
 * Sources:
 *   1. Exa AI — semantic web search across 40+ proven query vectors
 *   2. GitHub API — Chicago-based technical founders
 *
 * Enrichment:
 *   - EnrichLayer — LinkedIn profile enrichment for top scorers (8+)
 *
 * Scoring:
 *   - Claude — geography-weighted 1-10 fit score with structured signals
 */

const db = require('../db');
const https = require('https');
const { MODEL } = require('../lib/providerKeys');

// ── API Clients ──

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(result) }); }
        catch { resolve({ status: res.statusCode, data: result }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers,
    }, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(result) }); }
        catch { resolve({ status: res.statusCode, data: result }); }
      });
    });
    req.on('error', reject);
  });
}

// ── Illinois Verification (ported from Claude Funnel v3) ──

const ILLINOIS_LOCATIONS = [
  'chicago', 'evanston', 'naperville', 'aurora', 'joliet', 'rockford',
  'schaumburg', 'palatine', 'skokie', 'oak park', 'wicker park',
  'lincoln park', 'river north', 'west loop', 'south loop', 'pilsen',
  'logan square', 'downers grove', 'elmhurst', 'wheaton', 'lombard',
  'urbana', 'champaign', 'peoria', 'springfield', 'bloomington',
  'northbrook', 'highland park', 'lake forest', 'winnetka', 'wilmette',
  'oak brook', 'lisle', 'bolingbrook', 'orland park', 'tinley park',
  'illinois', 'chicagoland'
];

const ILLINOIS_SCHOOLS = [
  'university of illinois', 'uiuc', 'illinois institute of technology',
  'iit', 'northwestern university', 'northwestern', 'kellogg',
  'university of chicago', 'uchicago', 'chicago booth', 'loyola chicago',
  'depaul university', 'illinois state', 'southern illinois'
];

const ELITE_SCHOOLS = [
  'stanford', 'harvard', 'mit', 'uc berkeley', 'university of michigan',
  'carnegie mellon', 'caltech', 'princeton', 'yale', 'columbia',
  'university of pennsylvania', 'wharton', 'cornell'
];

const HYPERSCALE_COMPANIES = [
  'google', 'meta', 'facebook', 'apple', 'amazon', 'microsoft', 'netflix',
  'stripe', 'openai', 'anthropic', 'palantir', 'anduril', 'spacex',
  'coinbase', 'datadog', 'snowflake', 'databricks', 'figma', 'notion',
  'linear', 'vercel', 'supabase', 'plaid', 'robinhood', 'citadel',
  'jump trading', 'drw', 'two sigma', 'jane street', 'tempus',
  'grubhub', 'groupon', 'avant', 'braintree', 'paypal'
];

// R1: Elite national schools are a PEDIGREE signal, NEVER a standalone IL tie.
// Tie must come from: (a) current location, (b) strict work-context, (c) Illinois school,
// (d) grew up / from / raised in IL, (e) worked at Chicago-HQ company.
function verifyIllinois(text, headline) {
  const combined = stripFalseGeo(((headline || '') + ' ' + (text || '')).toLowerCase());

  // (a) Current location — "City, Illinois" or "City, IL" patterns
  for (const loc of ILLINOIS_LOCATIONS) {
    if (combined.includes(`${loc}, illinois`) || combined.includes(`${loc}, il`)) {
      return { verified: true, type: 'current', location: loc.charAt(0).toUpperCase() + loc.slice(1) };
    }
  }
  if (combined.includes('greater chicago area') || combined.includes('chicagoland') || combined.includes('chicago metropolitan')) {
    return { verified: true, type: 'current', location: 'Chicago Area' };
  }

  // (b) Work context — tighter regex with explicit work verbs
  const workPatterns = [
    /\bbased in (chicago|illinois|evanston|greater chicago)/,
    /\blocated in (chicago|illinois)/,
    /\b(currently|now) (building|working|living) (in|out of) (chicago|illinois)/,
    /\b(moved|relocated|moving)\s+(to\s+)?chicago/,
    /\b(founder|ceo|cto|cofounder|co-founder|engineer)\s+(at|@|in|of)\s+[a-z0-9\s]{0,40}(chicago|illinois|evanston)/,
  ];
  for (const p of workPatterns) {
    if (p.test(combined)) return { verified: true, type: 'working', location: 'Chicago' };
  }

  // (c) Illinois school alumni — local-anchor schools satisfy both tie + pedigree per ICP
  for (const school of ILLINOIS_SCHOOLS) {
    if (combined.includes(school)) {
      return { verified: true, type: 'school_alumni', location: school.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') };
    }
  }

  // (d) Hometown / grew up in IL
  const hometownPatterns = [
    /\b(from|grew up in|born in|raised in|native of)\s+(chicago|illinois|evanston|naperville|oak park)/,
    /\b(chicago|illinois)\s+(native|local|born)/,
  ];
  for (const p of hometownPatterns) {
    if (p.test(combined)) return { verified: true, type: 'hometown', location: 'Illinois (hometown)' };
  }

  // (e) Worked at Chicago-HQ company (strict: company name + Chicago office context)
  const chicagoHqCompanies = ['grubhub', 'groupon', 'avant', 'braintree', 'tempus', 'sprout social', 'cameo', 'outcome health'];
  for (const co of chicagoHqCompanies) {
    if (combined.includes(co) && (combined.includes('chicago') || combined.includes('illinois'))) {
      return { verified: true, type: 'chicago_company', location: `Ex-${co.charAt(0).toUpperCase() + co.slice(1)}` };
    }
  }

  // NOTE: Elite-school-only path intentionally removed — see R1 of sourcing audit.
  // National elite schools (Stanford, Harvard, MIT, etc.) are pedigree multipliers,
  // NEVER a standalone IL tie. They must pair with one of the above tie types.
  return { verified: false, type: null, location: null };
}

// ── Generic Location Verification (uses user's target locations) ──

// R1: Tie verification — elite schools never establish tie on their own.
// Tie requires one of:
//   (a) location keyword in structured form (", IL" / ", Illinois" / "based in")
//   (b) user-target school attendance
//   (c) hometown / grew up in target location
//   (d) worked at target-location-HQ company with location context
// Raw substring match on a user location is rejected unless it has structural
// context (comma pattern, "based in", etc.) — too many false positives like
// "Chicago Bears fan" or "Illinois tax law".
// Strip phrases where a location word is NOT a geographic tie — sports teams, media,
// etc. ("Chicago Bears", "Chicago Tribune") so they can't trigger a false tie.
function stripFalseGeo(s) {
  return s
    .replace(/\bchicago\s+(bears|bulls|cubs|white\s*sox|blackhawks|fire|sky|red\s*stars|marathon|tribune|sun[-\s]?times|magazine|pizza|style|hope|med)\b/g, ' ')
    .replace(/\billinois\s+(lottery|tollway)\b/g, ' ');
}

function verifyLocation(text, headline, criteria) {
  const combined = stripFalseGeo(((headline || '') + ' ' + (text || '')).toLowerCase());
  const userLocations = (criteria.locations || []).map(l => l.toLowerCase());
  const userSchools = (criteria.schools || []).map(s => s.toLowerCase());

  // No location preference → everyone passes (intentional — broad search mode)
  if (userLocations.length === 0 && userSchools.length === 0) {
    return { verified: true, type: 'broad', location: 'Any' };
  }

  // (a) Structured current-location mention of user's target locations
  for (const loc of userLocations) {
    // "chicago, il" / "chicago, illinois" / "based in chicago" / "located in chicago"
    const patterns = [
      new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*(il\\b|illinois\\b)`, 'i'),
      new RegExp(`\\bbased in\\s+${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
      new RegExp(`\\blocated in\\s+${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
      new RegExp(`\\bgreater\\s+${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+area\\b`, 'i'),
      new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(metropolitan|area|metro)\\b`, 'i'),
    ];
    if (patterns.some(p => p.test(combined))) {
      return { verified: true, type: 'current', location: loc.charAt(0).toUpperCase() + loc.slice(1) };
    }
    // Work-role + location co-occurrence (stricter than previous 40-char window)
    const workRole = new RegExp(`\\b(founder|ceo|cto|cofounder|co-founder|head of|vp of|director of)\\b[^.]{0,30}\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (workRole.test(combined)) {
      return { verified: true, type: 'working', location: loc.charAt(0).toUpperCase() + loc.slice(1) };
    }
  }

  // (b) User-target school attendance
  for (const school of userSchools) {
    if (combined.includes(school)) {
      return { verified: true, type: 'school_alumni', location: school.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') };
    }
  }

  // (c) Hometown / from-ties to target location
  for (const loc of userLocations) {
    const hometown = new RegExp(`\\b(from|grew up in|born in|raised in|native of)\\s+${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const nativeOf = new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(native|local|born)\\b`, 'i');
    if (hometown.test(combined) || nativeOf.test(combined)) {
      return { verified: true, type: 'hometown', location: `${loc.charAt(0).toUpperCase() + loc.slice(1)} (hometown)` };
    }
  }

  // NOTE: Elite-school-only path intentionally removed — see R1 of sourcing audit.
  // National elite schools are pedigree, not location ties.
  return { verified: false, type: null, location: null };
}

// Word-boundary matcher — stops "mit" matching "submit", "meta" matching "metadata", etc.
function reWord(term) {
  return new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
}
const titleCase = (s) => s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// MANIACAL ACCURACY HELPERS ──────────────────────────────────────────────────
// (1) Strip contamination. LinkedIn/Exa snippets frequently append OTHER people
// ("People also viewed", "Similar profiles"). Verifying or scoring past these markers
// attributes the wrong person's school/company/tie. Cut the text at the first marker so
// we only ever reason about the focal person's own profile.
const CONTAM_MARKERS = /(people also viewed|people you may know|similar profiles?|others? named|more profiles|view full profile|connections? who|recommended for you|profiles? similar|others viewed)/i;
function cleanProfileText(text) {
  const s = String(text || '');
  const m = s.match(CONTAM_MARKERS);
  return m ? s.slice(0, m.index) : s;
}

// (2) A real person name: 2–4 tokens, each capitalized (or a name particle), no digits, no
// sentence/marketing words. Kills garbage "names" scraped from article/company titles
// (e.g. "our new product", "Introducing Acme", "How we built X").
const NON_NAME_WORDS = new Set(['our','the','new','product','products','building','build','stealth','founder','cofounder','ceo','cto','startup','company','launch','launching','introducing','meet','how','why','what','we','are','is','for','and','to','of','in','at','with','your','my','this','that','best','top','announcing','presenting','welcome','join']);
const NAME_PARTICLES = new Set(['de','van','von','la','del','di','da','bin','al','der','den']);
function isPlausiblePersonName(name) {
  const n = String(name || '').trim();
  if (n.length < 3 || n.length > 50 || /\d/.test(n)) return false;
  const tokens = n.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  for (const tok of tokens) {
    const w = tok.toLowerCase().replace(/[^a-z'’-]/g, '');
    if (!w) return false;
    if (NON_NAME_WORDS.has(w)) return false;
    if (!NAME_PARTICLES.has(w) && !/^[A-ZÀ-Ý]/.test(tok)) return false; // must start uppercase
  }
  return true;
}

function extractSignals(text, headline) {
  const combined = ((headline || '') + ' ' + (text || '')).toLowerCase();
  const pedigree = [];
  const builder = [];
  const anchorSchoolsIl = [];
  const eliteSchoolsNational = [];

  // Schools — word-boundary so we don't tag "MIT" from "submit" or "limited".
  for (const school of ILLINOIS_SCHOOLS) {
    if (reWord(school).test(combined)) {
      const display = titleCase(school);
      pedigree.push(display);
      anchorSchoolsIl.push(display);
    }
  }
  for (const school of ELITE_SCHOOLS) {
    if (reWord(school).test(combined)) {
      const display = titleCase(school);
      pedigree.push(display);
      eliteSchoolsNational.push(display);
    }
  }

  // Hyperscale pedigree — REQUIRE employment context. Common-word company names
  // (apple, meta, notion, stripe, avant) must appear with an "ex-/former/at/worked at"
  // cue, or immediately before a role word, before we claim someone worked there.
  const EMP_BEFORE = '(ex-?|former(ly)?|previously|prev\\.?|alum(ni)? of|worked (at|for)|joined|engineer at|pm at|spent\\s+[\\w\\s]{0,12}\\s+at|at|@|with)';
  for (const company of HYPERSCALE_COMPANIES) {
    const c = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = new RegExp(EMP_BEFORE + '\\s+' + c + '\\b', 'i');
    const after = new RegExp('\\b' + c + '\\s*(engineer|alum|alumni|veteran|exec|executive|employee|team|—|-|\\()', 'i');
    if (before.test(combined) || after.test(combined)) {
      pedigree.push('Ex-' + titleCase(company));
    }
  }

  // Builder signals
  if (/\by combinator\b|\bycombinator\b|\byc[ws]\d{2}\b|\byc\b/i.test(combined)) builder.push('YC Alum');
  if (/techstars/.test(combined)) builder.push('Techstars');
  if (/south park commons/.test(combined)) builder.push('SPC');
  if (/\b(exited|acquired|sold|exit)\b/.test(combined)) builder.push('Previous Exit');
  if (/serial (founder|entrepreneur)/.test(combined)) builder.push('Serial Founder');
  if (/second.time (founder|entrepreneur)/.test(combined)) builder.push('Second-time Founder');
  if (/co.?found/.test(combined)) builder.push('Co-founder');
  if (/open.source/.test(combined)) builder.push('Open Source');
  if (/ph\.?d/.test(combined)) builder.push('PhD');
  if (/patent/.test(combined)) builder.push('Patent Holder');

  // Stealth / early-stage signals (high-value — these are our ideal candidates)
  if (/stealth/.test(combined)) builder.push('Stealth Mode');
  if (/building something new/.test(combined)) builder.push('Building Something New');
  if (/exploring what['']?s next/.test(combined)) builder.push('Exploring Next');
  if (/\bjust left\b/.test(combined)) builder.push('Just Left Role');
  if (/\bpre.?launch\b/.test(combined)) builder.push('Pre-launch');
  if (/\bpre.?seed\b/.test(combined)) builder.push('Pre-seed');
  if (/\bday (one|1|zero|0)\b/.test(combined)) builder.push('Day One');
  if (/\bin stealth\b/.test(combined)) builder.push('Stealth Mode');
  if (/working on something new/.test(combined)) builder.push('Building Something New');
  if (/\bformer (cto|ceo|vp|head of)\b/.test(combined)) builder.push('Former Executive');
  if (/\b(next chapter|what['']?s next|new venture)\b/.test(combined)) builder.push('Starting New Venture');

  return {
    pedigree: [...new Set(pedigree)],
    builder: [...new Set(builder)],
    anchor_schools_il: [...new Set(anchorSchoolsIl)],
    elite_schools_national: [...new Set(eliteSchoolsNational)],
  };
}

// Drop pedigree tags whose entity doesn't actually appear in the profile text
// (catches both loose regex matches and any LLM invention like a fabricated "Ex-Stripe").
const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function verifyPedigree(tags, text) {
  const t = normText(text);
  if (!t) return tags || [];
  return (tags || []).filter(tag => {
    const phrase = normText(String(tag).toLowerCase().replace(/^ex-?\s*/, ''));
    if (!phrase) return false;
    const tokens = phrase.split(' ').filter(Boolean);
    // Single-token tag (MIT, IIT, Northwestern, Stripe): must appear as a WHOLE word —
    // never inside another word ("MIT" must not match "submit"/"committee").
    if (tokens.length === 1) return reWord(tokens[0]).test(t);
    // Multi-word name (Illinois Institute of Technology, University of Chicago, Carnegie
    // Mellon): the FULL phrase must appear. A stray "Illinois" or "Chicago" elsewhere in the
    // text is NOT enough — this is what stops a city mention inventing a university.
    return t.includes(phrase);
  });
}

// VERBATIM evidence gate — the core anti-hallucination tool. A claim survives ONLY if its
// quote is genuinely present in the profile text (normalized for whitespace/punctuation).
function verbatimIn(quote, text) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(quote), t = norm(text);
  if (!q || q.length < 8) return false;        // too short to be meaningful evidence
  if (t.includes(q)) return true;
  // Allow a long quote to match if a substantial contiguous chunk is present (LLM trims edges).
  const words = q.split(' ');
  if (words.length >= 8) {
    const mid = words.slice(2, words.length - 2).join(' ');
    return mid.length >= 12 && t.includes(mid);
  }
  return false;
}

// Genuine Illinois signals that a tie quote must contain to count.
const IL_TIE_TOKENS = [
  'chicago', 'illinois', '\\bil\\b', 'evanston', 'naperville', 'oak park', 'champaign', 'urbana',
  'schaumburg', 'wicker park', 'river north', 'hyde park', 'lincoln park', 'west loop',
  'northwestern', 'university of chicago', 'uchicago', 'uiuc', 'university of illinois',
  '\\biit\\b', 'illinois institute', 'kellogg', 'booth', 'loyola', 'depaul',
  'grubhub', 'groupon', 'avant', 'braintree', 'tempus', 'sprout social', 'cameo', 'relativity',
];
// A tie is VERIFIED only if its evidence quote is verbatim in the text AND names a real IL signal.
function verifyTieEvidence(evidenceMap, text) {
  const q = evidenceMap && evidenceMap.tie_evidence;
  if (!verbatimIn(q, text)) return false;
  const lc = String(q).toLowerCase();
  return IL_TIE_TOKENS.some(tok => new RegExp(tok, 'i').test(lc));
}

// ── CALIBER: the unicorn-grade axis ──
// Detected SEPARATELY from confidence/relevance. These are hard, evidence-backed
// signals that — independent of any Chicago tie — say "this is a best-of-best
// builder": a prior exit, admission to a top program (the YC/a16z-speedrun bar),
// a senior departure from a category-defining company, a repeat founder, or
// research eminence. We compute caliber deterministically so the LLM can NUANCE
// the tier but can never INFLATE it to S without one of these signals present.

// Top programs whose admission is itself proof of best-of-best selection.
const TOP_PROGRAMS = [
  { re: /\by[- ]?combinator\b|\bycombinator\b|\byc\s?[wsf]\d{2}\b/i, label: 'YC' },
  { re: /a16z\s+speedrun|andreessen\s+speedrun|\bspeedrun\b/i, label: 'a16z Speedrun' },
  { re: /\bz[- ]?fellows?\b|\bzfellows\b/i, label: 'ZFellows' },
  { re: /thiel\s+fellow/i, label: 'Thiel Fellow' },
  { re: /\bneo\s+(scholar|fellow|cohort|accelerator)\b/i, label: 'Neo' },
];
// Strong-but-second-tier programs: caliber signal, but not S-grade on their own.
const STRONG_PROGRAMS = [
  { re: /south\s+park\s+commons|\bspc\b/i, label: 'SPC' },
  { re: /techstars/i, label: 'Techstars' },
  { re: /\bon\s+deck\b|\bodf\b/i, label: 'On Deck' },
  { re: /pear\s?vc|pearx|pear\s+garage/i, label: 'PearX' },
  { re: /entrepreneur\s+first|\bef\s+cohort\b/i, label: 'Entrepreneur First' },
];
const SENIOR_TITLE_RE = /\b(staff|senior staff|principal|distinguished|lead|founding)\s+(engineer|scientist|researcher|designer|architect)\b|\b(vp|vice president|head of|director|chief|cto|ceo|coo|cpo)\b/i;
const DEPARTURE_RE = /\b(ex-|former(ly)?|previously|just left|recently left|left\s+\w+\s+(to|after)|departed|alum(ni)? of|spent \d+ years at|years at)\b/i;

function detectCaliberSignals(text, headline) {
  const combined = ((headline || '') + ' ' + (text || '')).toLowerCase();
  const signals = [];

  // (1) Prior exit — the strongest single signal
  const exitRe = /\b(acquired by|was acquired|got acquired|exited|sold (my|the|our|his|her|a) (company|startup|business)|successful exit|prior exit|previously exited|ipo'?d)\b/;
  if (exitRe.test(combined)) {
    const bigExit = /\$\s?\d{2,}\s?(m|mm|million|b|bn|billion)\b/.test(combined)
      || /\b(unicorn|nine[- ]figure|hundreds of millions|\$\d+\s?b)\b/.test(combined);
    signals.push(bigExit ? 'Prior exit (significant)' : 'Prior exit');
  }

  // (2) Top-program admission
  let topProgram = false;
  for (const p of TOP_PROGRAMS) {
    if (p.re.test(combined)) { signals.push(`${p.label} alum`); topProgram = true; }
  }
  for (const p of STRONG_PROGRAMS) {
    if (p.re.test(combined)) signals.push(`${p.label} alum`);
  }

  // (3) Senior departure from a category-defining company
  let hyperscaleDeparture = false;
  for (const co of HYPERSCALE_COMPANIES) {
    if (!combined.includes(co)) continue;
    const idx = combined.indexOf(co);
    const window = combined.slice(Math.max(0, idx - 80), idx + co.length + 80);
    if (SENIOR_TITLE_RE.test(window) && DEPARTURE_RE.test(combined)) {
      signals.push(`Senior departure: ${co.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`);
      hyperscaleDeparture = true;
      break;
    }
  }

  // (4) Repeat / serial founder
  if (/\b(serial (founder|entrepreneur)|repeat founder|second.time founder|third.time founder|previously founded|co.?founded \w+)\b/.test(combined)) {
    signals.push('Repeat founder');
  }

  // (5) Research eminence
  if (/\bph\.?d\b/.test(combined) && /\b(cited|citations|published|papers|neurips|icml|iclr|cvpr|professor|faculty|research scientist)\b/.test(combined)) {
    signals.push('Research eminence');
  }
  // Significant open-source work (a real builder signal independent of any badge)
  if (/\b(\d[\d,.]*\s?k?\+?\s*(github )?stars|widely[- ]used|popular open[- ]source|maintainer of|creator of .{0,30}(open source|library|framework))\b/.test(combined)) {
    signals.push('Notable open-source');
  }

  // (6) Elite-company background — worked at a category-defining company, even WITHOUT
  //     an explicit senior-departure phrase. Being an engineer at OpenAI/Stripe is itself
  //     a caliber signal for a builder, not only when they "just left."
  let eliteCompany = false;
  if (!hyperscaleDeparture) {
    for (const co of HYPERSCALE_COMPANIES) {
      if (combined.includes(co)) {
        signals.push(`Elite-company background: ${co.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`);
        eliteCompany = true;
        break;
      }
    }
  }

  // (7) TRACTION — the most important builder signal of all. Real customers, revenue,
  //     or users mean this person is BUILDING, not just credentialed. No badge required.
  let traction = false, strongTraction = false;
  const payingCustomers = combined.match(/\b(\d{1,5})\+?\s*(paying\s+)?(customers|clients|enterprises?|logos|design partners)\b/);
  const userCount = combined.match(/\b(\d[\d,.]*)\s*(k|m|mm|million|thousand)\+?\s*(users|signups|sign-ups|downloads|developers|subscribers|members)\b/);
  const revenueWord = /\b(arr|mrr|revenue|profitable|ramen profitable|cash[- ]flow positive)\b/.test(combined);
  const dollarFig = /\$\s?\d[\d,.]*\s*(k|m|mm|million|b|bn)?\b/.test(combined);
  const grewTo = /\b(grew|scaled|went from|took it (from|to)|bootstrapped to)\b[^.]{0,40}\b(\$|\d|users|customers|revenue|profitable)/.test(combined);
  const profitable = /\b(profitable|ramen profitable|cash[- ]flow positive)\b/.test(combined);
  if (payingCustomers || userCount || (revenueWord && dollarFig) || grewTo || profitable) {
    traction = true;
    const bigDollar = /\$\s?\d[\d,.]*\s*(m|mm|million|b|bn)\b/.test(combined);
    let usersAbs = 0;
    if (userCount) {
      const n = parseFloat((userCount[1] || '0').replace(/,/g, ''));
      const unit = (userCount[2] || '').toLowerCase();
      const mult = /m|mm|million/.test(unit) ? 1e6 : /k|thousand/.test(unit) ? 1e3 : 1;
      usersAbs = n * mult;
    }
    const manyCustomers = payingCustomers && parseInt(payingCustomers[1], 10) >= 10;
    strongTraction = !!(bigDollar || usersAbs >= 100000 || manyCustomers
      || (profitable && (revenueWord || userCount || payingCustomers)));
    signals.push(strongTraction ? 'Strong traction (revenue/users)' : 'Early traction');
  }

  // (8) Shipped & scaled — built something real and at scale
  if (/\b(shipped|built and scaled|scaled (to|a)|launched .{0,30}(used by|to thousands|to millions)|millions of (users|requests)|powering)\b/.test(combined)) {
    signals.push('Shipped at scale');
  }

  // (9) Raised INSTITUTIONAL capital — third-party conviction from a real fund/accelerator.
  //     This is the signal that defines the founders Danny actually backs: technical people
  //     who got a credible investor to commit, usually at pre-seed/seed, often pre-traction.
  //     Tight patterns so we don't fire on "raised awareness" / "raised the bar".
  let institutionalRaise = false;
  const raisedMoney = /\braised\s+(a\s+|an\s+|our\s+|its\s+|their\s+)?(\$\s?\d|pre[- ]?seed|seed|series\s+[a-d]|angel|institutional)/.test(combined);
  const roundWord = /\b(pre[- ]?seed|seed|series\s+[a-d])\s+(round|funding|financing|raise)\b/.test(combined);
  const backedBy = /\b(backed by|funded by|raised from|investors? include|venture[- ]backed|vc[- ]backed)\b/.test(combined);
  const namedBackers = /\b(y[- ]?combinator|techstars|sequoia|a16z|andreessen|benchmark|founders fund|khosla|greylock|accel|first round|general catalyst|lightspeed|bessemer|index ventures|gv|google ventures|nea|8vc|craft ventures|initialized|pear vc|hustle fund|precursor|chapter one|matterhorn|m25|hyde park (angels|ventures)|chicago ventures|jump capital|hyde park)\b/.test(combined);
  if (raisedMoney || roundWord || backedBy || namedBackers) {
    institutionalRaise = true;
    signals.push('Raised institutional capital');
  }

  return {
    signals: [...new Set(signals)],
    topProgram, hyperscaleDeparture, eliteCompany, traction, strongTraction, institutionalRaise,
  };
}

// Deterministic caliber tier from hard signals. The LLM may raise a tier within
// the evidence it can justify, but S requires at least one hard signal here.
function computeCaliber(text, headline, eliteSchoolsNational = []) {
  const det = detectCaliberSignals(text, headline);
  const { signals, topProgram, hyperscaleDeparture, eliteCompany, traction, strongTraction, institutionalRaise } = det;
  const has = (frag) => signals.some(s => s.toLowerCase().includes(frag));
  const bigExit = has('exit (significant)');
  const anyExit = has('exit');
  const repeat = has('repeat founder');
  const research = has('research eminence');
  const oss = has('open-source');
  const shipped = has('shipped at scale');
  const eliteNational = (eliteSchoolsNational || []).length > 0;

  // Two distinct axes, deliberately separated to fix the leniency:
  //   topOutcome  = a proven, top-tier RESULT (exit, top-program admit, strong traction,
  //                 research/OSS eminence). These earn A on their own.
  //   building    = evidence the person is ACTIVELY building something real right now
  //                 (raised institutional capital, traction, shipped product).
  //   credential  = an elite background WITHOUT a result (ex-elite-company, FAANG departure,
  //                 repeat founder, elite school). A credential alone is NOT best-of-best.
  const topOutcome = bigExit || anyExit || topProgram || strongTraction || research || oss;
  const building = institutionalRaise || traction || strongTraction || shipped || research || oss;
  const credential = eliteCompany || hyperscaleDeparture || repeat || eliteNational;

  let tier, score, rationale;
  if (bigExit
      || (anyExit && (repeat || strongTraction || topProgram))
      || (topProgram && strongTraction)
      || (strongTraction && repeat)) {
    tier = 'S'; score = 9;
    rationale = 'Top-tier: a meaningful exit, a top-program admit paired with serious traction, or strong traction paired with a prior win.';
  } else if (topOutcome || (building && credential) || (institutionalRaise && (traction || shipped))) {
    // A = a proven outcome, OR a credible elite founder who is demonstrably BUILDING
    // (raised, shipping, or with traction). A bare credential no longer reaches A.
    tier = 'A'; score = 7;
    rationale = 'Best-of-best: a prior exit/top program/strong traction, OR an elite background paired with real building (institutional raise, shipped product, or traction).';
  } else if (building || eliteCompany || hyperscaleDeparture || repeat || (eliteNational && signals.length > 0)) {
    // B = one real building or strong-credential signal. Note: an elite SCHOOL alone is
    // pedigree, not caliber — it only reaches B alongside another signal.
    tier = 'B'; score = 5;
    rationale = 'Strong builder with at least one real signal — institutional raise, early traction, elite-company background, or a repeat founder.';
  } else {
    tier = 'C'; score = 3;
    rationale = 'Limited evidence of building so far — a credential or elite school alone is not enough to grade higher.';
  }
  // A hard signal lets the LLM justify A/S. Credential-only is intentionally NOT a hard
  // signal anymore: a real outcome or active building is required to claim the top tiers.
  const hardSignalPresent = anyExit || topProgram || strongTraction || research || oss || institutionalRaise;
  return { tier, score, signals, rationale, hardSignalPresent };
}

const TIER_RANK = { S: 4, A: 3, B: 2, C: 1 };
const TIER_BAND = { S: [9, 10], A: [7, 8], B: [5, 6], C: [1, 4] };

// Reconcile caliber. The LLM (with the full rubric + verbatim evidence) is the AUTHORITY —
// the deterministic layer must NOT inflate above it (that's how regex hits like "exit" in a
// blog text produced a false S). The LLM tier wins when present; deterministic is only a
// guard that CAPS S (no S unless a hard signal is genuinely detected in the text).
function reconcileCaliber(det, llmTier, llmScore) {
  let tier = (llmTier && TIER_RANK[llmTier]) ? llmTier : det.tier;
  if (tier === 'S' && !det.hardSignalPresent) tier = 'A'; // S demands hard evidence
  const [lo, hi] = TIER_BAND[tier];
  let score = Number.isFinite(llmScore) ? llmScore : det.score;
  if (score < lo) score = lo;
  if (score > hi) score = hi;
  return { tier, score };
}

// Red flags that hard-clamp relevance to a pass and cap caliber.
const DISQUALIFYING_FLAGS = [
  'student', 'recruiter', 'consultant', 'service provider', 'agency',
  'job seeker', 'job-seeker', 'no commercial', 'series a', 'series b',
  'fractional', 'coach', 'advisor only',
];
function hasDisqualifyingFlag(redFlags = []) {
  return (redFlags || []).some(rf =>
    DISQUALIFYING_FLAGS.some(d => String(rf).toLowerCase().includes(d))
  );
}

// ── FOUNDER GATE ──
// We only want FOUNDERS (current or stealth) with Chicago/IL ties — not investors,
// fund/accelerator staff, recruiters, or operators-at-a-fund. A profile passes only
// if it shows a real founder/building signal AND is not primarily an investor-side role.
// A genuine founder who also angel-invests still passes (founder signal wins).
const FOUNDER_SIGNAL_RE = new RegExp([
  '\\b(co-?founder|founder|founding (ceo|cto|engineer))\\b',
  '\\b(ceo|cto|coo) (of|@|at) (my|our|a|the|\\w)',
  '\\b(launched|started|founded|co-?founded|created) (a|my|our|the)? ?(company|startup|product|venture|business)\\b',
  '\\b(in stealth|stealth mode|stealth founder|building something new)\\b',
  '\\b(sold|exited) (my|our|the|his|her|a) (company|startup|business)\\b',
  '\\b(serial|repeat|second.time|two.time) (founder|entrepreneur)\\b',
  "\\bi'?m building\\b|\\bwe'?re building\\b",
].join('|'), 'i');

// Roles that mark someone as investor/fund/accelerator/recruiter side (not a founder).
const INVESTOR_ROLE_RE = /\b(general partner|managing partner|venture partner|investment partner|limited partner|\bgp\b|\blp\b|venture capitalist|angel investor|investor|principal|investment (associate|analyst|team)|scout|platform (lead|partner|manager|team|role)|talent (partner|lead|manager|team)|community (manager|lead|builder)|program (manager|director|lead|associate)|head of platform|deal team|portfolio (manager|operations|support))\b/i;
const FUND_CONTEXT_RE = /\b(a16z|andreessen horowitz|speedrun|sequoia|benchmark|accel|greylock|founders fund|khosla|lightspeed|general catalyst|bessemer|first round|initialized|\bnea\b|index ventures|bain capital|insight partners|\bventures\b|\bcapital\b|\bvc\b|y combinator|techstars)\b/i;
const RECRUITER_RE = /\b(recruiter|talent acquisition|headhunter|sourcer|staffing|executive search|recruiting)\b/i;

function founderGate(text, headline) {
  const h = (headline || '').toLowerCase();
  const t = (text || '').toLowerCase();
  const full = h + ' ' + t.slice(0, 1500);

  // The HEADLINE is the authoritative identity. A VC tagline like "we back founders
  // building the future" must not let an investor pass as a founder, so the investor
  // checks key off the headline and are only waived by a founder signal IN THE HEADLINE.
  const founderInHeadline = FOUNDER_SIGNAL_RE.test(h);

  if (RECRUITER_RE.test(h)) return { ok: false, reason: 'Recruiter, not a founder' };

  if (!founderInHeadline && INVESTOR_ROLE_RE.test(h) && FUND_CONTEXT_RE.test(full)) {
    return { ok: false, reason: 'Investor / fund role, not a founder' };
  }
  // Self-identifying investor language anywhere in the profile (not just the headline) —
  // a VC/angel/partner whose scraped headline happened to look innocuous (the Mark Suster
  // case). Waived only by a clear founder signal in the headline.
  const SELF_INVESTOR_RE = /\b(general partner|managing partner|managing director at|venture partner|founding partner|angel investor|solo ?capitalist|i invest in|we invest in|we back founders|i back founders|partner (at|@) [a-z]|invests? in (startups|founders|companies)|portfolio company of mine)\b/i;
  if (!founderInHeadline && SELF_INVESTOR_RE.test(full)) {
    return { ok: false, reason: 'Self-identified investor, not a founder' };
  }
  if (!founderInHeadline && /\b(at|@|with)\s+(a16z|andreessen|speedrun|sequoia|benchmark|accel|greylock|founders fund|khosla|y combinator|techstars)\b/i.test(h)) {
    return { ok: false, reason: 'Works at a fund/accelerator, not a founder' };
  }
  // Must show SOME founder/building signal somewhere — we source founders, not operators at large.
  if (!FOUNDER_SIGNAL_RE.test(full)) {
    return { ok: false, reason: 'No founder/building signal' };
  }
  return { ok: true, reason: null };
}

// Tie types that count as a verified Chicago/IL connection.
const VALID_TIE_TYPES = ['current', 'working', 'school_alumni', 'hometown', 'chicago_company'];

// ── Name normalization for dedup ──
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // strip punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
}
function linkedinSlug(url) {
  if (!url) return null;
  const u = String(url).toLowerCase().split('?')[0].replace(/\/+$/, '');
  const slug = u.split('/in/')[1];
  return slug ? slug.split('/')[0] : null;
}

// ── R6: Stage Pre-filter — body text + seniority + funding patterns ──
// Returns { disqualified: bool, reason: string | null }
// Disqualifies candidates whose own company is clearly past pre-seed.
// Prior version only checked headline for "IPO/unicorn/500+ employees" — caught ~5%.
// This version scans body for funding-round language + named top-tier investors
// bounded to the candidate's OWN company (heuristic: "raised by X", "our Series B",
// "we raised", or funding language within 80 chars of a first-person signal).
function isTooFarAlong(text, headline) {
  const h = (headline || '').toLowerCase();
  const t = (text || '').toLowerCase();

  // HEADLINE disqualifiers — strong, unambiguous
  const headlinePatterns = [
    { p: /\bipo\b/, reason: 'IPO in headline' },
    { p: /\bunicorn\b/, reason: 'Unicorn in headline' },
    { p: /\b\d{3,}\+?\s*employees\b/, reason: 'Headcount in headline' },
    { p: /\bceo\s+(of|@)\s+.{1,50}(public|nasdaq|nyse)/i, reason: 'CEO of public co' },
    { p: /\bpost[- ]ipo\b/, reason: 'Post-IPO' },
    { p: /\bseries\s+[b-z]\b/i, reason: 'Series B+ in headline' },
  ];
  for (const { p, reason } of headlinePatterns) {
    if (p.test(h)) return { disqualified: true, reason };
  }

  // BODY disqualifiers — need to distinguish "our Series B" (disqualify) from
  // "previously at a Series B startup" (past employer, pass).
  // Present-tense self-reference = strong signal. Past-tense or "previously/ex-/former"
  // near the funding signal negates the disqualification.
  const presentSelfRef = new RegExp([
    "\\bwe(['’]re| are| have| just| recently| raised| closed| launched| are building)\\b",
    "\\bour (current |company|startup|co|seed|series|round|funding|team)\\b",
    "\\bi (just |recently |have )?(raised|closed|launched|incorporated|founded|am building|am raising|led|lead)\\b",
    "\\bmy (company|startup|co|business|venture|new)\\b",
    "\\bthe company (has|is|just|raised|we|our)\\b",
    "\\bhere at\\b",
    "\\bfounder of\\b",
    "\\b(ceo|cto|coo) of\\b",
  ].join("|"), "i");
  const pastEmployerSignal = /\b(previously|formerly|ex-|former|prior to|used to|was at|was a|joined\s+\w+\s+as|worked at|worked for|during my time|left\s+to|before (starting|founding|co-founding)|back when|while at|stint at)\b/i;

  const bodyFundingPatterns = [
    { p: /\bseries\s+[b-z]\b/i, reason: 'Series B+ in body (own co)' },
    { p: /\braised\s+\$\s?\d+(\.\d+)?\s*[mb]\b/i, reason: 'Raised $N[mb] (own co)' },
    { p: /\$\d+(\.\d+)?\s*[mb]\s+(seed|round|raise|funding)\b/i, reason: 'Funding round amount (own co)' },
    { p: /\bfunding\s+led\s+by\s+(sequoia|a16z|andreessen|benchmark|accel|greylock|founders fund|khosla|redpoint|nea|lightspeed|insight|general catalyst|thrive|spark|ribbit|iconiq)/i, reason: 'Named tier-1 lead' },
    { p: /\bbacked\s+by\s+(sequoia|a16z|andreessen|benchmark|accel|greylock|founders fund|khosla|redpoint|nea|lightspeed|insight|general catalyst|thrive|spark|ribbit|iconiq)/i, reason: 'Backed by tier-1' },
  ];

  for (const { p, reason } of bodyFundingPatterns) {
    const match = t.match(p);
    if (match) {
      const idx = match.index;
      const windowStart = Math.max(0, idx - 150);
      const windowEnd = Math.min(t.length, idx + match[0].length + 50);
      const window = t.slice(windowStart, windowEnd);
      // If past-employer signal is within window, this is noise about a previous job
      if (pastEmployerSignal.test(window)) continue;
      // Require explicit present-tense self-reference
      if (presentSelfRef.test(window)) {
        return { disqualified: true, reason };
      }
    }
  }

  // Established-company seniority without departure signal
  const seniorityTitle = /\b(vp|vice president|director|head of|principal|staff|cto|ceo|chief)\s+(of\s+)?(engineering|product|design|data|ml|ai|growth|marketing|sales|technology|executive|operations|technical officer)?\b/i;
  const departureSignal = /\b(ex-|formerly|previously|just left|left\s+\w+\s+(to|for)|departed|exiting|stealth|founder|cofounder|co-founder|building (something|a new)|new venture)\b/i;
  if (seniorityTitle.test(h) && !departureSignal.test(h) && !departureSignal.test(t.slice(0, 600))) {
    // Check if body mentions their current co is mature, with present-tense self-ref nearby
    const matureMatch = t.slice(0, 1500).match(/\b(series [a-z]|\$\d+[mb] raised|\d{3,}\+\s*employees|publicly traded|nasdaq|nyse|post-?ipo)\b/i);
    if (matureMatch) {
      const idx = matureMatch.index;
      const window = t.slice(Math.max(0, idx - 150), idx + matureMatch[0].length + 50);
      if (presentSelfRef.test(window) && !pastEmployerSignal.test(window)) {
        return { disqualified: true, reason: 'Senior title at mature company, no departure signal' };
      }
    }
  }

  return { disqualified: false, reason: null };
}

function extractCompanyInfo(text, headline) {
  const combined = (headline || '') + ' ' + (text || '');

  // Try to extract company name from headline patterns like "Name | Role at Company"
  const patterns = [
    /(?:founder|ceo|cto|co-founder|cofounder)\s+(?:at|of|@)\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\s*[|·—\-]|\s*$)/i,
    /(?:building|launched|started)\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\s*[|·—\-,]|\s*$)/i,
    /\|\s*([A-Z][A-Za-z0-9\s&.]+?)(?:\s*[|·—\-]|\s*$)/,
  ];

  for (const p of patterns) {
    const match = combined.match(p);
    if (match && match[1] && match[1].trim().length > 1 && match[1].trim().length < 50) {
      return match[1].trim();
    }
  }
  return null;
}

// ── Search Queries (ported from Claude Funnel v3, organized by daily theme) ──

// R9: Tighter queries using site: operators, exact-phrase quotes, and negative filters.
// Target LinkedIn profiles directly ("site:linkedin.com/in"), exclude recruiter/hiring noise,
// and rely on structured tokens (quoted phrases) instead of keyword soup.
const NEG = '-"recruiter" -"hiring" -"we are hiring" -"join our team" -"looking for" -"open to work"';

const SEARCH_GROUPS = {
  monday: [
    { name: 'LinkedIn stealth Chicago', query: `site:linkedin.com/in "stealth" ("Chicago" OR "Evanston" OR "Oak Park" OR "Wicker Park") ("founder" OR "co-founder") ${NEG}` },
    { name: 'LinkedIn ex-SF moved Chicago', query: `site:linkedin.com/in ("formerly San Francisco" OR "formerly Bay Area" OR "moved to Chicago") "founder" ${NEG}` },
    { name: 'LinkedIn just left to build Chicago', query: `site:linkedin.com/in ("just left" OR "recently left") ("Chicago" OR "Illinois") "building" ${NEG}` },
    { name: 'LinkedIn YC Chicago founder', query: `site:linkedin.com/in ("Y Combinator" OR "YC W25" OR "YC S25" OR "YC W26") ("Chicago" OR "Evanston") "founder" ${NEG}` },
    { name: 'LinkedIn Techstars Chicago', query: `site:linkedin.com/in "Techstars" ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn SPC Chicago', query: `site:linkedin.com/in "South Park Commons" ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn On Deck Chicago', query: `site:linkedin.com/in ("On Deck" OR "ODF") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn pre-seed Chicago', query: `site:linkedin.com/in "pre-seed" ("Chicago" OR "Evanston") "founder" ${NEG}` },
  ],
  tuesday: [
    { name: 'LinkedIn ex-OpenAI Chicago', query: `site:linkedin.com/in ("ex-OpenAI" OR "formerly OpenAI") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn ex-Google Chicago', query: `site:linkedin.com/in ("ex-Google" OR "formerly Google" OR "previously Google") ("Chicago" OR "Evanston" OR "Oak Park") "founder" ${NEG}` },
    { name: 'LinkedIn ex-Stripe Chicago', query: `site:linkedin.com/in ("ex-Stripe" OR "formerly Stripe") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn ex-Meta Chicago', query: `site:linkedin.com/in ("ex-Meta" OR "formerly Meta" OR "formerly Facebook") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn ex-Anthropic Chicago', query: `site:linkedin.com/in ("ex-Anthropic" OR "formerly Anthropic") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn ex-Ramp/Brex Chicago', query: `site:linkedin.com/in ("ex-Ramp" OR "ex-Brex" OR "ex-Plaid") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn ex-Anduril Chicago', query: `site:linkedin.com/in ("ex-Anduril" OR "ex-Palantir" OR "ex-SpaceX") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn eng leader departed Chicago', query: `site:linkedin.com/in ("Head of Engineering" OR "VP Engineering") ("just left" OR "recently departed") ("Chicago" OR "Illinois") ${NEG}` },
  ],
  wednesday: [
    { name: 'LinkedIn AI founder Chicago', query: `site:linkedin.com/in ("AI founder" OR "ML founder") ("Chicago" OR "Illinois") ("stealth" OR "building") ${NEG}` },
    { name: 'LinkedIn LLM agent Chicago', query: `site:linkedin.com/in ("LLM" OR "AI agent") ("founder" OR "co-founder") ("Chicago" OR "Evanston") ${NEG}` },
    { name: 'LinkedIn PhD commercializing Chicago', query: `site:linkedin.com/in "PhD" ("commercializing" OR "spinout") ("Chicago" OR "UIUC" OR "University of Chicago") "founder" ${NEG}` },
    { name: 'LinkedIn Argonne Fermilab spinout', query: `site:linkedin.com/in ("Argonne National Laboratory" OR "Fermilab") ("founder" OR "spinout" OR "CEO") ${NEG}` },
    { name: 'LinkedIn UIUC research spinout', query: `site:linkedin.com/in "University of Illinois" ("PhD" OR "research scientist") "founder" "Chicago" ${NEG}` },
    { name: 'LinkedIn defense founder Chicago', query: `site:linkedin.com/in ("defense tech" OR "dual-use") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn climate founder Chicago', query: `site:linkedin.com/in ("climate tech" OR "clean energy") ("Chicago" OR "Illinois") ("founder" OR "stealth") ${NEG}` },
    { name: 'LinkedIn robotics Chicago', query: `site:linkedin.com/in ("robotics" OR "autonomy") ("founder" OR "CEO") ("Chicago" OR "Illinois") ${NEG}` },
  ],
  thursday: [
    { name: 'LinkedIn fintech founder Chicago', query: `site:linkedin.com/in ("fintech" OR "payments" OR "banking") ("Chicago" OR "Illinois") ("founder" OR "stealth") ${NEG}` },
    { name: 'LinkedIn ex-Citadel founder', query: `site:linkedin.com/in ("ex-Citadel" OR "ex-Jump Trading" OR "ex-DRW") ("founder" OR "stealth") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn healthtech Chicago', query: `site:linkedin.com/in ("healthtech" OR "digital health") ("Chicago" OR "Illinois") ("founder" OR "co-founder") ${NEG}` },
    { name: 'LinkedIn biotech Chicago', query: `site:linkedin.com/in ("biotech" OR "life sciences") ("Chicago" OR "Illinois") ("founder" OR "CEO") ${NEG}` },
    { name: 'LinkedIn vertical SaaS Chicago', query: `site:linkedin.com/in "vertical SaaS" ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn construction/logistics Chicago', query: `site:linkedin.com/in ("construction tech" OR "logistics tech" OR "supply chain") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn cybersec Chicago', query: `site:linkedin.com/in ("cybersecurity" OR "infosec") ("Chicago" OR "Illinois") ("founder" OR "stealth") ${NEG}` },
    { name: 'LinkedIn insurtech Chicago', query: `site:linkedin.com/in "insurtech" ("Chicago" OR "Illinois") "founder" ${NEG}` },
  ],
  friday: [
    { name: 'LinkedIn serial founder Chicago', query: `site:linkedin.com/in ("serial founder" OR "second-time founder" OR "repeat founder") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn post-exit building Chicago', query: `site:linkedin.com/in ("post-exit" OR "after acquisition" OR "previously exited") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn sold company Chicago', query: `site:linkedin.com/in ("sold my company" OR "acquired by") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn first engineer solo Chicago', query: `site:linkedin.com/in ("first engineer" OR "founding engineer") ("Chicago" OR "Illinois") ("starting" OR "founder") ${NEG}` },
    { name: 'LinkedIn staff eng exploring Chicago', query: `site:linkedin.com/in ("staff engineer" OR "principal engineer") ("exploring" OR "what's next") ("Chicago" OR "Illinois") ${NEG}` },
    { name: 'LinkedIn Kellogg/Booth founder', query: `site:linkedin.com/in ("Kellogg" OR "Chicago Booth") "founder" ("stealth" OR "building") ${NEG}` },
    { name: 'LinkedIn devtools OSS Chicago', query: `site:linkedin.com/in ("open source maintainer" OR "devtools") ("Chicago" OR "Illinois") "founder" ${NEG}` },
    { name: 'LinkedIn new venture Chicago', query: `site:linkedin.com/in ("new venture" OR "next chapter" OR "building something new") ("Chicago" OR "Illinois") ${NEG}` },
  ],
};

// Evergreen daily — tightest ICP signals, always run
const DAILY_STEALTH_QUERIES = [
  { name: 'LinkedIn stealth Chicago strict', query: `site:linkedin.com/in "stealth mode" ("Chicago" OR "Evanston" OR "Oak Park") "founder" ${NEG}` },
  { name: 'LinkedIn building something new Chicago', query: `site:linkedin.com/in "building something new" ("Chicago" OR "Illinois") ("founder" OR "co-founder") ${NEG}` },
  { name: 'LinkedIn just left Google Chicago', query: `site:linkedin.com/in "just left Google" ("Chicago" OR "Illinois") ${NEG}` },
  { name: 'LinkedIn just left Stripe Chicago', query: `site:linkedin.com/in "just left Stripe" ("Chicago" OR "Illinois") ${NEG}` },
  { name: 'LinkedIn just left OpenAI Chicago', query: `site:linkedin.com/in "just left OpenAI" ("Chicago" OR "Illinois") ${NEG}` },
  { name: 'LinkedIn UChicago founder stealth', query: `site:linkedin.com/in "University of Chicago" ("founder" OR "co-founder") ("stealth" OR "building") ${NEG}` },
  { name: 'LinkedIn Northwestern founder stealth', query: `site:linkedin.com/in "Northwestern" ("founder" OR "co-founder") ("stealth" OR "building") ${NEG}` },
  { name: 'LinkedIn UIUC founder stealth', query: `site:linkedin.com/in "University of Illinois" ("founder" OR "co-founder") ("stealth" OR "building") ${NEG}` },
  { name: 'LinkedIn Kellogg founder', query: `site:linkedin.com/in "Kellogg" ("founder" OR "co-founder") ("stealth" OR "building") ${NEG}` },
  { name: 'LinkedIn Booth founder', query: `site:linkedin.com/in "Chicago Booth" ("founder" OR "co-founder") ("stealth" OR "building") ${NEG}` },
  { name: 'LinkedIn pre-seed Chicago founder', query: `site:linkedin.com/in "pre-seed" ("Chicago" OR "Illinois") "founder" ${NEG}` },
  { name: 'LinkedIn repeat founder Chicago', query: `site:linkedin.com/in ("repeat founder" OR "second-time founder" OR "serial founder") ("Chicago" OR "Illinois") ${NEG}` },
  // ARCHETYPE-MATCHED — the founders Danny actually backs: technical people who RAISED
  // institutional capital recently for an ambitious (often AI-native) build, in Chicago.
  { name: 'LinkedIn raised pre-seed/seed Chicago', query: `site:linkedin.com/in ("raised" OR "backed by") ("pre-seed" OR "seed") ("Chicago" OR "Illinois") ("founder" OR "co-founder") ${NEG}` },
  { name: 'LinkedIn AI-native founder raised Chicago', query: `site:linkedin.com/in ("AI" OR "agents" OR "LLM") ("raised" OR "pre-seed" OR "seed") ("Chicago" OR "Illinois") ("founder" OR "building") ${NEG}` },
  { name: 'LinkedIn backed by Chicago funds', query: `site:linkedin.com/in ("backed by" OR "raised from") ("M25" OR "Hyde Park Angels" OR "Chicago Ventures" OR "Jump Capital" OR "Hyde Park Venture") "founder" ${NEG}` },
  { name: 'LinkedIn venture-backed founder Chicago', query: `site:linkedin.com/in ("venture-backed" OR "VC-backed" OR "raised from") ("Chicago" OR "Illinois") ("founder" OR "co-founder") "building" ${NEG}` },
];

// ELITE COHORT QUERIES — the inversion. Instead of scraping LinkedIn for "stealth
// Chicago founder" (high recall, low precision), start from authoritative proof of
// caliber — recent top-program cohorts and exited founders — and intersect with the
// target geography. Precision over recall: every hit already cleared an elite bar.
// {LOC} is replaced with a parenthesized OR of the user's target locations.
// Cohort queries draw from elite programs — which also have STAFF (partners, platform,
// talent, scouts). Exclude investor/team language so we get the founders, not the team.
const COHORT_NEG = `${NEG} -"partner" -"general partner" -"investor" -"venture" -"platform" -"talent" -"scout" -"portfolio" -"we backed" -"we invest" -"program manager"`;
const ELITE_COHORT_QUERY_TEMPLATES = [
  { name: 'Recent YC founder back home', query: `site:linkedin.com/in ("YC W25" OR "YC S25" OR "YC W26" OR "Y Combinator 2025" OR "Y Combinator 2026") ("founder" OR "co-founder") {LOC} ${COHORT_NEG}` },
  { name: 'a16z Speedrun founder', query: `site:linkedin.com/in ("a16z Speedrun" OR "Speedrun company") ("founder" OR "co-founder" OR "building") {LOC} ${COHORT_NEG}` },
  { name: 'Thiel Fellow building', query: `site:linkedin.com/in "Thiel Fellow" ("founder" OR "co-founder" OR "stealth") {LOC} ${COHORT_NEG}` },
  { name: 'Neo Scholar founder', query: `site:linkedin.com/in ("Neo Scholar" OR "Neo cohort") ("founder" OR "co-founder") {LOC} ${COHORT_NEG}` },
  { name: 'Exited founder building again', query: `site:linkedin.com/in ("previously exited" OR "sold my company" OR "second-time founder") ("founder" OR "co-founder" OR "building") {LOC} ${COHORT_NEG}` },
  { name: 'Ex-frontier-lab founder', query: `site:linkedin.com/in ("ex-OpenAI" OR "ex-Anthropic" OR "ex-DeepMind" OR "formerly OpenAI" OR "formerly Anthropic") ("founder" OR "co-founder" OR "stealth" OR "building") {LOC} ${COHORT_NEG}` },
  { name: 'Forbes 30u30 founder local', query: `site:linkedin.com/in ("Forbes 30 Under 30" OR "30 under 30") ("founder" OR "co-founder") {LOC} ${COHORT_NEG}` },
];

function buildEliteCohortQueries(locations) {
  const locs = (locations || []).filter(Boolean).slice(0, 6);
  const locClause = locs.length
    ? '(' + locs.map(l => `"${l}"`).join(' OR ') + ')'
    : '("Chicago" OR "Illinois" OR "Evanston")';
  return ELITE_COHORT_QUERY_TEMPLATES.map(q => ({
    name: q.name,
    query: q.query.replace('{LOC}', locClause),
    cohort: true,
  }));
}

function getTodaySearchGroup() {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = days[new Date().getDay()];
  // Weekend defaults to monday
  if (dayName === 'saturday' || dayName === 'sunday') return SEARCH_GROUPS.monday;
  return SEARCH_GROUPS[dayName] || SEARCH_GROUPS.monday;
}

// ── Exa AI Search ──

async function searchExa(query, numResults = 25, exaApiKey = null) {
  // Key is owner-resolved upstream (loadUserApiKeys). No env fallback here — that would
  // silently bill the platform Exa key for a non-owner whose resolved key is null.
  const apiKey = exaApiKey;
  if (!apiKey) return { results: [], error: 'No EXA_API_KEY configured' };

  try {
    const resp = await httpPost('https://api.exa.ai/search', {
      'x-api-key': apiKey,
    }, {
      query,
      type: 'auto',
      num_results: numResults,
      category: 'people',
      contents: { text: { max_characters: 8000 } },
    });

    if (resp.status !== 200) {
      return { results: [], error: `Exa HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}` };
    }

    return { results: resp.data.results || [] };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ── GitHub Search ──

async function searchGitHub(criteria, githubToken) {
  try {
    const token = githubToken; // owner-resolved upstream; no env fallback for non-owners
    const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Stu-Sourcing' };
    if (token) headers['Authorization'] = `token ${token}`;

    // Build queries dynamically from user's target locations
    const locations = (criteria.locations || []).length > 0 ? criteria.locations : ['Chicago'];
    const queries = [];
    for (const loc of locations.slice(0, 5)) {
      const encodedLoc = loc.includes(' ') ? `"${loc}"` : loc;
      queries.push(`location:${encodedLoc}+type:user+repos:>5+followers:>20`);
      queries.push(`location:${encodedLoc}+type:user+repos:>10+followers:>50`);
    }
    // Add language-specific queries for top 2 locations
    const topLocs = locations.slice(0, 2);
    for (const loc of topLocs) {
      const encodedLoc = loc.includes(' ') ? `"${loc}"` : loc;
      for (const lang of ['python', 'typescript', 'rust', 'go']) {
        queries.push(`location:${encodedLoc}+type:user+language:${lang}+followers:>15`);
      }
    }

    const allUsers = [];
    for (const q of queries.slice(0, 15)) {
      const resp = await httpGet(`https://api.github.com/search/users?q=${q}&sort=joined&order=desc&per_page=10`, headers);
      if (resp.status === 200 && resp.data.items) {
        allUsers.push(...resp.data.items);
      }
    }

    return allUsers.map(u => ({
      name: u.login,
      headline: `GitHub: ${u.login}${u.bio ? ' — ' + u.bio : ''}`,
      text: `GitHub user ${u.login}. ${u.bio || ''} Location: ${u.location || 'Unknown'}. Repos: ${u.public_repos || 0}. Followers: ${u.followers || 0}.`,
      url: u.html_url,
      linkedin_url: null,
      github_url: u.html_url,
      email: u.email || null,
      source: 'github',
    }));
  } catch (err) {
    console.error('[Sourcing][GitHub] Error:', err.message);
    return [];
  }
}

// ── EnrichLayer (LinkedIn enrichment for top scorers) ──

async function enrichWithLinkedIn(linkedinUrl, enrichlayerApiKey) {
  const apiKey = enrichlayerApiKey; // owner-resolved upstream; no env fallback for non-owners
  if (!apiKey || !linkedinUrl) return null;

  try {
    // EnrichLayer v2 (Proxycurl-compatible): Bearer auth, /api/v2/profile. The old /v1 + x-api-key
    // path 404s now — verified live 2026-07-01.
    const resp = await httpGet(
      `https://enrichlayer.com/api/v2/profile?url=${encodeURIComponent(linkedinUrl)}&use_cache=if-present`,
      { Authorization: `Bearer ${apiKey}` }
    );

    if (resp.status === 200 && resp.data) {
      return resp.data;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Claude Scoring ──

// R4: Extract-then-score prompt. Forces verbatim quotes as evidence, defaults to 5 when
// evidence is missing, surfaces red flags, and treats elite national schools as pedigree
// only (never as a standalone Chicago tie — R10).
const SCORING_PROMPT = `You are the deal sourcing analyst for Superior Studios, a Chicago-based PRE-SEED venture fund (~$10M Fund I). Every candidate shown to Danny must be a top-decile fit. False positives are more expensive than false negatives — err on the side of "pass" when evidence is thin.

Your job has two stages:
STAGE 1 — EXTRACT. For each scoring dimension, pull the *verbatim* quote from the profile text that justifies a claim. If no quote exists for a dimension, the evidence for that dimension is empty.
STAGE 2 — SCORE. Only score a dimension above 5 when you have a verbatim quote supporting it. If evidence is empty or ambiguous, default to 5. Do not extrapolate.

Who we want (the ICP):
- People who worked at TOP TECH COMPANIES with a Chicago presence in the last ~10 years
  (Google/Meta/Stripe/etc. Chicago offices, or Chicago-grown winners — Grubhub, Groupon,
  Braintree, Tempus, Avant, Sprout Social, Relativity, Cameo) who have now STARTED their own company
- Founders with YC / a16z Speedrun / ZFellows or strong coastal (SF/NYC) startup experience, now in/from IL
- Real engineers and top product leaders (founding/Staff+/VP eng or product) building something
- Stealth founders who just left a senior role; repeat founders in transition (post-exit/acquisition)
- High-pedigree operators with a VERIFIED Chicago/IL tie poised to start something

Hard disqualifiers (auto-score 1-3, set caliber C, add a red_flag, regardless of other signals):
- INVESTOR / VC. The person's primary identity is investing, not founding: general partner,
  managing partner, venture partner, investment partner, principal at a fund, angel investor,
  "I invest in / back / fund founders", scout, LP, or a platform/talent/community role at a VC
  or accelerator. Examples of who to REJECT: a partner at a fund, a solo-capitalist/angel, a
  "writer on venture" / VC blogger (e.g. someone whose profile is about investing, not building).
  ONLY treat them as a founder if the profile CLEARLY states they are CURRENTLY building their
  OWN startup (operator now, not "I advise/invest in startups"). When in doubt → investor → reject.
- Company has RAISED Series A or later
- Company has raised a large seed ($5M+)
- Candidate is a senior exec at an established co with NO departure signal
- Candidate is clearly a job-seeker or recruiter, not a builder
- Candidate is a student with a portfolio project and no commercial evidence
- Candidate is a service provider (consultant, agency, recruiter) not a founder

Location rules — CRITICAL:
- Tie categories in priority order: current Chicago/IL residence > Chicago-based work > Illinois school alumni (Northwestern/UChicago/UIUC/IIT/Kellogg/Booth/Loyola/DePaul) > hometown/raised in IL > worked at Chicago-HQ company (Grubhub/Groupon/Avant/Braintree/Tempus/Sprout/Cameo).
- National elite schools (Stanford, Harvard, MIT, Berkeley, CMU, Princeton, Yale, Columbia, Penn/Wharton, Cornell) are PEDIGREE MULTIPLIERS, not ties. Attending an elite national school without one of the above tie types = geography score 3-4, not 7+.
- The strongest combination is: elite national school + verified Chicago/IL tie + one of the four archetype signals. Flag it explicitly in rationale when you see it.

Recency rules — CRITICAL:
- "Just left" / "recently departed" is only a 9-10 stage signal if the departure was WITHIN 6 MONTHS. Estimate months-since-departure from the text.
- If the profile says "just left" but with no date, and no other freshness signals, assume 6+ months and score stage 5-6, not 9-10.
- Explicitly named recent dates (2025, 2026) count as fresh if within the last 6 months.

Stage & timing rubric (25% weight):
- 9-10: Stealth, departed top company <=3 months ago, no funding
- 7-8: Early (prototype/MVP), founded <12mo, pre-seed or small angel
- 5-6: Exploring, still employed, side-building
- 3-4: Has raised seed $2-4M
- 1-2: Series A+ or established

Founder caliber (35% weight):
- 9-10: Previously exited. Serial founder. Staff+/VP/Director at target companies (Google/Meta/Stripe/OpenAI/Anthropic/Ramp/Anduril/Scale/Databricks). YC/TechStars/SPC alum. PhD from elite school commercializing.
- 7-8: Staff+ at notable co. Elite institution grad. Exceptional domain depth.
- 5-6: Solid pro background. Good institution.
- 3-4: Junior or unclear.
- 1-2: No relevant experience.

Geography (25% weight): per tie-category priority above.

Sector fit (15% weight):
- Ideal: B2B SaaS, AI/ML, devtools, fintech, healthtech, defense/govtech, vertical software
- Good if exceptional: deep tech, climate, biotech
- Lower: consumer, social, crypto

CALIBER ASSESSMENT — answer this SEPARATELY from the fit score above:
The fit score answers "is this a real, fresh, Chicago-tied founder?" Caliber answers a DIFFERENT
question: "independent of geography, is this a best-of-best builder?" A founder can be a strong
local fit but only B-caliber, or S-caliber but stale. Do not let one bleed into the other.

CRITICAL — A CREDENTIAL IS NOT CALIBER. The bar is being too lenient: a brand-name employer or
school alone is being graded as best-of-best. It is not. What earns the top tiers is a proven OUTCOME
or evidence the founder is ACTIVELY BUILDING something real. "Ex-Google engineer" with no startup is
B, not A. "Ex-Google engineer who raised a pre-seed and is shipping" is A. Judge building EVIDENCE,
not pedigree. Equally: an exceptional builder with real traction deserves A or S with NO brand badge.

The single most telling builder signal for this fund is RAISED INSTITUTIONAL CAPITAL — a credible
investor committed (pre-seed/seed/Series, "backed by", named funds/accelerators). Weight it heavily.

S-TIER MUST MEAN IT. Reserve S for the rare, bona-fide unicorn-trajectory founder. Be stingy —
when unsure between S and A, choose A. S requires HARD, VERBATIM-QUOTED evidence of ONE of these:
  • A meaningful prior EXIT — their company was acquired or IPO'd (not a tiny acqui-hire).
  • A top-accelerator admit with their current OR a prior company — Y Combinator, a16z Speedrun,
    ZFellows, Neo, Thiel Fellowship (the marquee programs only).
  • A repeat / experienced founder whose PRIOR startup was notable or venture-backed, now building again.
  • A category-defining-company senior leader (founding/Staff+/VP at Google/Meta/Stripe/OpenAI/
    Anthropic/Ramp/Anduril/Scale/Databricks) now building, WITH real traction or top-fund backing.
A pedigree, an elite school, or a seed raise ALONE is NOT S. No quoted hard evidence → NOT S.

- S (9-10): the unicorn-caliber bar above, with a verbatim quote proving it.
- A (7-8): best-of-best builder. EITHER a proven outcome (prior exit; top-program admit; real
  traction — paying customers/revenue/meaningful users; shipped-and-scaled product; research/OSS
  eminence) — OR an elite background PAIRED WITH active building (raised institutional capital,
  shipping, traction). The technical founder building an ambitious, often AI-native product in a
  hard vertical, early-stage, usually with institutional backing — like Sid Sinha (Avant Health),
  Samuel Oh (Concorda), Ashtyn Bell (Gil), Jensen Coonradt (Crebit Pay) — is the heart of A.
- B (5-6): one real signal — raised institutional capital, early traction, elite-company background,
  a repeat founder, or serious technical work. Clearly building but pre-validation.
- C (1-4): a credential or elite school ALONE, or thin evidence — not enough to grade higher.

Only claim a caliber_signal you can support with a verbatim quote. Never invent an exit, program,
title, or traction number. If you cannot quote it, it does not count.

ACCURACY RULES — ZERO hallucination. These descriptions must be TRUE to THIS person's profile:
- Every pedigree_signal (school/employer) and the Chicago/IL tie MUST be explicitly stated in the
  profile text, and you MUST quote it verbatim. If you cannot copy the exact words from the text,
  DO NOT make the claim — omit it. A claim with no verbatim quote will be discarded anyway.
- NEVER infer a school or company from a city, a similar-sounding name, a publication, a club, an
  award, a partner/client, or "people also viewed" — e.g. "MIT Technology Review" ≠ MIT; living in
  a city ≠ attending its university; "Illinois" appearing somewhere ≠ Illinois Institute of Technology.
- If the profile does not clearly state where they studied or worked, leave those fields EMPTY.
- The Chicago/IL tie must be THIS person's own (they live/work/studied/grew up there or worked at a
  Chicago company). A mention of Chicago that isn't about them is NOT a tie — set tie_type "none".
- company_one_liner must describe what THIS person is actually building, drawn from the text. If the
  text doesn't say, use "Stealth" or "Unclear" — never invent a company, product, or sector.
- tags and builder_signals must reflect what the profile states, not what's plausible for the archetype.
- confidence_rationale must cite the specific evidence you used. If evidence is thin, say so and score low.

Return ONLY valid JSON in this exact shape:
{
  "evidence_map": {
    "tie_evidence": "<verbatim quote or empty string>",
    "tie_type": "<one of: current|working|school_alumni|hometown|chicago_company|none>",
    "caliber_evidence": "<verbatim quote or empty string>",
    "stage_evidence": "<verbatim quote or empty string>",
    "sector_evidence": "<verbatim quote or empty string>"
  },
  "departure_recency_months": <integer months since last role change, or null if unknown>,
  "anchor_schools_il": ["<IL schools attended, verbatim>"],
  "elite_schools_national": ["<national elite schools attended, verbatim>"],
  "red_flags": ["<concrete red flags: 'student, no commercial evidence', 'Series B company', 'recruiter, not builder', etc.>"],
  "caliber_tier": "<S|A|B|C — the unicorn-grade axis, independent of geography>",
  "caliber_score": <1-10 integer aligned to the tier band: S=9-10, A=7-8, B=5-6, C=1-4>,
  "caliber_signals": ["<hard, quote-backed caliber signals: 'Prior exit (acquired by X)', 'YC W25 alum', 'Ex-OpenAI Staff Eng', 'Repeat founder', 'PhD + cited research', etc.>"],
  "caliber_rationale": "<1-2 sentences: why this tier, citing the strongest caliber signal>",
  "confidence_score": <1-10 integer; default 5 if evidence is thin>,
  "confidence_rationale": "<2-3 sentences. Cite the verbatim evidence. If score is low, say WHY specifically. If score is high, explain which archetype + tie they match.>",
  "tags": ["<domain>", "<stage>", "<geography>", "<signal>"],
  "chicago_connection": "<one sentence; if no tie, write 'No verified tie'>",
  "pedigree_signals": ["<'Ex-Google Staff Eng', 'Northwestern Kellogg MBA', etc.>"],
  "builder_signals": ["<'Previous exit (acquired by X)', 'YC W24', etc.>"],
  "company_one_liner": "<what they're building, or 'Stealth' or 'Exploring' if unclear>"
}`;

function emptyScore(rationale) {
  return {
    scored: false, // verification did NOT run — caller must fail closed (never admit)
    confidence_score: 5,
    confidence_rationale: rationale,
    tags: [],
    chicago_connection: '',
    pedigree_signals: [],
    builder_signals: [],
    company_one_liner: '',
    evidence_map: {},
    departure_recency_months: null,
    anchor_schools_il: [],
    elite_schools_national: [],
    red_flags: [],
    caliber_tier: 'C',
    caliber_score: 3,
    caliber_signals: [],
    caliber_rationale: 'Not assessed — scoring unavailable.',
  };
}

async function scoreFounder(client, founder, scoringPrompt) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1536,
      system: scoringPrompt || SCORING_PROMPT,
      messages: [{
        role: 'user',
        content: `Score this founder candidate:\n\nName: ${founder.name}\nHeadline: ${founder.headline || 'N/A'}\nCompany: ${founder.company || 'Unknown'}\nLinkedIn: ${founder.linkedin_url || 'N/A'}\nGitHub: ${founder.github_url || 'N/A'}\nSource: ${founder.source}\nPre-extracted anchor IL schools: ${JSON.stringify(founder.anchor_schools_il || [])}\nPre-extracted elite national schools: ${JSON.stringify(founder.elite_schools_national || [])}\n\nProfile text:\n${(founder.text || '').slice(0, 4000)}`
      }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return emptyScore('Could not parse scoring response');
    const parsed = JSON.parse(jsonMatch[0]);

    // R3: normalize recency — clamp to valid range
    let recency = parsed.departure_recency_months;
    if (recency !== null && recency !== undefined) {
      recency = parseInt(recency);
      if (isNaN(recency) || recency < 0 || recency > 240) recency = null;
    } else {
      recency = null;
    }

    // R3: decay the score if "just left" claim is stale (>6 months without freshness)
    let score = parsed.confidence_score || 5;
    const rawScore = score;
    if (recency !== null && recency > 6 && score >= 8) {
      score = Math.max(5, score - 2);
    }

    const redFlags = parsed.red_flags || [];

    // CALIBER: reconcile the LLM's tier with the deterministic floor computed from
    // hard signals in the raw text. The LLM can nuance within its evidence, but it
    // cannot inflate to S-tier without a hard signal (exit / top program / senior
    // departure) actually being present.
    const eliteNational = parsed.elite_schools_national || founder.elite_schools_national || [];
    const det = computeCaliber(founder.text, founder.headline, eliteNational);
    let { tier: caliberTier, score: caliberScore } = reconcileCaliber(det, parsed.caliber_tier, parsed.caliber_score);
    const caliberSignals = [...new Set([...(det.signals || []), ...(parsed.caliber_signals || [])])];
    let caliberRationale = parsed.caliber_rationale || det.rationale;

    // ENFORCE red flags: a disqualifying flag clamps relevance to a pass (<=3) and
    // caps caliber at C, regardless of what the LLM scored. This was previously
    // captured and ignored.
    if (hasDisqualifyingFlag(redFlags)) {
      score = Math.min(3, score);
      caliberTier = 'C';
      caliberScore = Math.min(3, caliberScore);
      caliberRationale = `Red-flagged (${redFlags.join('; ')}). ` + caliberRationale;
    }

    return {
      scored: true, // verification ran successfully
      confidence_score: score,
      raw_confidence_score: rawScore,
      confidence_rationale: parsed.confidence_rationale || '',
      tags: parsed.tags || [],
      chicago_connection: parsed.chicago_connection || '',
      pedigree_signals: parsed.pedigree_signals || [],
      builder_signals: parsed.builder_signals || [],
      company_one_liner: parsed.company_one_liner || '',
      evidence_map: parsed.evidence_map || {},
      departure_recency_months: recency,
      anchor_schools_il: parsed.anchor_schools_il || [],
      elite_schools_national: eliteNational,
      red_flags: redFlags,
      caliber_tier: caliberTier,
      caliber_score: caliberScore,
      caliber_signals: caliberSignals,
      caliber_rationale: caliberRationale,
    };
  } catch (err) {
    return emptyScore('Scoring failed: ' + err.message);
  }
}

// ── Deduplication ──

// Dedup rules — once a person is in sourced_founders in ANY status, Scout never
// re-adds them.
//
// This changed because the old rule broke the one promise the Pass button makes.
// Danny: "If I pass on a founder and then hit Scout, a lot of times those passed-on
// founders show up again." He was right. The Pass button calls /dismiss, which set
// status='dismissed' with do_not_resurface=0 — and the old dedup let exactly those
// rows re-surface, on the theory that a plain Pass meant "maybe later." It doesn't.
// A Pass is Danny clearing the person off the board, and Scout re-adding them the
// next morning meant the inbox could never get cleaner: he'd re-triage the same
// people every run. The distinction between "pass" and "hide forever" was invented
// here, not by him, and it cost him exactly the noise the inbox exists to remove.
//
// So: any existing sourced_founders row for this identity blocks re-adding, whatever
// its status. dismissed (passed), starred, approved, pending — all already-seen, and
// a second copy is never what he wants. `do_not_resurface` no longer gates dedup;
// clearing a row for a deliberate re-look stays a manual action.
function isDuplicate(founder, userId) {
  const slug = linkedinSlug(founder.linkedin_url);
  if (slug) {
    const existing = db.prepare('SELECT id FROM founders WHERE LOWER(linkedin_url) LIKE ? AND created_by = ? AND is_deleted = 0').get(`%/in/${slug}%`, userId);
    if (existing) return true;
    const sourced = db.prepare('SELECT id FROM sourced_founders WHERE LOWER(linkedin_url) LIKE ? AND user_id = ?').get(`%/in/${slug}%`, userId);
    if (sourced) return true;
  }
  if (founder.email) {
    const existing = db.prepare('SELECT id FROM founders WHERE email = ? AND created_by = ? AND is_deleted = 0').get(founder.email, userId);
    if (existing) return true;
    const sourced = db.prepare('SELECT id FROM sourced_founders WHERE email = ? AND user_id = ?').get(founder.email, userId);
    if (sourced) return true;
  }
  // Name match. Block when company also matches OR either side has no company —
  // the same person often appears once "stealth" (no company) and once with one.
  if (founder.name) {
    const nm = normName(founder.name);
    if (nm.length >= 4) {
      const co = (founder.company || '').toLowerCase();
      const existing = db.prepare('SELECT company FROM founders WHERE LOWER(name) = LOWER(?) AND created_by = ? AND is_deleted = 0').all(founder.name, userId);
      if (existing.some(r => !r.company || !co || r.company.toLowerCase() === co)) return true;
      const sourced = db.prepare('SELECT company FROM sourced_founders WHERE LOWER(name) = LOWER(?) AND user_id = ?').all(founder.name, userId);
      if (sourced.some(r => !r.company || !co || r.company.toLowerCase() === co)) return true;
    }
  }
  return false;
}

// ── Slack Notification ──

async function notifySlack(message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await httpPost(webhookUrl, {}, { text: message });
  } catch (err) {
    console.error('[Sourcing][Slack] Failed:', err.message);
  }
}

// ── Main Engine ──

// Extra broad queries for full sweeps — potential founders, recent job changes, talent pool
const BROAD_TALENT_QUERIES = [
  { name: 'Staff eng Chicago leaving', query: 'staff engineer principal engineer Chicago Illinois leaving exploring founding starting 2025' },
  { name: 'VP product Chicago starting', query: 'VP product director product Chicago Illinois starting founding new company 2025 stealth' },
  { name: 'CTO Chicago new company', query: 'CTO chief technology officer Chicago Illinois starting new company stealth pre-seed' },
  { name: 'Technical founder Chicago pre-seed', query: 'technical founder Chicago Illinois pre-seed building new product MVP prototype 2025' },
  { name: 'Solo founder Chicago building', query: 'solo founder Chicago Illinois building new app product stealth bootstrapping pre-seed' },
  { name: 'First-time founder Chicago', query: 'first time founder Chicago Illinois building new startup 2024 2025 pre-seed stealth' },
  { name: 'PhD commercializing Chicago', query: 'PhD researcher commercializing starting company Chicago Illinois new startup deep tech' },
  { name: 'Ex-unicorn Chicago founder', query: 'left unicorn startup Chicago Illinois starting new company founder stealth pre-seed 2025' },
  { name: 'Acquired founder new co Chicago', query: 'acquired exited sold previous startup founder new company Chicago Illinois stealth 2025' },
  { name: 'Builder Chicago pre-launch', query: 'builder maker hacker Chicago Illinois pre-launch new product startup 2025 founder' },
  { name: 'Midwest stealth founder', query: 'stealth mode founder Midwest Illinois Indiana Wisconsin Iowa building new startup pre-seed' },
  { name: 'Chicago tech scene founder', query: 'Chicago tech startup scene founder building new company 2025 early stage pre-seed stealth' },
  { name: 'IL school alumni founding', query: 'Northwestern UChicago UIUC Illinois alumni founding starting new company stealth pre-seed 2025' },
  { name: 'Michigan alum Chicago founder', query: 'University of Michigan alumni Chicago Illinois founding starting stealth new company pre-seed' },
  { name: 'Stanford Harvard alum Chicago', query: 'Stanford Harvard MIT alumni Chicago Illinois starting founding stealth new company pre-seed' },
  { name: 'Immigrant founder Chicago', query: 'immigrant founder building Chicago Illinois new startup pre-seed stealth technical 2025' },
];

function getAllSearchQueries() {
  const all = [];
  for (const day of Object.values(SEARCH_GROUPS)) {
    all.push(...day);
  }
  all.push(...DAILY_STEALTH_QUERIES);
  all.push(...BROAD_TALENT_QUERIES);
  all.push(...buildEliteCohortQueries([]));
  return all;
}

// ── Per-user criteria loader ──

function loadUserCriteria(userId) {
  const keys = [
    'sourcing_locations', 'sourcing_schools', 'sourcing_companies',
    'sourcing_builder_signals', 'sourcing_domains', 'sourcing_stage_filter',
    'sourcing_custom_queries',
  ];
  const rows = db.prepare(
    `SELECT setting_key, setting_value FROM user_settings WHERE user_id = ? AND setting_key IN (${keys.map(() => '?').join(',')})`
  ).all(userId, ...keys);

  const userMap = {};
  for (const row of rows) userMap[row.setting_key] = row.setting_value;

  function parse(val, fallback) {
    if (val === undefined || val === null) return fallback;
    try { return JSON.parse(val); } catch { return val; }
  }

  // Respect user selections — empty arrays mean "no preference", not "use defaults"
  return {
    locations: parse(userMap.sourcing_locations, []),
    schools: parse(userMap.sourcing_schools, []),
    companies: parse(userMap.sourcing_companies, []),
    builderSignals: parse(userMap.sourcing_builder_signals, []),
    domains: parse(userMap.sourcing_domains, []),
    stageFilter: parse(userMap.sourcing_stage_filter, 'Any'),
    customQueries: parse(userMap.sourcing_custom_queries, []),
  };
}

function buildUserSearchQueries(criteria, fullSweep) {
  const locs = criteria.locations.slice(0, 5);
  const companies = criteria.companies.slice(0, 8);
  const schools = criteria.schools.slice(0, 5);
  const domains = criteria.domains.slice(0, 6);
  const stage = criteria.stageFilter || 'Any';
  const hasLocs = locs.length > 0;
  const stageStr = stage === 'Any' ? '' : stage;

  const queries = [];

  if (hasLocs) {
    // Location-specific stealth founder queries
    for (const loc of locs.slice(0, 3)) {
      queries.push({ name: `Stealth founder ${loc}`, query: `stealth mode founder ${loc} building something new just left 2025 2026` });
      queries.push({ name: `LinkedIn stealth ${loc}`, query: `site:linkedin.com/in "stealth" "${loc}" founder building` });
      queries.push({ name: `Building new ${loc}`, query: `site:linkedin.com/in "building something new" ${loc} founder engineer` });
    }
  } else {
    // Broad stealth founder queries (no location filter)
    queries.push({ name: 'Stealth founder broad', query: `stealth mode founder building something new just left 2025 2026 startup` });
    queries.push({ name: 'LinkedIn stealth broad', query: `site:linkedin.com/in "stealth" founder building startup 2025` });
    queries.push({ name: 'Building new broad', query: `site:linkedin.com/in "building something new" founder engineer startup` });
  }

  // Ex-company queries
  const locSuffix = hasLocs ? ` ${locs[0]}` : '';
  for (const co of companies.slice(0, 5)) {
    queries.push({ name: `Ex-${co} stealth`, query: `left ${co} stealth new startup${locSuffix} founder ${stageStr} 2025`.trim() });
  }

  // School alumni queries
  for (const school of schools.slice(0, 3)) {
    queries.push({ name: `${school} founder stealth`, query: `site:linkedin.com/in "${school}" founder stealth building startup${locSuffix}`.trim() });
  }

  // Domain queries
  for (const domain of domains.slice(0, 4)) {
    queries.push({ name: `${domain} stealth`, query: `${domain} stealth founder${locSuffix} new startup ${stageStr} 2025`.trim() });
  }

  // Generic high-signal queries
  queries.push({ name: 'Serial founder stealth', query: `serial founder exited previous company building new startup${locSuffix} stealth ${stageStr} 2025`.trim() });
  if (stageStr) {
    queries.push({ name: `${stageStr} founders`, query: `site:linkedin.com/in "${stageStr}" founder building startup${locSuffix}`.trim() });
  }
  queries.push({ name: 'YC alum new', query: `Y Combinator YC alumni starting new company${locSuffix} stealth exploring`.trim() });
  queries.push({ name: 'Just quit to build', query: `just quit left job to start build company${locSuffix} founder stealth 2025 2026`.trim() });

  // Custom queries from user
  for (const cq of (criteria.customQueries || [])) {
    if (cq.query) queries.push({ name: cq.name || 'Custom query', query: cq.query });
  }

  // ELITE COHORT — always run these high-precision authoritative-list queries,
  // even in daily mode. They are the highest-yield-per-call source of S/A caliber.
  const cohortQueries = buildEliteCohortQueries(criteria.locations);

  if (!fullSweep) return [...cohortQueries, ...queries.slice(0, 20)];
  return [...cohortQueries, ...queries];
}

// R4: User-customized prompt reuses the base SCORING_PROMPT's extract-then-score
// structure and output schema. Only the criteria preface differs.
function buildUserScoringPrompt(criteria) {
  const locations = (criteria.locations || []).join(', ') || 'Chicago, Illinois';
  const schools = (criteria.schools || []).join(', ') || 'Northwestern, UChicago, UIUC, IIT, Kellogg, Booth, Loyola, DePaul';
  const companies = (criteria.companies || []).join(', ') || 'Google, Meta, Stripe, OpenAI, Anthropic, Ramp, Anduril, Scale, Databricks';
  const domains = (criteria.domains || []).join(', ') || 'B2B SaaS, AI/ML, devtools, fintech, healthtech, defense, vertical software';
  const stage = criteria.stageFilter || 'Pre-seed';

  const preface = `Criteria for this run:
- Target stage: ${stage}
- Target locations (tie-qualifying): ${locations}
- Target local-anchor schools (tie + pedigree): ${schools}
- Target pedigree-qualifying companies: ${companies}
- Target sectors: ${domains}

`;
  return preface + SCORING_PROMPT;
}

// ── User API Key Loader ──

// Delegated to the central resolver so the owner-gated env fallback + decryption
// live in exactly one place. See server/lib/providerKeys.js.
function loadUserApiKeys(userId) {
  return require('../lib/providerKeys').loadUserApiKeys(userId);
}

async function runSourcingEngine({ fullSweep = false, userId = 1 } = {}) {
  console.log(`[Sourcing] Starting sourcing run for user ${userId}... (mode: ${fullSweep ? 'FULL SWEEP' : 'daily rotation'})`);

  // Load user-specific criteria and API keys
  const criteria = loadUserCriteria(userId);
  // A Chicago/IL tie is non-negotiable for this fund. If the user hasn't set target
  // locations/schools, default to Chicago/IL so the tie check NEVER falls back to
  // "everyone passes" (which was letting in talented founders with no local tie).
  if (!criteria.locations || criteria.locations.length === 0) {
    criteria.locations = ['chicago', 'illinois', 'evanston', 'naperville', 'oak park', 'champaign', 'urbana'];
  }
  if (!criteria.schools || criteria.schools.length === 0) {
    criteria.schools = ILLINOIS_SCHOOLS.slice();
  }
  const apiKeys = loadUserApiKeys(userId);

  // Require at minimum an Exa key to run sourcing
  if (!apiKeys.exa) {
    console.log(`[Sourcing] User ${userId} has no Exa API key configured — skipping sourcing run`);
    return { totalFound: 0, totalAdded: 0, totalDeduped: 0, totalFiltered: 0, errors: [{ source: 'config', error: 'No Exa API key configured. Add your API key in Settings.' }] };
  }

  console.log(`[Sourcing] User ${userId} criteria: ${criteria.locations.length} locations, ${criteria.schools.length} schools, ${criteria.companies.length} companies, ${criteria.domains.length} domains`);
  console.log(`[Sourcing] User ${userId} API keys: Exa=${apiKeys.exa ? 'yes' : 'no'}, Anthropic=${apiKeys.anthropic ? 'yes' : 'no'}, Enrich=${apiKeys.enrichlayer ? 'yes' : 'no'}, GitHub=${apiKeys.github ? 'yes' : 'no'}`);

  const run = db.prepare('INSERT INTO sourcing_runs (sources_hit, user_id) VALUES (?, ?)').run(JSON.stringify([]), userId);
  const runId = run.lastInsertRowid;

  const sourcesHit = [];
  const errors = [];
  let totalFound = 0;
  let totalAdded = 0;
  let totalDeduped = 0;
  let totalFiltered = 0;

  // ── Phase 1: Exa AI searches ──
  // Build search queries from user criteria
  const searchGroup = buildUserSearchQueries(criteria, fullSweep);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  console.log(`[Sourcing] Today is ${dayName} — running ${searchGroup.length} Exa queries for user ${userId}${fullSweep ? ' (FULL SWEEP)' : ' (daily)'}`);

  const exaCandidates = [];

  const resultsPerQuery = fullSweep ? 50 : 25;

  for (const search of searchGroup) {
    console.log(`[Sourcing][Exa] ${search.name}...`);
    require('../lib/providerKeys').recordCost(userId, { provider: 'exa', feature: 'sourcing', estCostUsd: 0.005 });
    const { results, error } = await searchExa(search.query, resultsPerQuery, apiKeys.exa);

    if (error) {
      console.error(`[Sourcing][Exa] ${search.name} error: ${error}`);
      errors.push({ source: 'exa', query: search.name, error });
      continue;
    }

    sourcesHit.push(`exa:${search.name}`);
    let verified = 0;

    for (const result of results) {
      const headline = result.title || '';
      // Strip contamination BEFORE any verification/scoring so a "People also viewed"
      // section can never lend its school/company/tie to this person.
      const text = cleanProfileText(result.text || '');
      const url = result.url || '';

      // Only interested in LinkedIn profiles or personal pages
      const isLinkedIn = url.includes('linkedin.com/in/');

      // Extract name from headline (before | or — or -)
      let name = headline.split(/[|·—\-]/)[0].trim();
      if (name.length > 60) name = name.slice(0, 60);
      // NAME GATE: must look like a real person, not an article/company headline.
      if (!isPlausiblePersonName(name)) {
        totalFiltered++;
        continue;
      }

      // Verify location connection using user's target locations (on cleaned text)
      const il = verifyLocation(text, headline, criteria);
      if (!il.verified) {
        totalFiltered++;
        continue;
      }

      verified++;

      const company = extractCompanyInfo(text, headline);
      const signals = extractSignals(text, headline);

      exaCandidates.push({
        name,
        company,
        headline: headline.slice(0, 500),
        text: text.slice(0, 8000),
        linkedin_url: isLinkedIn ? url : null,
        email: null,
        github_url: null,
        source: 'exa',
        search_query: search.name,
        location_city: il.location,
        location_type: il.type,
        pedigree_signals: signals.pedigree,
        builder_signals: signals.builder,
        anchor_schools_il: signals.anchor_schools_il || [],
        elite_schools_national: signals.elite_schools_national || [],
      });
    }

    console.log(`[Sourcing][Exa] ${search.name}: ${results.length} results → ${verified} location-verified`);
    totalFound += results.length;
  }

  // ── Phase 2: GitHub search ──
  console.log('[Sourcing][GitHub] Searching...');
  const githubResults = await searchGitHub(criteria, apiKeys.github);
  console.log(`[Sourcing][GitHub] Found ${githubResults.length} users`);
  sourcesHit.push('github');
  totalFound += githubResults.length;

  // Process GitHub results through IL verification
  for (const gh of githubResults) {
    const il = verifyLocation(gh.text, gh.headline, criteria);
    if (il.verified) {
      exaCandidates.push({
        ...gh,
        location_city: il.location,
        location_type: il.type,
        pedigree_signals: [],
        builder_signals: ['Active GitHub'],
        search_query: 'github',
      });
    }
  }

  // ── Phase 3: Dedup across all candidates ──
  console.log(`[Sourcing] Deduplicating ${exaCandidates.length} IL-verified candidates...`);

  // Dedup within this batch first (by LinkedIn URL)
  const seen = new Set();
  const uniqueCandidates = [];
  for (const c of exaCandidates) {
    // Prefer the LinkedIn slug as the identity key; fall back to the normalized
    // NAME ALONE (not name+company) so the same person doesn't slip through twice
    // when one hit has a company and another doesn't.
    const slug = linkedinSlug(c.linkedin_url);
    const key = slug ? `li:${slug}` : `nm:${normName(c.name)}`;
    if (seen.has(key)) {
      totalDeduped++;
      continue;
    }
    seen.add(key);

    if (isDuplicate(c, userId)) {
      totalDeduped++;
      continue;
    }
    uniqueCandidates.push(c);
  }

  console.log(`[Sourcing] ${uniqueCandidates.length} unique, new candidates to score`);

  // ── Phase 4: Claude scoring ──
  // Metered + billed to the run's owner (apiKeys.anthropic is already owner-resolved).
  const anthropic = require('../lib/providerKeys').meteredClient(apiKeys.anthropic, userId, 'sourcing');
  // LEARNING LOOP: build Danny's taste profile from his approve/star/dismiss history
  // and feed it into the scoring prompt. Affinity (computed per candidate below) then
  // nudges ranking among already-qualified founders.
  const { computeTasteProfile, scoreAffinity } = require('./taste');
  const taste = computeTasteProfile(userId);
  const userScoringPrompt = buildUserScoringPrompt(criteria) + (taste.promptText || '');
  if (taste.promptText) console.log(`[Sourcing] Learning from ${taste.likedN} approvals / ${taste.passedN} passes`);

  const insertStmt = db.prepare(`
    INSERT INTO sourced_founders (
      name, company, role, linkedin_url, email, source,
      confidence_score, confidence_rationale, raw_data,
      headline, location_city, location_type, chicago_connection,
      tags, search_query, company_one_liner,
      pedigree_signals, builder_signals, github_url, website_url,
      user_id,
      departure_recency_months, signal_captured_at,
      anchor_schools_il, elite_schools_national,
      evidence_map, red_flags,
      caliber_tier, caliber_score, caliber_rationale, caliber_signals,
      affinity_score, affinity_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const candidate of uniqueCandidates) {
    // TIE GATE: a verified Chicago/IL tie is mandatory. Intake verification sets a
    // tie type (current/working/school_alumni/hometown/chicago_company); anything
    // else (e.g. 'broad') means no real local tie — drop it.
    if (!VALID_TIE_TYPES.includes(candidate.location_type)) {
      console.log(`[Sourcing] 🚫 ${candidate.name} — no verified Chicago/IL tie (${candidate.location_type || 'none'})`);
      totalFiltered++;
      continue;
    }

    // Founder gate: only real founders/builders — drop investors, fund/accelerator
    // staff, recruiters, and non-founder operators before spending a Claude call.
    const gate = founderGate(candidate.text, candidate.headline);
    if (!gate.ok) {
      console.log(`[Sourcing] 🚫 ${candidate.name} — not a founder: ${gate.reason}`);
      totalFiltered++;
      continue;
    }

    // Pre-filter: skip founders who are obviously too far along (saves Claude API calls)
    const stageCheck = isTooFarAlong(candidate.text, candidate.headline);
    if (stageCheck.disqualified) {
      console.log(`[Sourcing] ⏭️ ${candidate.name} — skipped: ${stageCheck.reason}`);
      totalFiltered++;
      continue;
    }

    // FAIL CLOSED: a founder is admitted ONLY when AI verification actually ran and
    // confirmed they're a founder with a real IL tie and caliber. Without the LLM (no key
    // or an API error like an exhausted credit balance), the crude keyword layer alone
    // would admit VCs/bloggers with false ties (e.g. Mark Suster) — so we SKIP instead.
    if (!anthropic) {
      console.log(`[Sourcing] ⏭️ ${candidate.name} — skipped: AI scoring unavailable (no Anthropic key)`);
      totalFiltered++;
      continue;
    }
    const score = await scoreFounder(anthropic, candidate, userScoringPrompt);
    if (!score.scored) {
      console.log(`[Sourcing] ⏭️ ${candidate.name} — skipped: not verified (${score.confidence_rationale})`);
      totalFiltered++;
      continue;
    }

    // Merge extracted signals with AI signals, then verify pedigree against the actual
    // profile text so no inaccurate "Ex-X"/school tag is ever stored. Schools are verified
    // the SAME way (every distinctive token must appear), so a hallucinated "MIT" / "Illinois
    // Institute of Technology" that isn't in the profile is dropped, not displayed as fact.
    const verifyText = (candidate.headline || '') + ' ' + (candidate.text || '');
    const allPedigree = verifyPedigree([...new Set([...(candidate.pedigree_signals || []), ...(score.pedigree_signals || [])])], verifyText);
    const allBuilder = [...new Set([...(candidate.builder_signals || []), ...(score.builder_signals || [])])];
    const allAnchorIl = verifyPedigree([...new Set([...(candidate.anchor_schools_il || []), ...(score.anchor_schools_il || [])])], verifyText);
    const allEliteNational = verifyPedigree([...new Set([...(candidate.elite_schools_national || []), ...(score.elite_schools_national || [])])], verifyText);

    // ANTI-HALLUCINATION TIE GATE: if this founder's only tie is being an IL-school alum but
    // that school didn't survive verification (not actually in the profile), the tie is fake —
    // drop it so they're filtered out. Prevents "from MIT & IIT" inventing a Chicago tie.
    if (candidate.location_type === 'school_alumni' && allAnchorIl.length === 0) {
      console.log(`[Sourcing] 🚫 ${candidate.name} — school-based tie unverified (claimed school not in profile)`);
      totalFiltered++;
      continue;
    }

    // Affinity to Danny's revealed taste (re-rank nudge, not an override).
    const aff = scoreAffinity({
      tags: JSON.stringify(score.tags || []),
      pedigree_signals: JSON.stringify(allPedigree),
      builder_signals: JSON.stringify(allBuilder),
      caliber_signals: JSON.stringify(score.caliber_signals || []),
      location_type: candidate.location_type,
      caliber_tier: score.caliber_tier,
    }, taste.weights);
    const affinityReason = aff.hits.length ? `Matches your taste: ${aff.hits.join(', ')}` : null;

    try {
      insertStmt.run(
        candidate.name,
        candidate.company || null,
        'Founder',
        candidate.linkedin_url || null,
        candidate.email || null,
        candidate.source,
        score.confidence_score,
        score.confidence_rationale,
        JSON.stringify({ headline: candidate.headline, text: (candidate.text || '').slice(0, 2000) }),
        candidate.headline || null,
        candidate.location_city || null,
        candidate.location_type || null,
        score.chicago_connection || candidate.location_city || null,
        JSON.stringify(score.tags || []),
        candidate.search_query || null,
        score.company_one_liner || null,
        JSON.stringify(allPedigree),
        JSON.stringify(allBuilder),
        candidate.github_url || null,
        null,
        userId,
        score.departure_recency_months,
        JSON.stringify(allAnchorIl),
        JSON.stringify(allEliteNational),
        JSON.stringify(score.evidence_map || {}),
        JSON.stringify(score.red_flags || []),
        score.caliber_tier || 'C',
        score.caliber_score != null ? score.caliber_score : 3,
        score.caliber_rationale || null,
        JSON.stringify(score.caliber_signals || []),
        aff.affinity,
        affinityReason
      );
      totalAdded++;

      const tierEmoji = { S: '💎', A: '🔥', B: '✅', C: '📝' }[score.caliber_tier || 'C'] || '📝';
      console.log(`[Sourcing] ${tierEmoji} ${candidate.name} (${candidate.company || 'stealth'}) → fit ${score.confidence_score}/10 · caliber ${score.caliber_tier || 'C'}${score.caliber_score ? ` (${score.caliber_score})` : ''} [${candidate.location_type}:${candidate.location_city}]`);
    } catch (err) {
      console.error(`[Sourcing] Insert error for ${candidate.name}: ${err.message}`);
      errors.push({ source: candidate.source, name: candidate.name, error: err.message });
    }
  }

  // ── Phase 5: EnrichLayer for top scorers ──
  if (apiKeys.enrichlayer) {
    const topScorers = db.prepare(
      "SELECT id, linkedin_url FROM sourced_founders WHERE status = 'pending' AND user_id = ? AND confidence_score >= 8 AND linkedin_url IS NOT NULL AND enriched_data IS NULL ORDER BY confidence_score DESC LIMIT 5"
    ).all(userId);

    if (topScorers.length > 0) {
      console.log(`[Sourcing][Enrich] Enriching ${topScorers.length} top scorers...`);
      for (const s of topScorers) {
        const data = await enrichWithLinkedIn(s.linkedin_url, apiKeys.enrichlayer);
        if (data) {
          db.prepare('UPDATE sourced_founders SET enriched_data = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(data), s.id, userId);
          console.log(`[Sourcing][Enrich] Enriched ${s.linkedin_url}`);
        }
        // Rate limit: 800ms between requests
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  // ── Phase 5.5: Co-founder pair detection (R5) ──
  try {
    const { detectPairs } = require('./pair-detector');
    const pairStats = detectPairs({ userId, windowDays: 90 });
    if (pairStats.pairsFound > 0) {
      console.log(`[Sourcing][Pairs] ${pairStats.pairsFound} pair(s), ${pairStats.rowsBumped} row(s) bumped`);
      sourcesHit.push(`pairs:${pairStats.pairsFound}`);
    }
  } catch (err) {
    console.error('[Sourcing][Pairs] Error:', err.message);
    errors.push({ source: 'pair-detector', error: err.message });
  }

  // ── Phase 5.6: GitHub activity depth (R8) for top scorers ──
  try {
    const { scoreGithubActivity } = require('./github-activity');
    await scoreGithubActivity({ userId, githubToken: apiKeys.github, limit: 10 });
  } catch (err) {
    console.error('[Sourcing][GH-Activity] Error:', err.message);
    errors.push({ source: 'github-activity', error: err.message });
  }

  // ── Phase 5.7: Score the new arrivals ──
  // The inbox reads a STORED verdict (lib/fitIndex), so a founder inserted here
  // without one would render as "didn't qualify" — indistinguishable from a real
  // rejection, and wrong. Scoring here closes that window inside the same run that
  // opened it. Cheap and self-limiting: only rows with no verdict match.
  try {
    const f = require('../lib/fitIndex').rescoreStale({ userId });
    if (f.scored) console.log(`[Sourcing] Scored ${f.scored} new arrival(s) against the founder rubric`);
  } catch (err) {
    console.error('[Sourcing][Fit] scoring failed (rows still saved):', err.message);
    errors.push({ source: 'fit-index', error: err.message });
  }

  // ── Phase 6: Update run log ──
  db.prepare('UPDATE sourcing_runs SET sources_hit = ?, founders_found = ?, founders_added = ?, founders_deduplicated = ?, errors = ? WHERE id = ?').run(
    JSON.stringify(sourcesHit), totalFound, totalAdded, totalDeduped, JSON.stringify(errors), runId
  );

  // ── Phase 7: Slack notification ──
  const topPick = db.prepare("SELECT name, company, confidence_score, chicago_connection FROM sourced_founders WHERE status = 'pending' AND user_id = ? ORDER BY confidence_score DESC, created_at DESC LIMIT 1").get(userId);
  const pendingCount = db.prepare("SELECT COUNT(*) as c FROM sourced_founders WHERE status = 'pending' AND user_id = ?").get(userId).c;

  const slackMsg = `*Stu Sourcing Run Complete* (${dayName})\n` +
    `${totalAdded} new founders added · ${totalDeduped} duplicates filtered · ${totalFiltered} location-filtered\n` +
    `${pendingCount} total pending review\n` +
    (topPick ? `Top pick: *${topPick.name}*${topPick.company ? ` (${topPick.company})` : ''} — Score: ${topPick.confidence_score}/10${topPick.chicago_connection ? ` · ${topPick.chicago_connection}` : ''}` : 'No new founders found');

  await notifySlack(slackMsg);

  console.log(`[Sourcing] ✅ Complete: ${totalFound} found → ${totalAdded} added, ${totalDeduped} deduped, ${totalFiltered} filtered, ${errors.length} errors`);
  return { totalFound, totalAdded, totalDeduped, totalFiltered, errors };
}

module.exports = {
  runSourcingEngine,
  enrichWithLinkedIn,
  // Exported for testing/reuse
  detectCaliberSignals,
  computeCaliber,
  reconcileCaliber,
  hasDisqualifyingFlag,
  buildEliteCohortQueries,
  founderGate,
  normName,
  linkedinSlug,
  VALID_TIE_TYPES,
  extractSignals,
  verifyPedigree,
  verifyLocation,
  verifyIllinois,
  isTooFarAlong,
  cleanProfileText,
  isPlausiblePersonName,
  verbatimIn,
  verifyTieEvidence,
  loadUserCriteria,
};
