'use strict';
// ══════════════════════════════════════════════════════════════════════════
// morningList.js — which founders the homepage shows before Danny wakes up.
//
// Danny: "I don't need the newly sourced founders to be emailed to me. If they
// could just appear on Stu's homepage every morning that's fine."
//
// They could not. Two independent defects meant the one thing the morning list
// exists to show — who arrived last night — was the one thing it could not show.
//
// ── 1. "New" was measured against the clock that starts AFTER the work ──
// job_runs.ran_at is `DEFAULT CURRENT_TIMESTAMP` on INSERT, and the scout records
// its row at the END of the run (index.js, after sweep → rosters → enrich → score).
// So every founder that run inserted has created_at EARLIER than the ran_at of the
// very run that inserted it. The shortlist then asked `created_at >= lastRun`.
// That is false for every founder the scout has ever added, so `new_today` was
// structurally 0 and no row ever got the "new" badge. The UI for it shipped and
// was correct; it was simply never handed a true value.
//
// The boundary must therefore be the PREVIOUS run's completion — "everything since
// the last list you saw" — not this run's. That window also self-heals a missed
// night: if the scout skips a day, the next morning correctly shows two days of
// arrivals rather than silently dropping them.
//
// ── 2. Ranking had no room for arrivals ──
// The order was tier → priority → created_at, capped at 10, over a pool that only
// drains when Danny dispositions someone. Measured on the real 932-row database:
// 82 eligible, 17 of them must-meet, and 9 of the 10 rows on screen were sourced
// on a single day six weeks earlier. A founder sourced last night had to be
// must-meet AND out-rank the 17th incumbent to be seen; all 65 "strong" founders
// were unreachable at any age. New arrivals did not lose the ranking — they never
// entered it.
//
// So arrivals get RESERVED SLOTS. Up to half the list is held for founders newer
// than the boundary; the rest fills from the standing ranked backlog exactly as
// before. Nothing is relaxed about the quality gates — a new founder still has to
// clear fit_meet and the stage filter to be eligible at all. The change is that
// clearing them is now sufficient to be seen, which is what "they appear on the
// homepage every morning" requires.
//
// When nothing is new, reserved slots collapse to zero and the list is byte-for-byte
// what it was before. The old behaviour is the empty case of the new one.
// ══════════════════════════════════════════════════════════════════════════

// The eligibility gate. Unchanged from the original shortlist query and shared by
// both bands, so "new" can never mean "held to a lower standard".
const ELIGIBLE = `
  user_id = ? AND status IN ('pending','starred')
  AND COALESCE(do_not_resurface, 0) = 0
  AND list_scope = 'pipeline'
  AND fit_meet = 1
  AND COALESCE(fit_stage_late, 0) = 0`;

// tier, then priority, then recency — the standing ranking, applied within each band.
const RANK = `
  ORDER BY CASE fit_tier WHEN 'must-meet' THEN 2 WHEN 'strong' THEN 1 ELSE 0 END DESC,
           COALESCE(fit_priority, 0) DESC,
           created_at DESC`;

// ── The "new since he last looked" boundary ──
// Deliberately the SECOND-most-recent run: see the header. Only completed runs count
// ('ok'/'partial'), because a run that errored before inserting anything did not
// show him a list, and using it as a boundary would silently mark real arrivals old.
function newBoundary(db, userId) {
  const runs = db.prepare(
    `SELECT ran_at FROM job_runs
      WHERE job = 'nightly_scout' AND (user_id = ? OR user_id IS NULL)
        AND status IN ('ok','partial')
      ORDER BY ran_at DESC LIMIT 2`
  ).all(userId);

  // The usual case: everything added since the previous morning's list.
  if (runs.length >= 2) return runs[1].ran_at;

  // Exactly one run on record — it is the one that just populated the list, and its
  // own rows predate its ran_at. Reach back a day so they are correctly new.
  if (runs.length === 1) {
    return db.prepare(`SELECT datetime(?, '-1 day') AS t`).get(runs[0].ran_at).t;
  }

  // Never run (fresh install, or a scout that has only ever errored).
  return db.prepare(`SELECT datetime('now','-1 day') AS t`).get().t;
}

// ── Pick the ids for the morning list ──
// Returns ids in DISPLAY order: arrivals first, then the standing backlog. A morning
// list is read top-down and stops being read early, so what is new goes where it will
// actually be seen. Rows still carry their tier, so nothing is disguised as better
// than it is.
function pickShortlist(db, userId, limit) {
  const boundary = newBoundary(db, userId);

  // Hold up to half the list for arrivals — enough that a real night of sourcing is
  // never invisible, bounded so a noisy night cannot evict the whole standing list.
  const reserved = Math.ceil(limit / 2);

  const fresh = db.prepare(
    `SELECT id FROM sourced_founders WHERE ${ELIGIBLE} AND created_at >= ? ${RANK} LIMIT ?`
  ).all(userId, boundary, reserved).map((r) => r.id);

  const freshSet = new Set(fresh);

  // Fill the remainder from everything else, newest arrivals already removed so a
  // founder can never occupy two slots.
  const rest = limit - fresh.length;
  const standing = rest > 0
    ? db.prepare(
      `SELECT id FROM sourced_founders WHERE ${ELIGIBLE} AND created_at < ? ${RANK} LIMIT ?`
    ).all(userId, boundary, rest).map((r) => r.id)
    : [];

  return { ids: [...fresh, ...standing], boundary, isNew: (id) => freshSet.has(id) };
}

module.exports = { newBoundary, pickShortlist, ELIGIBLE, RANK };
