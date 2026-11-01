// ══════════════════════════════════════════════════════════════════════════
// ilTie.js — the canonical "does this person have an Illinois tie?" verifier.
//
// Danny, 2026-07-15: "Tie to Illinois is important to me. Either they're from
// Chicago or Illinois, worked here for some time, went to school here in some
// way, etc."
//
// And from the fund thesis: geography is the moat. "'Best of the best' = the best
// we can be FIRST to, not the best in the world." Every other filter in this
// product can be soft. This one decides whether a name belongs on the board.
//
// ── WHY THIS FILE EXISTS ──
// The tie was previously derived from `criteria.schools` — the user's own Sourcing
// Criteria setting. That setting merges two different ideas into one list, and on
// 2026-07-15 Danny's held 48 schools: 12 Illinois and 36 national elite. So
// verifyLocation() read "Stanford" out of a list labelled "schools" and returned
//   { verified: true, type: 'school_alumni', location: 'Stanford' }
// which the queue gate accepted, because that gate checks the tie TYPE is
// canonical and the evidence text is non-empty — never that the evidence names
// anywhere in Illinois. Result: 55 of 85 founders on the IL-tied board were
// Stanford / Yale / CMU / Wharton / USC alumni with no Illinois connection at all.
//
// The engine had already been fixed for this once — sourcing-engine.js:224 says
// "Elite-school-only path intentionally removed... National elite schools are
// pedigree, not location ties." The code was right and the config walked it back.
// So the lesson is that a tie must not be configurable. An Illinois tie is a fact
// about Illinois. Pedigree is a separate axis and belongs in the caliber score,
// where "Stanford" is a legitimate and useful signal.
//
// ── DESIGN ──
//   · Every tie carries EVIDENCE — the literal phrase that established it. A tie
//     you can't read the reason for is a tie Danny can't overrule, and the whole
//     failure above was invisible precisely because nobody could see "Stanford"
//     sitting in a field called chicago_connection.
//   · False positives are the enemy, not false negatives. A missed founder costs
//     one name; a board that lies costs the board. When in doubt: no tie.
//   · No LLM. This is a fact lookup and the model already hallucinated it once.
// ══════════════════════════════════════════════════════════════════════════

// ── Illinois places ──
// Cities/neighborhoods that are unambiguously in Illinois. Ordered longest-first
// at match time so "oak park" wins over "park".
// Places whose NAME is unambiguous — the string can only mean the Illinois place.
const IL_PLACES = [
  'chicago', 'chicagoland', 'evanston', 'naperville', 'joliet', 'rockford',
  'schaumburg', 'skokie', 'oak park', 'des plaines',
  'arlington heights', 'mount prospect', 'buffalo grove', 'northbrook', 'glenview',
  'highland park', 'lake forest', 'winnetka', 'wilmette', 'deerfield', 'hinsdale',
  'oak brook', 'downers grove', 'elmhurst', 'wheaton', 'lombard', 'lisle',
  'bolingbrook', 'orland park', 'tinley park', 'oak lawn', 'evergreen park',
  'urbana', 'carbondale', 'dekalb', 'rock island', 'moline',
  // Chicago neighborhoods — a founder writing these is telling you where they live.
  'wicker park', 'lincoln park', 'river north', 'west loop', 'south loop',
  'the loop', 'pilsen', 'logan square', 'hyde park', 'bucktown', 'ravenswood',
  'lakeview', 'old town', 'gold coast', 'fulton market', 'bridgeport', 'uptown',
];

// ══════════════════════════════════════════════════════════════════════
// Places whose name is ALSO an ordinary English word, a person's name, or a city
// in another state. These NEVER establish a tie on the bare name — they require
// an explicit Illinois qualifier ("Normal, IL", "Aurora, Illinois").
//
// This list is not hypothetical. On 2026-07-15, running the a16z Speedrun
// connector for the first time, this gate verified:
//
//   Benjamin Lee — Vega — New York — bio "cto @ vega / BEING SO NORMAL"
//     -> { verified: true, type: 'worked', place: 'Normal' }
//
// because Normal, Illinois is a real city and \bnormal\b matched inside "BEING SO
// NORMAL". That is the exact failure this whole file exists to prevent, produced
// by the file itself. A word-boundary match is not enough when the word is a word.
//
// Springfield is here for a different reason: it exists in ~34 states, and the
// Illinois one is the least likely to be meant by an unqualified mention.
// ══════════════════════════════════════════════════════════════════════
const IL_PLACES_AMBIGUOUS = [
  'normal',       // "being so normal"
  'aurora',       // a person's name, aurora borealis, and cities in CO/OH/ON
  'cicero',       // the Roman
  'palatine',     // the Roman hill / the adjective
  'quincy',       // a name; also Quincy, MA
  'champaign',    // reads as champagne; harmless but weak alone
  'berwyn',       // also Berwyn, PA
  'peoria',       // also Peoria, AZ
  'decatur',      // also Decatur, GA — a big one
  'bloomington',  // also Bloomington, IN and MN
  'springfield',  // ~34 states
];

// An ambiguous place counts only when Illinois is named right next to it.
function ambiguousPlaceTie(text) {
  for (const place of IL_PLACES_AMBIGUOUS) {
    const qualified = new RegExp(`\\b${esc(place)}\\s*,?\\s*(il|illinois)\\b`, 'i');
    const m = text.match(qualified);
    if (m) return { place, matched: m[0] };
  }
  return null;
}

// ── Illinois schools ──
// EVERY entry here must be unambiguously an Illinois institution. The bar is:
// could this string match a school in another state? If yes, it needs qualifying.
// See IL_SCHOOL_TRAPS below for the ones that bit.
const IL_SCHOOLS = [
  'university of illinois', 'uiuc', 'u of i', 'illinois urbana', 'urbana-champaign',
  'university of illinois chicago', 'uic', 'university of illinois springfield',
  'illinois institute of technology', 'illinois tech',
  'northwestern university', 'northwestern engineering', 'northwestern mccormick',
  'kellogg school', 'kellogg school of management',
  'university of chicago', 'uchicago', 'chicago booth', 'booth school',
  'pritzker school', 'harris school of public policy',
  'loyola university chicago', 'loyola chicago',
  'depaul university', 'depaul',
  'illinois state university', 'southern illinois university',
  'northern illinois university', 'eastern illinois university',
  'western illinois university',
  'columbia college chicago', 'school of the art institute of chicago', 'saic chicago',
  'rush university', 'rosalind franklin', 'bradley university', 'knox college',
  'wheaton college illinois', 'lake forest college', 'augustana college illinois',
  'north central college', 'elmhurst university', 'roosevelt university',
  'chicago state university', 'governors state university',
  'illinois wesleyan', 'monmouth college illinois', 'principia college',
  'argonne', 'fermilab', 'fermi national accelerator',
];

// ── The traps. Each of these LOOKS Illinois and is not. ──
// Every one is a real false positive this gate has to survive.
const IL_SCHOOL_TRAPS = [
  // "IIT" is overwhelmingly the Indian Institutes of Technology, and the YC
  // directory is full of their graduates. Bare "iit" must NEVER establish a tie;
  // only the spelled-out Illinois Institute of Technology counts (above).
  /\biit\s+(bombay|delhi|madras|kanpur|kharagpur|roorkee|guwahati|hyderabad|bhu|indore|patna|ropar|gandhinagar|jodhpur|mandi|varanasi)\b/i,
  /\bindian institute of technology\b/i,
  // Northwestern Mutual is a Milwaukee insurer. Northwestern Polytechnic is CA.
  // Northwestern State is Louisiana. Only the University is Illinois.
  /\bnorthwestern mutual\b/i,
  /\bnorthwestern polytechnic\b/i,
  /\bnorthwestern state\b/i,
  // Loyola has campuses in Maryland, New Orleans, and Los Angeles (Marymount).
  // Only "Loyola Chicago" / "Loyola University Chicago" is Illinois — handled by
  // requiring the qualifier in IL_SCHOOLS, but strip the others explicitly.
  /\bloyola marymount\b/i,
  /\bloyola university maryland\b/i,
  /\bloyola university new orleans\b/i,
  // Columbia University is New York; Columbia College Chicago is Illinois.
  /\bcolumbia university\b/i,
  // Wheaton College also exists in Massachusetts.
  /\bwheaton college,?\s+(massachusetts|ma)\b/i,
  // Augustana also exists in South Dakota.
  /\baugustana university\b/i,
];

// ── Chicago-anchored employers ──
// "Worked here for some time" — a job at one of these IS time spent in Illinois.
// Deliberately conservative: only firms whose center of gravity is Chicago, so a
// satellite-office employee is a false positive we accept losing.
const IL_COMPANIES = [
  'citadel', 'citadel securities', 'drw', 'drw trading', 'jump trading',
  'peak6', 'optiver chicago', 'belvedere trading', 'akuna capital', 'imc chicago',
  'groupon', 'grubhub', 'tempus', 'tempus ai', 'avant', 'braintree', 'enova',
  'morningstar', 'motorola solutions', 'motorola mobility', 'abbott laboratories',
  'abbvie', 'caterpillar', 'john deere', 'deere & company', 'allstate', 'state farm',
  'mcdonald\'s corporation', 'united airlines', 'boeing chicago', 'archer daniels midland',
  'cdw', 'sprout social', 'showpad chicago', 'g2', 'g2 crowd', 'shipbob', 'project44',
  'cameo', 'catalytic', 'sprocket', 'vivid seats', 'kin insurance', 'clearcover',
  'm1 finance', 'amount', 'nuveen', 'northern trust', 'discover financial',
  'walgreens', 'us foods', 'conagra', 'mondelez', 'kraft heinz chicago',
  'aon', 'mccormick place', 'exelon', 'commonwealth edison', 'salesforce chicago',
  'google chicago', 'meta chicago', 'relativity', 'yello', 'paylocity', 'paycor chicago',
  'oak street health', 'villagemd', 'zoro', 'grainger', 'w.w. grainger',
  '1871', 'mhub', 'p33', 'polsky center', 'techstars chicago', 'gener8tor chicago',
  'matter chicago', 'blue1647', 'chicago booth accelerator',
];

// ── False geography. Strings that name Chicago but mean nothing about location. ──
// The sourcing-gate test suite calls this out with "Chicago Bears superfan in SF",
// and it is a real shape: sports allegiance travels, people don't.
const FALSE_GEO = [
  /\bchicago (bears|bulls|cubs|white sox|blackhawks|fire|sky|red stars)\b/i,
  /\bchicago[- ]style\b/i,
  /\bchicago (pizza|dog|hot dog|deep dish)\b/i,
  /\bchicago manual of style\b/i,
  /\bthe chicago (tribune|sun-times)\b/i, // reading it isn't living there
  /\bchicago typewriter\b/i,
  /\buniversity of illinois press\b/i,
  /\bchicago pile\b/i,
  /\bbook of mormon chicago\b/i,
  /\bhamilton chicago\b/i,
  /\bchicago (the )?musical\b/i,
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word-boundary match. Stops "normal" matching "normally", "aurora" matching
// "auroral", and "g2" matching "g20".
const word = (term) => new RegExp(`\\b${esc(term)}\\b`, 'i');

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Strip phrases that name Illinois without meaning it, BEFORE any matching.
 * Returns the cleaned text plus what was removed, so a rejection is explainable.
 */
function stripFalseGeo(text) {
  let out = normalize(text);
  const stripped = [];
  for (const p of FALSE_GEO) {
    const m = out.match(p);
    if (m) { stripped.push(m[0]); out = out.replace(p, ' '); }
  }
  return { text: out, stripped };
}

/** Pull the sentence-ish window around a match, so evidence is readable. */
function evidenceAround(text, match, span = 60) {
  const i = text.toLowerCase().indexOf(String(match).toLowerCase());
  if (i < 0) return match;
  const start = Math.max(0, i - span);
  const end = Math.min(text.length, i + match.length + span);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * The gate. Returns:
 *   { verified: true,  type, place, evidence, matched }
 *   { verified: false, reason, stripped? }
 *
 * `type` is one of Danny's own four:
 *   current  — lives/based in Illinois now
 *   worked   — held a job in Illinois, or at a Chicago-anchored company
 *   school   — attended an Illinois school
 *   hometown — from / grew up in Illinois
 *
 * Order matters: strongest evidence of ACTUAL PRESENCE first. A founder who lives
 * in Chicago and went to Stanford is "current", not "no tie".
 */
function verifyIlTie(rawText) {
  const raw = normalize(rawText);
  if (!raw) return { verified: false, reason: 'no profile text to check' };

  const { text, stripped } = stripFalseGeo(raw);

  // Traps first. If the only Illinois-looking string is IIT Bombay, we must not
  // fall through into a loose match on "illinois".
  for (const trap of IL_SCHOOL_TRAPS) {
    const m = text.match(trap);
    if (m) {
      // Remove the trap and keep checking — a person can be both an IIT Bombay
      // grad AND live in Chicago, and that person has a real tie.
      return verifyIlTieOn(text.replace(trap, ' '), raw, stripped, m[0]);
    }
  }
  return verifyIlTieOn(text, raw, stripped, null);
}

function verifyIlTieOn(text, raw, stripped, trapRemoved) {
  const no = (reason) => ({
    verified: false,
    reason,
    ...(stripped.length ? { stripped } : {}),
    ...(trapRemoved ? { trap_removed: trapRemoved } : {}),
  });
  const yes = (type, place, matched, extra = {}) => ({
    verified: true, type, place, matched, evidence: evidenceAround(raw, matched),
    strength: TIE_STRENGTH[type], ...extra,
  });

  // ══════════════════════════════════════════════════════════════════════
  // THE HIERARCHY (2026-11 sourcing inspection). Danny's order, strongest first:
  //
  //   1. current  — lives in Illinois NOW
  //   2. school / hometown — FROM Illinois, or went to school here (equal rank)
  //   3. worked   — held a job in Illinois / at a Chicago-anchored employer
  //   4. cofounder — borrowed from a co-founder (propagateCofounderTies)
  //
  // The checks used to run current > worked > school > hometown, and "current"
  // fired on ANY "<word>, IL" — including a past job line ("Previously PM at
  // Motorola, Schaumburg, IL"). So a former employee who now lives in Austin
  // carried the strongest tie on the board, and "worked" outranked "went to
  // UIUC". Both are fixed here; `strength` makes the order machine-readable so
  // the ranking (lib/founderFit) can use it instead of treating every tie alike.
  // ══════════════════════════════════════════════════════════════════════

  // ── (1) CURRENT — lives/based in Illinois ──
  // Explicit state suffix is the strongest single signal a profile can carry —
  // UNLESS the clause it sits in is plainly about the past ("previously … at
  // Motorola, Schaumburg, IL"). Then it is evidence of a job here, not a home.
  const stateSuffix = /\b([a-z][a-z .'-]{2,28}?),\s*(il|illinois)\b/gi;
  let pastSuffix = null;
  let ms;
  while ((ms = stateSuffix.exec(text))) {
    if (PAST_CLAUSE.test(clauseBefore(text, ms.index))) { if (!pastSuffix) pastSuffix = ms; continue; }
    return yes('current', cityOf(ms[1]), ms[0]);
  }

  for (const place of [...IL_PLACES].sort((a, b) => b.length - a.length)) {
    // `(the )?` is load-bearing: Chicago neighborhoods take an article in ordinary
    // speech — "based out of the West Loop", "living in the Loop" — and dropping
    // it silently rejected people who told you exactly where they live.
    const patterns = [
      new RegExp(`\\b(based|living|live|located|headquartered|hq)\\s+(in|out of)\\s+(the\\s+)?${esc(place)}\\b`, 'i'),
      new RegExp(`\\bgreater\\s+${esc(place)}\\s+(area|metro)\\b`, 'i'),
      new RegExp(`\\b${esc(place)}\\s+(metropolitan area|metro area|area)\\b`, 'i'),
      new RegExp(`\\b(moved|relocated|moving)\\s+(back\\s+)?(to\\s+)?(the\\s+)?${esc(place)}\\b`, 'i'),
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return yes('current', titleCase(place), m[0]);
    }
  }

  // An ambiguous place, but explicitly qualified as Illinois ("Normal, IL").
  // Same past-clause rule as the state suffix above.
  const amb = ambiguousPlaceTie(text);
  if (amb && !PAST_CLAUSE.test(clauseBefore(text, text.indexOf(amb.matched)))) {
    return yes('current', titleCase(amb.place), amb.matched);
  }

  // ── (2a) SCHOOL — attended an Illinois school ──
  // "went to school here in some way" — Danny's words, so a bootcamp, a masters,
  // or an accelerator at an IL institution all count.
  for (const school of [...IL_SCHOOLS].sort((a, b) => b.length - a.length)) {
    const m = text.match(word(school));
    if (m) return yes('school', titleCase(school), m[0]);
  }

  // ── (2b) HOMETOWN — from / grew up in Illinois ──
  for (const place of [...IL_PLACES].sort((a, b) => b.length - a.length)) {
    const home = new RegExp(
      `\\b(from|grew up in|born in|raised in|native of|hometown[:\\s]+)\\s*${esc(place)}\\b`,
      'i'
    );
    const native = new RegExp(`\\b${esc(place)}\\s+(native|born|raised)\\b`, 'i');
    const m = text.match(home) || text.match(native);
    if (m) return yes('hometown', titleCase(place), m[0]);
  }

  // ── (3) WORKED — a job held in Illinois ──
  for (const place of [...IL_PLACES].sort((a, b) => b.length - a.length)) {
    // A role and an Illinois place inside one clause. The 40-char window is tight
    // on purpose: "CTO at Foo. Previously advised a Chicago nonprofit" should not
    // read as a Chicago job.
    const role = new RegExp(
      `\\b(founder|co-?founder|ceo|cto|coo|cfo|engineer|swe|pm|head of|vp of|director of|partner|analyst|associate|intern)\\b[^.;|]{0,40}\\b${esc(place)}\\b`,
      'i'
    );
    const m = text.match(role);
    if (m) return yes('worked', titleCase(place), m[0]);
  }

  for (const co of [...IL_COMPANIES].sort((a, b) => b.length - a.length)) {
    const m = text.match(word(co));
    if (!m) continue;
    // Employer names that are ALSO ordinary words ("amount", "avant-garde",
    // "catalytic", "cameo appearance") need an employment cue right in front.
    // Bare "the amount of …" was establishing a Chicago work tie.
    if (AMBIGUOUS_IL_COMPANIES.has(co) && !EMPLOYMENT_CUE.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    return yes('worked', titleCase(co), m[0]);
  }

  if (pastSuffix) return yes('worked', cityOf(pastSuffix[1]), pastSuffix[0]);

  // Bare "illinois" anywhere, as a last resort, but ONLY as a state reference and
  // never off the back of a stripped trap. This used to be typed `current` —
  // the STRONGEST tie — for a profile that merely contains the word ("customers
  // in Illinois"). It is a mention: verified so it can be read, ranked last.
  const bare = text.match(/\billinois\b/i);
  if (bare && !trapRemoved) {
    return yes('mention', 'Illinois', bare[0], { weak: true });
  }

  return no(
    trapRemoved
      ? `the only Illinois-looking string was "${trapRemoved}", which is not Illinois`
      : 'no Illinois place, employer, school, or hometown found'
  );
}

// The clause in front of a match — back to the last sentence/bullet break. Used
// to ask "is this ', IL' about a past job?"
function clauseBefore(text, idx) {
  const before = String(text).slice(0, Math.max(0, idx));
  const cut = Math.max(before.lastIndexOf('.'), before.lastIndexOf('•'), before.lastIndexOf('|'),
    before.lastIndexOf(';'), before.lastIndexOf('\n'));
  return before.slice(cut + 1).slice(-90);
}
const PAST_CLAUSE = /\b(previously|formerly|former|ex-|prior(ly)?|used to|was (a|an|at|the)|worked (at|for)|spent \d+|interned|alumn|graduated|studied|(19|20)\d{2}\s*[-–]\s*(19|20)\d{2})\b/i;
const EMPLOYMENT_CUE = /\b(at|@|ex-?|former(ly)?|joined|worked (at|for)|engineer|pm|manager|director|lead|analyst)\s*$/i;
// IL_COMPANIES entries that collide with ordinary English or other entities.
const AMBIGUOUS_IL_COMPANIES = new Set(['amount', 'avant', 'catalytic', 'sprocket', 'zoro', 'yello', 'aon', 'g2', 'cameo', 'relativity', 'discover financial', 'amount', 'enova', 'citadel']);

// Machine-readable rank of a tie type, strongest first. Covers BOTH vocabularies
// in the database: this file's (current/school/hometown/worked/cofounder/mention)
// and the Exa sweep's legacy one (working/school_alumni/chicago_company).
const TIE_STRENGTH = {
  current: 4,
  school: 3, hometown: 3, school_alumni: 3,
  worked: 2, working: 2, chicago_company: 2,
  cofounder: 1,
  mention: 0,
};
function tieStrength(type) {
  const s = TIE_STRENGTH[String(type || '').toLowerCase()];
  return s == null ? null : s;
}

// "Based in Chicago, IL" → the regex captures "Based in Chicago", because it
// matches at the earliest position it can. The place is what's left once the
// leading preposition is gone; without this the board reads "current: Based IN
// Chicago", and evidence that looks broken doesn't get trusted.
function cityOf(captured) {
  // Only the last clause: "Staff engineer. Based in Chicago" → "Based in Chicago"
  // (the capture class allows '.' for "St. Charles", so it can run across a sentence).
  const lastClause = String(captured).split(/(?<!\b(?:St|Mt|Ft))\.\s+|[•|;]\s+/).pop();
  const cleaned = String(lastClause)
    .trim()
    .replace(/^(?:i'?m\s+)?(?:currently\s+)?(?:based|living|lives|live|located|headquartered|hq|working|from|now)\s+(?:in|out of|at)\s+/i, '')
    .replace(/^(?:in|at|from|near|the)\s+/i, '')
    .trim();
  return titleCase(cleaned || captured);
}

// Only genuine two-letter abbreviations get shouted. The old rule uppercased ANY
// short word, which turned "in" into "IN" — the Indiana state code, on a gate
// whose entire job is telling Illinois from everywhere else.
const UPPER_TOKENS = new Set(['il', 'us', 'usa', 'uic', 'iit', 'ai', 'vc']);
function titleCase(s) {
  return String(s)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      UPPER_TOKENS.has(w.toLowerCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(' ');
}

/** Build the text to check from a sourced_founders / founders shaped row. */
function profileText(p) {
  const loc = [p.location_city, p.location_state].filter(Boolean).join(', ');
  return [
    loc ? `Based in ${loc}.` : '',
    p.headline, p.bio, p.role, p.company, p.company_one_liner,
    p.notable_background, p.previous_companies,
    // NOT p.chicago_connection — that's the field this gate WRITES. Reading it back
    // in would let a bad tie from a previous run re-verify itself forever, which is
    // exactly how "school_alumni: Stanford" would survive a re-partition.
  ]
    .filter(Boolean)
    .join(' • ');
}

// ══════════════════════════════════════════════════════════════════════════
// Co-founder ties.
//
// A company is Illinois-tied if a founder is. Measured on the real inbox: 13
// people across 10 companies have no personal Illinois evidence while a
// co-founder does — and the list settles the question by itself:
//
//   perspectives health   tied: Eshan Dosani (UChicago)  | untied: Kyle Jung
//
// Perspectives Health is in Danny's PORTFOLIO. Dropping its CTO for having a
// terse YC bio would be exactly as wrong as keeping a Stanford alum in Palo Alto.
// Same for Rise Reforming, LegalOS, Axis, Wafer, G LNK.
//
// But this is precisely the move that caused the original bug — the old system
// gave Matthew Asir his co-founder's UChicago tie and showed it as if it were
// his own. So the rule is: propagate, but NEVER launder. A co-founder tie gets
// its own type and evidence that names the person it came from, so Danny can
// read it, sort it, and throw it out. A derived tie that looks identical to a
// direct one is a lie with extra steps.
// ══════════════════════════════════════════════════════════════════════════

// Company names that identify nothing. "Stealth" is 8 unrelated rows in the live
// inbox — grouping on it would hand one person's tie to seven strangers.
const GENERIC_COMPANY = /^(stealth|stealth mode|unknown|n\/?a|none|tbd|confidential|undisclosed|new startup|building)$/i;

function companyKey(row) {
  const c = String(row.company || '').trim();
  if (!c || c.length < 2 || GENERIC_COMPANY.test(c)) return null;
  return c.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|llc|corp|co)$/i, '').trim();
}

/**
 * Given rows and their direct verdicts, lend each untied person the strongest
 * verified tie held by a co-founder at the same (non-generic) company.
 *
 * @param rows      array of sourced_founders-shaped records
 * @param verdictOf (row) => verifyIlTie result
 * @returns Map<rowId, verdict>  — direct verdicts untouched; derived ones added.
 */
function propagateCofounderTies(rows, verdictOf) {
  const out = new Map();
  const groups = new Map();

  for (const r of rows) {
    const v = verdictOf(r);
    out.set(r.id, v);
    const k = companyKey(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // Presence beats pedigree here too: someone who LIVES in Illinois is a better
  // anchor for their company than someone who once went to school here.
  const strength = TIE_STRENGTH;

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const anchors = members
      .map((m) => ({ m, v: out.get(m.id) }))
      .filter((x) => x.v.verified && !x.v.derived && !x.v.weak)
      .sort((a, b) => (strength[b.v.type] || 0) - (strength[a.v.type] || 0));
    if (!anchors.length) continue;
    const best = anchors[0];

    for (const m of members) {
      const v = out.get(m.id);
      if (v.verified) continue;
      out.set(m.id, {
        verified: true,
        type: 'cofounder',
        derived: true, // never renders as a direct tie
        place: best.v.place,
        via: best.m.name,
        via_type: best.v.type,
        matched: best.v.matched,
        // The evidence names the borrowing. Danny reads this and knows instantly
        // that the tie is the company's, not the person's.
        evidence: `via co-founder ${best.m.name} at ${m.company} — ${best.v.type}: ${best.v.place}`,
      });
    }
  }

  return out;
}

module.exports = {
  verifyIlTie,
  propagateCofounderTies,
  companyKey,
  profileText,
  stripFalseGeo,
  IL_PLACES,
  IL_SCHOOLS,
  IL_COMPANIES,
  IL_SCHOOL_TRAPS,
  FALSE_GEO,
  TIE_STRENGTH,
  tieStrength,
};
