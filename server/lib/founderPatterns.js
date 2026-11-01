'use strict';
// ══════════════════════════════════════════════════════════════════════════
// founderPatterns — the five judgment patterns, as structured, quote-backed fields.
//
// Source: an analysis of 242 founder biographies (founderprofiles.ai) found five
// patterns recurring in exceptional founders more than any others:
//
//   1. persistence  — a failure, firing, or collapse they kept building through
//   2. lived_problem — a problem personally lived, usually after years inside the
//                      industry later disrupted
//   3. self_taught  — the core skill learned outside formal schooling, often young
//   4. frontline    — support, deliveries, installs, customer interviews, done
//                      personally
//   5. trusted_complement — a co-founder from a long-trusted circle, or one mentor
//                      who opened a decisive door
//
// These are SURVIVOR patterns: they were read off people who already won, so they
// carry survivorship bias, and Stu's own ledger is too thin to show whether any of
// them predicts a meeting for this investor (docs/sourcing-inspection.md, Part 3).
// So they are RECORDED and SHOWN, and they do not move the ranking. They exist so
// the investor can see them at triage and so the ledger can test them over time.
//
// THE RULE: a field is filled only when the record itself says so, with a verbatim
// quote. A silent record leaves the field null. Nothing here infers a pattern from
// a plausible story — "ex-nurse building health software" is NOT lived_problem
// unless the text says she lived the problem; that inference belongs to the
// founder-market-fit marker, which reads structured employment, not prose.
// ══════════════════════════════════════════════════════════════════════════

const PATTERN_KEYS = ['persistence', 'lived_problem', 'self_taught', 'frontline', 'trusted_complement'];

// Each detector: a list of regexes over the founder's OWN prose. First hit wins and
// its matched text is the quote. Kept deliberately literal — recall is sacrificed
// for the guarantee that a filled field is true to the record.
const DETECTORS = {
  persistence: [
    /\b(after|despite|following) (my|our|the) (first|previous|last|prior) (startup|company|venture) (failed|shut down|folded|collapsed|didn'?t work)\b[^.]{0,60}/i,
    /\b(my|our) (first|previous|last|prior) (startup|company|venture) (failed|shut down|folded|collapsed)\b[^.]{0,60}/i,
    /\b(shut (it )?down|wound down|failed) (my|our|the) (first|previous|last) (startup|company)\b[^.]{0,60}/i,
    /\b(i was|got) (fired|laid off|let go)\b[^.]{0,80}\b(start(ed)?|found(ed)?|build|built|launch(ed)?)\b/i,
    /\b(pivoted|pivot(ing)?) (\d+|two|three|four|several) times\b/i,
    /\b(bootstrapp?ed|kept building|kept going) (through|after|despite)\b[^.]{0,60}/i,
    /\b(survived|came back from|rebuilt after) (bankruptcy|a failed|near[- ]death|running out of (money|cash))\b[^.]{0,40}/i,
  ],
  lived_problem: [
    /\b(i|we) (lived|experienced|faced|saw) (this|the|that) (problem|pain|issue)( first[- ]?hand)?\b[^.]{0,60}/i,
    /\b(first[- ]?hand|personally) (experienced|saw|watched|lived)\b[^.]{0,80}/i,
    /\bafter (\d+|two|three|four|five|six|seven|eight|nine|ten|a decade|years) (years )?(as an? |in |at |working (in|as) )[^.]{3,60}\b(i|we) (started|founded|built|decided|set out)\b[^.]{0,40}/i,
    /\b(frustrated|fed up) (with|by) [^.]{3,60} (as an? |while working (as|at|in) )[^.]{3,40}/i,
    /\bbuilt (it|this|the (tool|product|software)) (i|we) wished (i|we) had\b[^.]{0,40}/i,
  ],
  self_taught: [
    /\bself[- ]taught\b[^.]{0,50}/i,
    /\btaught (myself|himself|herself|themselves) (to (code|program|build)|how to (code|program|build)|programming|coding|engineering)\b[^.]{0,40}/i,
    /\b(started|began) (coding|programming|building (apps|software|websites|games)) (at|when i was) (age )?(\d{1,2}|ten|eleven|twelve|thirteen|fourteen|fifteen)\b[^.]{0,30}/i,
    /\b(wrote|built|shipped|sold) (my|his|her) first (app|program|game|website|software|company) at (age )?(\d{1,2})\b[^.]{0,30}/i,
    /\b(dropped out of|left) (college|school|university|high school|stanford|harvard|mit|[a-z]+ university) to (build|start|found|work on)\b[^.]{0,40}/i,
  ],
  frontline: [
    /\b(personally|myself) (did|handled|ran|answered|made|drove|delivered|installed|onboarded|sold)\b[^.]{0,60}/i,
    /\b(talked|spoke) (to|with) (\d{2,}|over \d+|hundreds of|dozens of) (customers|users|operators|nurses|doctors|drivers|merchants|farmers|teachers|contractors|founders|engineers)\b[^.]{0,40}/i,
    /\b(\d{2,}|hundreds of|dozens of) (customer|user|discovery) (interviews|calls|conversations)\b[^.]{0,40}/i,
    /\b(did|doing|ran) (all|every|our) (customer support|support tickets|sales calls|deliveries|installs|installations|onboarding)( myself| personally)?\b[^.]{0,40}/i,
    /\b(founder[- ]led sales|door[- ]to[- ]door|cold[- ]called|worked the (counter|floor|line|register))\b[^.]{0,40}/i,
  ],
  trusted_complement: [
    /\b(co-?founders?( is| are)?|co-?founded [^.]{0,30} with) (my|a|our) (childhood friend|best friend|college roommate|roommate|brother|sister|twin|cousin|wife|husband|spouse|longtime friend|friend of \d+ years)\b[^.]{0,30}/i,
    /\b(my|a) (childhood friend|best friend|college roommate|roommate|brother|sister|twin|longtime friend|former (colleague|teammate|manager)|old (colleague|teammate|boss))[^.]{0,30}\b(co-?found|co-?founder|started|built)\b[^.]{0,30}/i,
    /\b(we'?ve|we have|who i'?ve) (known each other|worked together|been friends) (for|since) (\d+|over \d+|a decade|years|college|high school|childhood)\b[^.]{0,30}/i,
    /\b(worked together|met) (at|while at) [A-Z][\w&.\- ]{1,30} (for \d+ years|before (starting|founding|co-founding))\b[^.]{0,30}/i,
    /\b(mentor|mentored by)\b[^.]{0,40}\b(introduced (me|us)|opened (the|a) door|first (check|customer|investor|hire)|vouched for)\b[^.]{0,30}/i,
  ],
};

// A pattern describing an investee, a client, or the person's portfolio is not THEIR
// pattern. Checked over the matched sentence only.
const VETO = /\b(we (back|invest in|fund)|our portfolio|portfolio compan|i invest|investor in|my clients?|our clients?|help(ing)? founders)\b/i;

function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the five patterns from a block of the founder's own text.
 * Returns { persistence: {quote}|null, ..., count }. Never fills a field without a
 * verbatim quote that is present in `text`.
 */
function extractPatterns(text) {
  const t = String(text || '').replace(/https?:\/\/\S+/gi, ' ');
  const out = {};
  let count = 0;
  for (const key of PATTERN_KEYS) {
    out[key] = null;
    for (const re of DETECTORS[key]) {
      const m = t.match(re);
      if (!m) continue;
      const quote = m[0].replace(/\s+/g, ' ').trim();
      // Sentence-level veto (investor/client framing).
      const start = Math.max(0, (m.index || 0) - 80);
      if (VETO.test(t.slice(start, (m.index || 0) + m[0].length))) continue;
      // The receipt has to be real — belt and braces against a regex that could
      // match across normalisation boundaries.
      if (!normText(t).includes(normText(quote))) continue;
      out[key] = { quote: quote.slice(0, 200) };
      count++;
      break;
    }
  }
  out.count = count;
  return out;
}

const PATTERN_LABELS = {
  persistence: 'Kept building through a failure',
  lived_problem: 'Lived the problem',
  self_taught: 'Self-taught builder',
  frontline: 'Does the frontline work',
  trusted_complement: 'Trusted co-founder / door-opening mentor',
};

/** Labels for the filled fields, for the "why" line. */
function patternLabels(p) {
  if (!p) return [];
  return PATTERN_KEYS.filter((k) => p[k]).map((k) => PATTERN_LABELS[k]);
}

module.exports = { extractPatterns, patternLabels, PATTERN_KEYS, PATTERN_LABELS };
