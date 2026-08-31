// ══════════════════════════════════════════════════════════════════════════
// Pipeline — the front door, and the one connected read.
//
// Danny, verbatim and repeatedly: "I want to transition Stu into being my
// personal Affinity/Harmonic (sourcing, tracking, assessing). And then I publish
// memos in Obsidian for opportunities that warrant it."
//
// That is ONE sentence about ONE object. Stu had four screens pretending it had
// four objects: a sourced founder, a founder, and an assessment were three
// tables that didn't know about each other, so approving someone from Discover
// turned them into a different record and nothing carried forward.
//
// ── WHY THERE IS NO `companies` TABLE ──
// The obvious fix is a companies/people migration. It was priced at 10-15 days
// and it is a trap wearing a feature's clothes. It is also unnecessary:
// `founders` is already the spine, and every other table already points at it.
// One record means every stage JOINS to founders — which is what this file does.
// Measured before deciding (2026-07-15): 187 live founders, 5,328 soft-deleted.
// The scary "5,513 rows / 1,841 fuzzy company strings" the rebuild brief priced
// the migration against is 96% deleted junk. There is no dedupe project here.
// Do not start one.
//
// ── THE COLUMNS, AND WHY THESE ONES ──
// Company · Stage · Source · Read (Stu) · Call (Danny) · Owed · Signal
//
// READ and CALL are two columns that never merge. Stu's band and Danny's band
// sit side by side, and the DISAGREEMENT is the artifact — it's the only dataset
// in this product that compounds, and the only question no tool he can buy is
// able to answer, because answering it needs a record of what he thought before
// he knew.
//
// ── COLUMNS DELIBERATELY ABSENT ──
// "Who knows them" is Affinity's whole $2,000/user/year product and it needs a
// relationship graph that does not exist in this database yet. "Last contact" is
// worse than absent — it's fake: every live founder's updated_at is 2026-03-18,
// the Airtable import. Shipping either as an empty or lying column would teach
// Danny to distrust the row. They arrive when their data does.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const { pickShortlist } = require('../lib/morningList');
const router = express.Router();
const db = require('../db');
const vocab = require('../lib/airtableVocab');
const airtableSync = require('../services/airtable-sync');

// One query. Every stage of the funnel joined to the spine.
//
// The correlated subqueries look expensive and are not: 187 live rows, every
// join column indexed. Precompute and never spin — Danny should never see a
// loading state on his front door. Measured at ~4ms.
const PIPELINE_SQL = `
  SELECT
    f.id, f.name, f.company, f.company_one_liner, f.stage, f.status,
    f.deal_status, f.admissions_status, f.pipeline_tracks, f.source,
    -- The merged board's axis and badge, plus the Airtable link the card offers.
    f.stage_status, f.airtable_next_step, f.airtable_founder_record_id,
    -- Load-bearing, and this file's third casualty of the same omission. The board
    -- filters folded co-founders on represented_by_founder_id; leaving the column
    -- out of this list made that test read undefined -- truthy-negated for every
    -- row -- so both Permute cards stayed on the board, while the CARD (which
    -- selects f.*) correctly showed Eric as a co-founder. Identical in shape to the
    -- investment_amount and company_linkedin_url scars documented below. If you add
    -- a column the board reasons about, it goes here.
    f.represented_by_founder_id,
    f.chicago_connection, f.caliber_tier, f.next_action, f.arr,
    f.deal_entered_at, f.created_at,
    -- Load-bearing: stageOf() derives the invested stage from this. Omitting it
    -- made every portfolio company silently render as "met", because undefined > 0
    -- is false — the board showed "Invested 0" while the attention engine, which
    -- checks the same fact in SQL, correctly found all 9.
    f.investment_amount, f.valuation, f.round_size, f.security_type,

    -- THE READ. Stu's latest word, and only from a run that actually completed.
    (SELECT a.conviction_score FROM opportunity_assessments a
      WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
        AND a.status IN ('complete','partial')
      ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS stu_score,
    (SELECT a.conviction_band FROM opportunity_assessments a
      WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
        AND a.status IN ('complete','partial')
      ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS stu_band,
    (SELECT a.id FROM opportunity_assessments a
      WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
        AND a.status IN ('complete','partial')
      ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS assessment_id,

    -- THE INSIGHT. Danny, looking at the board: "I just want insights posted there."
    -- The card had a company, a person, and a next step — the shape of the pipeline,
    -- and nothing Stu had ever LEARNED. The band says how much conviction; this says
    -- what the conviction is ABOUT, which is the part he can act on at a glance.
    --
    -- Note this is the synthesis one_liner, NOT f.company_one_liner. Airtable's is the
    -- founder's pitch about themselves ("The trust layer of agentic commerce: Plaid
    -- meets Verisign"). Stu's is the read after listening to them ("Domain insider
    -- building the neutral trust graph... structurally correct thesis"). One is a
    -- claim, the other is a judgment. The card should carry the judgment.
    --
    -- Extracted in SQL rather than by parsing the blob in JS: synthesis_output runs to
    -- hundreds of KB, and a board of 184 rows would ship megabytes of agent JSON to
    -- render one sentence per card.
    (SELECT json_extract(a.synthesis_output, '$.one_liner') FROM opportunity_assessments a
      WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
        AND a.status IN ('complete','partial') AND a.synthesis_output IS NOT NULL
      ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS stu_read,

    -- THE CALL. Danny's. Never computed, never inferred, never defaulted.
    (SELECT d.band FROM decisions d WHERE d.founder_id = f.id
      ORDER BY d.decided_at DESC LIMIT 1) AS my_band,
    (SELECT d.id FROM decisions d WHERE d.founder_id = f.id
      ORDER BY d.decided_at DESC LIMIT 1) AS decision_id,

    -- OWED. Open promises, either direction. The clock only Stu can hold.
    (SELECT COUNT(*) FROM commitments c WHERE c.founder_id = f.id
      AND c.status = 'open' AND c.owed_by = 'them') AS they_owe,
    (SELECT COUNT(*) FROM commitments c WHERE c.founder_id = f.id
      AND c.status = 'open' AND c.owed_by = 'me') AS i_owe,

    -- THE SOURCE CHAIN, back to the inbox row this came from.
    -- Danny: "Source is a chain, not a dropdown." Airtable records only the last
    -- hop, which is why outbound looks like it produces nothing when it is
    -- actually how he fills the top of the funnel.
    (SELECT sf.source FROM sourced_founders sf WHERE sf.promoted_to_founder_id = f.id
      ORDER BY sf.created_at ASC LIMIT 1) AS sourced_via,
    (SELECT sf.id FROM sourced_founders sf WHERE sf.promoted_to_founder_id = f.id
      ORDER BY sf.created_at ASC LIMIT 1) AS sourced_id
    -- His own call on this founder, if he has made one. Selected here rather than
    -- joined in JS so the board can show what he already decided without a second
    -- round trip per row.
    (SELECT t.verdict FROM founder_triage t WHERE t.founder_id = f.id AND t.user_id = ?) AS triage,
    (SELECT t.reason FROM founder_triage t WHERE t.founder_id = f.id AND t.user_id = ?) AS triage_reason
  FROM founders f
  WHERE f.created_by = ? AND f.is_deleted = 0
`;

// ── Is this "founder" actually a person? ──
// The March Airtable import wrote company records into `founders` with the person
// field set to "<Company> (Company)" — Prizm's founder name is literally "Prizm
// (Company)". Rendering that in a Founder column prints the company name twice on
// the same row, which breaks the one-primary-ink rule by making the eye compare
// two identical strings. Suppress rather than repeat.
function personName(row) {
  const n = (row.name || '').trim();
  if (!n) return null;
  if (/\(company\)/i.test(n)) return null;
  const c = (row.company || '').trim().toLowerCase();
  if (c && n.toLowerCase() === c) return null;
  return n;
}

// The funnel, in order. A company's position is DERIVED from what has actually
// happened to it, never stored — a stored stage is a stage that drifts from the
// record, and this database is the proof: all 7 portfolio companies still say
// deal_status='Under Consideration' because nobody edited the field after the
// money moved.
//
//   found -> met -> assessed -> decided -> invested
//
// `invested` is checked FIRST and wins outright. Danny: "If we invest in a company
// before I assess, that's ok." So a portfolio company is never chased for a read —
// it's an outcome, not a gap. Deriving it from investment_amount rather than
// deal_status means it's true the moment the check is recorded, with no field to
// forget to update.
function stageOf(r) {
  if (r.investment_amount > 0) return 'invested';
  if (r.my_band) return 'decided';
  if (r.stu_band) return 'assessed';
  if (r.deal_status === 'Under Consideration') return 'met';
  return 'found';
}

// ── GET /api/pipeline ──
router.get('/', (req, res) => {
  const rows = db.prepare(PIPELINE_SQL).all(req.user.id, req.user.id, req.user.id);

  const {
    track, // 'investment' | 'admissions'
    geo, // 'il' -> Chicago/IL lens. Danny's default; Brandon will ask for the toggle.
    stage,
    q,
  } = req.query;

  let out = rows.map((r) => ({
    ...r,
    // Airtable's stage vocabulary was renamed ("Stage 1: Identified" →
    // "6 · Resident — Identified"). fromLegacyStage was written for exactly this and
    // then never called from anywhere, so every row carrying an old value grouped
    // against a column list that no longer contained it: a board reporting 190 rows
    // with 0 in every column. Normalising on READ fixes the stored rows and any
    // future import that arrives speaking the old dialect.
    stage_status: vocab.fromLegacyStage(r.stage_status) || r.stage_status,
    funnel_stage: stageOf(r),
    person: personName(r),
    // Airtable's words for the badge, derived from Stu's storage. The client never
    // parses the CSV — it would have to know Stu spells "Resident" as "admissions".
    tracks: vocab.tracksFromStu(r.pipeline_tracks),
  }));

  // ── WHO IS ON THE MERGED BOARD ──
  // A card is an opportunity if it has a stage. Airtable gives 161 of them one;
  // backfill-stage-status derives one for the 26 that came from Airtable's separate
  // Investment Pipeline table. Everything else is not pipeline.
  //
  // That "everything else" is 109 rows, and they are worth naming: all created
  // 2026-03-17/18 by the March bulk import, all source='exa', and NOT ONE has a
  // sourced_from_id — meaning not one was ever approved through the Sourcing inbox.
  // Their company names are scraper wreckage ("Kairos\n\nCo", "Chicago Inno 25
  // Under 25\n\nCo", "Full"). They sat in an admissions column called "Sourced",
  // inflating the board with 109 things Danny had never looked at.
  //
  // The fix is NOT to hand them a stage. "Stage 1: Identified" would be a lie —
  // nobody identified them — and it is exactly the pipeline inflation Danny refuses
  // to let this product do. Untriaged sourcing output belongs in Sourcing.
  // `?all=1` still returns them, so nothing is hidden, only un-promoted.
  //
  // 2026-08-31 — THE BANK. Danny: "instead of the kanban to mimic my Airtable, it
  // should be its own bank of the founders I like (and hit add) for in Source. So I
  // can keep track of them. And then move candidates I speak to into Airtable on my
  // own." A founder he APPROVED out of the sourcing inbox is a founder he chose, and
  // choosing is the act this board should record — whether or not Airtable has caught
  // up and given the row a stage yet. Requiring stage_status meant every Add he made
  // in Source vanished until Airtable was updated, which is exactly backwards: Stu is
  // where the choosing happens, Airtable is where the deal-making is tracked.
  //
  // sourced_from_id is the durable mark of that approval — untriaged scout output has
  // none, so this still cannot inflate the board with rows nobody looked at.
  if (req.query.all !== '1') out = out.filter((r) => !!r.stage_status || !!r.sourced_from_id);

  // ── ONE CARD PER COMPANY ──
  // Danny: "Eric Mills and Scott Nelson are both showing for Permute, and Kyle
  // DeSana and Ehren are showing for Siftree... Could we just have Scott and Kyle
  // kept in?"
  //
  // The co-founder isn't deleted — their row points at the card that represents the
  // company, and the card lists them. This board is a board of companies; two cards
  // for Permute is one company printed twice.
  if (req.query.all !== '1') out = out.filter((r) => !r.represented_by_founder_id);

  if (track) out = out.filter((r) => (r.pipeline_tracks || '').includes(track));
  if (geo === 'il') out = out.filter((r) => !!r.chicago_connection);
  if (stage) out = out.filter((r) => r.funnel_stage === stage);
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter(
      (r) =>
        (r.company || '').toLowerCase().includes(needle) ||
        (r.name || '').toLowerCase().includes(needle) ||
        (r.company_one_liner || '').toLowerCase().includes(needle)
    );
  }

  // Default order: the deals that want a decision first, then everything else.
  // NOT by date, and explicitly NOT by score — sorting his board by Stu's number
  // would let the engine set his agenda, which inverts who is assessing whom.
  const rank = { assessed: 0, met: 1, decided: 2, invested: 3, found: 4 };
  out.sort((a, b) => rank[a.funnel_stage] - rank[b.funnel_stage] || (b.stu_score || 0) - (a.stu_score || 0));

  res.json({
    rows: out,
    // The board's vocabulary rides with the board. The client does NOT keep its own
    // copy of the stage list: a second list is a second thing to drift out of sync
    // with Airtable, and drift is precisely what put 22 declined founders back on
    // this board as live prospects. One list, defined once, in lib/airtableVocab.
    vocab: { stages: vocab.STAGES, tracks: vocab.TRACKS, terminal: vocab.TERMINAL_STAGES },
    counts: {
      // Stage counts describe the board so it can be filtered. They are NOT a
      // scoreboard and no view rolls them into a "pipeline size" number —
      // Danny: "I want to inflate my pipeline numbers."
      found: out.filter((r) => r.funnel_stage === 'found').length,
      met: out.filter((r) => r.funnel_stage === 'met').length,
      assessed: out.filter((r) => r.funnel_stage === 'assessed').length,
      decided: out.filter((r) => r.funnel_stage === 'decided').length,
      invested: out.filter((r) => r.funnel_stage === 'invested').length,
    },
    total: out.length,
  });
});

// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// GET /api/pipeline/shortlist — the morning list.
//
// Danny: "a full funnel inbox of top founder candidates AS WELL AS a prioritized,
// ranked list — both updated in the morning before I wake up."
//
// Two surfaces, not one, because they answer different questions. The inbox is
// "everything that cleared the gates, let me sift." The shortlist is "it is 6am,
// who are the ten people worth my attention today." A list you scroll is a queue;
// a list you finish is a decision.
//
// THREE THINGS THIS DOES THAT THE INBOX DOES NOT:
//
//  1. It is CAPPED. Ten, not two hundred. The 101-unread lesson: a wall teaches you
//     to scroll past the thing that matters most.
//  2. It says WHAT KIND of signal each reason is. A prior exit is evidence the
//     founder is good. An elite school is evidence the SERIES A MARKET will like
//     them — those are different claims and rendering them identically is how a
//     fund talks itself into a pedigree portfolio. Markers carry `kind`
//     (quality | graduation | timing) and the row shows it.
//  3. It computes the full marker set for these ten rows only. The stored verdict
//     (lib/fitIndex) holds labels, not kinds, and it exists because scoring 2,000
//     rows per page load was slow. Ten rows is ~5ms, so the shortlist pays for
//     fidelity where it is cheap and reads the index where it is not.
// ══════════════════════════════════════════════════════════════════════════
router.get('/shortlist', (req, res) => {
  const uid = req.user.id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  // When did the scout last run? Reported as-is, for the "scout ran Nh ago" line.
  const lastRun = db.prepare(
    `SELECT ran_at FROM job_runs WHERE job = 'nightly_scout' AND user_id = ?
      ORDER BY ran_at DESC LIMIT 1`
  ).get(uid)?.ran_at || db.prepare(`SELECT datetime('now','-1 day') AS t`).get().t;

  // Step 1 — pick the ids off the INDEX. No blobs touched.
  //
  // Arrivals hold reserved slots, and "new" is measured against the PREVIOUS run's
  // completion rather than this one's. Both are required before a founder sourced
  // last night can appear here at all — lib/morningList.js has the why. Note this
  // does NOT reuse `lastRun` above: that is this run's timestamp, which every row
  // the run inserted predates, and comparing against it is the original bug.
  const { ids: picked, isNew } = pickShortlist(db, uid, limit);

  if (!picked.length) {
    return res.json({ generated_at: new Date().toISOString(), last_run: lastRun, count: 0, founders: [], empty_reason: 'Nothing cleared the gates. That is an answer, not a failure — the scout ran and found no one new worth the top of the list.' });
  }

  // Step 2 — full evaluation, but only for the handful being shown.
  const ff = require('../lib/founderFit');
  const rows = db.prepare(
    `SELECT * FROM sourced_founders WHERE id IN (${picked.map(() => '?').join(',')})`
  ).all(...picked);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const founders = picked.map((id) => {
    const r = byId.get(id);
    if (!r) return null;
    const v = ff.evaluate(r);
    const signals = v.markers.map((m) => ({
      label: m.label,
      kind: m.kind || 'quality',
      evidence: m.evidence,
      structured: !!m.structured,
    }));
    return {
      id: r.id,
      name: r.name,
      company: r.company || null,
      one_liner: r.company_one_liner || r.headline || null,
      role: r.role || null,
      source: r.source || null,
      linkedin_url: r.linkedin_url || null,
      website_url: r.website_url || null,
      github_url: r.github_url || null,
      il_tie: r.chicago_connection || null,
      tier: v.tier,
      why: v.tierReason,
      priority: v.priority,
      stage: v.stage,
      is_new: isNew(r.id),
      signals,
      // The honest split, precomputed so the UI cannot accidentally merge them.
      quality_signals: signals.filter((x) => x.kind === 'quality').length,
      graduation_signals: signals.filter((x) => x.kind === 'graduation').length,
      reachable_now: signals.some((x) => x.kind === 'timing'),
    };
  }).filter(Boolean);

  res.json({
    generated_at: new Date().toISOString(),
    last_run: lastRun,
    count: founders.length,
    new_today: founders.filter((f) => f.is_new).length,
    founders,
  });
});

// GET /api/pipeline/inbox — the connective tissue.
//
// Danny: "I want connective tissue between a high-quality sourcing engine and a
// pipeline tracker (Harmonic meets Affinity)."
//
// This is the seam. Harmonic finds; Affinity tracks; the reason both feel like
// products and Stu didn't is that Stu had a Discover screen whose output went
// nowhere. `sourced_founders` is not a different kind of thing from `founders` —
// it is the SAME company one stage earlier, which is why approve/:id promotes in
// one transaction and writes BOTH pointers (founders.sourced_from_id and
// sourced_founders.promoted_to_founder_id). The chain survives the promotion, so
// "how I found them" is still answerable six months later.
//
// That write path already existed and was good. What did not exist was anywhere
// to stand while using it — which is why all 167 rows are still 'pending'.
// ══════════════════════════════════════════════════════════════════════
router.get('/inbox', (req, res) => {
  const uid = req.user.id;
  const scope = req.query.scope === 'watchlist' ? 'watchlist' : 'pipeline';

  // ── The verdict is READ, not recomputed ──
  // This used to select raw_data / enriched_data / linkedin_data / github_slope_data
  // for every pending row so lib/founderFit could score them, then strip those four
  // columns back out before responding. On production's 2,232 rows that is ~51 MB
  // read and ~1.2 s of single-threaded CPU per page load, paid in full even for the
  // Must-meet view because the tier filter ran after the scoring.
  //
  // lib/fitIndex now writes the same verdict — same function, same evidence gate —
  // at ingest, enrichment and slope time. So this is an ordinary indexed SELECT and
  // not one blob is touched.
  const base = `FROM sourced_founders
    WHERE user_id = ? AND status IN ('pending','starred')
      AND COALESCE(do_not_resurface, 0) = 0
      AND list_scope = ?`;

  // Counts come from the FULL queue, before any filter, so the header can say how
  // many are behind each view and the number can never disagree with the list.
  const counts = db.prepare(`
    SELECT COALESCE(fit_tier, 'none') AS tier, COUNT(*) AS n ${base} GROUP BY 1
  `).all(uid, scope);
  const nOf = (t) => counts.find((c) => c.tier === t)?.n || 0;
  const tierCounts = {
    mustMeet: nOf('must-meet'),
    strong: nOf('strong'),
    all: counts.reduce((a, c) => a + c.n, 0),
  };

  // ── "New folks this morning" ──
  // Danny: "I want to log in in the morning and see new folks!" — answered with the
  // arrival DATE on every row rather than a per-session read/unread state, which is
  // one more thing to get wrong and reset at the wrong moment.
  //
  // The boundary is the last nightly scout, so "new" means "arrived on the most
  // recent run" and stays true all day instead of emptying the moment he blinks. No
  // scout has ever run on some databases, so fall back to the last 24 hours — never
  // to "everything", which would label the whole backlog new.
  const lastScout = db.prepare(
    `SELECT ran_at FROM job_runs WHERE job = 'nightly_scout' AND status IN ('ok','partial')
     ORDER BY ran_at DESC LIMIT 1`
  ).get();
  //
  // ONE boundary, resolved to a concrete timestamp here, used by the count in the
  // header, the "New" filter, and the dot on each row. Deriving it three times is
  // how a header says 23 over a list of 19.
  const newSince = lastScout?.ran_at
    || db.prepare(`SELECT datetime('now','-1 day') AS t`).get().t;
  const newCount = db.prepare(`SELECT COUNT(*) n ${base} AND created_at >= ?`)
    .get(uid, scope, newSince).n;

  // ── Filters ──
  const where = [];
  const params = [uid, scope];
  const tierParam = String(req.query.tier || '');
  if (tierParam === 'must-meet') where.push(`fit_tier = 'must-meet'`);
  else if (tierParam === 'strong') where.push(`fit_tier IN ('must-meet','strong')`);
  else if (String(req.query.meetWorthy) === '1') where.push(`fit_meet = 1`);
  if (String(req.query.hideLate) === '1') where.push(`COALESCE(fit_stage_late, 0) = 0`);
  if (String(req.query.newOnly) === '1') { where.push('created_at >= ?'); params.push(newSince); }

  // ── Order ──
  // 'newest' is one click away because the arrival date is only useful if he can
  // bring today's names to the top with it. 'best' stays the default: quality first,
  // which is what the screen is for the other 23 hours of the day.
  const order = req.query.sort === 'newest'
    ? `created_at DESC, COALESCE(fit_priority, 0) DESC`
    : `CASE fit_tier WHEN 'must-meet' THEN 2 WHEN 'strong' THEN 1 ELSE 0 END DESC,
       CASE WHEN fit_stage = 'earliest' THEN 1 ELSE 0 END DESC,
       COALESCE(fit_priority, 0) DESC,
       created_at DESC`;

  // A page, not the whole table. 200 is well past what anyone triages in a sitting
  // and small enough that the response is a few hundred KB rather than megabytes.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const filterSql = where.length ? ` AND ${where.join(' AND ')}` : '';
  const matched = db.prepare(`SELECT COUNT(*) n ${base}${filterSql}`).get(...params).n;

  const rows = db.prepare(`
    SELECT id, name, company, company_one_liner, role, source, headline,
           confidence_score, confidence_rationale, chicago_connection, location_city,
           location_type, caliber_tier, caliber_score, linkedin_url,
           github_url, website_url, list_scope, status, created_at,
           evidence_map, caliber_signals, builder_signals, pedigree_signals, tags,
           github_slope_score,
           fit_meet, fit_tier, fit_reason, fit_priority, fit_stage, fit_stage_late,
           fit_lifestyle, fit_why, fit_marker_count, fit_scored_at
    ${base}${filterSql}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const scored = rows.map((r) => {
    let why = [];
    try { const v = JSON.parse(r.fit_why || '[]'); if (Array.isArray(v)) why = v; } catch { /* leave empty */ }
    const {
      fit_meet, fit_tier, fit_reason, fit_priority, fit_stage, fit_stage_late,
      fit_lifestyle, fit_why, fit_marker_count, fit_scored_at, ...rest
    } = r;
    return {
      ...rest,
      // is_new is a FACT about the row against the run boundary, computed in one
      // place so the count in the header and the dot on the row can never disagree.
      is_new: r.created_at >= newSince,
      fit: {
        meetWorthy: !!fit_meet,
        tier: fit_tier,
        tierReason: fit_reason,
        priority: fit_priority || 0,
        stage: fit_stage,
        stageTooLate: !!fit_stage_late,
        lifestyle: !!fit_lifestyle,
        why,
        markers: new Array(fit_marker_count || 0),
        // Null means the rubric has not run on this row yet — a brand-new arrival
        // between the scout and the next boot. Say so rather than rendering it as
        // "didn't qualify", which is a different and untrue statement.
        scored: !!fit_scored_at,
      },
    };
  });

  // ── When did the scout last run, and what did it find? ──
  // Danny: "it didn't seem to be sourcing new founders for me on any time
  // interval? I would click 'Find Founders' and it wouldn't really work."
  //
  // It genuinely never ran on a schedule — the cron's readiness gate looked for the
  // Exa key in the environment while it has always lived in user_settings. Fixed in
  // index.js; this reads the one ledger row the nightly scout now writes, falling
  // back to the two older job names so a database mid-upgrade still says something true.
  const { lastRun } = require('../services/health');
  const last = lastRun('nightly_scout', uid)
    || lastRun('early_signal_sources', uid)
    || lastRun('sourcing_run', uid);

  // ══════════════════════════════════════════════════════════════════════
  // "NOT SCHEDULED" MUST NOT LOOK LIKE "FOUND NOBODY".
  //
  // The scout only runs if the owner's Exa + Anthropic keys resolve and
  // PIPELINE_ENABLED isn't explicitly 'false'. Both of those live outside the repo
  // — in Settings and in Railway's dashboard — so the app cannot test them and a
  // deploy cannot fix them. If either is wrong the scout silently never runs, which
  // is EXACTLY the failure this whole rebuild exists to end: for months the gate
  // looked for the Exa key in the environment, found nothing, declined to schedule,
  // and the screen just said the inbox was quiet.
  //
  // Boot records `scout_not_scheduled` with the reason. Surfacing it here — and only
  // when it is NEWER than the last real run, so a fixed config stops nagging — puts
  // the answer on the screen Danny opens every morning rather than in a log he'd
  // have to know to read.
  // ══════════════════════════════════════════════════════════════════════
  const blocked = lastRun('scout_not_scheduled', uid);
  const scoutBlocked = blocked && (!last || blocked.ran_at > last.ran_at)
    ? { reason: blocked.detail, since: blocked.ran_at }
    : null;

  res.json({
    rows: scored,
    // `total` is what the CURRENT filter matched, not what was returned — the client
    // needs it to know there is a next page.
    total: matched,
    returned: scored.length,
    limit,
    offset,
    tiers: tierCounts,
    new_count: newCount,
    new_since: newSince,
    // The national Frontier Watch — everything with no Illinois tie. Kept separate
    // rather than dropped, because "best of the best" is a different question from
    // "best we can be first to," and Brandon asks the first one.
    watchlist: db.prepare(
      `SELECT COUNT(*) n FROM sourced_founders
       WHERE user_id = ? AND status IN ('pending','starred') AND list_scope = 'watchlist'
         AND COALESCE(do_not_resurface, 0) = 0`
    ).get(uid).n,
    last_run: last
      ? { job: last.job, status: last.status, detail: last.detail, ran_at: last.ran_at }
      : // Null is not "it failed" — it's "no run has ever been recorded", which is
        // a different and more useful thing to say.
        null,
    // Set when the scheduler declined to arm the scout, with the reason. Null is the
    // healthy state.
    scout_blocked: scoutBlocked,
    arrived_today: db.prepare(
      `SELECT COUNT(*) n FROM sourced_founders
       WHERE user_id = ? AND DATE(created_at) = DATE('now')`
    ).get(uid).n,
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/pipeline/stats — the Home dashboard.
//
// Danny asked for "a dashboard covering pipeline stats" and also, separately and
// emphatically: "I want to inflate my pipeline numbers." Both are true, and the
// line between them is what this endpoint encodes.
//
// SHIPPED: funnel STATE — how many sit at each stage, which sources produce. That
// describes the board so he can navigate it, and it's what his own Permute spec
// asked for ("Count of founders by Source, so I can see which channel is
// producing volume"). A description isn't a score.
//
// NOT SHIPPED: a headline pipeline size, a growth trend, or conversion rates.
// Every one of those goes UP when he adds a name, which pays him to do the thing
// he already told me he does for the number's sake.
//
// The only progress metric is DECIDED — and its increment requires a dated
// falsifiable prediction (see routes/today.js), because a bare pass=+1 would pay
// him to fire his ten-second "cool but indefensible" reflex faster, and his own
// Portfolio Pattern Analysis says undocumented passes on strong founders are his
// most fixable blind spot.
// ══════════════════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
  const uid = req.user.id;
  const rows = db.prepare(PIPELINE_SQL).all(uid, uid, uid);
  const live = rows.filter((r) => (r.pipeline_tracks || '').includes('investment'));
  const staged = live.map((r) => stageOf(r));

  const bySource = {};
  for (const r of live) {
    const s = r.sourced_via || r.source || 'Unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }

  res.json({
    // Deliberately NOT summed into a total anywhere on the client.
    funnel: {
      found: staged.filter((s) => s === 'found').length,
      met: staged.filter((s) => s === 'met').length,
      assessed: staged.filter((s) => s === 'assessed').length,
      decided: staged.filter((s) => s === 'decided').length,
      invested: staged.filter((s) => s === 'invested').length,
    },
    by_source: Object.entries(bySource)
      .map(([source, n]) => ({ source, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
    inbox_waiting: db.prepare(
      `SELECT COUNT(*) n FROM sourced_founders
       WHERE user_id = ? AND status IN ('pending','starred') AND list_scope = 'pipeline'
         AND COALESCE(do_not_resurface, 0) = 0`
    ).get(uid).n,
    // The one progress number. Decided, not sourced.
    decided_this_week: db.prepare(
      `SELECT COUNT(*) n FROM decisions WHERE created_by = ? AND decided_at >= date('now','-7 day')`
    ).get(uid).n,
    // Null until there is something to say — n=0 is not 50/50. The only question
    // here that compounds.
    calibration: (() => {
      const d = db.prepare(
        `SELECT stu_band, band, outcome FROM decisions
         WHERE created_by = ? AND stu_band IS NOT NULL AND stu_band != 'indeterminate'`
      ).all(uid);
      const disagreed = d.filter((r) => r.stu_band !== r.band);
      const resolved = disagreed.filter((r) => r.outcome && r.outcome !== 'unresolved');
      return {
        decisions: d.length,
        disagreed: disagreed.length,
        right_when_disagreed: resolved.length
          ? Math.round((resolved.filter((r) => r.outcome === 'right').length / resolved.length) * 100)
          : null,
      };
    })(),
  });
});

// ── GET /api/pipeline/:id — one company, everything attached to it ──
// The detail page's substrate. Same record, more of it.
// ── The card selects f.*, the BOARD does not. This asymmetry is deliberate. ──
// PIPELINE_SQL lists columns explicitly because it runs over 187 rows and its
// payload is already 136KB — widening it to carry deck URLs and enrichment blobs
// nobody reads on a board would be paid 187 times per page load.
//
// But that narrowness is a trap, and this file documents its own scar: omitting
// investment_amount once made every portfolio company render as "met", because
// `undefined > 0` is false. I hit the identical bug building this card — the team
// block read "add the company LinkedIn URL" for a record that had one, because
// company_linkedin_url wasn't in the list. Then again on PATCH, which echoed back
// a row missing the very field it had just saved.
//
// So the card gets f.* — one row, every column, and no list to forget. It lives
// in one function precisely so GET and PATCH cannot drift apart.
function cardRow(userId, id) {
  return db.prepare(`
    SELECT f.*,
      (SELECT a.conviction_score FROM opportunity_assessments a
        WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
          AND a.status IN ('complete','partial')
        ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS stu_score,
      (SELECT a.conviction_band FROM opportunity_assessments a
        WHERE a.founder_id = f.id AND a.is_deleted = 0 AND a.assessment_type = 'assessment'
          AND a.status IN ('complete','partial')
        ORDER BY a.created_at DESC, a.version_number DESC LIMIT 1) AS stu_band,
      (SELECT d.band FROM decisions d WHERE d.founder_id = f.id
        ORDER BY d.decided_at DESC LIMIT 1) AS my_band
    FROM founders f
    WHERE f.created_by = ? AND f.is_deleted = 0 AND f.id = ?
  `).get(userId, id);
}

// ── Literal GET routes MUST come before GET /:id, or Express treats "movers" and
// "predictions" as founder ids and 404s them (it did). ──
router.get('/movers', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { movers } = require('../services/slope-snapshots');
    res.json({ movers: movers({ userId: req.user.id, limit: req.query.limit ? Number(req.query.limit) : 40 }) });
  } catch (e) { console.error('[Movers]', e.message); res.status(500).json({ error: e.message }); }
});
router.get('/predictions', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const P = require('../services/predictions');
    const today = new Date().toISOString().slice(0, 10);
    res.json({ scoreboard: P.scoreboard({ userId: req.user.id }), due: P.due({ userId: req.user.id, today }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registered ahead of '/:id' on purpose: Express matches in definition order, so a
// parameterised route declared first would swallow this one and answer /learning with
// "founder 'learning' not found".
// GET /api/pipeline/learning — what Danny's calls say about the rubric.
router.get('/learning', (req, res) => {
  const rows = db.prepare('SELECT * FROM founder_triage WHERE user_id = ?').all(req.user.id);
  const decided = rows.filter((r) => r.verdict !== 'watch');
  const advanced = decided.filter((r) => r.verdict === 'advance');
  const base = decided.length ? advanced.length / decided.length : 0;

  // Per-signal lift. A signal is only reported once it has been SEEN enough times to
  // mean anything — three calls is a coincidence, and a table of coincidences ranked
  // by lift is how you end up with a confident theory of nothing.
  const MIN_N = 5;
  const seen = new Map();
  for (const r of decided) {
    let labels = [];
    try { labels = JSON.parse(r.signals || '[]'); } catch (e) { labels = []; }
    for (const raw of new Set(labels.map((x) => String(x)))) {
      // Graduation signals are stored suffixed ("Stanford (next-round signal)").
      // Keep the suffix: whether Danny advances on pedigree is exactly the question
      // this table exists to answer, and merging the two kinds would hide it.
      const cur = seen.get(raw) || { signal: raw, n: 0, advanced: 0 };
      cur.n++; if (r.verdict === 'advance') cur.advanced++;
      seen.set(raw, cur);
    }
  }
  const signals = [...seen.values()]
    .filter((x) => x.n >= MIN_N)
    .map((x) => ({ ...x, rate: x.advanced / x.n, lift: base ? (x.advanced / x.n) / base : null }))
    .sort((a, b) => b.lift - a.lift);

  // Where he and the engine disagree. This is the part worth reading: agreement
  // teaches nothing, and every bump to RUBRIC_VERSION should have to answer these.
  const falsePositives = decided.filter((r) => r.verdict === 'pass' && r.rubric_tier === 'must-meet');
  const falseNegatives = decided.filter((r) => r.verdict === 'advance' && r.rubric_tier && r.rubric_tier !== 'must-meet');
  const unscored = decided.filter((r) => !r.rubric_tier);

  res.json({
    triaged: rows.length,
    decided: decided.length,
    advanced: advanced.length,
    base_advance_rate: base,
    // Below this, treat everything here as anecdote. Named so the number cannot be
    // quoted as a finding before it is one.
    enough_to_read: decided.length >= 30,
    signals,
    disagreement: {
      rubric_said_meet_he_passed: falsePositives.length,
      rubric_said_no_he_advanced: falseNegatives.length,
      no_rubric_verdict: unscored.length,
    },
    by_verdict: {
      advance: rows.filter((r) => r.verdict === 'advance').length,
      watch: rows.filter((r) => r.verdict === 'watch').length,
      pass: rows.filter((r) => r.verdict === 'pass').length,
    },
  });
});

router.get('/:id', (req, res) => {
  // PIPELINE_SQL lists columns explicitly because it runs over 187 rows and its
  // payload is already 136KB — widening it to carry deck URLs and enrichment
  // blobs nobody reads on a board would be paid 187 times per page load.
  //
  // But that narrowness is a trap, and this file documents its own scar: omitting
  // investment_amount once made every portfolio company render as "met", because
  // `undefined > 0` is false. I hit the identical bug building this card — the
  // team block read "add the company LinkedIn URL" for a record that had one,
  // because company_linkedin_url wasn't in the list.
  //
  // So the card gets f.* — one row, every column, no list to forget to update
  // the next time someone adds a field.
  const row = cardRow(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  res.json({
    ...row,
    funnel_stage: stageOf(row),

    // ── The co-founders folded into this card ──
    // Folding a co-founder off the board must not make them disappear from the
    // product — that would be deleting a relationship to tidy a column. Eric Mills
    // is still Permute's co-founder; he just isn't a second Permute card. The card
    // is where he lives now, so the card has to say so.
    cofounders: db.prepare(`
      SELECT id, name, role, email, linkedin_url, airtable_founder_record_id
      FROM founders WHERE represented_by_founder_id = ? AND is_deleted = 0
      ORDER BY name
    `).all(req.params.id),

    // And if THIS card is itself folded into another, say which — otherwise a card
    // that isn't on the board looks like a bug rather than a decision.
    represented_by: row.represented_by_founder_id
      ? db.prepare('SELECT id, name, company FROM founders WHERE id = ?').get(row.represented_by_founder_id)
      : null,

    assessments: db
      .prepare(
        `SELECT id, conviction_score, conviction_band, evidence_rung, status, assessment_type, created_at
         FROM opportunity_assessments WHERE founder_id = ? AND is_deleted = 0
         ORDER BY created_at DESC`
      )
      .all(req.params.id),
    decisions: db
      .prepare(`SELECT * FROM decisions WHERE founder_id = ? ORDER BY decided_at DESC`)
      .all(req.params.id),
    commitments: db
      .prepare(`SELECT * FROM commitments WHERE founder_id = ? ORDER BY stated_at DESC`)
      .all(req.params.id),
    notes: db
      .prepare(`SELECT * FROM founder_notes WHERE founder_id = ? ORDER BY created_at DESC`)
      .all(req.params.id),

    // The automated half — the team, their tenure, where they worked before, and
    // the arrival curve. Parsed here so the client never has to know it's stored
    // as a JSON blob. Null until enrichment runs; the card renders honest empty
    // states rather than pretending a company has no team.
    enrichment: (() => {
      if (!row.company_enrichment) return null;
      try { return JSON.parse(row.company_enrichment); } catch { return null; }
    })(),

    // The free half — the SEC's Form D record and their open roles. Same
    // machine-owned rules and the same honest-empty contract as `enrichment`
    // above, but it costs nothing to fetch, so it's the one that can be true for
    // every card rather than the two that had a LinkedIn URL.
    public_record: (() => {
      if (!row.company_public) return null;
      try { return JSON.parse(row.company_public); } catch { return null; }
    })(),

    // Danny's own call. Never computed, never inferred, never defaulted — and
    // deliberately NOT gated on an assessment existing: 174 of 183 cards have no
    // assessment and he has a view on all of them.
    my_decision: db.prepare(
      `SELECT id, band, rationale, prediction, resolve_by, decided_at, stu_band, stu_score, outcome
         FROM decisions WHERE founder_id = ? AND created_by = ?
        ORDER BY decided_at DESC LIMIT 1`
    ).get(req.params.id, req.user.id) || null,

    // The card offers "Assess this company" off this.
    assessment_id: db.prepare(
      `SELECT id FROM opportunity_assessments
        WHERE founder_id = ? AND is_deleted = 0 AND assessment_type = 'assessment'
          AND status IN ('complete','partial')
        ORDER BY created_at DESC, version_number DESC LIMIT 1`
    ).get(req.params.id)?.id || null,
  });
});

// ══════════════════════════════════════════════════════════════════════
// PATCH /api/pipeline/:id — Danny edits the card.
//
// "These should all be fields I can enter and edit too... I need add/edit/delete
// control on everything really."
//
// Strict allowlist. Two reasons it isn't a generic spread of req.body:
//   1. company_enrichment is MACHINE-owned. If Danny could write it, a re-fetch
//      would clobber him — and if a fetch could write his fields, it would erase
//      his typing. The split is the whole schema design: he owns columns, the
//      machine owns the blob, neither touches the other.
//   2. is_deleted / created_by / id are not "fields", and a PUT that lets the
//      client set them is how a bug becomes a data loss.
// ══════════════════════════════════════════════════════════════════════
const EDITABLE = [
  'name', 'company', 'role', 'email', 'linkedin_url', 'company_linkedin_url',
  'website_url', 'github_url', 'twitter',
  'company_one_liner', 'domain', 'stage', 'location_city', 'location_state',
  'deal_status', 'admissions_status', 'pipeline_tracks', 'next_action',
  'deck_url', 'data_room_url',
  'arr', 'monthly_burn', 'runway_months', 'valuation', 'round_size',
  'investment_amount', 'security_type', 'deal_lead', 'chicago_connection',
];

router.patch('/:id', (req, res) => {
  // website_url comes back too: the auto-read below fires on CHANGE, and without the
  // old value every save of an untouched field would re-read the site.
  const before = db.prepare('SELECT id, website_url FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!before) return res.status(404).json({ error: 'not found' });

  const fields = Object.keys(req.body).filter((k) => EDITABLE.includes(k));
  if (!fields.length) {
    return res.status(400).json({
      error: 'nothing editable in that payload',
      editable: EDITABLE,
    });
  }

  const set = fields.map((f) => `${f} = ?`).join(', ');
  const vals = fields.map((f) => (req.body[f] === '' ? null : req.body[f]));
  db.prepare(`UPDATE founders SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...vals, req.params.id);

  // ── A card that reads itself ──
  // Measured 2026-07-16: 79 cards carry a website, 3 had ever been read. The bulk
  // /read-web path existed the whole time and nobody ran it, which is the actual
  // lesson — a backfill you have to remember is a backfill that doesn't happen. So
  // the moment Danny pastes a URL, the card goes and reads it.
  //
  // Fire-and-forget, deliberately. Exa takes several seconds and this is a blur
  // handler: making him watch a spinner to save a text field would be a worse
  // product than not reading the site at all.
  if (fields.includes('website_url') && req.body.website_url !== before.website_url) {
    readWebsiteSoon(req.params.id, req.body.website_url, req.user.id);
  }

  // cardRow, not PIPELINE_SQL — the narrow board query would echo back a row
  // missing the field just saved, and the client would render the edit as lost.
  const updated = cardRow(req.user.id, req.params.id);
  res.json({ ...updated, funnel_stage: stageOf(updated) });
});

// Read a newly-saved website into the card's source log, out of band.
//
// Every failure here is swallowed to a log line on purpose: this is a side effect of
// saving a text field, and a dead site, a missing Exa key, or a rate limit must never
// surface as "your edit failed". The card shows what it managed to read; the Sources
// block already renders an honest empty state when that's nothing.
function readWebsiteSoon(founderId, rawUrl, userId) {
  const url = String(rawUrl || '').trim();
  if (!url) return;

  setImmediate(async () => {
    try {
      const { ingestUrl, BLOCKED_HOSTS } = require('../lib/ingest');
      // Founders paste more than one URL into the field; take the first.
      let u = url.split(/\s+/)[0];
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

      let host;
      try { host = new URL(u).hostname; } catch { return; }
      // linkedin.com/in/... lives in this field on the live board (LegalOS). Exa
      // returns a login wall for it, and ingest refuses it anyway — don't spend the
      // call to find out.
      if (BLOCKED_HOSTS.some((re) => re.test(host))) return;

      // Idempotent at the storage layer (content_hash), but checking first saves an
      // Exa call on the common case of Danny editing the same field twice.
      const seen = db.prepare(
        "SELECT 1 FROM company_sources WHERE founder_id = ? AND kind = 'url' AND uri = ? LIMIT 1"
      ).get(founderId, u);
      if (seen) return;

      const r = await ingestUrl({ founderId, url: u, userId });
      if (r?.error) { console.warn('[AutoRead] %s -> %s', u, r.error); return; }
      console.log('[AutoRead] read %s for founder %s', u, founderId);
      // Reading it is half the job — a source nobody analysed is a row that says
      // "not analysed".
      if (r.created && r.id) require('../lib/extract-signals').extractSoon(founderId, r.id, userId);
    } catch (e) {
      console.warn('[AutoRead] %s failed: %s', url, e.message);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// THE MERGED BOARD'S TWO WRITES — AND ONLY ONE OF THEM LEAVES STU
//
// Danny: "Let's merge Investment and Admissions pipelines, consolidating.
// Investment and/or Admissions Pipeline should be a badge I can edit on each
// card, similar to what I have in Airtable."
//
// So there is ONE board with ONE stage axis in Airtable's words, and the
// Resident/Investment track is a badge. Exactly two things move: the stage (drag)
// and the badge (click).
//
// THE STAGE PUBLISHES. THE BADGE DOES NOT. Danny drew that line himself:
//
//   "I'm comfortable with you publishing stage updates to Airtable. But that's it.
//    I'm going to primarily work in Stu, and then choose to enter my own context to
//    the team view in Airtable depending on what I want them to see."
//
// Stu is where he works; Airtable is what the team sees; he decides what crosses.
// The stage crosses because the team's view of where a deal stands must not
// silently disagree with his, and because the 5:45am sync would otherwise revert
// his drag by morning. The badge stays home.
//
// The stage drag is the ONLY caller in this file that passes { explicit: true }.
// Every scheduled job is still refused by the gate in services/airtable-sync.js.
// A human pressing a card is not an agent; that distinction is the whole rule.
//
// The push is AWAITED and its outcome is returned. Fire-and-forget would let Stu
// report a move that Airtable rejected — which is this codebase's oldest bug, a
// status message decoupled from the thing it describes. If Airtable refuses, the
// response says so and names the reason.
// ══════════════════════════════════════════════════════════════════════════

// PATCH /api/pipeline/:id/stage  { stage: "Stage 2: Interviewed" }
router.patch('/:id/stage', async (req, res) => {
  const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!founder) return res.status(404).json({ error: 'not found' });

  const stage = req.body?.stage;
  if (!vocab.isStage(stage)) {
    return res.status(400).json({
      error: 'Not a stage Airtable knows.',
      detail: 'The board may only use options that exist on Airtable\'s Admission Status field — anything else would 422 on the way up.',
      allowed: vocab.STAGES,
    });
  }

  const before = founder.stage_status;
  if (before === stage) return res.json({ ...cardRow(req.user.id, founder.id), airtable: { skipped: 'unchanged' } });

  db.prepare('UPDATE founders SET stage_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(stage, founder.id);

  // Keep the mirror column honest: it means "what Airtable says", so it may only
  // move once Airtable has actually accepted the write.
  let airtable = { skipped: 'no_airtable_record' };
  try {
    airtable = await airtableSync.pushStage(founder, stage, { explicit: true });
    if (airtable && airtable.pushed) {
      db.prepare('UPDATE founders SET airtable_admission_status = ?, airtable_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(stage, founder.id);
    }
  } catch (e) {
    airtable = { error: e.message };
  }

  const updated = cardRow(req.user.id, founder.id);
  res.json({ ...updated, funnel_stage: stageOf(updated), airtable });
});

// PATCH /api/pipeline/:id/tracks  { tracks: ["Resident","Investment"] }
router.patch('/:id/tracks', async (req, res) => {
  const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!founder) return res.status(404).json({ error: 'not found' });

  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : null;
  if (!tracks || tracks.some((t) => !vocab.TRACKS.includes(t))) {
    return res.status(400).json({
      error: 'tracks must be an array of Airtable Pipeline options',
      allowed: vocab.TRACKS,
    });
  }

  const csv = vocab.tracksToStu(tracks);
  db.prepare(
    'UPDATE founders SET pipeline_tracks = ?, tracks_set_by_user_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(csv, founder.id);

  // ── THE BADGE DOES NOT GO TO AIRTABLE ──
  // Danny, asked how far the Airtable write should go: "I'm comfortable with you
  // publishing stage updates to Airtable. But that's it. I'm going to primarily
  // work in Stu, and then choose to enter my own context to the team view in
  // Airtable depending on what I want them to see."
  //
  // So the stage publishes and nothing else does. That has a consequence which has
  // to be handled here rather than discovered later: the nightly sync UNIONS tracks
  // (Airtable may add a track, never remove one). With no push, a badge Danny
  // switches OFF in Stu would be switched straight back ON at 5:45am by an Airtable
  // record that still says Investment — his edit silently undone overnight, which
  // is the exact class of bug that made this board lie for four months.
  //
  // `tracks_set_by_user_at` is the fix: once Danny has touched a founder's badge,
  // Stu owns that founder's tracks and the sync stops unioning them. His edit is
  // the more recent decision and it stands.
  const updated = cardRow(req.user.id, founder.id);
  res.json({
    ...updated,
    funnel_stage: stageOf(updated),
    airtable: { skipped: 'tracks_are_stu_only' },
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/pipeline/:id/represented-by  { by: <founderId> | null }
//
// Fold a co-founder's row into the card that represents their company, or unfold it.
// Danny: "Could we just have Scott and Kyle kept in?"
//
// Nothing is deleted. `by: null` puts the row back on the board — which is the whole
// reason this is a pointer and not a DELETE. He asked for "a clear way for me to
// manually add, edit, and delete anything in pipeline"; a delete you can't undo
// isn't a feature, it's a trap on a board built out of relationships.
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/represented-by', (req, res) => {
  const row = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const by = req.body?.by ?? null;
  if (by === null) {
    db.prepare('UPDATE founders SET represented_by_founder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(row.id);
    return res.json(cardRow(req.user.id, row.id));
  }

  // SELECT * — the guard below reads represented_by_founder_id, and a narrow column
  // list would hand it `undefined` and pass silently. That exact bug has already
  // shipped from this file once (see cardRow's comment); it is not shipping twice.
  const target = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(by, req.user.id);
  if (!target) return res.status(400).json({ error: 'that card does not exist' });
  if (Number(by) === row.id) return res.status(400).json({ error: 'a card cannot represent itself' });

  // One hop only. If the target is itself folded into someone else, pointing at it
  // would build a chain the board has to walk — and a cycle would hide both rows
  // from the board forever with no way back through the UI.
  if (target.represented_by_founder_id) {
    return res.status(400).json({
      error: 'that card is itself folded into another one',
      detail: 'Point at the card that actually shows on the board.',
    });
  }

  db.prepare('UPDATE founders SET represented_by_founder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(target.id, row.id);
  res.json(cardRow(req.user.id, row.id));
});

// ══════════════════════════════════════════════════════════════════════════
// The other three inputs — the ones that don't need a LinkedIn URL.
//
// Danny: "We can enrich records with free internet data (LinkedIn, Crunchbase, etc),
// Granola data you have access to, and the notes I just gave you on all these
// companies... I want Harmonic-level insight in the cards."
//
// EnrichLayer needs company_linkedin_url and resolves for ~26% of the book, which is
// where coverage stalled. His notes (/api/vault-sync/notes), his Granola calls
// (/api/vault-sync/call-notes) and the open web need no such thing. These two
// endpoints finish the job:
//
//   read-web  — ingest each card's own website through Exa as a `url` source
//   extract   — turn EVERY unread source into typed, quote-backed signals
//
// Both page (?limit&offset) for the same reason the enricher does: one synchronous
// pass over ~250 sources is minutes of work and the platform proxy 502s long before.
// Both return { done } so the caller knows when to stop.
// ══════════════════════════════════════════════════════════════════════════

// ── POST /api/pipeline/score-slope — compute GitHub founder-slope for the pool ──
// Paged (?limit): each call scores a batch and reports what's left, same as the
// other backfills. Uses the server's GITHUB_TOKEN (5000 req/hr authed).
router.post('/score-slope', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { scoreGithubSlope } = require('../pipeline/github-activity');
    const r = await scoreGithubSlope({
      userId: req.user.id,
      githubToken: process.env.GITHUB_TOKEN,
      limit: req.query.limit ? Number(req.query.limit) : 40,
    });
    res.json({ ...r, done: r.remaining === 0 });
  } catch (e) {
    console.error('[ScoreSlope]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/discover-builders — GitHub-native builder sourcing ──
// The elegant inversion: source builders from the builder graph (GitHub), IL-tied and
// ranked by slope, so the illegible builder shows up natively. See pipeline/github-source.
router.post('/discover-builders', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { discoverGithubBuilders } = require('../pipeline/github-source');
    const r = await discoverGithubBuilders({
      userId: req.user.id,
      token: process.env.GITHUB_TOKEN,
      candidatesPerQuery: req.query.per ? Number(req.query.per) : 15,
      pages: req.query.pages ? Number(req.query.pages) : 1,
    });
    res.json(r);
  } catch (e) {
    console.error('[DiscoverBuilders]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/resolve-github — corroborated LinkedIn→GitHub matching ──
// Paged. Only accepts a match on name + a second independent fact; see github-resolve.
router.post('/resolve-github', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { resolveGithubHandles } = require('../pipeline/github-resolve');
    res.json(await resolveGithubHandles({ userId: req.user.id, token: process.env.GITHUB_TOKEN, limit: req.query.limit ? Number(req.query.limit) : 30, reset: String(req.query.reset) === '1' }));
  } catch (e) {
    console.error('[ResolveGithub]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/backfill-github — pull GitHub links from the LinkedIn scrape ──
router.post('/backfill-github', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { backfillGithubFromScrape } = require('../pipeline/github-source');
    res.json(backfillGithubFromScrape({ userId: req.user.id }));
  } catch (e) {
    console.error('[BackfillGithub]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/revalidate-backfill — purge name-inconsistent backfill URLs ──
router.post('/revalidate-backfill', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { revalidateBackfill } = require('../pipeline/github-source');
    res.json(revalidateBackfill({ userId: req.user.id }));
  } catch (e) {
    console.error('[RevalidateBackfill]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/run-radar — run the whole builder-radar now, DETACHED ──
// The full pipeline (backfill → resolve → score → discover → snapshot) makes dozens
// of rate-limited GitHub calls and takes minutes — far past the platform's HTTP
// timeout, which is why the per-step endpoints 502. This fires it server-side and
// returns immediately; progress lands in job_runs (slope_refresh). This is the "refresh
// my builders now" button — same code the Sunday cron runs.
let radarRunning = false;
router.post('/run-radar', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  if (radarRunning) return res.json({ started: false, note: 'a radar run is already in progress' });
  radarRunning = true;
  const { runBuilderRadar } = require('../services/builder-radar');
  runBuilderRadar({ userId: req.user.id })
    .then((r) => console.log(`[RunRadar] ${r.summary}`))
    .catch((e) => console.error('[RunRadar]', e.message))
    .finally(() => { radarRunning = false; });
  res.json({ started: true, note: 'running in the background; watch job_runs (slope_refresh) or /movers' });
});

router.post('/predictions/:id/resolve', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const P = require('../services/predictions');
    res.json(P.resolve({ id: Number(req.params.id), userId: req.user.id, outcome: req.body?.outcome }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/pipeline/snapshot — capture the weekly signal state (manual trigger) ──
router.post('/snapshot', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { captureSnapshots } = require('../services/slope-snapshots');
    res.json(captureSnapshots({ userId: req.user.id }));
  } catch (e) {
    console.error('[Snapshot]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/read-web', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { ingestWebsites } = require('../services/card-backfill');
    res.json(await ingestWebsites({
      userId: req.user.id,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    }));
  } catch (e) {
    console.error('[ReadWeb]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/extract-signals', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    // No offset, deliberately — the queue empties as it's read, so a window that
    // advances walks past work. Call it again until `done`. See card-backfill.js.
    const { extractAll } = require('../services/card-backfill');
    res.json(await extractAll({
      userId: req.user.id,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      maxSpendUsd: Number(req.query.maxSpend || 12),
    }));
  } catch (e) {
    console.error('[ExtractSignals]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/enrich-backfill — resolve + enrich the whole live board ──
//
// The per-card enrich below is Danny pressing a button on one company. This is the
// same work across everything live, and it exists because the per-card button was
// unreachable for 103 of 105 cards: it 400s without `company_linkedin_url`, and
// almost nothing had one. Stage 1 resolves that URL; stage 2 spends the credits.
//
// `?dry=1` resolves only and spends nothing — worth running first, since its
// `unresolved` list with reasons is the actual to-fix list ("one-word name — no
// corroboration" is fixed by finding the website, not by loosening the matcher).
//
// `maxSpendUsd` is a local ceiling on top of providerKeys' daily cap. A bulk loop is
// where a cap earns its keep.
router.post('/enrich-backfill', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { enrichBackfill } = require('../services/enrich-backfill');
    const r = await enrichBackfill({
      userId: req.user.id,
      dryRun: req.query.dry === '1',
      maxSpendUsd: Number(req.query.maxSpend || 15),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(r);
  } catch (e) {
    console.error('[EnrichBackfill]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/:id/enrich — fetch the team from LinkedIn, on demand ──
// Costs real credits (2 + 4/employee), so it is never automatic on page load.
// Danny presses it, or the nightly job does it in bulk.
router.post('/:id/enrich', async (req, res) => {
  const row = db.prepare('SELECT id, company, company_linkedin_url FROM founders WHERE id = ? AND created_by = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.company_linkedin_url) {
    // Say WHICH field is missing and what to do — an "enrichment failed" toast
    // that doesn't name the cause is how a feature gets abandoned.
    return res.status(400).json({
      error: 'No company LinkedIn URL on this card.',
      detail: `Add the company's LinkedIn page URL (not the founder's profile) and enrich again.`,
      field: 'company_linkedin_url',
    });
  }

  try {
    const { enrichCompany, saveCompanyEnrichment } = require('../pipeline/company-enrich');
    const blob = await enrichCompany(row.company_linkedin_url, { userId: req.user.id });
    if (!blob) {
      return res.status(502).json({
        error: 'LinkedIn returned nothing for that URL.',
        detail: 'Check the URL points at a company page, or that your EnrichLayer key has credits.',
      });
    }
    saveCompanyEnrichment(row.id, blob);
    res.json(blob);
  } catch (e) {
    console.error('[Pipeline] enrich failed:', e.message);
    res.status(500).json({ error: 'Enrichment failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/pipeline — a new card, from the board.
//
// Danny: "these founder/company kanban cards in Pipeline need to be highly
// editable, I need to be able to create and delete the cards themselves."
//
// POST /api/founders has existed the whole time, and /founders/new is a routed
// page. Neither is reachable from Pipeline, which is where he actually lives — so
// the capability may as well not have existed. This is the same write, at the
// place the work happens.
//
// ── WHY BOTH NAMES ARE REQUIRED ──
// `founders` is the spine, and a row on it is A PERSON. The March Airtable import
// wrote COMPANY records into it with the company in the name column, which is why
// isPerson() exists forty lines up and why the board still has rows called
// "Gatsby Robotics" where a human should be. A composer that accepts a bare company
// name would manufacture that exact junk at speed. Two fields, both required.
//
// ── WHY THIS DOES NOT TOUCH AIRTABLE ──
// The board's rule, and Danny's: the STAGE publishes, nothing else does. Airtable is
// team-visible and this is his private workbench, so a card he makes here is his
// until he drags it. Verified the nightly sync can't punish that — neither
// airtable-sync.js nor airtable-import.js soft-deletes rows it doesn't recognise,
// and the import matches on name, so a founder he later adds to the team's base
// links up to this card rather than duplicating it.
router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const company = String(req.body?.company || '').trim();
  const website = String(req.body?.website_url || '').trim();

  if (!name) return res.status(400).json({ error: 'A founder name is required.', field: 'name' });
  if (!company) {
    return res.status(400).json({
      error: 'A company name is required.',
      detail: 'A card is a person AND their company — the board has rows where a company got typed into the founder field, and it can’t tell them apart afterwards.',
      field: 'company',
    });
  }

  // Don't let him create the duplicate he's about to regret. Same normalisation the
  // note matcher uses, so "Cadrian" and "Cadrian AI" are recognised as the same board.
  const dupe = db.prepare(
    `SELECT id, name, company FROM founders
      WHERE created_by = ? AND is_deleted = 0
        AND LOWER(TRIM(name)) = LOWER(?) AND LOWER(TRIM(company)) = LOWER(?) LIMIT 1`
  ).get(req.user.id, name, company);
  if (dupe) {
    return res.status(409).json({
      error: `${dupe.name} at ${dupe.company} is already on the board.`,
      founder_id: dupe.id,
    });
  }

  const r = db.prepare(`
    INSERT INTO founders (name, company, website_url, stage, status, pipeline_tracks, stage_status, created_by)
    VALUES (?, ?, ?, 'Pre-seed', 'Sourced', ?, ?, ?)
  `).run(name, company, website || null, req.body?.pipeline_tracks || 'investment', vocab.STAGES[1], req.user.id);

  // A card that reads itself, the moment it exists. See readWebsiteSoon.
  if (website) readWebsiteSoon(r.lastInsertRowid, website, req.user.id);

  const created = cardRow(req.user.id, r.lastInsertRowid);
  res.status(201).json({ ...created, funnel_stage: stageOf(created) });
});

// ── DELETE /api/pipeline/:id — take a card off the board ──
//
// Soft, like every other delete in this codebase. Not caution for its own sake: the
// row is the join target for call transcripts, commitments, assessments and
// decisions, and a hard delete would orphan all of it to save a few KB. It also
// makes the undo in the UI a one-line restore rather than a re-import.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id, name, company FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  db.prepare('UPDATE founders SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  // Airtable is untouched, deliberately — see POST above. Removing a company from
  // his own board is not a statement to his team about the deal.
  res.json({ removed: { id: row.id, name: row.name, company: row.company } });
});

// ── POST /api/pipeline/:id/restore — the undo ──
// A delete Danny can't take back is a delete he won't use.
router.post('/:id/restore', (req, res) => {
  const row = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 1')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found, or not deleted' });
  db.prepare('UPDATE founders SET is_deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  const restored = cardRow(req.user.id, row.id);
  res.json({ ...restored, funnel_stage: stageOf(restored) });
});

// ── POST /api/pipeline/:id/public — the free read: Form D + open roles ──
//
// Deliberately NOT folded into /enrich. That one spends EnrichLayer credits and
// 400s without a company LinkedIn URL, which 103 of 105 cards didn't have. This
// needs only a company name and costs nothing, so it must not inherit either the
// gate or the bill.
router.post('/:id/public', async (req, res) => {
  const row = db.prepare('SELECT id, company, name, website_url FROM founders WHERE id = ? AND created_by = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.company || !String(row.company).trim()) {
    return res.status(400).json({
      error: 'No company name on this card.',
      detail: 'The SEC and the job boards are both searched by company name.',
      field: 'company',
    });
  }

  try {
    const { readPublicRecord, savePublicRecord } = require('../services/public-record');
    const blob = await readPublicRecord({ company: row.company, founderName: row.name, website: row.website_url });
    savePublicRecord(row.id, blob);
    // Always 200, even when both halves found nothing. "No Form D and no job board"
    // is the correct answer for most pre-seed companies, and an error status would
    // make the card render a failure where it should render a fact.
    res.json(blob);
  } catch (e) {
    console.error('[Pipeline] public record read failed:', e.message);
    res.status(500).json({ error: 'Public record read failed: ' + e.message });
  }
});

// ── POST /api/pipeline/public-backfill — the same, across the live board ──
// Free, so there's no maxSpend here. Paged for the same reason enrich-backfill is:
// one synchronous request across 188 cards 502s.
router.post('/public-backfill', async (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { publicRecordBackfill } = require('../services/public-record');
    const r = await publicRecordBackfill({
      userId: req.user.id,
      limit: req.query.limit ? Number(req.query.limit) : 25,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(r);
  } catch (e) {
    console.error('[PublicBackfill]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pipeline/snapshot-seed — capture the readings we already hold ──
//
// One-time. Every blob on `founders` is a reading that exists in exactly one place
// and would be destroyed by the next fetch. This lifts them into the append-only
// series, backdated to when they were actually taken. Idempotent — safe to re-run.
router.post('/snapshot-seed', (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: 'not available for your account' });
  try {
    const { seedFromExisting } = require('../lib/snapshots');
    res.json(seedFromExisting({ userId: req.user.id }));
  } catch (e) {
    console.error('[SnapshotSeed]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/pipeline/:id/history — the series, and the delta if it's earned ──
router.get('/:id/history', (req, res) => {
  const row = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { snapshotsFor, deltaFor } = require('../lib/snapshots');
  res.json({
    snapshots: snapshotsFor(row.id),
    headcount: deltaFor(row.id, 'enrichlayer', 'headcount'),
    roles: deltaFor(row.id, 'public_record', 'role_count'),
  });
});

// ── Notes: add / edit / delete. His words, his rows. ──
router.post('/:id/notes', (req, res) => {
  const { content, source } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content required' });
  const r = db.prepare(
    `INSERT INTO founder_notes (founder_id, content, source, created_by) VALUES (?, ?, ?, ?)`
  ).run(req.params.id, String(content).trim(), source || 'manual', req.user.id);
  res.json(db.prepare('SELECT * FROM founder_notes WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/:id/notes/:noteId', (req, res) => {
  const n = db.prepare('SELECT * FROM founder_notes WHERE id = ? AND founder_id = ?')
    .get(req.params.noteId, req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  const { content } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content required' });
  db.prepare('UPDATE founder_notes SET content = ? WHERE id = ?').run(String(content).trim(), n.id);
  res.json(db.prepare('SELECT * FROM founder_notes WHERE id = ?').get(n.id));
});

router.delete('/:id/notes/:noteId', (req, res) => {
  const n = db.prepare('SELECT * FROM founder_notes WHERE id = ? AND founder_id = ?')
    .get(req.params.noteId, req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM founder_notes WHERE id = ?').run(n.id);
  res.json({ id: n.id, deleted: true });
});

// ══════════════════════════════════════════════════════════════════════════
// TRIAGE — the loop that lets the rubric learn what Danny actually wants.
//
// The sourcing engine ranks founders. Nothing has ever told it whether the ranking
// was any good, so RUBRIC_VERSION has only ever moved on argument. These two routes
// close that: every advance/watch/pass is a labelled example, and the labels are the
// only thing in the system that carries Danny's taste rather than a proxy for it.
// ══════════════════════════════════════════════════════════════════════════

// POST /api/pipeline/:id/triage  { verdict, reason? }
router.post('/:id/triage', (req, res) => {
  const { verdict, reason } = req.body || {};
  if (!['advance', 'watch', 'pass'].includes(verdict)) {
    return res.status(400).json({ error: 'verdict must be advance, watch or pass' });
  }
  const f = db.prepare('SELECT id, sourced_from_id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0')
    .get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'Founder not found' });

  // Snapshot the engine's verdict AS IT STANDS NOW. Read later via a join it would
  // silently become whatever the current rubric thinks, and the calibration set would
  // measure today's rubric against yesterday's decision — always agreeing with itself.
  let snap = {};
  if (f.sourced_from_id) {
    snap = db.prepare(
      'SELECT fit_tier, fit_priority, fit_rubric_version, fit_why FROM sourced_founders WHERE id = ?'
    ).get(f.sourced_from_id) || {};
  }

  db.prepare(`
    INSERT INTO founder_triage (founder_id, user_id, verdict, reason, rubric_tier, rubric_priority, rubric_version, signals, triaged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(founder_id, user_id) DO UPDATE SET
      verdict = excluded.verdict, reason = excluded.reason, triaged_at = CURRENT_TIMESTAMP
  `).run(
    f.id, req.user.id, verdict, reason || null,
    snap.fit_tier || null, snap.fit_priority == null ? null : snap.fit_priority,
    snap.fit_rubric_version || null, snap.fit_why || null
  );

  res.json({ ok: true, founder_id: f.id, verdict });
});

module.exports = router;
