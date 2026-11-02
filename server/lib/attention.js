// ══════════════════════════════════════════════════════════════════════════
// The attention engine — what needs Danny today, computed from pipeline state.
//
// PROVENANCE: these rules are Danny's, not mine. On 2026-07-07 he wrote a spec
// into Permute for a "Venture Pipeline Daily Operating Dashboard" and led with:
//
//   "1. Needs My Attention Today (top of page, most important)
//      - Superior Portfolio rows where Next Follow Up Date is today or past
//      - Founder Ecosystem rows where Steward-Operator Flagged is checked and
//        Admission Status is not yet finalized
//      - Founder Ecosystem rows where 'Add to Investment Pipeline' is checked
//        but the company does not appear in Investment Pipeline
//        (A PROMOTION THAT FELL THROUGH THE CRACKS)
//      - Investment Pipeline rows where 'Add to Portfolio' is checked but the
//        company does not appear in Superior Portfolio (same check, one stage
//        later)"
//
// Three of his four rules are CROSS-STAGE INTEGRITY CHECKS. Not "nag me to
// follow up" — find the things that fell BETWEEN the stages. That is the right
// model for two reasons he has stated himself:
//
//   "A lot of it is neglect."          → the failure is dropped things, not laziness
//   "I want to inflate my pipeline numbers."
//                                      → so no rule may ever COUNT the pipeline.
//                                        Every rule below counts a GAP, and a gap
//                                        is a number he has no incentive to game:
//                                        the only way to make it go down is to
//                                        actually do the thing.
//
// And a gap check only works if the stages are one connected record, which is
// why this file is the thing that proves the substrate.
//
// ── THE RULE THAT MAKES THIS RENDER HONESTLY ──
// Every check returns a row EVERY DAY, including when it is clean. Permute does
// this and it is the reason their screen is trustworthy: "✓ Portfolio Follow-Ups
// Overdue — No overdue follow-ups" sits right next to the amber one. A list that
// only appears when there's a problem is indistinguishable from a list that is
// broken. Silence has to mean "I looked," not "I didn't run."
//
// ── WHAT THIS IS NOT ──
// Not a nag. Danny: "Sometimes I just don't feel like following up... Or I'm
// waiting to think through if I believe in a company or not." The blocker isn't
// discipline, it's an unformed view — so a rule fires on the DECISION being
// absent, and the affordance is always "form the view," never "send the email."
// Per his hard constraint, no rule here may ever send anything.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const commitments = require('./commitments');
// companyKey normalises a company name and returns null for generics ("Stealth",
// "Unknown", "TBD"). Reused rather than reimplemented so the definition of "the
// same company" can't drift between the tie gate and the attention engine.
const { companyKey } = require('./ilTie');

// Days a live deal can sit untouched before it counts as going cold.
// Not arbitrary: Crebit died because the round closed the week they met. Three
// weeks is already past the point where latency has cost him a deal once.
const COLD_DAYS = 21;

// The band at which "no decision yet" stops being fine and starts being a gap.
// The rubric's own ladder: >= 7 is "write a memo". If Stu says memo-grade and
// there's no decision on file, that is the exact shape of the thing he told me
// he does — sit on it while the view stays unformed.
const HIGH_SIGNAL = 7;

const today = () => new Date().toISOString().slice(0, 10);

// ── Is this "founder" actually a person? ──
// The March Airtable import wrote company records into `founders` with the person
// field set to "<Company> (Company)" — Prizm's founder name is literally "Prizm
// (Company)". So a row's name is not reliably a human, and printing it next to the
// company renders "Prizm — Prizm (Company)".
//
// This is not worth a migration (see routes/pipeline.js on why nothing here gets
// migrated), but every surface that shows a founder name has to know the field
// lies sometimes. Suppress rather than repeat.
function personName(row) {
  const n = (row.name || '').trim();
  if (!n) return null;
  if (/\(company\)/i.test(n)) return null;
  const c = (row.company || '').trim().toLowerCase();
  if (c && n.toLowerCase() === c) return null;
  return n;
}

// ── Last contact. There is no last_contact column, so it's derived. ──
// call_logs has zero rows in every database I've looked at, so notes carry it in
// practice; updated_at is the floor. COALESCE order matters: a real interaction
// always beats a field edit.
const LAST_TOUCH_SQL = `
  MAX(
    COALESCE((SELECT MAX(created_at) FROM founder_notes n WHERE n.founder_id = f.id), '1970-01-01'),
    COALESCE((SELECT MAX(created_at) FROM call_logs  c WHERE c.founder_id = f.id), '1970-01-01'),
    COALESCE(f.updated_at, '1970-01-01')
  )`;

// ══════════════════════════════════════════════════════════════════════
// Is "last contact" a real signal, or an import artifact?
//
// Measured 2026-07-15 on the live DB: EVERY one of the 187 live founders has
// updated_at = 2026-03-18, and all 189 founder_notes fall inside 2026-03-16..18.
// That is the one-time Airtable import, not contact. call_logs has zero rows.
//
// So a going-cold check would have told Danny "118 days quiet" about all 40 live
// deals, every day, forever — a number computed off the day the data was loaded.
// That is precisely the failure the conviction engine one layer down exists to
// prevent: rendering an infrastructure gap and a real judgment identically. The
// engine's rule is "below the evidence rung there is no score, there's a question
// list," and the attention layer has to obey the same rule or it inherits the
// dishonesty the rebuild was meant to remove.
//
// So the check BLOCKS itself rather than firing. This is self-diagnosing, not a
// hardcoded off-switch: the moment a real touch lands — Granola workups pushing
// to the write path that already carries commitments — freshness returns and the
// check starts running on its own. Nobody has to remember to turn it back on.
// ══════════════════════════════════════════════════════════════════════
const TOUCH_LIVENESS_DAYS = 30;

function touchSignalIsLive(uid) {
  const row = db.prepare(`
    SELECT MAX(t) AS newest FROM (
      SELECT MAX(n.created_at) AS t FROM founder_notes n
        JOIN founders f ON n.founder_id = f.id WHERE f.created_by = ? AND f.is_deleted = 0
      UNION ALL
      SELECT MAX(c.created_at) FROM call_logs c
        JOIN founders f ON c.founder_id = f.id WHERE f.created_by = ? AND f.is_deleted = 0
    )
  `).get(uid, uid);

  if (!row?.newest) return { live: false, reason: 'No calls or notes have ever been recorded against a founder.' };

  const ageDays = Math.floor((Date.now() - new Date(row.newest).getTime()) / 86400000);
  if (ageDays > TOUCH_LIVENESS_DAYS) {
    return {
      live: false,
      newest: String(row.newest).slice(0, 10),
      reason:
        `The most recent call or note in the whole pipeline is ${ageDays} days old (${String(row.newest).slice(0, 10)}), ` +
        `which is the Airtable import, not contact. Every "days quiet" number would be measuring the day the data loaded. ` +
        `Wire Granola workups into the contact log and this check starts running on its own.`,
    };
  }
  return { live: true, newest: String(row.newest).slice(0, 10) };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 1 — They owe me, and it's past due.
// Danny's "Next Follow Up Date is today or in the past", over the ledger that
// actually holds promises. Q10 is his self-declared best signal; this is the
// only place in the stack where the delta between said and did becomes visible.
// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
// THIS DROPPED DANNY'S OWN COMMITMENTS ON THE FLOOR.
//
// commitments.due() returns { i_owe, they_owe }. This destructured only
// they_owe — so the engine surfaced everyone's neglect except his.
//
// His own diagnosis is "a lot of it is neglect" and "sometimes I just don't feel
// like following up". That's HIS neglect. Meanwhile, from the real Cadrian call,
// he owes two things due 2026-07-18:
//   "Send intro to Tom Elnik (Tegus/Alpha Science) and Bezod Surjanny"
//   "Book the Cadrian demo and loop in Eric + Rob"
// Neither appeared anywhere on Home. The second is him doing deal-leader
// behaviour on the record — the exact thing this product exists to make possible
// — and the engine dropped it.
//
// A red-team of investors found this in one read. It was one destructure.
// ══════════════════════════════════════════════════════════════════════
function owedByMe(uid) {
  const { i_owe } = commitments.due({ userId: uid, withinDays: 3 });
  return {
    key: 'i_owe',
    title: 'You owe them',
    clean: 'You owe nobody anything',
    count: i_owe.length,
    action: 'Do it or say when',
    rows: i_owe.map((c) => ({
      id: c.id,
      founder_id: c.founder_id,
      company: c.founder_company,
      primary: c.founder_company || c.founder_name || 'Unknown',
      detail: c.commitment,
      quote: c.quote,
      meta: c.due_at ? (c.overdue ? `overdue since ${c.due_at}` : `due ${c.due_at}`) : null,
    })),
  };
}

function overduePromises(uid) {
  const { they_owe } = commitments.due({ userId: uid, withinDays: 0 });
  return {
    key: 'overdue_promises',
    title: 'Promises past due',
    clean: 'Nobody owes you anything overdue',
    count: they_owe.length,
    // Not "chase them" — his constraint is absolute: "Just nudge me to follow up."
    action: 'Check the delta before you follow up',
    rows: they_owe.map((c) => ({
      id: c.id,
      founder_id: c.founder_id,
      primary: c.founder_company || c.founder_name || 'Unknown',
      detail: c.commitment,
      quote: c.quote,
      meta: `owed since ${c.due_at}`,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 2 — Stu says memo-grade. There is no decision on file.
// Danny's "flagged (score >= 6) and Admission Status is not yet finalized."
//
// This is the highest-value rule in the file, because it fires precisely on the
// failure his own Portfolio Pattern Analysis names as most fixable: "you pass
// well on markets, poorly on documentation — and the gap is exactly on your best
// founders." An undecided memo-grade read IS that gap, caught while it's still
// live rather than in a retrospective 12 months later.
// ══════════════════════════════════════════════════════════════════════
function undecidedHighSignal(uid) {
  // ══════════════════════════════════════════════════════════════════════
  // BLOCKED, not clean. This check cannot run and must say so.
  //
  // Measured 2026-07-16: 14 completed assessments, and conviction_score is NULL
  // on all 14. Not a persistence bug — routes/assessments.js:765 writes it fine.
  // Every one of those assessments ran 2026-04-04..15, and the conviction engine
  // shipped in July. NOTHING HAS BEEN ASSESSED SINCE THE ENGINE WAS BUILT.
  //
  // So `conviction_score >= 7` was evaluating `NULL >= 7` -> NULL -> false, and
  // this check reported "✓ Every memo-grade read has your call on it" — a clean
  // green tick asserting the opposite of the truth, which is that no read has a
  // score at all. That is exactly the false-by-silence failure goingCold() below
  // refuses to commit, in the same file, thirty lines down.
  //
  // routes/today.js:48 already draws the distinction this check was missing: a
  // NULL band means EITHER the engine ran and honestly held for lack of evidence,
  // OR the row predates the engine and was never scored. conviction_output tells
  // them apart. Reporting the second as "clean" is the same lie the rebuild
  // exists to remove, one layer up.
  //
  // Self-diagnosing: the moment one assessment runs under the current engine,
  // this unblocks on its own. Nobody has to remember.
  // ══════════════════════════════════════════════════════════════════════
  const scored = db.prepare(`
    SELECT COUNT(*) n FROM opportunity_assessments
    WHERE created_by = ? AND is_deleted = 0 AND assessment_type = 'assessment'
      AND status IN ('complete','partial') AND conviction_output IS NOT NULL
  `).get(uid).n;

  const legacy = db.prepare(`
    SELECT COUNT(*) n FROM opportunity_assessments
    WHERE created_by = ? AND is_deleted = 0 AND assessment_type = 'assessment'
      AND status IN ('complete','partial') AND conviction_output IS NULL
  `).get(uid).n;

  if (!scored) {
    return {
      key: 'undecided_high_signal',
      title: 'Memo-grade reads with no decision',
      clean: 'Every memo-grade read has your call on it',
      count: 0,
      blocked: true,
      blocked_reason: legacy
        ? `${legacy} assessments on file, none scored by the current conviction engine — they all predate it. ` +
          `Re-run one and this check starts working. Until then it can't tell a memo-grade read from a pass.`
        : 'No assessment has ever completed, so there is nothing to have a view about yet.',
      action: legacy ? 'Re-run a read' : null,
      rows: [],
    };
  }

  const rows = db.prepare(`
    SELECT a.id AS assessment_id, a.founder_id, a.conviction_score, a.conviction_band,
           a.created_at, f.name AS founder_name, f.company AS founder_company
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.created_by = ? AND a.is_deleted = 0
      AND a.status IN ('complete','partial') AND a.assessment_type = 'assessment'
      AND a.conviction_score >= ?
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.assessment_id = a.id)
      -- One row per founder, not per assessment run. He has one Gatsby decision
      -- to make, not two, however many times the engine ran.
      AND a.id = (
        SELECT a2.id FROM opportunity_assessments a2
        WHERE a2.is_deleted = 0 AND a2.created_by = a.created_by
          AND a2.status IN ('complete','partial') AND a2.assessment_type = 'assessment'
          AND a2.founder_id = a.founder_id
        ORDER BY a2.created_at DESC, a2.version_number DESC LIMIT 1)
    ORDER BY a.conviction_score DESC
  `).all(uid, HIGH_SIGNAL);

  // ── The check can only speak for what it can SEE. ──
  // The guard above asks "has the engine ever run"; this check's claim requires
  // "has it run on the things this check is about". Measured 2026-07-16: 2 of 40
  // assessments are scored, so the moment ONE ran the check unblocked and rendered
  // a green "✓ Every memo-grade read has your call on it" — computed over 2 deals
  // and silent about 38. That's the same false-by-silence failure this file's own
  // header describes fixing, reintroduced by a guard that was too coarse.
  //
  // So a clean result now states its scope. "Clean" that quietly means "clean
  // across 5% of your pipeline" is a lie of omission, and this file's whole
  // premise is that it doesn't tell those.
  const scopeNote = legacy
    ? `across the ${scored} assessment${scored === 1 ? '' : 's'} the engine has scored — ${legacy} predate it and can't be checked`
    : null;

  return {
    key: 'undecided_high_signal',
    title: 'Memo-grade reads with no decision',
    clean: legacy
      ? `No memo-grade read is missing your call — ${scopeNote}`
      : 'Every memo-grade read has your call on it',
    scope_note: scopeNote,
    count: rows.length,
    action: 'Make the call',
    rows: rows.map((r) => ({
      id: r.assessment_id,
      founder_id: r.founder_id,
      assessment_id: r.assessment_id,
      primary: r.founder_company || r.founder_name || 'Unknown',
      detail: `Stu reads ${r.conviction_score?.toFixed?.(1) ?? r.conviction_score} — ${r.conviction_band}. You haven't said.`,
      meta: `assessed ${String(r.created_at).slice(0, 10)}`,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 3 — Approved out of the inbox, never entered the pipeline.
// Danny's, verbatim: "a promotion that fell through the cracks."
//
// This is the check that only exists because sourcing and pipeline are ONE
// record. `sourced_founders.promoted_to_founder_id` is the join; if a row is
// approved and that pointer is still null, the approve either failed or the
// promotion was never finished. Today that is a silent data loss — the row just
// sits there looking handled.
// ══════════════════════════════════════════════════════════════════════
function approvedNeverEntered(uid) {
  const rows = db.prepare(`
    SELECT id, name, company, source, created_at
    FROM sourced_founders
    WHERE user_id = ? AND status = 'approved' AND promoted_to_founder_id IS NULL
    ORDER BY created_at DESC
  `).all(uid);

  return {
    key: 'approved_never_entered',
    title: 'Approved but never entered the pipeline',
    clean: 'No promotions fell through the cracks',
    count: rows.length,
    action: 'Finish the promotion',
    rows: rows.map((r) => ({
      id: r.id,
      company: r.company,
      // A generic company name is not a name. 8 of the 31 rows in
      // considering_never_assessed all read "Stealth" and they are 8 DIFFERENT
      // companies — eight identical cards is how a list gets ignored. Fall back
      // to the founder, who at least tells them apart.
      primary: companyKey({ company: r.company }) ? r.company : (r.name || 'Unknown'),
      detail: 'You approved this out of the inbox and it never became a pipeline record.',
      meta: `via ${r.source}`,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 4 — LIVE and never assessed. Danny's "same check, one stage later."
//
// The gap this exists to catch: 40 deals under consideration, 6 ever assessed.
// That is the reason he cannot walk into IC as the deal leader — not because the
// engine is bad, but because it was never pointed at the other 34.
//
// ── WHY INVESTED COMPANIES ARE EXCLUDED ──
// Danny, 2026-07-15: "If we invest in a company before I assess, that's ok."
//
// The first run of this rule returned all 7 portfolio companies — Prizm, Permute,
// Bridgeline, Scaylor, Siftree, Avant Health, Paragility — as "live deals Stu has
// never looked at," because every one of them still carries the stale
// deal_status='Under Consideration' from before the money moved. Chasing a read on
// a company he already owns is not a gap, it's noise, and noise is how a list like
// this loses his trust in a week.
//
// So the filter is investment_amount, not deal_status: a recorded check is a fact
// that can't go stale, and it's true the moment it's written. An unassessed
// portfolio company is an outcome, not an omission.
// ══════════════════════════════════════════════════════════════════════
function consideringNeverAssessed(uid) {
  const rows = db.prepare(`
    SELECT f.id, f.name, f.company, f.company_one_liner, f.deal_status,
           f.deal_entered_at, f.created_at
    FROM founders f
    WHERE f.created_by = ? AND f.is_deleted = 0
      AND (
        -- EVIDENCE of life, not a stale field. See the note above.
        f.deal_status = 'Under Consideration'
        OR EXISTS (SELECT 1 FROM company_sources cs WHERE cs.founder_id = f.id)
        OR EXISTS (SELECT 1 FROM commitments cm WHERE cm.founder_id = f.id AND cm.status = 'open')
        OR EXISTS (SELECT 1 FROM call_logs cl WHERE cl.founder_id = f.id)
      )
      AND COALESCE(f.investment_amount, 0) = 0
      AND COALESCE(f.investment_amount, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM opportunity_assessments a
        WHERE a.founder_id = f.id AND a.is_deleted = 0
          AND a.status IN ('complete','partial') AND a.assessment_type = 'assessment')
    ORDER BY COALESCE(f.deal_entered_at, f.created_at) DESC
  `).all(uid);

  return {
    key: 'considering_never_assessed',
    title: 'Live deals with no read',
    clean: 'Every live deal has a read on it',
    count: rows.length,
    action: 'Run the read',
    rows: rows.map((r) => ({
      id: r.id,
      founder_id: r.id,
      company: r.company,
      // A generic company name is not a name. 8 of the 31 rows in
      // considering_never_assessed all read "Stealth" and they are 8 DIFFERENT
      // companies — eight identical cards is how a list gets ignored. Fall back
      // to the founder, who at least tells them apart.
      primary: companyKey({ company: r.company }) ? r.company : (r.name || 'Unknown'),
      // The fact that Stu has never looked is the CHECK's claim, not the row's —
      // it's already in the title. Rendering it per-row printed one identical
      // sentence 40 times, which is the same "nine rows carrying one bit between
      // them" failure the old Today screen shipped. The row's job is to tell them
      // apart, so it carries the thing that differs.
      detail: [personName(r), r.company_one_liner].filter(Boolean).join(' — '),
      // ── No meta. Measured: deal_entered_at is 2026-03-18 on ALL 40 rows. ──
      // It's the Airtable import date, not when anything entered anything. So
      // "in the pipeline since 2026-03-18" rendered 31 times is 31 rows carrying
      // ONE bit between them — the precise failure the header of this file
      // describes fixing on the old Today screen, reproduced here at 31x by a
      // line whose own comment calls it "a real recorded fact." It records the
      // import, and Danny cannot act on it.
      //
      // When there is nothing distinguishing to say, say nothing. This comes back
      // the moment deal_entered_at means something.
      meta: null,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 5 — Live and going cold.
// Not in his Permute spec; earned its place from the record. Crebit was lost
// because the round closed the week they met. Latency kills deals, and a deal
// nobody has touched in three weeks is a deal that is deciding itself.
// ══════════════════════════════════════════════════════════════════════
function goingCold(uid) {
  // Refuse before computing. A "days quiet" number off the import date is not a
  // weaker signal than the real thing — it is a fabricated one, and it would be
  // the loudest thing on the screen.
  const signal = touchSignalIsLive(uid);
  if (!signal.live) {
    return {
      key: 'going_cold',
      title: 'Live deals going cold',
      clean: 'Nothing live has gone quiet',
      count: 0,
      blocked: true,
      blocked_reason: signal.reason,
      action: 'Wire up contact history',
      rows: [],
    };
  }

  const rows = db.prepare(`
    SELECT f.id, f.name, f.company, ${LAST_TOUCH_SQL} AS last_touch,
           CAST(julianday('now') - julianday(${LAST_TOUCH_SQL}) AS INTEGER) AS days
    FROM founders f
    WHERE f.created_by = ? AND f.is_deleted = 0
      AND (
        -- EVIDENCE of life, not a stale field. See the note above.
        f.deal_status = 'Under Consideration'
        OR EXISTS (SELECT 1 FROM company_sources cs WHERE cs.founder_id = f.id)
        OR EXISTS (SELECT 1 FROM commitments cm WHERE cm.founder_id = f.id AND cm.status = 'open')
        OR EXISTS (SELECT 1 FROM call_logs cl WHERE cl.founder_id = f.id)
      )
      AND COALESCE(f.investment_amount, 0) = 0
      -- A portfolio company going quiet is a portfolio-management question, not a
      -- deal that's slipping away. Same exclusion as rule 4, same reason.
      AND COALESCE(f.investment_amount, 0) = 0
      AND julianday('now') - julianday(${LAST_TOUCH_SQL}) > ?
    ORDER BY days DESC
  `).all(uid, COLD_DAYS);

  return {
    key: 'going_cold',
    title: 'Live deals going cold',
    clean: 'Nothing live has gone quiet',
    count: rows.length,
    action: 'Decide or let it go',
    rows: rows.map((r) => ({
      id: r.id,
      founder_id: r.id,
      company: r.company,
      // A generic company name is not a name. 8 of the 31 rows in
      // considering_never_assessed all read "Stealth" and they are 8 DIFFERENT
      // companies — eight identical cards is how a list gets ignored. Fall back
      // to the founder, who at least tells them apart.
      primary: companyKey({ company: r.company }) ? r.company : (r.name || 'Unknown'),
      // Passing must be cheap and kind — so the framing offers the exit, not guilt.
      detail: `${r.days} days quiet. A pass with respect is a real answer.`,
      meta: `last touched ${String(r.last_touch).slice(0, 10)}`,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// RULE 6 — A prediction has come due.
// The only rule here that makes anything compound. Every decision carries a
// dated falsifiable claim; this is the day the claim gets checked. Without this
// rule the calibration set never resolves and "when Stu and I disagreed, who was
// right?" stays permanently unanswerable.
// ══════════════════════════════════════════════════════════════════════
function predictionsDue(uid) {
  const rows = db.prepare(`
    SELECT d.*, f.name AS founder_name, f.company AS founder_company
    FROM decisions d LEFT JOIN founders f ON d.founder_id = f.id
    WHERE d.created_by = ? AND d.resolved_at IS NULL AND d.resolve_by <= date('now')
    ORDER BY d.resolve_by ASC
  `).all(uid);

  return {
    key: 'predictions_due',
    title: 'Predictions to settle',
    clean: 'No predictions have come due',
    count: rows.length,
    action: 'Were you right?',
    rows: rows.map((r) => ({
      id: r.id,
      founder_id: r.founder_id,
      decision_id: r.id,
      primary: r.founder_company || r.founder_name || 'Unknown',
      detail: r.prediction,
      meta: `you said ${r.band}${r.stu_band && r.stu_band !== r.band ? ` · Stu said ${r.stu_band}` : ''} on ${String(r.decided_at).slice(0, 10)}`,
    })),
  };
}

/**
 * Run every check. Order is fixed and meaningful: it descends from "someone else
 * is waiting on you" through "you're the blocker" to "you can learn something."
 * Clean checks are NOT filtered out — see the header.
 */
function checks(uid = 1) {
  const all = [
    // HIS commitments lead. "A lot of it is neglect" — his words about his own
    // follow-through — and until now the engine surfaced everyone's but his.
    owedByMe(uid),
    overduePromises(uid),
    undecidedHighSignal(uid),
    consideringNeverAssessed(uid),
    goingCold(uid),
    predictionsDue(uid),
  ];

  // The headline counts DISTINCT COMPANIES, not rows.
  //
  // Summing rows across checks reported 80 when the truth was 40 — the same 40
  // deals are both never-assessed and going cold, because those are two symptoms
  // of one fact. A number that doubles when you add a rule is a number that
  // punishes Danny for instrumenting his own pipeline, and he'd stop reading it
  // by Thursday. What he needs to know is how many COMPANIES want him today.
  // ══════════════════════════════════════════════════════════════════════
  // Dedupe by COMPANY, which is what the comment below always claimed and the
  // code never did. It keyed on `f${founder_id}` — per FOUNDER — so Permute's two
  // rows (Scott Nelson, Eric Mills) counted twice, as did Siftree's, Mondo's,
  // ClearCogs' and August's. Danny does not have two Permute decisions to make.
  //
  // companyKey() comes from ilTie.js, which already solved the other half: it
  // returns null for GENERIC_COMPANY ("Stealth", "Unknown", "TBD"). That matters
  // here more than anywhere — 8 of the 31 rows in considering_never_assessed all
  // render `primary: "Stealth"`, and they are 8 DIFFERENT companies. Collapsing
  // them on the string would hide seven real gaps; counting them as one company
  // would be worse than counting eight. So a generic name falls back to the
  // founder id, which is the only identity those rows actually have.
  // ══════════════════════════════════════════════════════════════════════
  // The read backlog (considering_never_assessed) is a FACT, not a task — reading all
  // of it is one Opus run per deal, which is why Home splits it into the footer
  // ("N live deals with no read") and keeps it OUT of the Needs You panel. The header
  // count has to agree with that: it counts actionable gaps, not the backlog, or it
  // reads "94 companies need you" while the panel it sits above says "all clean".
  const BACKLOG_KEYS = new Set(['considering_never_assessed']);
  const distinct = new Set();
  for (const c of all) {
    if (c.blocked || BACKLOG_KEYS.has(c.key)) continue;
    for (const r of c.rows) {
      const key = companyKey({ company: r.company });
      distinct.add(key ? `c:${key}` : r.founder_id ? `f${r.founder_id}` : `${c.key}:${r.id}`);
    }
  }

  return {
    checks: all,
    open: all.filter((c) => c.count > 0).length,
    blocked: all.filter((c) => c.blocked).length,
    // A count of GAPS, deduped by company. Never a count of pipeline.
    needs_attention: distinct.size,
    generated_at: today(),
  };
}

module.exports = { checks, COLD_DAYS, HIGH_SIGNAL, touchSignalIsLive };
