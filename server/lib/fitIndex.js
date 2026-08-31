'use strict';
// ══════════════════════════════════════════════════════════════════════════
// fitIndex — the founder-quality verdict, computed once and STORED.
//
// Danny: "it's very laggy." Measured, and it was not the network.
//
// /api/pipeline/inbox scored every pending row on every page load. To do that it
// had to SELECT the four scrape blobs — raw_data, enriched_data, linkedin_data,
// github_slope_data — because lib/founderFit reads employment history and slope out
// of them. Then it threw the blobs away before responding. Measured locally on 226
// rows: 5.13 MB read and 118 ms of founderFit CPU, which is 23.3 KB and 0.52 ms per
// row. Production holds 2,232 pending rows, so that is roughly 51 MB read and 1.2
// seconds of single-threaded CPU, every time the screen opens.
//
// And it was paid in full for the default view. The tier filter ran AFTER scoring,
// so looking at the best 8% cost exactly what looking at all of it cost.
//
// The verdict does not change between page loads. It changes when the ROW changes —
// when LinkedIn enrichment adds employment history, or the slope scorer runs. So it
// is computed at those moments, written to indexed columns, and the inbox becomes an
// ordinary indexed SELECT with a LIMIT.
//
// THE RULE THAT KEEPS THIS HONEST: nothing here re-implements the rubric. It calls
// lib/founderFit.evaluate() — the same function, with the same verbatim-evidence
// gate — and stores what it returns. A second copy of the ranking logic is exactly
// how routes/sourcing.js and routes/pipeline.js drifted into two different inboxes,
// and there will not be a third.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const ff = require('./founderFit');
const RUBRIC_VERSION = ff.RUBRIC_VERSION;

// Everything founderFit.evaluate() reads. Kept here so the one place that pays the
// blob cost is this file, and the inbox never selects a blob again.
const SCORING_COLS = `
  id, name, company, company_one_liner, role, source, headline, fit_rubric_version,
  chicago_connection, location_type, previous_company_norm,
  caliber_signals, builder_signals, pedigree_signals, tags, red_flags,
  raw_data, enriched_data, linkedin_data,
  github_slope_score, github_slope_data, github_resolve_reason
`;

const WRITE = `
  UPDATE sourced_founders SET
    fit_meet = ?, fit_tier = ?, fit_reason = ?, fit_priority = ?,
    fit_stage = ?, fit_stage_late = ?, fit_lifestyle = ?,
    fit_why = ?, fit_marker_count = ?, fit_scored_at = CURRENT_TIMESTAMP,
    fit_rubric_version = ?
  WHERE id = ?
`;

/** Run the rubric on one already-loaded row and return the storable verdict. */
function verdictOf(row) {
  const f = ff.evaluate(row);
  return {
    meet: f.meetWorthy ? 1 : 0,
    tier: f.tier || null,
    reason: f.tierReason || null,
    priority: f.priority || 0,
    stage: f.stage || null,
    stageLate: f.stageTooLate ? 1 : 0,
    lifestyle: f.lifestyle ? 1 : 0,
    // Only the LABELS are stored. The evidence quotes stay in the source blobs where
    // they can be re-derived; the row renders labels, and a stored quote would be a
    // second copy of a receipt that can go stale against the profile it came from.
    why: JSON.stringify(f.why || []),
    markerCount: (f.markers || []).length,
  };
}

/** Score a set of ids (or every row for a user when ids is omitted). */
function rescore({ userId = 1, ids = null } = {}) {
  const where = ids && ids.length
    ? `id IN (${ids.map(() => '?').join(',')})`
    : 'user_id = ?';
  const params = ids && ids.length ? ids : [userId];
  const rows = db.prepare(`SELECT ${SCORING_COLS} FROM sourced_founders WHERE ${where}`).all(...params);

  const write = db.prepare(WRITE);
  const tx = db.transaction((batch) => {
    for (const r of batch) {
      const v = verdictOf(r);
      write.run(v.meet, v.tier, v.reason, v.priority, v.stage, v.stageLate, v.lifestyle, v.why, v.markerCount, RUBRIC_VERSION, r.id);
    }
  });
  tx(rows);
  return { scored: rows.length };
}

/**
 * Score what needs it: never scored, or scored BEFORE the enrichment that would
 * change the answer. Those are the only two ways a stored verdict can be wrong —
 * LinkedIn enrichment adds the employment history the hyperscaler marker reads, and
 * the slope scorer adds the one marker a founder with no pedigree can win on.
 */
function rescoreStale({ userId = 1, limit = 5000 } = {}) {
  const rows = db.prepare(`
    SELECT ${SCORING_COLS} FROM sourced_founders
    WHERE user_id = ?
      AND (
        fit_scored_at IS NULL
        OR (linkedin_enriched_at IS NOT NULL AND fit_scored_at < linkedin_enriched_at)
        OR (github_slope_scored_at IS NOT NULL AND fit_scored_at < github_slope_scored_at)
        -- The rubric itself moved. Without this clause a weight change never reaches
        -- an already-scored founder, and the inbox ranks on retired logic in silence.
        OR COALESCE(fit_rubric_version, '') != ?
      )
    LIMIT ?
  `).all(userId, RUBRIC_VERSION, limit);

  const write = db.prepare(WRITE);
  const tx = db.transaction((batch) => {
    for (const r of batch) {
      const v = verdictOf(r);
      write.run(v.meet, v.tier, v.reason, v.priority, v.stage, v.stageLate, v.lifestyle, v.why, v.markerCount, RUBRIC_VERSION, r.id);
    }
  });
  tx(rows);
  return { scored: rows.length };
}

module.exports = { rescore, rescoreStale, verdictOf, SCORING_COLS };
