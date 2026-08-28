// ══════════════════════════════════════════════════════════════════════════
// Today — the surface.
//
// Stu is not a second brain. Obsidian is the brain, the nightly tasks are the
// analyst, Airtable is the team's window. Stu is the SCREEN you open at 9am and
// work from all day — the one thing none of the others can be, because they hold
// documents and this holds state that changes.
//
// Two rules that come straight from Danny:
//
//   1. "It is my to-do list — I should be able to add/modify/delete/check-off my
//      own ideas in addition to what your agents suggest."
//      → Agents are GUESTS here. His rows are his. Agent rows tombstone rather
//        than delete, so a re-run can never resurrect something he dismissed.
//
//   2. "I want to inflate my pipeline numbers."
//      → So the headline number is DECIDED, not pipeline. A metric he has told me
//        he games is a metric I will not build.
//
// And the lanes are not chores — they're DECISIONS. Danny: "Sometimes I just don't
// feel like following up... Or I'm waiting to think through if I believe in a
// company or not." The follow-up isn't blocked by discipline, it's blocked by an
// unformed view. So the first lane is UNDECIDED, and nagging comes second.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const db = require('../db');
const commitments = require('../lib/commitments');
const attention = require('../lib/attention');

const today = () => new Date().toISOString().slice(0, 10);

// ── GET /api/today/attention ──
// The cross-stage integrity checks. Danny's own four rules from his Permute spec,
// plus going-cold and predictions-due. See lib/attention.js for provenance.
// Every check returns a row even when clean — silence must mean "I looked".
router.get('/attention', (req, res) => {
  res.json(attention.checks(req.user.id));
});

// ── GET /api/today ──
router.get('/', (req, res) => {
  const uid = req.user.id;
  const t = today();

  // Lane 1 — UNDECIDED. Assessed, but Danny hasn't made the call.
  // This is the real blocker, so it leads.
  const undecided = db.prepare(`
    SELECT a.id AS assessment_id, a.founder_id, a.conviction_score, a.conviction_band,
           a.evidence_rung, a.created_at, f.name AS founder_name, f.company AS founder_company,
           -- A NULL band means one of two completely different things and the screen
           -- must not confuse them: either the conviction engine RAN and held (no
           -- evidence), or the row predates the engine entirely and was never scored.
           -- Saying "not enough evidence" about a run that never happened is the same
           -- lie this rebuild exists to remove, one level up.
           CASE WHEN a.conviction_output IS NULL THEN 1 ELSE 0 END AS predates_engine
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.created_by = ? AND a.is_deleted = 0 AND a.status IN ('complete','partial')
      AND a.assessment_type = 'assessment'
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.assessment_id = a.id)
      -- Dedupe by FOUNDER, not by group. Seen on the real screen: "Gatsby Robotics"
      -- appeared twice, because two separate assessment groups exist for the same
      -- company. Danny doesn't have two Gatsby decisions to make — he has one.
      AND a.id = (
        SELECT a2.id FROM opportunity_assessments a2
        WHERE a2.is_deleted = 0 AND a2.created_by = a.created_by
          AND a2.status IN ('complete','partial') AND a2.assessment_type = 'assessment'
          AND (a2.founder_id = a.founder_id OR (a2.founder_id IS NULL AND a2.id = a.id))
        ORDER BY a2.created_at DESC, a2.version_number DESC LIMIT 1)
    ORDER BY a.created_at DESC
  `).all(uid);

  // Lanes 2 + 3 — the commitment ledger.
  const owed = commitments.due({ userId: uid });

  // Lane 4 — his own rows, plus any agent rows he hasn't dismissed.
  const items = db.prepare(`
    SELECT * FROM today_items
    WHERE created_by = ? AND completed_at IS NULL AND dismissed_at IS NULL
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
    ORDER BY COALESCE(sort_order, id) ASC
  `).all(uid, t);

  // Lane 5 — predictions coming due. The only thing that makes any of this compound.
  const predictions = db.prepare(`
    SELECT d.*, f.name AS founder_name, f.company AS founder_company
    FROM decisions d LEFT JOIN founders f ON d.founder_id = f.id
    WHERE d.created_by = ? AND d.resolved_at IS NULL AND d.resolve_by <= date('now','+14 day')
    ORDER BY d.resolve_by ASC
  `).all(uid);

  // Split the lane. Seen on the real production screen: nine rows, all reading
  // "Scored under the old engine — re-run to get a read." Nine rows carrying one bit
  // of information between them, with the only row that mattered (Dan Preiss, met
  // today, round closing next week) at the same visual weight as Ghost Social from
  // 92 days ago. That is a migration backlog wearing a to-do list's clothes.
  //
  // A legacy row is not a decision Danny can make — there is nothing to decide FROM.
  // It's one chore: re-run them. So it collapses to one row, and the lane goes back
  // to holding actual decisions.
  const legacy = undecided.filter((a) => a.predates_engine);
  const real = undecided.filter((a) => !a.predates_engine);

  res.json({
    // The headline. Decided — never pipeline count.
    decided_this_week: db.prepare(
      `SELECT COUNT(*) n FROM decisions WHERE created_by = ? AND decided_at >= date('now','-7 day')`
    ).get(uid).n,
    undecided: real,
    // One row, not nine.
    needs_rerun: { count: legacy.length, ids: legacy.map((a) => a.assessment_id) },
    i_owe: owed.i_owe,
    they_owe: owed.they_owe,
    predictions_due: predictions,
    items,
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/today/agents — what Danny can set running from the home screen.
//
// Danny: "It could even just give me the ability to build a custom task list or set
// off agents to go accomplish tasks for me."
//
// There are exactly THREE things in Stu that do real work in the background, one per
// product, and all three already exist and are already used elsewhere:
//
//   scout   → the nightly sweep, on demand          (POST /api/sourcing/run)
//   read    → the nine-lens panel on one company    (POST /api/companies/:id/read)
//   hiring  → source candidates for one open role   (POST /api/hiring/roles/:id/source)
//
// This endpoint does NOT dispatch. It answers "what can I run, on what, and is
// anything running right now" — the client fires the existing routes. Dispatching
// from here would be a fourth copy of three workflows, and this codebase already has
// two inboxes and two rankers from exactly that instinct.
//
// TARGETS ARE PRE-FILTERED TO WHAT WOULD ACTUALLY WORK. The read agent only lists
// companies that HAVE materials on file, because `/read` refuses (correctly) to score
// a company with nothing to read — offering the other 90 would be offering 90 errors.
// This is also the honest replacement for Home's old "Live deals with no read: 101",
// which was a backlog wearing a task's clothes: 101 things he cannot act on, versus
// the handful he actually can.
// ══════════════════════════════════════════════════════════════════════════
router.get('/agents', (req, res) => {
  const uid = req.user.id;

  // ── Running right now ──
  const runningReads = db.prepare(`
    SELECT a.id, a.founder_id, f.company, f.name AS founder_name
    FROM opportunity_assessments a LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.created_by = ? AND a.is_deleted = 0
      AND a.status IN ('running','processing_inputs','synthesizing')
    ORDER BY a.created_at DESC
  `).all(uid);

  const runningHiring = db.prepare(`
    SELECT h.id, h.role_id, r.title, r.company_name
    FROM hiring_runs h LEFT JOIN hiring_roles r ON h.role_id = r.id
    WHERE h.user_id = ? AND h.finished_at IS NULL AND h.status = 'running'
    ORDER BY h.run_at DESC
  `).all(uid);

  // ── Read targets: companies with materials on file and no completed read ──
  const readTargets = db.prepare(`
    SELECT f.id, f.company, f.name,
           (SELECT COUNT(*) FROM company_sources cs
             WHERE cs.founder_id = f.id AND cs.content_text IS NOT NULL) AS materials
    FROM founders f
    WHERE f.created_by = ? AND f.is_deleted = 0
      AND EXISTS (SELECT 1 FROM company_sources cs
                   WHERE cs.founder_id = f.id AND cs.content_text IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM opportunity_assessments a
                       WHERE a.founder_id = f.id AND a.is_deleted = 0
                         AND a.status IN ('complete','partial')
                         AND a.assessment_type = 'assessment')
    ORDER BY f.updated_at DESC, f.id DESC
    LIMIT 25
  `).all(uid);

  // ── Hiring targets: open roles ──
  const roleTargets = db.prepare(`
    SELECT r.id, r.title, r.company_name, f.company AS founder_company,
           (SELECT COUNT(*) FROM hiring_matches m WHERE m.role_id = r.id AND m.is_deleted = 0) AS matches
    FROM hiring_roles r LEFT JOIN founders f ON r.founder_id = f.id
    WHERE r.user_id = ? AND r.is_deleted = 0 AND r.status = 'open'
    ORDER BY r.updated_at DESC
    LIMIT 25
  `).all(uid);

  const { lastRun } = require('../services/health');
  const scoutLast = lastRun('nightly_scout', uid) || lastRun('sourcing_run', uid);

  res.json({
    agents: [
      {
        kind: 'scout',
        label: 'Find new founders',
        detail: 'Sweep the open web for stealth and just-departed builders with an Illinois tie',
        needs_target: false,
        // The scout has no durable "running" row of its own — it writes its ledger
        // line when it FINISHES. Saying so is better than inventing a spinner state
        // the server cannot actually observe.
        running: [],
        last: scoutLast
          ? { status: scoutLast.status, detail: scoutLast.detail, ran_at: scoutLast.ran_at }
          : null,
        targets: null,
      },
      {
        kind: 'read',
        label: 'Run a read',
        detail: 'Put one company through the nine-lens panel',
        needs_target: true,
        running: runningReads.map((r) => ({
          id: r.id, target_id: r.founder_id, label: r.company || r.founder_name || `#${r.founder_id}`,
        })),
        last: null,
        targets: readTargets.map((t) => ({
          id: t.id,
          label: t.company || t.name,
          detail: `${t.materials} ${t.materials === 1 ? 'document' : 'documents'} on file`,
        })),
        // Named so the empty state can be honest about WHY it is empty.
        empty_reason: 'No company has materials on file without a read. Add a deck or call notes to a card first.',
      },
      {
        kind: 'hiring',
        label: 'Source candidates',
        detail: 'Find people for one open role at a portfolio company',
        needs_target: true,
        running: runningHiring.map((r) => ({
          id: r.id, target_id: r.role_id, label: r.title || `role #${r.role_id}`,
        })),
        last: null,
        targets: roleTargets.map((t) => ({
          id: t.id,
          label: t.title,
          detail: [t.company_name || t.founder_company, t.matches ? `${t.matches} found so far` : 'nothing found yet']
            .filter(Boolean).join(' · '),
        })),
        empty_reason: 'No open roles. Add one on the Hiring screen.',
      },
    ],
  });
});

// ── POST /api/today/items — Danny adds his own ──
router.post('/items', (req, res) => {
  const { title, detail, lane = 'mine', due_at, founder_id } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  const r = db.prepare(`
    INSERT INTO today_items (origin, lane, title, detail, due_at, founder_id, created_by)
    VALUES ('user', ?, ?, ?, ?, ?, ?)
  `).run(lane, String(title).trim(), detail || null, due_at || null, founder_id || null, req.user.id);
  res.json(db.prepare('SELECT * FROM today_items WHERE id = ?').get(r.lastInsertRowid));
});

// ── PATCH /api/today/items/:id — edit, complete, snooze ──
router.patch('/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM today_items WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const { title, detail, due_at, completed, snoozed_until, sort_order } = req.body;
  db.prepare(`
    UPDATE today_items SET
      title = COALESCE(?, title), detail = COALESCE(?, detail), due_at = COALESCE(?, due_at),
      snoozed_until = COALESCE(?, snoozed_until), sort_order = COALESCE(?, sort_order),
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP WHEN ? = 0 THEN NULL ELSE completed_at END
    WHERE id = ?
  `).run(
    title ?? null, detail ?? null, due_at ?? null, snoozed_until ?? null, sort_order ?? null,
    completed === true ? 1 : null, completed === false ? 0 : null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM today_items WHERE id = ?').get(req.params.id));
});

// ── DELETE /api/today/items/:id ──
// A user row is deleted. An AGENT row is tombstoned, never deleted — otherwise the
// next nightly run re-inserts the thing Danny just dismissed, which is the single
// most common way this pattern dies.
router.delete('/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM today_items WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.origin === 'agent') {
    db.prepare('UPDATE today_items SET dismissed_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.id);
    return res.json({ id: item.id, dismissed: true });
  }
  db.prepare('DELETE FROM today_items WHERE id = ?').run(item.id);
  res.json({ id: item.id, deleted: true });
});

// ── POST /api/decisions — Danny makes the call ──
// A prediction is REQUIRED. This is the whole design of the metric:
// his most common kill is "cool but indefensible" — a ten-second reflex — so a bare
// pass=+1 would pay him to fire it faster, and Portfolio Pattern Analysis says his
// undocumented passes on STRONG founders (Crebit, StrideKick, Concorda) are his most
// fixable blind spot: "you can't tell whether those were good passes or fear/laziness."
// A pass without a dated, checkable claim is not a decision. It stays undecided.
router.post('/decisions', (req, res) => {
  const { founder_id, assessment_id, band, rationale, prediction, resolve_by } = req.body;

  if (!['anchor', 'memo', 'monitor', 'pass'].includes(band)) {
    return res.status(400).json({ error: 'band must be anchor | memo | monitor | pass' });
  }
  if (!prediction || !String(prediction).trim()) {
    return res.status(400).json({
      error: 'A decision needs a falsifiable prediction.',
      detail: 'Without one this is a reflex, not a decision — and in 12 months you cannot tell whether it was a good pass or a fast one. Name something checkable.',
    });
  }
  if (!resolve_by || !/^\d{4}-\d{2}-\d{2}$/.test(resolve_by)) {
    return res.status(400).json({ error: 'resolve_by (YYYY-MM-DD) required — when do we find out?' });
  }

  // Capture what the engine said, so the disagreement becomes the calibration set.
  let stu_band = null, stu_score = null;
  if (assessment_id) {
    const a = db.prepare('SELECT conviction_band, conviction_score FROM opportunity_assessments WHERE id = ? AND created_by = ?')
      .get(assessment_id, req.user.id);
    if (a) { stu_band = a.conviction_band; stu_score = a.conviction_score; }
  }

  // Was the score already computed when he ruled? If conviction_output exists on
  // the assessment, it was on his screen — the client no longer hides it. Recorded
  // as a fact so the calibration set can filter to independent judgements rather
  // than averaging anchored rows in and calling the result calibration.
  const sawFirst = assessment_id
    ? (db.prepare('SELECT conviction_output IS NOT NULL AS seen FROM opportunity_assessments WHERE id = ?')
         .get(assessment_id)?.seen ? 1 : 0)
    : 0;

  const r = db.prepare(`
    INSERT INTO decisions (founder_id, assessment_id, band, rationale, prediction, resolve_by, stu_band, stu_score, saw_score_first, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(founder_id || null, assessment_id || null, band, rationale || null,
         String(prediction).trim(), resolve_by, stu_band, stu_score, sawFirst, req.user.id);

  const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid);
  res.json({
    ...decision,
    // The interesting artifact isn't the decision — it's the gap.
    disagreed: !!(stu_band && stu_band !== band && stu_band !== 'indeterminate'),
  });
});

// ── GET /api/decisions/calibration ──
// "When Stu and I disagreed, who was right?" — the only question here that compounds,
// and the one no tool you can buy is able to answer, because it needs a record of what
// you thought before you knew.
router.get('/decisions/calibration', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, f.name AS founder_name, f.company AS founder_company
    FROM decisions d LEFT JOIN founders f ON d.founder_id = f.id
    WHERE d.created_by = ? ORDER BY d.decided_at DESC
  `).all(req.user.id);

  const withStu = rows.filter((r) => r.stu_band && r.stu_band !== 'indeterminate');
  const disagreed = withStu.filter((r) => r.stu_band !== r.band);
  const resolved = disagreed.filter((r) => r.outcome && r.outcome !== 'unresolved');

  res.json({
    total: rows.length,
    agreed: withStu.length - disagreed.length,
    disagreed: disagreed.length,
    // Null until there is something to say. n=0 is not 50/50.
    danny_right_when_disagreed: resolved.length
      ? Math.round((resolved.filter((r) => r.outcome === 'right').length / resolved.length) * 100)
      : null,
    resolved: resolved.length,
    awaiting: disagreed.length - resolved.length,
    rows: disagreed,
  });
});

// ── PATCH /api/decisions/:id/resolve ──
// ── DELETE /api/today/decisions/:id — he mis-clicked, or it was a probe ──
//
// A decision is a record of judgement, so deleting one is not free: the
// calibration set is only worth anything if it contains the calls he got wrong.
// Nothing here stops him from deleting exactly those, and no amount of code could
// — it's his tool, he's the one being measured, and self-deception is his risk to
// take, not a bug for the server to police.
//
// It exists because the alternative is worse. Without it a fat-fingered band or a
// test row is permanent, and a ledger you cannot correct is one you stop trusting
// — which is the same failure as a ledger full of duplicates, arrived at from the
// other side. Changing his mind does NOT need this: recording a new decision
// supersedes the old one, and both are kept.
router.delete('/decisions/:id', (req, res) => {
  const d = db.prepare('SELECT id FROM decisions WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM decisions WHERE id = ?').run(d.id);
  res.json({ deleted: true, id: d.id });
});

router.patch('/decisions/:id/resolve', (req, res) => {
  const { outcome } = req.body;
  if (!['right', 'wrong', 'unresolved'].includes(outcome)) {
    return res.status(400).json({ error: 'outcome must be right | wrong | unresolved' });
  }
  const d = db.prepare('SELECT * FROM decisions WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE decisions SET outcome = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(outcome, d.id);
  res.json(db.prepare('SELECT * FROM decisions WHERE id = ?').get(d.id));
});

// ── Commitments ──
router.get('/commitments', (req, res) => {
  res.json(commitments.due({ userId: req.user.id, withinDays: Number(req.query.days) || 7 }));
});

router.get('/commitments/founder/:founderId', (req, res) => {
  res.json(commitments.deltaFor(Number(req.params.founderId)));
});

router.post('/commitments', (req, res) => {
  try {
    const r = commitments.record({ ...req.body, createdBy: req.user.id });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/commitments/:id', (req, res) => {
  const { status, closed_at } = req.body;
  try {
    commitments.close(Number(req.params.id), status, closed_at);
    res.json(db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
