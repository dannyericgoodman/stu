const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const runManager = require('../agents/runManager');
const { fetchUrlContent } = require('../agents/urlFetcher');

const { anthropicFor, loadUserApiKeys, MODEL } = require('../lib/providerKeys');
const { computeEvidenceRung, computeConviction, bandFor } = require('../lib/conviction');

// ── Why this exists ──
// No temperature was ever set anywhere in this server, so every call ran at the API
// default of 1.0 — including every scoring agent. Stu was sampling its own verdicts.
// The proof is in the database: six founders were assessed twice on byte-identical
// inputs (same assessment_inputs, same total char counts, ~24h apart) and the overall
// score moved every time.
//
//   Hale          18,150 chars → 5.8 then 5.3   (Δ 0.5)
//   Gil           21,937 chars → 6.8 then 6.3   (Δ 0.5)
//   kya labs      47,907 chars → 6.0 then 5.8   (Δ 0.2)
//   The Graph     30,600 chars → 5.9 then 5.8   (Δ 0.1)
//   Ghost Social     170 chars → 2.8 then 1.7   (Δ 1.1)
//
// Median |Δ| 0.35, max 1.1. That is the instrument's own noise floor on identical
// input — wide enough to move a company across a band boundary for no reason at all.
// An evaluation instrument that returns a different answer to the same question is
// not an instrument. Judgment gets temperature 0; prose generation elsewhere can
// keep its default.
const SCORING_TEMPERATURE = 0;

// ── Why 8192 and not 4096 ──
// Every agent ran at max_tokens 4096. The Bear's schema (primary_risks,
// twelve_month_kill, bundling_risk, deck_omissions, failure_scenarios,
// assumptions_required, bear_adjustment, narrative) does not fit in it on a rich
// input: measured against real data it returns stop_reason "max_tokens" at exactly
// 4096, so robustJsonParse grabs `{` to the last `}` mid-structure and the agent
// "fails". At 8192 the same call stops at end_turn on 4,236 tokens and parses.
//
// This bug predates the conviction rebuild. It was invisible because temperature 1.0
// made it intermittent — the Bear sometimes fit and sometimes didn't, which reads as
// flakiness. Pinning temperature to 0 made it fail every time, which is how it became
// findable. Output tokens are billed as used, so the headroom is free unless taken.
const AGENT_MAX_TOKENS = 8192;

// ── The model the assessment path runs on ──
// Sourcing is high-volume and cost-sensitive and stays on the cheap global MODEL
// (providerKeys.MODEL, currently Sonnet). Assessment is the opposite: low-volume,
// high-value — a few dollars per deal is the right trade for the strongest grounded
// analysis. So it gets its own knob, defaulting to Opus.
//
// WHY Opus 4.6 AND NOT OPUS 5: the whole scoring path pins temperature to 0 (see
// SCORING_TEMPERATURE above — "Stu was sampling its own verdicts"). Opus 4.7/4.8/5
// REMOVE the temperature parameter and 400 if it's sent. Opus 4.6 is Opus-tier AND
// still accepts temperature:0, so it's the model that satisfies both the brief's
// explicit "temp 0 for grounded extraction" and this file's determinism scar without
// changing the request shape. Override via env if a key wants a different Opus.
const ASSESSMENT_MODEL = process.env.ASSESSMENT_MODEL || 'claude-opus-4-6';

// Run async thunks with a bounded concurrency. The room is nine lenses; firing all
// nine at once made the rate limit the bottleneck (the same lesson that pulled the
// rubric out of the old parallel batch). A small pool keeps every lens in flight
// without the burst. Order of results matches order of thunks. A thunk that throws
// resolves to a rejected settle — callers use the same settle() pattern as before.
async function runPool(thunks, concurrency = 4) {
  const results = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await thunks[i]() }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, worker));
  return results;
}

// ── GET /api/assessments — list all (only latest version per group) ──
router.get('/', (req, res) => {
  // For grouped assessments, only return the latest version
  const assessments = db.prepare(`
    SELECT a.*, f.name as founder_name, f.company as founder_company
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.is_deleted = 0
      AND a.created_by = ?
      AND a.id = (
        SELECT a2.id FROM opportunity_assessments a2
        WHERE a2.is_deleted = 0
          AND (
            (a2.group_id IS NOT NULL AND a2.group_id = a.group_id)
            OR (a2.group_id IS NULL AND a2.id = a.id)
          )
        ORDER BY a2.version_number DESC, a2.created_at DESC
        LIMIT 1
      )
    ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json(assessments);
});

// ── GET /api/assessments/group/:groupId — all versions for an opportunity ──
router.get('/group/:groupId', (req, res) => {
  const versions = db.prepare(`
    SELECT a.*, f.name as founder_name, f.company as founder_company
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.group_id = ? AND a.is_deleted = 0 AND a.created_by = ?
    ORDER BY a.version_number DESC
  `).all(req.params.groupId, req.user.id);

  // Attach change summaries from assessment_versions
  for (const v of versions) {
    const av = db.prepare('SELECT change_summary FROM assessment_versions WHERE assessment_id = ?').get(v.id);
    v.change_summary = av?.change_summary || null;
  }

  res.json(versions);
});

// ── GET /api/assessments/:id — single assessment with full data ──
router.get('/:id', (req, res) => {
  // Widen the founder JOIN for the headline: the Read page leads with company/founder/
  // round facts, not just the name. (The narrow SELECT was the "headline info missing"
  // gap — everything below is already on the founder record.)
  const assessment = db.prepare(`
    SELECT a.*,
      f.name as founder_name, f.company as founder_company, f.role as founder_role,
      f.website_url, f.linkedin_url, f.company_linkedin_url, f.domain,
      f.location_city, f.location_state, f.stage, f.company_one_liner,
      f.round_size, f.valuation, f.investment_amount, f.security_type, f.arr
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.id = ? AND a.is_deleted = 0 AND a.created_by = ?
  `).get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  // ── Danny's call, if he's made one. ──
  // Load-bearing for the Read page: his decision is what UNLOCKS Stu's column.
  // Blind-first isn't decoration — if he reads a 7.8 and then types his view,
  // the disagreement record measures how much he anchors, not who was right.
  const decision = db.prepare(
    'SELECT * FROM decisions WHERE assessment_id = ? AND created_by = ? ORDER BY decided_at DESC LIMIT 1'
  ).get(assessment.id, req.user.id);

  // The 7-M, assembled server-side from the agent outputs that already exist.
  // No LLM call — it's a FORMATTER, which is why it can't disagree with the
  // engine or sample a different answer on a re-render. Danny asked for
  // "pretty close to a memo"; this has been built the whole time, 1,200 lines
  // deep in a component nobody scrolled to.
  //
  // NOTE THE COLUMN LIE, third re-derivation in this codebase:
  //   founder_agent_output  = Team
  //   market_agent_output   = Product
  //   economics_agent_output= Market
  // A scar from a retired 6-agent schema. Renaming is a migration; carrying the
  // mapping in one place per file is the cheap correct move until then.
  // ══════════════════════════════════════════════════════════════════════
  // NOT BLIND. Danny's call, 2026-07-16:
  //   "I understand but don't agree with the paradigm that I need to provide my
  //    perspective on a company before it is scored. I should be able to add my
  //    own notes, view, ratings, etc. But let's not make this so complicated."
  //
  // He's right and it was never his idea — it came from a handoff brief, and I
  // built a gate he never asked for and then briefly enforced it server-side.
  // Forcing a VC to type a verdict before he's allowed to read his own analysis
  // is a tax on the person who owns the judgment.
  //
  // WHAT'S KEPT, because it costs him nothing: we record WHETHER the score was
  // already visible when he decided. Not to nag — to keep the data honest.
  // "When Stu and I disagreed, who was right?" only means something across rows
  // where his view was formed independently. Now the calibration set can filter
  // to those instead of silently averaging anchored and unanchored rows together
  // and calling the result calibration.
  //
  // The red team caught that BOTH existing decisions were recorded after the
  // score existed — one of them two minutes after. Without this flag that's
  // invisible and the set is quietly poisoned. With it, it's just a column.
  //
  // The page still leads with his column, because leading with it is free. It
  // just no longer stops him.
  // ══════════════════════════════════════════════════════════════════════
  res.json({
    ...assessment,
    decision: decision || null,
    // The room + its agenda, parsed server-side so the client, the 7-M builder, and
    // the vault export all read one shape. Null on pre-panel assessments. `bear` is the
    // ninth voice — it keeps its own schema (it alone feeds the score), so it rides
    // alongside the panel rather than inside it.
    panel: parseJsonColumn(assessment.panel_output),
    agenda: parseJsonColumn(assessment.agenda_output),
    bear: parseJsonColumn(assessment.bear_agent_output),
    // The headline facts, one tidy object. Any field may be null (a just-typed founder
    // has almost nothing yet) — the UI shows only what's present.
    company: {
      name: assessment.founder_company || null,
      founder: assessment.founder_name || null,
      role: assessment.founder_role || null,
      website: assessment.website_url || null,
      linkedin: assessment.company_linkedin_url || assessment.linkedin_url || null,
      domain: assessment.domain || null,
      location: [assessment.location_city, assessment.location_state].filter(Boolean).join(', ') || null,
      stage: assessment.stage || null,
      one_liner: assessment.company_one_liner || null,
      round_size: assessment.round_size ?? null,
      valuation: assessment.valuation ?? null,
      investment_amount: assessment.investment_amount ?? null,
      security_type: assessment.security_type || null,
      arr: assessment.arr ?? null,
    },
    memo_7m: buildMemo7M(assessment),
    defensibility: buildDefensibility(assessment),
  });
});

// Parse a JSON text column, tolerating null/garbage — read-back must never throw on
// a malformed blob (the same forgiveness the vault export and buildMemo7M rely on).
function parseJsonColumn(s) {
  if (!s) return null;
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

// The 7-M: Recommendation · Management · Model · Market · Momentum · Malfeasance
// · Conditions. Canon per Brain/04 Fund & Systems.
//
// Two sections carry an honest `note` rather than pretending: Model has no
// dedicated unit-economics agent, and Conditions has no deal-terms agent. Both
// are assembled from adjacent outputs. Labelling the seam beats a confident
// section built from nothing — this whole product exists because a deck once
// talked itself into an Invest.
// ══════════════════════════════════════════════════════════════════════════
// Flatten an agent field to prose. Agent output is NOT uniformly strings.
//
// Caught by the screen going blank: React error #31, "objects are not valid as a
// React child", on an object with keys {assessment, defensible, adjustment} —
// bear.bundling_risk. My txt() handled strings and arrays and shrugged at
// objects, so the raw object went down the wire and killed the page.
//
// The agents emit at least four shapes for a "field": a string, an array of
// strings, an array of objects, and an object with a prose field plus scoring
// metadata. Rather than special-case each, walk it: pull the prose, drop the
// scoring scaffolding (booleans, numbers, adjustments), never stringify an object
// into "[object Object]" on Danny's screen.
// ══════════════════════════════════════════════════════════════════════════
const PROSE_KEYS = ['assessment', 'summary', 'text', 'detail', 'description', 'reason', 'body', 'risk', 'note', 'title'];

function flatten(v, depth = 0) {
  if (v == null || depth > 3) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return null; // a flag is not prose
  if (Array.isArray(v)) {
    const parts = v.map((x) => flatten(x, depth + 1)).filter(Boolean);
    return parts.length ? parts.join('\n\n') : null;
  }
  if (typeof v === 'object') {
    // Prefer a known prose field; fall back to the longest string on the object.
    for (const k of PROSE_KEYS) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    }
    const strings = Object.entries(v)
      .filter(([, x]) => typeof x === 'string' && x.trim().length > 20)
      .map(([, x]) => x.trim());
    if (strings.length) return strings.sort((a, b) => b.length - a.length)[0];
    // Nothing readable — say nothing rather than dump JSON at him.
    return null;
  }
  return null;
}

// Pull a lens's prose out of the panel by key, unless it abstained. Verdict first
// (the one-line call), then the read (the analysis). Null if absent or abstained.
function lensProse(byKey, key) {
  const l = byKey[key];
  if (!l || l.applies === false || l.error) return null;
  return flatten([l.verdict, l.read].filter(Boolean));
}

// The 7-M, sourced from the NINE-LENS PANEL when one exists, falling back to the
// legacy Team/Product/Market columns for pre-panel assessments. The mapping from the
// room to the memo's sections:
//   Management  ← Founder-Edge (Rabois), Hard-Problems (Lonsdale), Long-Game (Housel)
//   Model       ← Unit-Economics (Gurley), Monopoly (Thiel)
//   Market      ← Inflection (Maples), Unit-Economics (Gurley)
//   Momentum    ← Networks (Hoffman)
//   Malfeasance ← The Bear (unchanged — it still runs)
//   Conditions  ← the diligence agenda (top priorities + founder follow-ups)
function buildMemo7MFromPanel(panel, syn, bear, agenda) {
  const txt = flatten;
  const byKey = Object.fromEntries(panel.map((l) => [l.key, l]));
  const agendaText = (bucketArr) => Array.isArray(bucketArr)
    ? bucketArr.map((q) => (typeof q === 'string' ? q : q?.q)).filter(Boolean)
    : [];
  const conditions = [
    ...(Array.isArray(agenda?.top_priorities) ? agenda.top_priorities : []),
    ...agendaText(agenda?.founder),
  ];
  const out = [
    { key: 'rec', title: 'I. Recommendation', body: txt(syn?.executive_summary || syn?.one_liner) },
    { key: 'mgmt', title: 'II. Management', body: txt([lensProse(byKey, 'founder_edge'), lensProse(byKey, 'hard_problems'), lensProse(byKey, 'long_game')].filter(Boolean)) },
    { key: 'model', title: 'III. Model', body: txt([lensProse(byKey, 'unit_economics'), lensProse(byKey, 'monopoly')].filter(Boolean)) },
    { key: 'market', title: 'IV. Market', body: txt([lensProse(byKey, 'inflection'), lensProse(byKey, 'unit_economics')].filter(Boolean)) },
    { key: 'momentum', title: 'V. Momentum', body: txt(lensProse(byKey, 'networks')) },
    { key: 'malfeasance', title: 'VI. Malfeasance', body: txt([bear?.primary_risks, bear?.twelve_month_kill, bear?.deck_omissions].filter(Boolean)) },
    {
      key: 'conditions', title: 'VII. Conditions',
      note: 'The diligence agenda — the top priorities and founder follow-ups the room surfaced.',
      body: txt(conditions.filter(Boolean)),
    },
  ];
  return out.filter((s) => s.body && String(s.body).trim());
}

function buildMemo7M(a) {
  const j = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
  const syn = j(a.synthesis_output);
  const bear = j(a.bear_agent_output);

  // New runs carry the panel. Source the memo from the room.
  const panel = j(a.panel_output);
  if (Array.isArray(panel) && panel.length) {
    return buildMemo7MFromPanel(panel, syn, bear, j(a.agenda_output));
  }

  // ── Legacy path: pre-panel assessments whose depth lives in the mis-named columns ──
  const team = j(a.founder_agent_output);      // NOT founder — Team
  const product = j(a.market_agent_output);    // NOT market — Product
  const market = j(a.economics_agent_output);  // NOT economics — Market
  if (!syn && !team) return [];

  const txt = flatten;
  // ── The field names below are MEASURED, not guessed. ──
  // My first pass invented plausible ones (summary, assessment, moat, risks) and
  // produced 1 section of 7 against a real assessment. The actual shapes:
  //   synthesis : executive_summary, one_liner, overall_signal, score_calculation
  //   team      : verdict, the_read, snapshot, subcategories, key_quotes, risks
  //   product   : product_thesis, build_vs_buy_risk, vision_gap, subcategories
  //   market    : why_now, competitive_moat, kill_shot_risk, subcategories
  //   bear      : primary_risks, twelve_month_kill, bundling_risk, deck_omissions,
  //               failure_scenarios, kill_shot_risk, assumptions_required
  const out = [
    { key: 'rec', title: 'I. Recommendation', body: txt(syn?.executive_summary || syn?.one_liner) },
    { key: 'mgmt', title: 'II. Management', body: txt(team?.the_read || team?.verdict || team?.snapshot) },
    {
      key: 'model', title: 'III. Model',
      note: 'No dedicated unit-economics agent — assembled from the product thesis and the build-vs-buy risk.',
      body: txt([product?.product_thesis, product?.build_vs_buy_risk].filter(Boolean)),
    },
    { key: 'market', title: 'IV. Market', body: txt([market?.why_now, market?.kill_shot_risk].filter(Boolean)) },
    { key: 'momentum', title: 'V. Momentum', body: txt(team?.snapshot || product?.vision_gap) },
    {
      key: 'malfeasance', title: 'VI. Malfeasance',
      body: txt([bear?.primary_risks, bear?.twelve_month_kill, bear?.deck_omissions].filter(Boolean)),
    },
    {
      key: 'conditions', title: 'VII. Conditions',
      note: 'No deal-terms agent — assembled from open questions and the Bear’s required assumptions.',
      body: txt([bear?.assumptions_required, team?.open_questions, market?.key_questions].filter(Boolean)),
    },
  ];
  return out.filter((s) => s.body && String(s.body).trim());
}

// ══════════════════════════════════════════════════════════════════════════
// DEFENSIBILITY — Danny's most common kill, computed since April, shown nowhere.
//
// Verbatim: "Most of the time, founders are building technically cool but
// relatively easy and INDEFENSIBLE things." It's his highest-frequency reason for
// passing, it's readable from a deck before he's spent a meeting, and I grepped
// every screen in this app for it: three hits, all in COMMENTS describing the
// kill, zero in rendered output.
//
// Meanwhile the agents have been emitting `competitive_moat`, `build_vs_buy_risk`
// and `kill_shot_risk` on every assessment for four months. The data was never
// missing. It was buried 1,200 lines deep in a component nobody scrolled to, and
// only reachable at memo time — long after the ten-second reflex it should inform.
//
// So it goes near the top of the read, on its own, before the movements. Not a
// score: the three sentences, as written, with their seams visible.
// ══════════════════════════════════════════════════════════════════════════
function buildDefensibility(a) {
  const j = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
  const bear = j(a.bear_agent_output);
  const txt = flatten;

  // New runs: defensibility is exactly what the moat lenses see. The Monopoly (Thiel)
  // and Deep-Tech (Wolfe) lenses ARE the moat read; Hard-Problems (Lonsdale) is the
  // build-vs-buy read; the Gurley kill and the Bear's bundling risk are the kill shots.
  const panel = j(a.panel_output);
  if (Array.isArray(panel) && panel.length) {
    const byKey = Object.fromEntries(panel.map((l) => [l.key, l]));
    const gurley = byKey.unit_economics || {};
    const parts = [
      { label: 'Moat', body: txt([lensProse(byKey, 'monopoly'), lensProse(byKey, 'deep_tech')].filter(Boolean)) },
      { label: 'Build vs buy', body: txt(lensProse(byKey, 'hard_problems')) },
      { label: 'Kill shot', body: txt([gurley.dead_market_note || null, bear?.kill_shot_risk].filter(Boolean)) },
      { label: 'Gets bundled', body: txt([bear?.bundling_risk, lensProse(byKey, 'networks')].filter(Boolean)) },
    ].filter((p) => p.body && String(p.body).trim());
    return parts.length ? parts : null;
  }

  // ── Legacy path: pre-panel assessments ──
  const product = j(a.market_agent_output);    // NOT market — Product
  const market = j(a.economics_agent_output);  // NOT economics — Market
  const parts = [
    { label: 'Moat', body: txt(market?.competitive_moat) },
    { label: 'Build vs buy', body: txt(product?.build_vs_buy_risk) },
    { label: 'Kill shot', body: txt(market?.kill_shot_risk || bear?.kill_shot_risk) },
    { label: 'Gets bundled', body: txt(bear?.bundling_risk) },
  ].filter((p) => p.body && String(p.body).trim());

  return parts.length ? parts : null;
}

// ── GET /api/assessments/:id/inputs — all inputs for an assessment ──
router.get('/:id/inputs', (req, res) => {
  // Verify assessment ownership before returning inputs
  const assessment = db.prepare('SELECT id FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  const inputs = db.prepare('SELECT * FROM assessment_inputs WHERE assessment_id = ? ORDER BY input_type, created_at').all(req.params.id);
  res.json(inputs);
});

// ── POST /api/assessments — create new assessment ──
// Accepts JSON body: { founder_id, group_id?, inputs: { decks[], transcripts[], urls[], notes[] } }
router.post('/', async (req, res) => {
  const { founder_id, group_id, inputs } = req.body;
  const assessmentType = req.body.assessment_type === 'meeting_prep' ? 'meeting_prep' : 'assessment';

  // Validate founder_id if provided
  const validFounderId = founder_id ? parseInt(founder_id) : null;
  if (validFounderId) {
    const founder = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ?').get(validFounderId, req.user.id);
    if (!founder) return res.status(400).json({ error: 'Founder not found' });
  }

  // Determine group and version
  let gid = group_id;
  let versionNumber = 1;
  let previousAssessmentId = null;

  if (gid) {
    // Re-run: increment version — scope by user to prevent cross-user group hijacking
    const latest = db.prepare('SELECT id, version_number FROM opportunity_assessments WHERE group_id = ? AND is_deleted = 0 AND created_by = ? ORDER BY version_number DESC LIMIT 1').get(gid, req.user.id);
    if (latest) {
      versionNumber = latest.version_number + 1;
      previousAssessmentId = latest.id;
    }
  } else {
    gid = crypto.randomUUID();
  }

  // Create assessment record
  let result;
  try {
    result = db.prepare(`
      INSERT INTO opportunity_assessments (founder_id, inputs, status, group_id, version_number, created_by, assessment_type)
      VALUES (?, ?, 'processing_inputs', ?, ?, ?, ?)
    `).run(validFounderId, JSON.stringify(inputs || {}), gid, versionNumber, req.user.id, assessmentType);
  } catch (err) {
    console.error('[Assessment] Insert error:', err);
    return res.status(500).json({ error: 'Failed to create assessment' });
  }
  const assessmentId = result.lastInsertRowid;

  // Create version record
  let changeSummary = null;
  if (previousAssessmentId) {
    const oldInputs = db.prepare('SELECT input_type, COUNT(*) as c FROM assessment_inputs WHERE assessment_id = ? GROUP BY input_type').all(previousAssessmentId);
    const oldMap = Object.fromEntries(oldInputs.map(i => [i.input_type, i.c]));
    const parts = [];
    if ((inputs.decks?.length || 0) > 0) parts.push(`+${inputs.decks.length} deck(s)`);
    if ((inputs.transcripts?.length || 0) > 0) parts.push(`+${inputs.transcripts.length} transcript(s)`);
    if ((inputs.urls?.length || 0) > 0) parts.push(`+${inputs.urls.length} URL(s)`);
    if ((inputs.notes?.length || 0) > 0) parts.push(`+${inputs.notes.length} note(s)`);
    changeSummary = parts.length > 0 ? `v${versionNumber}: ${parts.join(', ')}` : `v${versionNumber}: re-run with same inputs`;
  }

  db.prepare('INSERT INTO assessment_versions (group_id, assessment_id, version_number, change_summary, previous_assessment_id) VALUES (?, ?, ?, ?, ?)').run(
    gid, assessmentId, versionNumber, changeSummary, previousAssessmentId
  );

  res.json({ id: assessmentId, group_id: gid, version_number: versionNumber, status: 'processing_inputs' });

  // Process inputs and run agents in background
  processInputsAndRun(assessmentId, inputs || {}, validFounderId, previousAssessmentId).catch(err => {
    console.error('[Assessment] Error:', err);
    db.prepare("UPDATE opportunity_assessments SET status = 'error' WHERE id = ?").run(assessmentId);
  });
});

// ── PUT /api/assessments/:id — update metadata ──
router.put('/:id', (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const { founder_id, manual_notes } = req.body;

  if (founder_id !== undefined) {
    // Only allow pointing at a founder the caller owns (no cross-tenant foreign keys).
    let fid = founder_id ? parseInt(founder_id) : null;
    if (fid) {
      const owned = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(fid, req.user.id);
      if (!owned) return res.status(400).json({ error: 'founder_id not found or not yours' });
    }
    db.prepare('UPDATE opportunity_assessments SET founder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fid, req.params.id);
  }

  // Allow adding/editing notes on an existing assessment
  if (manual_notes !== undefined) {
    // Update the inputs JSON
    let currentInputs = {};
    try { currentInputs = JSON.parse(assessment.inputs || '{}'); } catch { currentInputs = {}; }
    currentInputs.manual_notes = manual_notes;
    db.prepare('UPDATE opportunity_assessments SET inputs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(currentInputs), req.params.id);
  }

  const updated = db.prepare('SELECT a.*, f.name as founder_name, f.company as founder_company FROM opportunity_assessments a LEFT JOIN founders f ON a.founder_id = f.id WHERE a.id = ?').get(req.params.id);
  res.json(updated);
});

// ── POST /api/assessments/:id/override — apply GP score override ──
router.post('/:id/override', (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const { adjustment, justification } = req.body;
  if (typeof adjustment !== 'number') return res.status(400).json({ error: 'adjustment (number) required' });
  if (adjustment < -1 || adjustment > 1) return res.status(400).json({ error: 'adjustment must be between -1 and 1' });

  const synthesis = JSON.parse(assessment.synthesis_output || '{}');

  // A GP may adjust a score. A GP may not conjure one.
  //
  // This route used to do `const baseScore = synthesis.overall_score || 0`. On an
  // indeterminate run overall_score is null, so `|| 0` made the base zero and a +1
  // override produced a confident 1.0 "Pass with respect" — a fabricated verdict on an
  // assessment the engine had explicitly refused to score. It then wrote the retired
  // Invest/Monitor/Pass vocabulary and left conviction_band untouched, so the row
  // disagreed with itself.
  if (typeof synthesis.overall_score !== 'number' || assessment.conviction_band === 'indeterminate') {
    return res.status(409).json({
      error: 'This assessment has no conviction score to override.',
      detail: synthesis.insufficient_evidence_reason
        || 'The evidence did not support a score. An override would invent one. Add a call transcript and re-run instead.',
    });
  }

  const baseScore = synthesis.overall_score;
  const newScore = Math.max(1, Math.min(10, round1(baseScore + adjustment)));
  const band = bandFor(newScore);

  synthesis.override = { adjustment, justification: justification || '', by: 'GP', base: baseScore };
  synthesis.overall_score = newScore;
  synthesis.score_calculation = (synthesis.score_calculation || '') + ` → GP override ${adjustment > 0 ? '+' : ''}${adjustment} = ${newScore}`;
  synthesis.overall_signal = band.label;
  synthesis.recommended_next_step = band.action;
  if (synthesis.conviction) {
    synthesis.conviction.score = newScore;
    synthesis.conviction.band = band;
    synthesis.conviction.gp_override = synthesis.override;
  }

  // Keep the denormalised columns in step with the JSON. They used to drift.
  db.prepare('UPDATE opportunity_assessments SET synthesis_output = ?, overall_signal = ?, conviction_score = ?, conviction_band = ?, conviction_output = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(synthesis), band.label, newScore, band.key, JSON.stringify(synthesis.conviction || null), req.params.id);

  res.json({ id: assessment.id, overall_score: newScore, overall_signal: band.label, conviction_band: band.key, override: synthesis.override });
});

// ── PATCH /api/assessments/:id/synthesis — patch synthesis fields directly ──
router.patch('/:id/synthesis', (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const synthesis = JSON.parse(assessment.synthesis_output || '{}');
  const patches = req.body;

  // Merge patches into synthesis
  for (const [key, value] of Object.entries(patches)) {
    synthesis[key] = value;
  }

  // Re-derive the band if the score was patched. This used to write the retired
  // Invest/Monitor/Pass ladder and leave conviction_band alone, so the row's JSON and
  // its columns disagreed about the verdict.
  let bandUpdate = null;
  if (patches.overall_score !== undefined) {
    if (typeof synthesis.overall_score !== 'number') {
      return res.status(400).json({ error: 'overall_score must be a number, or omit it to leave the verdict alone.' });
    }
    synthesis.overall_score = Math.max(1, Math.min(10, round1(synthesis.overall_score)));
    bandUpdate = bandFor(synthesis.overall_score);
    synthesis.overall_signal = bandUpdate.label;
    synthesis.recommended_next_step = bandUpdate.action;
    if (synthesis.conviction) {
      synthesis.conviction.score = synthesis.overall_score;
      synthesis.conviction.band = bandUpdate;
    }
  }

  if (bandUpdate) {
    db.prepare('UPDATE opportunity_assessments SET synthesis_output = ?, overall_signal = ?, conviction_score = ?, conviction_band = ?, conviction_output = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(synthesis), bandUpdate.label, synthesis.overall_score, bandUpdate.key, JSON.stringify(synthesis.conviction || null), req.params.id);
  } else {
    db.prepare('UPDATE opportunity_assessments SET synthesis_output = ?, overall_signal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(synthesis), synthesis.overall_signal || assessment.overall_signal, req.params.id);
  }

  res.json({ id: assessment.id, synthesis });
});

// ── DELETE /api/assessments/:id — soft delete ──
router.delete('/:id', (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  // Cancel if running
  if (assessment.status === 'running' || assessment.status === 'synthesizing') {
    runManager.cancel(assessment.id);
  }

  db.prepare('UPDATE opportunity_assessments SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ message: 'Assessment deleted' });
});

// ── GET /api/assessments/:id/steward-operator — latest rubric evaluation ──
router.get('/:id/steward-operator', (req, res) => {
  const assessment = db.prepare('SELECT id FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const evaluation = db.prepare(
    'SELECT * FROM steward_operator_evaluations WHERE assessment_id = ? ORDER BY id DESC LIMIT 1'
  ).get(req.params.id);

  if (!evaluation) return res.json(null);
  res.json(evaluation);
});

// ── POST /api/assessments/:id/steward-operator — RETIRED ──
// The 9-trait Steward-Operator rubric was replaced by the Founder Rubric on 2026-06-25
// (canonical: Brain/02 Frameworks/Founder Rubric.md). The Founder Rubric now runs inside
// every assessment as the `founderRubric` agent and produces the conviction score.
//
// This endpoint is gone rather than rewired. Leaving it live would let a click score a
// founder against a retired framework — which is worse than the button not existing.
// The GET above still serves historical evaluations so old assessments render.
router.post('/:id/steward-operator', (req, res) => {
  return res.status(410).json({
    error: 'The Steward-Operator rubric was retired on 2026-06-25 and replaced by the Founder Rubric.',
    detail: 'The Founder Rubric now runs automatically inside every assessment and produces the conviction score. There is nothing to trigger — re-run the assessment instead.',
  });
});

// ── POST /api/assessments/:id/cancel — cancel running assessment ──
router.post('/:id/cancel', (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  if (assessment.status !== 'running' && assessment.status !== 'synthesizing' && assessment.status !== 'processing_inputs') {
    return res.status(400).json({ error: 'Assessment is not running' });
  }

  runManager.cancel(assessment.id);
  db.prepare("UPDATE opportunity_assessments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  res.json({ message: 'Assessment cancelled' });
});

// ── POST /api/assessments/:id/rerun — re-run with additional inputs ──
router.post('/:id/rerun', async (req, res) => {
  const assessment = db.prepare('SELECT * FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const { inputs: newInputs } = req.body;
  const gid = assessment.group_id || crypto.randomUUID();
  const versionNumber = (assessment.version_number || 1) + 1;

  // Merge: carry forward founder_id + assessment_type (a re-run of a Meeting Prep must stay
  // a Meeting Prep, not silently default back to the 4-agent investability eval), combine
  // old inputs with new
  const result = db.prepare(`
    INSERT INTO opportunity_assessments (founder_id, inputs, status, group_id, version_number, created_by, assessment_type)
    VALUES (?, ?, 'processing_inputs', ?, ?, ?, ?)
  `).run(assessment.founder_id, JSON.stringify(newInputs || {}), gid, versionNumber, req.user.id, assessment.assessment_type || 'assessment');
  const newId = result.lastInsertRowid;

  // Build change summary
  const parts = [];
  if ((newInputs?.decks?.length || 0) > 0) parts.push(`+${newInputs.decks.length} deck(s)`);
  if ((newInputs?.transcripts?.length || 0) > 0) parts.push(`+${newInputs.transcripts.length} transcript(s)`);
  if ((newInputs?.urls?.length || 0) > 0) parts.push(`+${newInputs.urls.length} URL(s)`);
  if ((newInputs?.notes?.length || 0) > 0) parts.push(`+${newInputs.notes.length} note(s)`);
  const changeSummary = parts.length > 0 ? `v${versionNumber}: ${parts.join(', ')}` : `v${versionNumber}: re-run`;

  db.prepare('INSERT INTO assessment_versions (group_id, assessment_id, version_number, change_summary, previous_assessment_id) VALUES (?, ?, ?, ?, ?)').run(
    gid, newId, versionNumber, changeSummary, assessment.id
  );

  // Also update original assessment's group_id if it didn't have one
  if (!assessment.group_id) {
    db.prepare('UPDATE opportunity_assessments SET group_id = ? WHERE id = ?').run(gid, assessment.id);
    // Create a version record for the original too
    db.prepare('INSERT OR IGNORE INTO assessment_versions (group_id, assessment_id, version_number, change_summary) VALUES (?, ?, 1, ?)').run(gid, assessment.id, 'v1: Initial assessment');
  }

  res.json({ id: newId, group_id: gid, version_number: versionNumber, status: 'processing_inputs' });

  // Copy old inputs, add new, then run
  processRerunInputs(newId, assessment.id, newInputs, assessment.founder_id).catch(err => {
    console.error('[Assessment] Rerun error:', err);
    db.prepare("UPDATE opportunity_assessments SET status = 'error' WHERE id = ?").run(newId);
  });
});

// ════════════════════════════════════════════════════════
// Background processing
// ════════════════════════════════════════════════════════

async function processInputsAndRun(assessmentId, inputs, founderId, previousAssessmentId) {
  const insertInput = db.prepare('INSERT INTO assessment_inputs (assessment_id, input_type, label, content, source_url, file_name) VALUES (?, ?, ?, ?, ?, ?)');
  // Same BYOK contract as the LLM path: keys resolve per-user, never a shared default.
  const ownerId = db.prepare('SELECT created_by FROM opportunity_assessments WHERE id = ?').get(assessmentId)?.created_by;
  const userKeys = ownerId ? loadUserApiKeys(ownerId) : {};

  // Every ingestion problem we hit, collected as we go. Previously each of these was
  // a console.warn and nothing else — so a deck that failed to extract, or a URL that
  // 403'd, was scored anyway and the reader was never told. deck_status in particular
  // was only ever written by a one-time migration, which meant the loud red
  // "this score is suspect" banner in the UI had been dead for every run since.
  const ingestionProblems = [];

  // Process decks. HARD RULE: never store unreadable deck data silently. A PDF is
  // extracted to text server-side; a link (DocSend/Slides) or unreadable/empty file
  // becomes an explicit "[NOT INGESTED]" marker so agents see the gap instead of garbage.
  if (inputs.decks && Array.isArray(inputs.decks)) {
    const { extractPdfText } = require('../services/pdf-extractor');
    const { planDeck, notIngestedMarker, deckContentIntegrity } = require('../agents/deck-ingest');
    for (const deck of inputs.decks) {
      const label = deck.label || 'Pitch Deck';
      const plan = planDeck(deck);

      if (plan.mode === 'pdf') {
        try {
          const text = await extractPdfText(Buffer.from(deck.base64, 'base64'));
          // Extraction "succeeding" is not the same as the text being usable — a
          // design-heavy deck can yield ligature soup. Check before trusting.
          // deckContentIntegrity returns { status: 'ok'|'empty'|'corrupted'|'link'|'not_ingested', reason? }
          const integrity = deckContentIntegrity(text);
          if (integrity.status !== 'ok') {
            const reason = integrity.reason || `extracted text was ${integrity.status}`;
            insertInput.run(assessmentId, 'deck', `${label} (NOT INGESTED)`, notIngestedMarker(`extracted text failed the integrity check: ${reason}`), null, deck.fileName || null);
            ingestionProblems.push({ kind: 'deck', label, reason });
            console.warn(`[Assessment ${assessmentId}] Deck "${label}" failed integrity: ${reason}`);
          } else {
            insertInput.run(assessmentId, 'deck', label, text, null, deck.fileName || null);
            console.log(`[Assessment ${assessmentId}] Deck "${label}" ingested: ${text.length} chars from PDF`);
          }
        } catch (err) {
          insertInput.run(assessmentId, 'deck', `${label} (NOT INGESTED)`, notIngestedMarker(`PDF could not be read: ${err.message}`), null, deck.fileName || null);
          ingestionProblems.push({ kind: 'deck', label, reason: `PDF could not be read: ${err.message}` });
          console.warn(`[Assessment ${assessmentId}] Deck "${label}" PDF extraction failed: ${err.message}`);
        }
      } else if (plan.mode === 'link') {
        insertInput.run(assessmentId, 'deck', `${label} (NOT INGESTED)`, notIngestedMarker(`link (${plan.content}) is behind an access wall and was not retrieved — upload a PDF export`), plan.content, deck.fileName || null);
        ingestionProblems.push({ kind: 'deck', label, reason: 'link behind an access wall — upload a PDF export' });
        console.warn(`[Assessment ${assessmentId}] Deck link not ingested: ${plan.content}`);
      } else if (plan.mode === 'empty') {
        insertInput.run(assessmentId, 'deck', `${label} (NOT INGESTED)`, notIngestedMarker('no readable text was provided'), null, deck.fileName || null);
        ingestionProblems.push({ kind: 'deck', label, reason: 'no readable text was provided' });
      } else {
        insertInput.run(assessmentId, 'deck', label, plan.content, null, deck.fileName || null);
      }
    }
  }
  // Legacy: single deck_text
  if (inputs.deck_text) {
    insertInput.run(assessmentId, 'deck', 'Pitch Deck', inputs.deck_text, null, null);
  }

  // Process transcripts
  if (inputs.transcripts && Array.isArray(inputs.transcripts)) {
    for (const t of inputs.transcripts) {
      insertInput.run(assessmentId, 'transcript', t.label || 'Call Transcript', t.content, null, null);
    }
  }
  // Legacy: single transcript
  if (inputs.transcript) {
    insertInput.run(assessmentId, 'transcript', 'Call Transcript', inputs.transcript, null, null);
  }

  // Process notes
  if (inputs.notes && Array.isArray(inputs.notes)) {
    for (const n of inputs.notes) {
      insertInput.run(assessmentId, 'notes', n.label || 'Analyst Notes', n.content, null, null);
    }
  }
  // Legacy: single manual_notes
  if (inputs.manual_notes) {
    insertInput.run(assessmentId, 'notes', 'Analyst Notes', inputs.manual_notes, null, null);
  }

  // Fetch URLs
  if (inputs.urls && Array.isArray(inputs.urls)) {
    for (const url of inputs.urls) {
      const urlStr = typeof url === 'string' ? url : url.url;
      if (!urlStr) continue;
      console.log(`[Assessment] Fetching URL: ${urlStr}`);
      // The Exa key lets the crawler render client-rendered sites. Roughly half the
      // startup sites worth assessing are unreadable without it — cadrian.ai and
      // avanthealth.com both return ~0 chars to a plain fetch. Resolved per-user, same
      // BYOK contract as everything else; absent, the crawler degrades to reporting the
      // site as unreadable rather than scoring an empty page.
      const fetched = await fetchUrlContent(urlStr, { exaKey: userKeys.exa });
      if (fetched.error) {
        console.warn(`[Assessment] URL fetch failed for ${urlStr}: ${fetched.error}`);
        insertInput.run(assessmentId, 'url', `${fetched.title || urlStr} (fetch failed)`, `Failed to fetch: ${fetched.error}`, urlStr, null);
        ingestionProblems.push({ kind: 'url', label: urlStr, reason: fetched.error });
      } else if (!fetched.text || fetched.text.trim().length < 200) {
        // The fetcher is a raw GET with a regex tag-strip and no JS rendering, so a
        // React/Next marketing site returns a near-empty shell and reports success.
        // An empty "success" is a failure — say so instead of scoring the shell.
        const reason = `returned only ${(fetched.text || '').trim().length} chars — the page is probably client-rendered and we cannot read it`;
        insertInput.run(assessmentId, 'url', `${fetched.title || urlStr} (fetch failed)`, `Failed to fetch: ${reason}`, urlStr, null);
        ingestionProblems.push({ kind: 'url', label: urlStr, reason });
        console.warn(`[Assessment] URL fetch empty for ${urlStr}: ${reason}`);
      } else {
        insertInput.run(assessmentId, 'url', fetched.title || urlStr, fetched.text, urlStr, null);
      }
    }
  }
  // Legacy: single website_content
  if (inputs.website_content) {
    insertInput.run(assessmentId, 'url', 'Company Website', inputs.website_content, null, null);
  }

  // Record ingestion problems on the assessment itself so the UI can show them.
  // This is what finally makes the (previously dead) suspect banner fire.
  if (ingestionProblems.length) {
    const reason = ingestionProblems.map(p => `${p.label}: ${p.reason}`).join(' · ');
    db.prepare("UPDATE opportunity_assessments SET deck_status = 'suspect', deck_status_reason = ? WHERE id = ?").run(reason, assessmentId);
  } else {
    db.prepare("UPDATE opportunity_assessments SET deck_status = 'ok', deck_status_reason = NULL WHERE id = ?").run(assessmentId);
  }

  // Now build context and run agents
  db.prepare("UPDATE opportunity_assessments SET status = 'running' WHERE id = ?").run(assessmentId);
  await runAssessmentAgents(assessmentId, founderId);
}

async function processRerunInputs(newAssessmentId, oldAssessmentId, newInputs, founderId) {
  const insertInput = db.prepare('INSERT INTO assessment_inputs (assessment_id, input_type, label, content, source_url, file_name) VALUES (?, ?, ?, ?, ?, ?)');

  // Copy all inputs from previous assessment
  const oldInputs = db.prepare('SELECT * FROM assessment_inputs WHERE assessment_id = ?').all(oldAssessmentId);
  for (const inp of oldInputs) {
    insertInput.run(newAssessmentId, inp.input_type, inp.label, inp.content, inp.source_url, inp.file_name);
  }

  // Add new inputs on top
  await processInputsAndRun(newAssessmentId, newInputs || {}, founderId, oldAssessmentId);
}

async function runAssessmentAgents(assessmentId, founderId) {
  // Get assessment's owner — used both for scoped queries and to bill the run to
  // the owner's Anthropic key (not the platform key).
  const assessmentOwner = db.prepare('SELECT created_by FROM opportunity_assessments WHERE id = ?').get(assessmentId);
  const ownerId = assessmentOwner?.created_by;

  const client = anthropicFor(ownerId, 'assessment');
  if (!client) {
    db.prepare("UPDATE opportunity_assessments SET status = 'error' WHERE id = ?").run(assessmentId);
    return;
  }

  const signal = runManager.register(assessmentId);

  try {
    // Build context from all assessment_inputs
    const allInputs = db.prepare('SELECT * FROM assessment_inputs WHERE assessment_id = ? ORDER BY input_type, id').all(assessmentId);

    // ── Budget-aware context assembly ──
    // Old behavior sliced the concatenation at 150K, which could cut a recent call
    // transcript mid-sentence (or drop it entirely) just because decks came first.
    // Instead we build prioritized blocks and fill a budget highest-priority first,
    // so the freshest founder voice (transcripts, recent calls, decks) is protected
    // and the lowest-value material (old CRM notes) is what gets trimmed — and we
    // log exactly what was truncated or dropped rather than failing silently.
    const inputsByType = {};
    for (const inp of allInputs) {
      if (!inputsByType[inp.input_type]) inputsByType[inp.input_type] = [];
      inputsByType[inp.input_type].push(inp);
    }

    const blocks = [];
    (inputsByType.transcript || []).forEach((t, i) => blocks.push({ priority: 1, label: `CALL TRANSCRIPT ${i + 1}: ${t.label || 'Meeting Notes'}`, content: t.content || '' }));
    (inputsByType.deck || []).forEach((d, i) => blocks.push({ priority: 2, label: `PITCH DECK ${i + 1}: ${d.label || d.file_name || 'Untitled'}`, content: d.content || '' }));
    (inputsByType.url || []).forEach((u) => blocks.push({ priority: 3, label: `WEBSITE${u.source_url ? ': ' + u.source_url : ''}`, content: u.content || '' }));
    (inputsByType.notes || []).forEach((n, i) => blocks.push({ priority: 3, label: `ANALYST NOTES ${i + 1}: ${n.label || ''}`, content: n.content || '' }));

    // Pull founder data if linked — scoped to assessment owner
    let founderContext = '';
    if (founderId && ownerId) {
      const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ?').get(founderId, ownerId);
      if (founder) {
        founderContext = `\nFounder: ${founder.name}\nCompany: ${founder.company || 'Unknown'}\nRole: ${founder.role || 'Founder'}\nLocation: ${founder.location_city || ''} ${founder.location_state || ''}\nStage: ${founder.stage || 'Pre-seed'}\nDomain: ${founder.domain || 'Unknown'}\nLinkedIn: ${founder.linkedin_url || 'N/A'}\nBio: ${founder.bio || 'N/A'}\nPrevious companies: ${founder.previous_companies || 'N/A'}\nNotable background: ${founder.notable_background || 'N/A'}`;

        // Recent CRM calls — high priority (founder's own words), newest first.
        const calls = db.prepare('SELECT structured_summary, raw_transcript FROM call_logs WHERE founder_id = ? ORDER BY created_at DESC LIMIT 5').all(founderId);
        calls.forEach((call, i) => {
          const text = call.structured_summary || call.raw_transcript;
          if (text) blocks.push({ priority: 2, label: `PREVIOUS CALL ${i + 1} (from CRM, newest first)`, content: text });
        });

        // CRM notes — lowest priority; trimmed first under budget pressure.
        const notes = db.prepare('SELECT content FROM founder_notes WHERE founder_id = ? ORDER BY created_at DESC LIMIT 10').all(founderId);
        if (notes.length > 0) {
          blocks.push({ priority: 4, label: 'CRM NOTES (newest first)', content: notes.map(n => n.content).join('\n---\n') });
        }
      }
    }

    const assembled = assembleContext(founderContext, blocks, 150000);
    const cappedContext = assembled.context;
    if (assembled.notes.length) {
      console.warn(`[Assessment ${assessmentId}] context assembly: ${assembled.notes.join('; ')}`);
    }
    // Persist what got truncated or dropped. This used to be console.warn-only, so a
    // transcript could be cut in half and the reader would never know. It is now the
    // source for the "what we didn't look at" section.
    db.prepare('UPDATE opportunity_assessments SET context_notes = ? WHERE id = ?')
      .run(assembled.notes.length ? JSON.stringify(assembled.notes) : null, assessmentId);

    // ── Evidence rung — computed from the inputs, never from the model ──
    // This is the gate that stops Stu scoring a marketing page with the same
    // authority as a deck plus two transcripts.
    const evidence = computeEvidenceRung(allInputs);
    db.prepare('UPDATE opportunity_assessments SET evidence_rung = ?, evidence_output = ? WHERE id = ?')
      .run(evidence.rung, JSON.stringify(evidence), assessmentId);
    console.log(`[Assessment ${assessmentId}] evidence rung ${evidence.rung} (${evidence.label}); dropped ${evidence.dropped.length} input(s)`);

    const AGENT_PROMPTS = require('../agents/prompts');

    // Meeting Prep is a single briefing pass, not the 4-agent investability eval — branch
    // out here and skip team/product/market/bear/synthesis entirely. Stored in
    // synthesis_output like everything else (contextual meaning per assessment_type).
    const assessmentRow = db.prepare('SELECT assessment_type FROM opportunity_assessments WHERE id = ?').get(assessmentId);
    if (assessmentRow?.assessment_type === 'meeting_prep') {
      try {
        const brief = await runAgent(client, AGENT_PROMPTS.meetingPrep, cappedContext, signal);
        if (signal.aborted) return;
        db.prepare(`UPDATE opportunity_assessments SET
          synthesis_output = ?, status = 'complete', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JSON.stringify(brief), assessmentId);
      } catch (err) {
        if (signal.aborted) return;
        console.error('[Assessment] Meeting prep error:', err);
        db.prepare("UPDATE opportunity_assessments SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(assessmentId);
      }
      return;
    }

    // ── The rubric runs FIRST, alone. Then the depth layer fans out. ──
    //
    // `founderRubric` scores the four movements of the canonical Founder Rubric and is
    // the ONLY input to the conviction score. (It used to be a manual button on a
    // separate tab running the archived 9-trait rubric, so the fund's actual evaluation
    // framework never ran unless you knew to click it.)
    //
    // It is not in the parallel batch, for a reason a live end-to-end run taught me:
    // firing everything at once made the rubric — the one agent whose output IS the
    // verdict — time out competing with the others for the rate limit. It completes in
    // ~60s when it isn't fighting them. Giving the critical path a clean shot costs ~60s
    // of wall clock and buys the thing actually working.
    //
    // If the rubric dies there is no SCORE — but the room still runs. Under the rescope
    // the nine lenses + the bucketed agenda are a real deliverable on their own (that is
    // exactly what an indeterminate read produces), so a dead rubric yields "no score,
    // here is the room and the agenda", not a skipped depth layer.
    const settle = (r, name) =>
      r.status === 'fulfilled' ? r.value : { error: r.reason?.message || `${name} agent failed` };

    const [rubricResult] = await Promise.allSettled([
      runAgent(client, AGENT_PROMPTS.founderRubric, cappedContext, signal),
    ]);
    if (signal.aborted) {
      console.log(`[Assessment] Run ${assessmentId} was cancelled`);
      return;
    }
    const rubricOut = settle(rubricResult, 'Founder Rubric');
    if (rubricOut.error) {
      console.error(`[Assessment ${assessmentId}] rubric agent failed (${rubricOut.error}) — no conviction score; the room + agenda still run as the deliverable`);
    }

    // ── The room: nine named lenses ──
    // The depth layer is no longer three generic agents (Team/Product/Market prose).
    // It is a panel of nine distinct investor lenses that ARE the analysis. Eight named
    // traditions run here; The Bear is the ninth and runs alongside because it alone
    // supplies bear_adjustment into conviction. They inform the reader; they do not
    // decide the number. Run under a bounded pool so nine concurrent calls don't lose
    // the rate-limit fight (the same lesson that isolated the rubric above).
    const roomThunks = [
      ...AGENT_PROMPTS.LENSES.map((lens) => () => runAgent(client, lens.prompt, cappedContext, signal)),
      () => runAgent(client, AGENT_PROMPTS.bear, cappedContext, signal),
    ];
    const roomResults = await runPool(roomThunks, 4);

    if (signal.aborted) {
      console.log(`[Assessment] Run ${assessmentId} was cancelled`);
      return;
    }

    // Stamp each lens's identity (key/label/weighs) onto its card so the panel is
    // self-describing on read-back, and so an errored lens still shows WHO went dark
    // rather than a nameless gap. Order matches AGENT_PROMPTS.LENSES.
    const panel = AGENT_PROMPTS.LENSES.map((lens, i) => {
      const card = settle(roomResults[i], lens.label);
      return { key: lens.key, label: lens.label, weighs: lens.weighs, ...card };
    });
    const bearOut = settle(roomResults[AGENT_PROMPTS.LENSES.length], 'The Bear');

    // The Bear is the ninth voice in the room AND the risk pass that feeds the score.
    // agentOutputs carries only what conviction + the tested arithmetic touch (bear,
    // rubric); the panel is the depth surface and is stored separately.
    const agentOutputs = { bear: bearOut, rubric: rubricOut };

    // ── A voice that died is an ERROR, not a low score ──
    // An infrastructure failure must never look like a negative judgment (the old
    // `(teamScore || 0) * 0.45` bug). A lens that honestly ABSTAINED (applies:false)
    // is NOT a failure — only a lens carrying `.error` is. Surface real failures.
    const failedVoices = [
      ...panel.filter((l) => l.error).map((l) => `${l.label} (${l.error})`),
      ...(bearOut.error ? [`The Bear (${bearOut.error})`] : []),
      ...(rubricOut.error ? [`Founder Rubric (${rubricOut.error})`] : []),
    ];
    if (failedVoices.length) {
      console.error(`[Assessment ${assessmentId}] voices failed: ${failedVoices.join('; ')}`);
    }
    // The rubric agent IS the conviction. If it died, there is no conviction to report —
    // and we must not fall back to a number that looks like a judgment.
    const rubricFailed = !!(rubricOut && rubricOut.error);

    // ── Deterministic score computation ──
    // LLMs can't do arithmetic reliably. The only number here is the bear clamp — the
    // lenses don't score. correctPillarScores is null-safe on the absent team/product/
    // market and just clamps bear_adjustment to [-1.5, 0].
    correctPillarScores(agentOutputs);

    // ── Trust layer: verify every quote against the source context ──
    // Same deterministic gate for the panel as for the rubric and bear: classify each
    // lens's quotes verbatim/paraphrased/unverified and flag invented numbers. Does not
    // change any score; it lets the reader trust (or distrust) each lens's evidence.
    try {
      const { verifyAllAgents, verifyPanel } = require('../agents/verify');
      verifyAllAgents(agentOutputs, cappedContext); // bear + rubric
      verifyPanel(panel, cappedContext);            // the nine lens cards
    } catch (e) {
      console.warn('[Assessment] quote verification skipped:', e.message);
    }

    // Save the depth surface. panel_output is the new home for the room; bear/rubric
    // keep their columns (bear feeds the score, rubric IS the score). The three
    // mis-named legacy columns (founder_/market_/economics_agent_output = Team/Product/
    // Market) are left NULL on new runs — the panel replaced them. Read-back prefers
    // panel_output and falls back to those columns for pre-panel assessments.
    db.prepare(`UPDATE opportunity_assessments SET
      panel_output = ?, bear_agent_output = ?, rubric_output = ?,
      founder_agent_output = NULL, market_agent_output = NULL, economics_agent_output = NULL,
      pattern_agent_output = NULL, status = 'synthesizing'
      WHERE id = ?
    `).run(JSON.stringify(panel), JSON.stringify(bearOut), JSON.stringify(rubricOut), assessmentId);

    if (signal.aborted) return;

    // ── Conviction, computed in code ──
    // The rubric agent supplies judgment on the four movements. Everything numeric
    // happens here. Note the order: conviction is decided BEFORE synthesis runs, and
    // is then handed to synthesis as a fact. The old flow let the synthesis agent
    // propose a score and then overwrote it, which meant the prose was written to
    // justify a number that changed underneath it.
    //
    // The dead-market dock now comes from the Unit-Economics Skeptic (Gurley) lens,
    // which inherited that one load-bearing boolean from the retired market agent.
    const gurley = panel.find((l) => l.key === 'unit_economics') || {};
    const conviction = computeConviction({
      movements: rubricFailed ? {} : (rubricOut?.movements || {}),
      rung: evidence.rung,
      marketRisk: {
        // Pass the RAW value — computeConviction's isTrue() coerces true/"true"/1/"1".
        // Pre-coercing here with `=== true` would silently drop a dead-market signal the
        // model emitted as the string "true", which is exactly the dock this feeds.
        structurally_dead: gurley.structurally_dead,
        note: gurley.dead_market_note || null,
      },
      bearAdjustment: bearOut?.bear_adjustment ?? 0,
      flags: (rubricFailed ? {} : rubricOut?.flags) || {},
    });
    if (rubricFailed) {
      conviction.determinate = false;
      conviction.score = null;
      conviction.band = null;
      conviction.reason = `The Founder Rubric agent failed (${rubricOut.error}). No conviction score — this is a system failure, not a judgment about the company. Re-run.`;
    }

    db.prepare('UPDATE opportunity_assessments SET conviction_output = ?, conviction_score = ?, conviction_band = ? WHERE id = ?')
      .run(
        JSON.stringify(conviction),
        conviction.determinate ? conviction.score : null,
        conviction.determinate ? conviction.band.key : 'indeterminate',
        assessmentId
      );
    console.log(`[Assessment ${assessmentId}] conviction: ${conviction.determinate ? `${conviction.score} (${conviction.band.label})` : 'INDETERMINATE — ' + conviction.reason}`);

    // Chair the room: the panel synthesizer writes the IC summary AND the diligence
    // agenda (every lens's questions, deduped and bucketed by owner). It explains the
    // already-decided conviction; it cannot move the number (correctSynthesisScores
    // stamps the code's verdict over anything the model emitted).
    try {
      const synthesis = await runPanelSynthesis(client, AGENT_PROMPTS.panelSynthesis, panel, bearOut, cappedContext, signal, conviction);
      if (signal.aborted) return;

      // Override synthesis scores with deterministic computation. agentOutputs has no
      // team/product/market — correctSynthesisScores reports those pillars as null.
      correctSynthesisScores(synthesis, agentOutputs, conviction);

      // The bucketed agenda gets its own column so the UI and the vault export can
      // render it as a first-class deliverable, not buried inside the summary blob.
      // NORMALIZE top_priorities into it: panelSynthesis's schema puts top_priorities as
      // a SIBLING of agenda, but the model sometimes nests it inside. Fold it in from
      // wherever it landed so agenda_output always carries it — otherwise the memo's
      // Conditions section and the UI's "start here" both read agenda.top_priorities and
      // silently get nothing.
      const rawAgenda = synthesis.agenda && typeof synthesis.agenda === 'object' ? synthesis.agenda : null;
      const agenda = rawAgenda
        ? {
            ...rawAgenda,
            top_priorities: (Array.isArray(rawAgenda.top_priorities) && rawAgenda.top_priorities.length)
              ? rawAgenda.top_priorities
              : (Array.isArray(synthesis.top_priorities) ? synthesis.top_priorities : []),
          }
        : null;

      // A synthesis that couldn't be parsed (returns {error} without throwing) has no
      // summary and no agenda — it must not read as a clean 'complete'. Treat it like a
      // failed voice so the header shows "partial" rather than a finished assessment.
      const synthesisFailed = !!synthesis.error;
      if (synthesisFailed) console.error(`[Assessment ${assessmentId}] panel synthesis failed to parse — marking partial`);

      db.prepare(`UPDATE opportunity_assessments SET
        synthesis_output = ?, agenda_output = ?, overall_signal = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        JSON.stringify(synthesis),
        agenda ? JSON.stringify(agenda) : null,
        synthesis.overall_signal,
        // A voice that died — or a synthesis that couldn't be read — must not masquerade
        // as a completed assessment.
        (failedVoices.length || synthesisFailed) ? 'partial' : 'complete',
        assessmentId
      );
    } catch (err) {
      if (signal.aborted) return;
      console.error('[Assessment] Synthesis error:', err);
      db.prepare("UPDATE opportunity_assessments SET status = 'partial', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(assessmentId);
    }
  } finally {
    runManager.cleanup(assessmentId);
  }
}

// ══════════════════════════════════════════════════════════
// Deterministic Score Computation
// LLMs hallucinate arithmetic. All scores are computed here.
// ══════════════════════════════════════════════════════════

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Fill a character budget with prioritized blocks (priority 1 = most important).
// High-priority blocks get budget first; a block that would overflow is truncated
// with an explicit marker; anything that can't fit is dropped and reported. Never
// cuts silently mid-stream the way a naive slice() did.
function assembleContext(header, blocks, budget = 150000) {
  const notes = [];
  let out = header || '';
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
  for (const b of sorted) {
    const piece = `\n\n--- ${b.label} ---\n`;
    const remaining = budget - out.length - piece.length;
    if (remaining <= 200) {
      notes.push(`dropped "${b.label}" (budget exhausted)`);
      continue;
    }
    let content = b.content || '';
    if (content.length > remaining) {
      const cut = content.length - remaining;
      content = content.slice(0, remaining) + `\n[... ${cut} chars truncated for length ...]`;
      notes.push(`truncated "${b.label}" by ${cut} chars`);
    }
    out += piece + content;
  }
  return { context: out, notes };
}

function computeTeamPillarScore(subs) {
  if (!subs) return null;
  // Founder-Problem Fit and Sales Capability carry 2x weight
  const weights = {
    founder_problem_fit: 2,
    sales_capability: 2,
    velocity: 1,
    storytelling_framing: 1,
    team_composition: 1,
    competitive_precision: 1,
    missionary_conviction: 1,
    // Legacy names (backward compat with old assessments)
    founder_market_fit: 1,
    idea_maze: 1,
    experience_stage_fit: 1,
  };
  let totalWeight = 0, totalScore = 0;
  for (const [key, w] of Object.entries(weights)) {
    const sub = subs[key];
    if (sub && typeof sub.score === 'number') {
      totalScore += sub.score * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? round1(totalScore / totalWeight) : null;
}

function computeSimplePillarScore(subs) {
  if (!subs) return null;
  const scores = Object.values(subs)
    .filter(s => s && typeof s.score === 'number')
    .map(s => s.score);
  if (scores.length === 0) return null;
  return round1(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeMarketPillarScore(subs) {
  if (!subs) return null;
  // Simple average, but exclude neutral_layer_viability if N/A or empty
  const scores = [];
  for (const [key, sub] of Object.entries(subs)) {
    if (!sub || typeof sub.score !== 'number') continue;
    if (key === 'neutral_layer_viability') {
      const ev = (sub.evidence || '').trim();
      if (ev.toLowerCase() === 'n/a' || ev === '') continue;
    }
    scores.push(sub.score);
  }
  if (scores.length === 0) return null;
  return round1(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeProductPillarScore(subs) {
  if (!subs) return null;
  // Product velocity and customer proximity carry 2x weight
  // (mirrors team weighting: demonstrated traction matters most)
  const weights = {
    product_velocity: 2,
    customer_proximity: 2,
    focus_prioritization: 1,
    moat_architecture: 1,
    flywheel_design: 1,
    // Legacy names (backward compat with old assessments)
    technical_defensibility: 1,
    product_market_intuition: 1,
  };
  let totalWeight = 0, totalScore = 0;
  for (const [key, w] of Object.entries(weights)) {
    const sub = subs[key];
    if (sub && typeof sub.score === 'number') {
      totalScore += sub.score * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? round1(totalScore / totalWeight) : null;
}

function correctPillarScores(agentOutputs) {
  // Team: weighted average (FPF and Sales 2x)
  if (agentOutputs.team && agentOutputs.team.subcategories) {
    const computed = computeTeamPillarScore(agentOutputs.team.subcategories);
    if (computed !== null) {
      agentOutputs.team.pillar_score = computed;
      if (agentOutputs.team.verdict) {
        agentOutputs.team.verdict.score = computed;
      }
    }
  }
  // Product: weighted average (velocity and proximity 2x)
  if (agentOutputs.product && agentOutputs.product.subcategories) {
    const computed = computeProductPillarScore(agentOutputs.product.subcategories);
    if (computed !== null) agentOutputs.product.pillar_score = computed;
  }
  // Market: simple average (with neutral_layer_viability exclusion)
  if (agentOutputs.market && agentOutputs.market.subcategories) {
    const computed = computeMarketPillarScore(agentOutputs.market.subcategories);
    if (computed !== null) agentOutputs.market.pillar_score = computed;
  }
  // Bear: clamp adjustment to [-1.5, 0]. Nothing else.
  //
  // Removed: the traction-based bear ceiling. It capped the bear's penalty at -0.5
  // when team and product both scored high, on the theory that "the bear agent
  // consistently overweights theoretical risks for companies with real traction."
  // The problem is what fed those high scores — a MANDATORY SCORING RULE forced
  // product_velocity and customer_proximity to 8 whenever the model read "paying
  // customers" on a slide. So an unverified sentence in a deck manufactured the
  // traction, the traction tripped the ceiling, and the ceiling silenced the one
  // agent whose entire job is to check the others. If the bulls are wrong together,
  // the bear has to be able to say so.
  //
  // Removed: the pre-product floor (bear <= -0.7 when velocity < 5). It punished
  // thin evidence as though it were a finding. Thin evidence is now handled honestly
  // by the evidence rung, which withholds the score instead of deducting from it.
  if (agentOutputs.bear && typeof agentOutputs.bear.bear_adjustment === 'number') {
    agentOutputs.bear.bear_adjustment = round1(Math.max(-1.5, Math.min(0, agentOutputs.bear.bear_adjustment)));
  }
}

// The conviction score is computed by server/lib/conviction.js from the Founder
// Rubric's four movements. This function's job is only to stamp that result onto
// the synthesis object and stop the LLM from contradicting it.
//
// What changed and why:
//   - The old weighted score was Team 45% + Product 25% + Market 30%. The canonical
//     Founder Rubric weights Earned Insight and Learning Velocity highest and treats
//     Market as a WEIGHED RISK NOTE, not a third of the number. Stu's weights were
//     the drift; the rubric is the spec.
//   - `(teamScore || 0)` is gone. A dead agent used to silently contribute 0 and flip
//     the verdict to Pass.
//   - The ±1 synthesis override is gone. The synthesis agent no longer gets a vote on
//     the number — it explains the number. An LLM that can move its own score by a
//     point can reach any conclusion it likes and then narrate backwards to it.
//   - Invest/Monitor/Pass is gone, replaced by the rubric's four bands. The old three
//     collapsed 7.0-10.0 into one "Invest", erasing the anchor-vs-memo call.
function correctSynthesisScores(synthesis, agentOutputs, conviction) {
  // Pillar scores are retained as the DEPTH layer — useful reading, not the verdict.
  synthesis.pillar_scores = {
    team: agentOutputs.team?.pillar_score ?? null,
    product: agentOutputs.product?.pillar_score ?? null,
    market: agentOutputs.market?.pillar_score ?? null,
  };
  synthesis.bear_adjustment = agentOutputs.bear?.bear_adjustment ?? 0;

  // The verdict comes from conviction and nowhere else.
  synthesis.conviction = conviction;
  synthesis.overall_score = conviction.determinate ? conviction.score : null;
  synthesis.score_calculation = conviction.calculation;

  if (conviction.determinate) {
    synthesis.overall_signal = conviction.band.label; // Anchor-grade | Top-quartile | Monitor | Pass with respect
    synthesis.recommended_next_step = conviction.band.action;
  } else {
    // Not a judgment about the company — a statement about what we know.
    synthesis.overall_signal = 'Insufficient evidence';
    synthesis.recommended_next_step = conviction.rung < 3 ? 'Take the call' : 'Re-run';
    synthesis.insufficient_evidence_reason = conviction.reason;
  }

  // The synthesis agent is asked for prose, not arithmetic. If it invented an
  // override anyway, drop it rather than let it sit in the JSON looking meaningful.
  delete synthesis.override;
  return synthesis;
}

function robustJsonParse(text) {
  // Try direct parse first
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let raw = jsonMatch[0];

  // Step 0: Replace smart quotes with regular quotes
  raw = raw.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  // Step 1: Try direct parse
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Step 2: Fix trailing commas
    let fixed = raw.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Step 3: Fix unescaped control characters and quotes in strings
      // Replace literal newlines/tabs inside strings with escaped versions
      fixed = fixed.replace(/[\x00-\x1F]/g, (ch) => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return '';
      });
      try {
        return JSON.parse(fixed);
      } catch (e3) {
        // Step 4: Aggressive repair - try to fix unescaped quotes in string values
        // Find string values and escape internal quotes
        fixed = fixed.replace(/"([^"]*?)"/g, (match, content) => {
          // If content itself contains unescaped quotes, escape them
          const escaped = content.replace(/(?<!\\)"/g, '\\"');
          return `"${escaped}"`;
        });
        try {
          return JSON.parse(fixed);
        } catch (e4) {
          console.error('[Assessment] JSON parse failed after all repair attempts:', e4.message);
          console.error('[Assessment] First 300 chars around error:', raw.substring(0, 300));
          return { error: e4.message };
        }
      }
    }
  }
}

// Anthropic call with retry + backoff on TRANSIENT errors (overloaded / rate-limit / timeout /
// 5xx / network). A single blip on the synthesis call used to nuke a whole assessment to
// "partial" AFTER all four agents (the expensive part) had already succeeded. This makes the
// run resilient. Non-transient errors (e.g. 400) throw immediately — retrying won't help.
async function anthropicCreateWithRetry(client, params, { attempts = 3, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await client.messages.create(params); }
    catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const transient = !status || status === 408 || status === 429 || status >= 500 ||
        /overloaded|rate.?limit|timeout|ETIMEDOUT|ECONNRESET|ENETUNREACH|socket hang up|fetch failed/i.test(err?.message || '');
      if (!transient || i === attempts - 1) throw err;
      const delay = baseDelay * Math.pow(2, i); // 1.5s → 3s → 6s
      console.warn(`[Assessment] Anthropic call failed (${status || err.message}); retry ${i + 1}/${attempts - 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── On prompt caching: deliberately NOT used here ──
// The obvious idea is to cache the 150K-char context, since all five agents read the
// identical block. I implemented it, then did the arithmetic and took it back out.
// Two reasons it cannot work in this shape:
//
//   1. Caching matches on PREFIX. Each agent has a different system prompt, and the
//      system block sits ahead of the context. So the five agents never share a cache
//      entry — each one would only ever hit its own previous run.
//   2. The agents run in PARALLEL. All five requests start before any cache write has
//      landed, so all five miss on every first run — and a cache write bills at 1.25x
//      base input. Caching here does not make a run cheaper; it makes it ~18% dearer.
//
// Making it actually pay would mean restructuring so an identical prefix (house rules +
// context) precedes the agent-specific instructions, AND serializing one agent to prime
// the cache before fanning out the other four — trading ~60s of wall clock for ~$0.38.
// Stu has run six assessments in its lifetime, so that is ~$2 of savings for real
// latency and real complexity. Not worth it. Revisit if volume ever justifies it.
async function runAgent(client, prompt, context, signal, retries = 1) {
  const response = await anthropicCreateWithRetry(client, {
    model: ASSESSMENT_MODEL,
    max_tokens: AGENT_MAX_TOKENS,
    temperature: SCORING_TEMPERATURE,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user(context) }],
  });

  const text = response.content[0].text.trim();
  const parsed = robustJsonParse(text);
  if (parsed && !parsed.error) return parsed;

  // Retry once on parse failure
  if (retries > 0) {
    console.warn('[Assessment] JSON parse failed, retrying agent...');
    return runAgent(client, prompt, context, signal, retries - 1);
  }

  if (parsed) return parsed; // Return error object
  return { raw: text, error: 'Could not parse JSON output' };
}

// ══════════════════════════════════════════════════════════
// Steward-Operator Rubric (post-synthesis diagnostic layer)
// ══════════════════════════════════════════════════════════

function safeParse(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

// (Removed: buildContextFromInputs + runStewardOperator — the archived 9-trait rubric
// runner and its private naive-slice context builder. The Founder Rubric now runs
// inline in the main batch and uses the budget-aware assembleContext.)

async function runSynthesis(client, prompt, agentOutputs, context, signal, conviction) {
  const response = await anthropicCreateWithRetry(client, {
    model: ASSESSMENT_MODEL,
    max_tokens: AGENT_MAX_TOKENS,
    temperature: SCORING_TEMPERATURE,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user(agentOutputs, context, conviction) }],
  });

  const text = response.content[0].text.trim();
  const parsed = robustJsonParse(text);
  if (parsed) return parsed;
  return { raw: text, error: 'Could not parse synthesis' };
}

// Panel synthesis — same call shape as runSynthesis, but the prompt reads the nine
// lens cards + The Bear + the decided conviction (see prompts.js panelSynthesis).
async function runPanelSynthesis(client, prompt, panel, bear, context, signal, conviction) {
  const response = await anthropicCreateWithRetry(client, {
    model: ASSESSMENT_MODEL,
    max_tokens: AGENT_MAX_TOKENS,
    temperature: SCORING_TEMPERATURE,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user(panel, bear, conviction, context) }],
  });

  const text = response.content[0].text.trim();
  const parsed = robustJsonParse(text);
  if (parsed) return parsed;
  return { raw: text, error: 'Could not parse panel synthesis' };
}

// ── POST /api/assessments/:id/push-to-notion — push assessment to Strider Notion ──
router.post('/:id/push-to-notion', async (req, res) => {
  // Verify ownership
  const assessment = db.prepare(
    'SELECT id, founder_id, status, synthesis_output FROM opportunity_assessments WHERE id = ? AND is_deleted = 0 AND created_by = ?'
  ).get(req.params.id, req.user.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  if (!assessment.synthesis_output) return res.status(400).json({ error: `Assessment is not complete (status: ${assessment.status})` });

  try {
    const { pushAssessmentToNotion } = require('../services/notion-assessment-sync');
    const result = await pushAssessmentToNotion(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[AssessmentSync] Push failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/:id/taste-divergence — how this founder sits vs. revealed taste
router.get('/:id/taste-divergence', (req, res) => {
  try {
    const a = db.prepare('SELECT founder_id FROM opportunity_assessments WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!a || !a.founder_id) return res.json({ available: false, reason: 'no linked founder' });
    const f = db.prepare('SELECT tags, caliber_signals, caliber_tier FROM founders WHERE id = ?').get(a.founder_id);
    if (!f) return res.json({ available: false, reason: 'founder not found' });
    res.json(require('../pipeline/taste').tasteDivergence(req.user.id, f));
  } catch (e) { res.status(500).json({ available: false, error: e.message }); }
});

// Export router + internal functions for migrations and tests.
// The scoring functions are exported so the conviction wiring can be tested without
// an LLM call — the arithmetic is the part that must never silently drift.
router._internal = {
  runAssessmentAgents,
  processRerunInputs,
  correctPillarScores,
  correctSynthesisScores,
  assembleContext,
  robustJsonParse,
  runPool,
  buildMemo7M,
  buildDefensibility,
  SCORING_TEMPERATURE,
  ASSESSMENT_MODEL,
};
module.exports = router;
