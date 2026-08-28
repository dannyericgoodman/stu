'use strict';
// ══════════════════════════════════════════════════════════════════════════
// rescore-hiring-matches — bring stored shortlists onto the new ranker.
//
// `hiring_matches.rank_score` was written by the old formula, where warm carried a
// flat +1,000. The role page orders by that column, so until a role is re-matched it
// still renders the old order — six Permute Hackathon attendees above the founding
// engineer who matches the JD — and the fix looks like it did nothing.
//
// This recomputes the DETERMINISTIC half only: fit_score, rank_score, tier,
// strengths, gaps, breakdown. It does not call an LLM, so it costs nothing.
//
// What it deliberately does NOT touch:
//   · rationale — written by a model against a real profile; still true, and
//     re-deriving it would mean spending money to say the same thing.
//   · status    — sourced → shortlisted → shared → intro_made is where Danny has
//     already moved someone. A re-score must never reset his pipeline.
//
// A candidate who no longer clears the gates (a hard function mismatch, below the
// fit floor, or nothing describable about them) is soft-deleted from the shortlist
// rather than left with a stale score — EXCEPT where Danny has already acted on
// them, because a name he shared with a founder must not vanish from his own record.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { rankCandidates } = require('../pipeline/hiring-match');

// Statuses that mean Danny has already done something with this person.
const ACTED = new Set(['shortlisted', 'shared', 'intro_made', 'hired', 'passed']);

function rescoreHiringMatches({ apply = true } = {}) {
  const roles = db.prepare('SELECT * FROM hiring_roles WHERE is_deleted = 0').all();
  let updated = 0, retired = 0, kept = 0;

  const upd = db.prepare(`
    UPDATE hiring_matches
       SET tier = ?, fit_score = ?, rank_score = ?, strengths = ?, gaps = ?, breakdown = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `);
  const retire = db.prepare(
    `UPDATE hiring_matches SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?`
  );

  for (const role of roles) {
    const matches = db.prepare(
      'SELECT * FROM hiring_matches WHERE role_id = ? AND is_deleted = 0'
    ).all(role.id);
    if (!matches.length) continue;

    const ids = matches.map((m) => m.candidate_id);
    const pool = db.prepare(
      `SELECT * FROM hiring_candidates WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted = 0`
    ).all(...ids);

    const ranked = rankCandidates(role, pool);
    const byCandidate = new Map(ranked.map((r) => [r.candidate.id, r]));

    db.transaction(() => {
      for (const m of matches) {
        const r = byCandidate.get(m.candidate_id);
        if (!r) {
          if (ACTED.has(m.status)) { kept++; continue; }   // his record, not ours to erase
          if (apply) retire.run(m.id);
          retired++;
          continue;
        }
        if (apply) {
          upd.run(
            r.tier, r.fit, r.rank_score,
            JSON.stringify(r.strengths || []), JSON.stringify(r.gaps || []),
            JSON.stringify(r.breakdown || {}), m.id
          );
        }
        updated++;
      }
    })();
  }

  return { roles: roles.length, updated, retired, kept_because_acted_on: kept };
}

module.exports = { rescoreHiringMatches };

if (require.main === module) {
  const apply = !process.argv.includes('--dry');
  console.log(JSON.stringify(rescoreHiringMatches({ apply }), null, 2));
}
