/**
 * Quote verification — the assessment trust layer.
 * ================================================
 * Agents are instructed to surface DIRECT quotes as evidence. A reader seeing
 * "closed 4 customers in 6 weeks" has no way to know whether that is verbatim from
 * a transcript or an LLM confabulation. This module checks every quote against the
 * source context — deterministically, with no extra LLM call — and tags it:
 *
 *   verbatim    — found word-for-word (after whitespace/punctuation normalization)
 *   paraphrased — the quote's content words appear in the source IN THE SAME ORDER
 *   unverified  — not found; treat as a potential hallucination
 *
 * Verification NEVER changes a score. It only annotates, so the human can trust
 * (or distrust) the evidence behind a number.
 *
 * ── Why `paraphrased` was rewritten ──
 * The original check asked "do 80% of the quote's content words appear ANYWHERE in
 * the corpus?" against a Set built from up to 150,000 characters. At that size the
 * answer is almost always yes: three or four common words will each appear somewhere
 * in a long transcript by coincidence. So `paraphrased` was very close to a
 * guaranteed pass — and it renders in the UI as a reassuring amber "≈ Paraphrased".
 *
 * Concretely: "we closed four customers" and "we lost four customers" BOTH passed,
 * because {closed|lost, four, customers} all appear somewhere. The badge was
 * certifying the opposite of what it claimed.
 *
 * The fix is adjacency. A real paraphrase preserves local word order; a coincidental
 * word-salad match does not. We now score the fraction of the quote's consecutive
 * content-word BIGRAMS that appear in the source's bigram set. "closed four" is not
 * "lost four", so the fabrication now fails while a genuine rewording still passes.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that',
  'these', 'those', 'it', 'its', 'as', 'by', 'from', 'we', 'our', 'they',
  'their', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'i', 'he',
  'she', 'them', 'his', 'her', 'about', 'into', 'than', 'then', 'so',
]);

// A paraphrase has to keep most of its adjacencies. 0.6 tolerates one reworded
// joint in a short quote while still rejecting a reshuffle.
const PARAPHRASE_BIGRAM_THRESHOLD = 0.6;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")  // smart quotes → '
    .replace(/[^a-z0-9\s'.%$]/g, ' ')             // punctuation → space (keep . % $ for numbers)
    .replace(/\s+/g, ' ')
    .trim();
}

function contentWords(normStr) {
  return normStr
    .split(' ')
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function bigrams(words) {
  const out = [];
  for (let i = 0; i < words.length - 1; i++) out.push(words[i] + ' ' + words[i + 1]);
  return out;
}

/**
 * Build the reusable index for a source corpus once per run, rather than per quote.
 */
function buildContextIndex(context) {
  const normContext = normalize(context);
  const ctxWords = contentWords(normContext);
  return {
    normContext,
    bigramSet: new Set(bigrams(ctxWords)),
    wordSet: new Set(ctxWords),
    // Every number token in the source. Used to catch invented figures.
    numberSet: new Set(extractNumbers(normContext)),
  };
}

// Numbers are where fabrication does the most damage — an invented ARR or customer
// count reads as hard evidence. Pull them out so they can be checked individually.
function extractNumbers(normStr) {
  const matches = String(normStr).match(/\$?\d[\d,.]*%?k?m?b?/g) || [];
  return matches
    .map(m => m.replace(/[,]/g, '').replace(/\.$/, ''))
    .filter(m => /\d/.test(m));
}

/**
 * Classify a single quote against a prepared context index.
 * @returns {'verbatim'|'paraphrased'|'unverified'}
 */
function classifyQuote(quote, index) {
  // Back-compat: older callers passed (quote, normContext, contextWordSet).
  if (typeof index === 'string') index = buildContextIndex(index);
  if (!index || !index.normContext) return 'unverified';

  const nq = normalize(quote);
  if (!nq || nq.length < 4) return 'unverified';

  const words = contentWords(nq);

  // Fewer than two content words cannot be verified, EVEN IF the string appears in
  // the source. A single word will occur by coincidence in any real transcript, and
  // tagging it "verbatim" puts a green check next to something that verifies nothing.
  // This gate sits ahead of the substring check on purpose.
  if (words.length < 2) return 'unverified';

  // Verbatim: the whole normalized quote is a substring of the source.
  if (index.normContext.includes(nq)) return 'verbatim';

  const qBigrams = bigrams(words);
  const hits = qBigrams.filter(b => index.bigramSet.has(b)).length;
  const coverage = hits / qBigrams.length;
  return coverage >= PARAPHRASE_BIGRAM_THRESHOLD ? 'paraphrased' : 'unverified';
}

/**
 * Find numbers asserted in a piece of agent prose that do NOT appear in the source.
 * A number the agent invented is the highest-damage hallucination available to it:
 * "$60K ARR" reads as a fact and there is no other way for a reader to catch it.
 * @returns {string[]} the unsupported number tokens
 */
// The digits, stripped of notation. "$15m" -> "15", "$500k" -> "500", "4.0" -> "4".
//
// Founders speak in shorthand and models write in notation. On the live Cadrian
// call Dan Preiss said "We're doing it at a 15 post" and "500 committed, another
// 250 soft committed"; the extractor faithfully rendered those as "$15M post" and
// "$500k committed". Comparing strings, "$15m" is nowhere in "15 post", so the
// gate discarded BOTH — the two most important facts on a live deal, with the
// quotes sitting right there proving them.
//
// A false negative is cheap by design, but not on the round terms. Comparing the
// mantissa keeps the constraint that matters — a claim asserting $15M must still
// find "15" in its own quote, so an invented "$60K ARR" against a quote with no 60
// still dies — while tolerating the notation drift that is the model doing its job.
function mantissa(n) {
  return String(n).replace(/[$%,]/g, '').replace(/[kmb]$/i, '').replace(/\.0+$/, '');
}

function unsupportedNumbers(text, index) {
  if (!text || !index) return [];
  const nums = extractNumbers(normalize(text));
  const mantissaSet = new Set([...index.numberSet].map(mantissa));
  return [...new Set(nums)].filter((n) => {
    if (index.numberSet.has(n)) return false;
    // Tolerate formatting drift: $60k vs 60000, 4 vs 4.0
    const bare = n.replace(/[$%]/g, '');
    if (index.numberSet.has(bare)) return false;
    if (index.numberSet.has('$' + bare)) return false;
    // Notation drift: the claim's "$15m" against the transcript's spoken "15".
    if (mantissaSet.has(mantissa(n))) return false;
    // Small integers are usually counts of things said in prose, not claims.
    if (/^\d$/.test(bare)) return false;
    return true;
  });
}

/**
 * Annotate an agent's key_quotes with a `verification` field and attach a
 * `quote_integrity` summary. Mutates and returns the agent output object.
 */
function verifyAgentQuotes(agentOutput, context) {
  if (!agentOutput || typeof agentOutput !== 'object') return agentOutput;
  const index = context && context.normContext ? context : buildContextIndex(context);

  const quotes = Array.isArray(agentOutput.key_quotes) ? agentOutput.key_quotes : [];
  const counts = { verbatim: 0, paraphrased: 0, unverified: 0 };

  for (const q of quotes) {
    // key_quotes entries may be strings or {quote, signal} objects.
    const text = typeof q === 'string' ? q : (q.quote || q.text || '');
    const verdict = classifyQuote(text, index);
    counts[verdict]++;
    if (typeof q === 'object' && q !== null) q.verification = verdict;
  }

  // ── Also verify the evidence fields ──
  // Only key_quotes were ever checked, which left every `evidence` string — the text
  // that actually JUSTIFIES each number — completely unverified. We can't classify
  // prose as a quote, but we CAN catch invented figures inside it.
  const flagged = [];
  if (agentOutput.subcategories && typeof agentOutput.subcategories === 'object') {
    for (const [key, sub] of Object.entries(agentOutput.subcategories)) {
      if (!sub || typeof sub !== 'object') continue;
      const bad = unsupportedNumbers(sub.evidence, index);
      if (bad.length) {
        sub.unsupported_numbers = bad;
        flagged.push({ field: `subcategories.${key}`, numbers: bad });
      }
    }
  }
  for (const field of ['the_read', 'product_thesis', 'why_now', 'competitive_moat', 'kill_shot_risk', 'narrative']) {
    const bad = unsupportedNumbers(agentOutput[field], index);
    if (bad.length) flagged.push({ field, numbers: bad });
  }

  if (quotes.length || flagged.length) {
    agentOutput.quote_integrity = {
      total: quotes.length,
      ...counts,
      has_unverified: counts.unverified > 0,
      unsupported_numbers: flagged,
      has_unsupported_numbers: flagged.length > 0,
    };
  }
  return agentOutput;
}

/**
 * Verify the Founder Rubric's per-movement quotes. This matters more than the others:
 * these are the quotes behind the only scores that reach the conviction number.
 */
function verifyRubricQuotes(rubric, index) {
  if (!rubric || typeof rubric !== 'object' || !rubric.movements) return rubric;
  const counts = { verbatim: 0, paraphrased: 0, unverified: 0 };

  for (const m of Object.values(rubric.movements)) {
    if (!m || typeof m !== 'object') continue;
    const quotes = Array.isArray(m.quotes) ? m.quotes : [];
    m.quote_verification = quotes.map((q) => {
      const text = typeof q === 'string' ? q : (q.quote || q.text || '');
      const verdict = classifyQuote(text, index);
      counts[verdict]++;
      return { quote: text, verification: verdict };
    });
    const bad = unsupportedNumbers(m.evidence, index);
    if (bad.length) m.unsupported_numbers = bad;
  }

  rubric.quote_integrity = {
    total: counts.verbatim + counts.paraphrased + counts.unverified,
    ...counts,
    has_unverified: counts.unverified > 0,
  };
  return rubric;
}

/**
 * Verify one named-lens card from the expert panel. Each lens makes grounded
 * claims and surfaces verbatim `quotes` as evidence; this classifies those quotes
 * against the source and flags invented numbers in the lens's prose — the exact
 * same deterministic gate the rubric and depth agents get, so a lens cannot launder
 * a fabrication into the room. Mutates and returns the lens object.
 *
 * An ABSTAINING lens (applies:false) makes no claims, so there is nothing to check —
 * it's left untouched.
 */
function verifyLensCard(lens, index) {
  if (!lens || typeof lens !== 'object' || lens.applies === false) return lens;
  const idx = index && index.normContext ? index : buildContextIndex(index);

  const quotes = Array.isArray(lens.quotes) ? lens.quotes : [];
  const counts = { verbatim: 0, paraphrased: 0, unverified: 0 };
  lens.quote_verification = quotes.map((q) => {
    const text = typeof q === 'string' ? q : (q.quote || q.text || '');
    const verdict = classifyQuote(text, idx);
    counts[verdict]++;
    return { quote: text, verification: verdict };
  });

  // The prose the reader actually weighs — read + each strength/risk. Catch invented
  // figures wherever they hide, not just in the quote list.
  const proseFields = [lens.read]
    .concat(Array.isArray(lens.strengths) ? lens.strengths : [])
    .concat(Array.isArray(lens.risks) ? lens.risks : []);
  const bad = [...new Set(proseFields.flatMap((t) => unsupportedNumbers(t, idx)))];
  if (bad.length) lens.unsupported_numbers = bad;

  lens.quote_integrity = {
    total: quotes.length,
    ...counts,
    has_unverified: counts.unverified > 0,
    has_unsupported_numbers: bad.length > 0,
  };
  return lens;
}

/** Verify every card in the panel in place, against one shared context index. */
function verifyPanel(panel, context) {
  if (!Array.isArray(panel)) return panel;
  const index = buildContextIndex(context);
  for (const lens of panel) {
    // A lens that errored (no card produced) has nothing to verify.
    if (lens && !lens.error) verifyLensCard(lens, index);
  }
  return panel;
}

// The Bear asserts most of its numbers in nested fields that verifyAgentQuotes' flat
// field list never reaches: primary_risks[].detail, twelve_month_kill.scenario,
// bundling_risk.assessment, assumptions_required[]. Scan those too so an invented figure
// in the Bear's risk prose is flagged, not laundered — the same gate every other voice gets.
function verifyBearNumbers(bear, index) {
  if (!bear || typeof bear !== 'object') return;
  const proseFields = [
    bear.twelve_month_kill?.scenario,
    bear.bundling_risk?.assessment,
    ...(Array.isArray(bear.primary_risks) ? bear.primary_risks.map((r) => (r && (r.detail || r.risk)) || '') : []),
    ...(Array.isArray(bear.assumptions_required) ? bear.assumptions_required.map((a) => (a && a.assumption) || '') : []),
    ...(Array.isArray(bear.failure_scenarios) ? bear.failure_scenarios : []),
  ];
  const bad = [...new Set(proseFields.flatMap((t) => unsupportedNumbers(t, index)))];
  if (!bad.length) return;
  // Merge into the same quote_integrity summary verifyAgentQuotes already built.
  bear.quote_integrity = bear.quote_integrity || { total: 0, verbatim: 0, paraphrased: 0, unverified: 0, has_unverified: false };
  const existing = bear.quote_integrity.unsupported_numbers || [];
  bear.quote_integrity.unsupported_numbers = [...existing, { field: 'risk_prose', numbers: bad }];
  bear.quote_integrity.has_unsupported_numbers = true;
}

/** Run verification across all agent outputs in place. */
function verifyAllAgents(agentOutputs, context) {
  const index = buildContextIndex(context);
  for (const key of ['team', 'product', 'market', 'bear']) {
    if (agentOutputs[key] && !agentOutputs[key].error) {
      verifyAgentQuotes(agentOutputs[key], index);
    }
  }
  if (agentOutputs.bear && !agentOutputs.bear.error) {
    verifyBearNumbers(agentOutputs.bear, index);
  }
  if (agentOutputs.rubric && !agentOutputs.rubric.error) {
    verifyRubricQuotes(agentOutputs.rubric, index);
  }
  return agentOutputs;
}

module.exports = {
  verifyAgentQuotes,
  verifyRubricQuotes,
  verifyLensCard,
  verifyPanel,
  verifyAllAgents,
  classifyQuote,
  buildContextIndex,
  unsupportedNumbers,
  normalize,
  PARAPHRASE_BIGRAM_THRESHOLD,
};
