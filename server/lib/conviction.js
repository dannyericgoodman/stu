// ══════════════════════════════════════════════════════════════════════════
// The conviction engine — deterministic, no LLM.
//
// Canonical rubric: Brain/02 Frameworks/Founder Rubric.md
// Core question: "When it goes sideways — not IF, but WHEN — will this founder
// see it early, adapt, and still win?"
//
// Two rules, both load-bearing:
//
//   1. Code does arithmetic. The LLM does judgment. (Stu's existing discipline —
//      see correctPillarScores. Kept.)
//
//   2. A conviction score is NEVER reported above the confidence its evidence
//      supports. This is the rule Stu was missing. It previously scored 2KB of
//      marketing copy with exactly the same authority as a deck plus two
//      transcripts — same word, same colour, same three-decimal arithmetic. A
//      URL-only run reliably produced "Pass ≈ 4.3", indistinguishable from a
//      Pass earned by reading everything and finding real problems.
//
// Rule 2 is why computeEvidenceRung is here and not in a prompt. Evidence
// strength is a fact about which inputs exist. The model never gets a vote on
// how much to trust itself.
// ══════════════════════════════════════════════════════════════════════════

// ── Evidence rungs ────────────────────────────────────────────────────────
// What we actually heard, ordered. Assigned in code from the inputs present.
const RUNG = {
  NONE: 0, // nothing readable reached the agents
  PUBLIC: 1, // their website / public record only — what they CLAIM
  STATED: 2, // + founder-stated materials (a deck) — still their own account
  OBSERVED: 3, // + the founder talking (transcript, call, meeting notes)
  CORROBORATED: 4, // + more than one independent conversation
};

const RUNG_LABEL = {
  0: 'No evidence',
  1: 'Website only',
  2: 'Founder-stated',
  3: 'Observed in conversation',
  4: 'Corroborated across calls',
};

// What each rung can honestly support. Shown to the user, not decorative.
const RUNG_MEANING = {
  0: 'Nothing readable reached the agents. Any score here would be invented.',
  1: 'We have their marketing claims and nothing else. This supports a read on positioning, not on the founder.',
  2: "We have their own account of themselves. Useful, unverified, and selected by them.",
  3: 'We heard the founder answer questions. This is the first rung where the rubric is scorable.',
  4: 'More than one conversation. Claims can be checked against each other.',
};

// ── The four movements ────────────────────────────────────────────────────
// Weights follow the rubric: "Weight 1 and 2 (strongest evidence) highest;
// 3 and 4 differentiate among founders who clear 1-2."
//
// `needs` is the rung below which the movement is not honestly scorable. These
// are not arbitrary — they come from the rubric's own tests:
//   - Earned Insight:  "How did you arrive at this problem? What do smart people
//                       in this space still get wrong?"           → needs a call
//   - Execution:       "What did you believe 6 months ago that you no longer
//                       believe?" / push back and watch           → needs a call
//   - Talent Magnetism:"Who committed before there was evidence?" → needs a call
//   - Nonconsensus:    a stated contrarian thesis + why-now. A deck or a site
//                      does assert this, so it is partially readable at STATED.
//                      The *quality* of the idea-maze walk still needs a call.
const MOVEMENTS = {
  earned_insight: {
    weight: 3,
    label: 'Earned Insight',
    blurb: 'They lived the problem. Obsessed with the problem, not the solution.',
    evidence_strength: 'STRONG',
    needs: RUNG.OBSERVED,
  },
  execution_velocity: {
    weight: 3,
    label: 'Execution & Learning Velocity',
    blurb: 'How fast they move — and how fast they update.',
    evidence_strength: 'STRONG',
    needs: RUNG.OBSERVED,
  },
  nonconsensus_vision: {
    weight: 2,
    label: 'Nonconsensus Vision & Market POV',
    blurb: 'A distinct, arguably-wrong thesis — and a clear view of how the market changes.',
    evidence_strength: 'MIXED',
    needs: RUNG.STATED,
  },
  talent_magnetism: {
    weight: 2,
    label: 'Talent Magnetism',
    blurb: 'Can they get great people to bet on them before there is proof?',
    evidence_strength: 'MIXED',
    needs: RUNG.OBSERVED,
  },
};

// The two movements with the strongest evidence in the literature (Gompers 2010;
// Azoulay 2020; Kaplan 2012/2021). They are 6 of 10 weight. If either is
// unscorable, there is no conviction score — there is a question list.
const LOAD_BEARING = ['earned_insight', 'execution_velocity'];

// ── Bands ─────────────────────────────────────────────────────────────────
// Straight from the rubric. Note this is FOUR bands, not the three Stu shipped
// (Invest >= 7 / Monitor >= 5 / Pass). The old ladder collapsed 7.0-10.0 into a
// single undifferentiated "Invest", which erased the anchor-vs-memo distinction —
// the most consequential call in the process.
const BANDS = [
  { min: 9, key: 'anchor', label: 'Anchor-grade', action: 'First call within a week' },
  { min: 7, key: 'memo', label: 'Top-quartile', action: 'Write a memo' },
  { min: 5, key: 'monitor', label: 'Monitor', action: 'Track the next data point' },
  { min: -Infinity, key: 'pass', label: 'Pass with respect', action: 'Pass' },
];

// ── The honesty this engine demands of everything else, applied to itself ──
// Every claim gets sized to its evidence. This one has almost none: six companies
// assessed, ever; no outcome loop; the score has never been checked against a result.
// And per Portfolio Pattern Analysis, the passes on strong founders have no recorded
// reasoning — so there isn't ground truth to calibrate against even retrospectively.
// This rides along with every conviction result and is rendered next to the number.
const CALIBRATION_NOTE =
  'This is an evidence-organising score, not a prediction. It has never been checked ' +
  'against an outcome: Stu has assessed 6 companies and has no outcome loop, so the ' +
  'score does not learn. Weights come from the assessment rubric; the gate threshold and ' +
  'the dock magnitudes are author-set and unvalidated. Treat it as a structured prior ' +
  'and a question list — the judgment stays yours.';

// The rubric gives DIRECTIONS ("dock, don't reward") and never a magnitude. Every
// number below is mine. Saying so in the artifact is the point.
const DOCK_NOTE = 'Dock magnitudes are author-set, not rubric-derived, and unvalidated.';

// Uncapped, the docks summed to -3.5 — two whole bands. Invented numbers should not
// be able to overrule two bands of evidence.
const MAX_TOTAL_DOCK = -1.5;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function bandFor(score) {
  return BANDS.find((b) => score >= b.min);
}

// ══════════════════════════════════════════════════════════════════════════
// Evidence rung — computed from the inputs, never from the model.
// ══════════════════════════════════════════════════════════════════════════

// An input only counts if it actually carries content. A deck whose PDF failed
// extraction, or a URL that 403'd, is a *gap*, not evidence — Stu used to store
// the literal string "Failed to fetch: HTTP 403" as an input and then score it.
function inputIsReal(input) {
  const content = (input.content || '').trim();
  if (!content) return false;
  if (content.startsWith('[PITCH DECK NOT INGESTED')) return false;
  if (content.startsWith('Failed to fetch:')) return false;
  if (/\(NOT INGESTED\)/.test(input.label || '')) return false;
  if (/\(fetch failed\)/.test(input.label || '')) return false;
  if (content.length < 40) return false; // a fragment is not a source
  return true;
}

// ── Does this material contain a record of the founder being MET? ───────────
//
// The first version of this gate keyed on `input_type === 'transcript'`. Running it
// against the real database killed that design: five of the six companies Stu has ever
// assessed have NO transcript row. The actual workflow is that Danny writes artifacts
// elsewhere — "Meeting Prep + Debrief", "Founder Assessment (coffee meeting, ~1 hour)",
// "[Scorecard — Meeting #1]" — and pastes them in as `notes`. His meeting record lives
// in `notes`. Gating on input_type would have refused to score 5 of 6 real companies
// while looking principled about it.
//
// So the rung keys on what the material IS, not which box it arrived in. This is a
// heuristic, which is a real cost — so it is deterministic, it is calibrated against
// every input row in the live DB, and computeEvidenceRung REPORTS which input lifted
// the rung and on what phrase, so a wrong call is visible rather than silent.
//
// Deliberately NOT matched: scheduling chatter ("meeting scheduled for 3/17"), which is
// a calendar note, not evidence that anyone was in a room.
const MEETING_MARKERS = [
  { re: /post-?meeting/i, why: 'says "post-meeting"' },
  { re: /\bdebrief\b/i, why: 'is a debrief' },
  { re: /\bcall notes?\b/i, why: 'contains call notes' },
  { re: /\bmeeting notes?\b/i, why: 'is titled meeting notes' },
  { re: /\btranscript\b/i, why: 'contains a transcript' },
  { re: /meeting\s*(?:type|date)\s*:/i, why: 'has a meeting header' },
  { re: /\bmeeting\s*#\s*\d/i, why: 'references a numbered meeting' },
  { re: /\b(?:coffee|zoom|call|pitch|intro|founder)\s+meeting\b/i, why: 'describes a meeting held' },
  { re: /\bmeeting\b[^.\n]{0,30}~?\s*\d+\s*(?:hour|hr|min)/i, why: 'records a meeting duration' },
  { re: /\bwhen asked\b/i, why: 'records the founder answering' },
  { re: /\b(?:he|she|they)\s+(?:said|told me|walked me through)\b/i, why: 'quotes the founder speaking' },
  { re: /\bscorecard\b[^\n]{0,40}meeting/i, why: 'is a post-meeting scorecard' },
];

// A calendar entry is not a meeting record. Checked first.
const SCHEDULING_ONLY = /\b(?:scheduled|scheduling|schedule)\b[^.\n]{0,30}\bmeeting\b|\bmeeting\b[^.\n]{0,20}\bscheduled\b/i;

function meetingRecord(input) {
  const content = String(input.content || '');
  const label = String(input.label || '');
  const hay = `${label}\n${content}`;
  // A note that ONLY schedules meetings evidences nothing about the founder.
  const strippedOfScheduling = hay.replace(new RegExp(SCHEDULING_ONLY.source, 'gi'), ' ');
  for (const m of MEETING_MARKERS) {
    if (m.re.test(strippedOfScheduling)) return { found: true, why: m.why, label: label || input.input_type };
  }
  return { found: false };
}

function computeEvidenceRung(inputs) {
  const real = (inputs || []).filter(inputIsReal);

  const transcripts = real.filter((i) => i.input_type === 'transcript');
  const decks = real.filter((i) => i.input_type === 'deck');
  const urls = real.filter((i) => i.input_type === 'url');
  const notes = real.filter((i) => i.input_type === 'notes');

  // Anything that actually records a conversation, whatever box it came in.
  const observed = [];
  for (const i of real) {
    if (i.input_type === 'transcript') {
      observed.push({ label: i.label || 'Transcript', why: 'is a transcript' });
      continue;
    }
    if (i.input_type === 'notes') {
      const m = meetingRecord(i);
      if (m.found) observed.push({ label: m.label, why: m.why });
    }
  }

  const dropped = (inputs || []).filter((i) => !inputIsReal(i));

  let rung = RUNG.NONE;
  if (urls.length || notes.length) rung = RUNG.PUBLIC;
  if (decks.length) rung = RUNG.STATED;
  if (observed.length) rung = RUNG.OBSERVED;
  // CORROBORATED means "more than one independent conversation", and only distinct
  // TRANSCRIPTS prove that. Notes cannot: Hale's three CRM notes are all
  // "[Scorecard — Meeting #1]" — one meeting written down three times — and counting
  // them as three conversations produced "Corroborated across calls" off a single
  // coffee. Detecting distinct meetings inside prose is not something this can do
  // honestly, so notes cap at OBSERVED and the claim stays true.
  if (transcripts.length > 1) rung = RUNG.CORROBORATED;

  return {
    rung,
    label: RUNG_LABEL[rung],
    meaning: RUNG_MEANING[rung],
    // Which inputs lifted the rung to OBSERVED, and on what evidence. Shown to the
    // reader so a heuristic misfire is auditable instead of invisible.
    observed_from: observed,
    counts: {
      transcripts: transcripts.length,
      decks: decks.length,
      urls: urls.length,
      notes: notes.length,
      meeting_records: observed.length,
    },
    // Every input we were handed but could not actually read. This is the
    // "what Stu didn't look at" list, and it is derived, not written.
    dropped: dropped.map((d) => ({
      type: d.input_type,
      label: d.label || d.input_type,
      reason: dropReason(d),
    })),
  };
}

function dropReason(input) {
  const content = (input.content || '').trim();
  if (content.startsWith('[PITCH DECK NOT INGESTED')) {
    const m = content.match(/\[PITCH DECK NOT INGESTED — ([^\].]+)/);
    return m ? m[1] : 'deck could not be read';
  }
  if (content.startsWith('Failed to fetch:')) return content.replace('Failed to fetch:', 'fetch failed:').trim();
  if (!content) return 'empty';
  if (content.length < 40) return 'too short to be a source';
  return 'not readable';
}

// ══════════════════════════════════════════════════════════════════════════
// Score coercion — the boundary between what the model said and what we trust
// ══════════════════════════════════════════════════════════════════════════
//
// The rubric agent is an LLM emitting JSON. It mostly emits a number. Sometimes it
// emits "8", or "N/A", or 11, or -5. Fuzzing the real parse path turned up two
// failures that mattered:
//
//   score: -5  → conviction 4.1 "Pass with respect". A nonsense value produced a
//                plausible verdict with no error. Wrong-but-believable is the exact
//                failure mode this whole engine exists to remove, so it cannot be
//                reintroduced at the parsing boundary.
//   score: "8" → treated as an abstention, and the UI then said "the agent abstained
//                rather than guess". That is a lie. It did not abstain — it answered
//                and we failed to read it. A false abstention is as dishonest as a
//                false score.
//
// So there are THREE outcomes here, not two, and they are different facts:
//   a real score      — the model judged, in range
//   'abstained'       — the model looked and honestly declined (null / "N/A")
//   'invalid'         — the model returned something unusable. A SYSTEM fault, and it
//                       must be reported as one rather than dressed as judgment.
function coerceScore(raw) {
  if (raw === null || raw === undefined) return { value: null, fault: 'abstained' };

  let n = raw;
  if (typeof n === 'string') {
    const t = n.trim().toLowerCase();
    // The model's honest ways of saying "I can't judge this".
    if (t === '' || t === 'null' || t === 'n/a' || t === 'na' || t === 'unknown' || t === 'none') {
      return { value: null, fault: 'abstained' };
    }
    n = Number(t);
  }

  if (typeof n !== 'number' || !Number.isFinite(n)) return { value: null, fault: 'invalid', raw };
  // Out of range is not "the model meant the maximum". It means the model did not
  // follow the schema, so this field cannot be trusted at all. Do NOT clamp — clamping
  // 11 to 10 silently invents a top score, and clamping -5 to 1 invents a bottom one.
  if (n < 1 || n > 10) return { value: null, fault: 'invalid', raw };

  return { value: round1(n), fault: null };
}

// ══════════════════════════════════════════════════════════════════════════
// Conviction
// ══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} args
 * @param {object} args.movements  { earned_insight: {score|null, evidence, ...}, ... }
 *                                  A null/absent score means the agent ABSTAINED.
 *                                  Abstention is a first-class answer here — the old
 *                                  prompts forbade it, so total ignorance rendered as a 5.
 * @param {number} args.rung       from computeEvidenceRung
 * @param {object} args.marketRisk { structurally_dead: bool, note: string }
 * @param {number} args.bearAdjustment  raw from the bear agent
 * @param {object} args.flags      { charisma_over_substance: bool, grievance_grandiosity: bool }
 *                                  — or whatever keys the rubric's yellow_flags define.
 * @param {array}  args.flag_defs  [{ key, label, why, amount }] from
 *                                  rubric.extras.yellow_flags. Omit for the two legacy
 *                                  Danny flags (backward compat).
 * @param {object} args.veto       { present: bool, reason: string } — a fatal flaw
 *                                  the agent surfaced. A veto forces the band to
 *                                  Pass: one disqualifier kills a deal no average
 *                                  can save, the way ICs actually work.
 * @param {array}  args.dimensions [{ key, label, blurb, weight, needs, load_bearing }]
 *                                  The rubric's dimensions. Omit for the legacy
 *                                  Founder Rubric four movements (backward compat).
 * @param {number} args.gate_threshold  min load-bearing score to "clear the gate"
 *                                  (author-set default 6, unvalidated — see below).
 */
function computeConviction({ movements = {}, rung = RUNG.NONE, marketRisk = {}, bearAdjustment = 0, flags = {}, veto = null, dimensions = null, gate_threshold = 6, flag_defs = null } = {}) {
  // The engine is generic over dimensions; the legacy four movements are just the
  // default rubric. Every behavior below that used to hardcode movement keys now
  // reads them off DIM.
  const DIM = dimensions || Object.entries(MOVEMENTS).map(([key, def]) => ({
    key,
    label: def.label,
    blurb: def.blurb,
    weight: def.weight,
    needs: def.needs,
    evidence_strength: def.evidence_strength,
    load_bearing: LOAD_BEARING.includes(key),
  }));
  const dimByKey = Object.fromEntries(DIM.map((d) => [d.key, d]));
  const lbKeys = DIM.filter((d) => d.load_bearing).map((d) => d.key);

  const detail = {};
  let totalWeight = 0;
  const unscorable = [];

  for (const def of DIM) {
    const key = def.key;
    const m = (movements && typeof movements === 'object' && !Array.isArray(movements) ? movements[key] : null) || {};
    const { value: raw, fault, raw: badRaw } = coerceScore(m.score);

    // Three independent ways a dimension can be unscorable, and they are different facts:
    //   (a) the rung is too low for this dimension to be honestly readable
    //   (b) the agent looked and abstained
    //   (c) the agent returned something unusable — a system fault, not a judgment
    const belowRung = rung < def.needs;
    const scorable = !belowRung && raw !== null;

    detail[key] = {
      label: def.label,
      blurb: def.blurb,
      weight: def.weight,
      load_bearing: !!def.load_bearing,
      evidence_strength: def.evidence_strength || null,
      needs_rung: def.needs,
      needs_rung_label: RUNG_LABEL[def.needs],
      score: scorable ? raw : null,
      scorable,
      // 'below_rung' | 'abstained' | 'invalid' | null — so the UI can tell the reader
      // which of these actually happened instead of guessing.
      fault: belowRung ? 'below_rung' : fault,
      reason: belowRung
        ? `Needs ${RUNG_LABEL[def.needs].toLowerCase()} — we only have ${RUNG_LABEL[rung].toLowerCase()}.`
        : fault === 'abstained'
          ? 'No evidence in the material provided. The agent abstained rather than guess.'
          : fault === 'invalid'
            ? `The agent returned an unusable score (${JSON.stringify(badRaw)}). Treated as no answer. This is a system fault, not a judgment about the founder — re-run.`
            : null,
      evidence: m.evidence || null,
      quotes: m.quotes || [],
    };

    if (scorable) {
      totalWeight += def.weight;
    } else {
      unscorable.push(key);
    }
  }

  // ── The determinacy gate ────────────────────────────────────────────────
  // If any load-bearing dimension can't be scored, we do not have a
  // conviction. We have a question list. Saying so is the product.
  //
  // A system fault ALSO kills the score, even when the load-bearing pair parsed fine.
  // This was a real bug: the fault check used to live only inside this branch, so a
  // single unusable movement (say talent_magnetism: 11) was quietly dropped from the
  // weighted average and the remaining three produced determinate=true, score=8,
  // "Top-quartile", reason: null. The only trace was the calculation string reading
  // "/ 8" instead of "/ 10", and nobody reads a denominator.
  //
  // That is precisely the wrong-but-plausible output this engine exists to prevent,
  // reintroduced by the engine itself. If the model did not follow the schema, the
  // response is not trustworthy — not partially trustworthy. Re-run it.
  const systemFault = Object.values(detail).some((d) => d.fault === 'invalid');
  const missingLoadBearing = lbKeys.filter((k) => !detail[k].scorable);
  if (missingLoadBearing.length > 0 || totalWeight === 0 || systemFault) {
    // Distinguish "we haven't learned enough yet" from "the machine broke". Both give
    // no score, but only one of them is about the company, and telling a user to go ask
    // better questions when the real problem is a malformed model response is its own
    // small lie.
    const lbLabels = lbKeys.map((k) => dimByKey[k].label).join(' and ');
    const reason = systemFault
      ? 'The rubric agent returned scores that could not be read. No conviction score — this is a system fault, not a judgment about the company. Re-run.'
      : rung < RUNG.OBSERVED
        ? `We have ${RUNG_LABEL[rung].toLowerCase()}. ${lbLabels} ${lbKeys.length > 1 ? 'are' : 'is'} only readable once the founder has answered questions — the rubric's own tests require it. No conviction score until then.`
        : 'The agents could not find evidence for the dimensions that carry the most weight. No conviction score.';

    return {
      determinate: false,
      score: null,
      band: null,
      rung,
      rung_label: RUNG_LABEL[rung],
      movements: detail,
      unscorable,
      missing_load_bearing: missingLoadBearing.map((k) => dimByKey[k].label),
      load_bearing_labels: lbKeys.map((k) => dimByKey[k].label),
      system_fault: systemFault,
      reason,
      calculation: null,
      docks: [],
    };
  }

  // ── Gate, then differentiate. NOT a weighted average. ──────────────────
  //
  // This is the most important arithmetic in the file and the first version got it
  // backwards. The rubric says:
  //
  //   "Weight 1 and 2 (strongest evidence) highest; 3 and 4 DIFFERENTIATE among
  //    founders who clear 1-2."
  //
  // That is a GATE followed by a TIEBREAK. A flat weighted mean is a COMPENSATOR, and
  // enumerating all 10,000 integer combinations through the old mean showed it
  // inverting the rubric in exactly the way you'd fear:
  //
  //   THE OLD MEAN (removed):        THE GATE BELOW (current, measured 2026-07-16):
  //     10,10, 1, 1 →  6.4 Monitor     10,10, 1, 1 →  9.0  Anchor-grade
  //      5, 5,10,10 →  7.0 memo         5, 5,10,10 →  6.0  Monitor
  //
  // ⚠️ READ THAT TABLE BEFORE QUOTING IT. The 6.4/7.0 numbers describe the BUG,
  // not this file. I quoted them as if they were the gate's output when briefing a
  // review panel, and the panel — correctly — came back with "you pitched us the
  // pathology as the product." The left column is what was wrong. The right column
  // is what the code does. Both are here so nobody has to re-derive it, including me.
  //
  // A founder who is perfect on both STRONG-evidence movements got tracked. A founder
  // middling on both got a memo, carried there by two movements the rubric itself
  // labels MIXED and says not to over-weight. 23% of memo-band results had a
  // load-bearing movement at 5 or below. That is the compensation the rubric forbids.
  //
  // So: the load-bearing dimensions SET the score. The rest can only move it ±1 —
  // enough to separate two founders who both cleared the gate, never enough to
  // carry one who didn't. This generalizes: whatever a user's rubric marks
  // load-bearing plays the role Earned Insight and Execution Velocity played.
  const lbScores = lbKeys.map((k) => detail[k].score);
  const loadBearingBase = lbScores.reduce((a, b) => a + b, 0) / lbScores.length;

  // The differentiator: mean of the non-load-bearing dimensions, centred on 5.5,
  // scaled to ±1. Dimensions that abstained simply don't differentiate.
  const diffScores = DIM.filter((d) => !d.load_bearing)
    .map((d) => detail[d.key].score)
    .filter((s) => typeof s === 'number');
  const differentiator = diffScores.length
    ? Math.max(-1, Math.min(1, (diffScores.reduce((a, b) => a + b, 0) / diffScores.length - 5.5) / 4.5))
    : 0;

  const base = loadBearingBase + differentiator;

  // AUTHOR-SET, NOT RUBRIC-DERIVED: the rubric says "clear 1-2" without defining it.
  // 6 is my threshold, not Danny's, and it is unvalidated. It is still a more faithful
  // reading than letting a 5 on both STRONG dimensions reach "write a memo".
  // Per-rubric override via gate_threshold.
  const clearedGate = Math.min(...lbScores) >= gate_threshold;

  // ── Docks. Never boosts. ────────────────────────────────────────────────
  const docks = [];

  // Booleans arrive from an LLM, so they arrive as anything. Raw truthiness made the
  // string "false" — and "no" — dock the founder 0.5, because both are truthy. The
  // score field was hardened by coerceScore and the flags were left raw; that asymmetry
  // is the bug. A model saying "no" must never cost a founder half a point.
  const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';

  // Bear: clamped to [-1.5, 0]. Deliberately NO traction-based ceiling.
  // The old code capped the bear's penalty when team+product scored high —
  // which let the bull agents mechanically silence the adversary that exists
  // to check them. If the bulls are wrong together, the bear must still speak.
  const bear = Math.max(-1.5, Math.min(0, Number(bearAdjustment) || 0));
  if (bear < 0) docks.push({ key: 'bear', amount: round1(bear), why: 'Adversarial risk pass' });

  // Market is a WEIGHED RISK NOTE, not a pillar. The rubric is explicit:
  // "don't discount a strong founder on market alone — great founders navigate
  // and pivot." Stu had market at 30% of the score, which is the drift. It only
  // docks when the market is structurally dead, and it is bounded.
  if (isTrue(marketRisk.structurally_dead)) {
    docks.push({ key: 'market', amount: -1, why: marketRisk.note || 'Structurally dead market' });
  }

  // Yellow flags. Rubric: "Dock, don't reward."
  // With flag_defs (a rubric's own extras.yellow_flags) each true flag docks its
  // configured amount. Without them, the two legacy Danny flags apply exactly
  // as before — same keys, same amounts, same copy.
  if (Array.isArray(flag_defs) && flag_defs.length) {
    for (const f of flag_defs) {
      if (f && f.key && isTrue(flags[f.key])) {
        docks.push({ key: f.key, amount: -(Number(f.amount ?? f.dock) || 0.5), why: f.why || f.label || f.key });
      }
    }
  } else {
    if (isTrue(flags.charisma_over_substance)) {
      docks.push({ key: 'charisma', amount: -0.5, why: 'Storytelling outrunning substance — predicts getting funded, not winning' });
    }
    if (isTrue(flags.grievance_grandiosity)) {
      docks.push({ key: 'grievance', amount: -0.5, why: 'Chip aimed at people rather than the work — variance and retention risk' });
    }
  }

  // Docks are capped in aggregate. Uncapped they summed to -3.5 — enough to take a 9.0
  // to a 5.5, crossing two whole bands on a scale where the memo band is 3 points wide.
  // None of these magnitudes come from the rubric (see DOCK_NOTE); they are mine. An
  // invented number should not be able to overrule two bands of evidence.
  const rawDockTotal = docks.reduce((a, d) => a + d.amount, 0);
  const dockTotal = Math.max(MAX_TOTAL_DOCK, rawDockTotal);
  const dockCapped = rawDockTotal < MAX_TOTAL_DOCK;

  let score = Math.max(1, Math.min(10, round1(base + dockTotal)));

  // The gate. Non-load-bearing dimensions differentiate among founders who clear
  // the load-bearing set — they cannot carry a founder who didn't.
  let gateApplied = false;
  if (!clearedGate && score >= 7) {
    score = 6.9;
    gateApplied = true;
  }

  // ── The veto. ─────────────────────────────────────────────────────────
  // One fatal flaw kills the deal no average can save — this mirrors how ICs
  // actually work. The score is still computed and shown (it's informative),
  // but the band is forced to Pass and the reason rides along.
  const vetoed = isTrue(veto?.present);
  const vetoReason = vetoed ? (veto.reason || 'The rubric agent flagged a fatal flaw.') : null;

  const lbDesc = lbKeys.map((k) => `${dimByKey[k].label} ${detail[k].score}`).join(' + ');
  const parts = `${lbDesc} → base ${round1(loadBearingBase)}` +
    `, differentiator ${differentiator >= 0 ? '+' : ''}${round1(differentiator)}` +
    (docks.length ? `, docks ${round1(dockTotal)}${dockCapped ? ` (capped from ${round1(rawDockTotal)})` : ''}` : '') +
    (gateApplied ? `, capped at 6.9 — did not clear ${gate_threshold} on every load-bearing dimension` : '') +
    (vetoed ? `, VETO — band forced to Pass` : '');

  return {
    determinate: true,
    score,
    band: vetoed ? BANDS.find((b) => b.key === 'pass') : bandFor(score),
    vetoed,
    veto_reason: vetoReason,
    cleared_gate: clearedGate,
    gate_applied: gateApplied,
    load_bearing_labels: lbKeys.map((k) => dimByKey[k].label),
    dock_capped: dockCapped,
    // Shipped with the number, every time. The engine's whole thesis is that a claim
    // should be sized to its evidence; that applies to the engine itself.
    calibration: CALIBRATION_NOTE,
    rung,
    rung_label: RUNG_LABEL[rung],
    movements: detail,
    unscorable,
    missing_load_bearing: [],
    system_fault: false, // unreachable when true — the gate above catches it
    reason: null,
    docks,
    calculation: parts + ` = ${score}`,
    dock_note: docks.length ? DOCK_NOTE : null,
  };
}

module.exports = {
  RUNG,
  RUNG_LABEL,
  RUNG_MEANING,
  MOVEMENTS,
  LOAD_BEARING,
  BANDS,
  bandFor,
  inputIsReal,
  computeEvidenceRung,
  computeConviction,
  round1,
};
