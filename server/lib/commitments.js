// ══════════════════════════════════════════════════════════════════════════
// The commitment ledger — the one thing only Stu can hold.
//
// Danny's first-call script, Q10:
//   "The delta between what they said and what they did is my single best
//    signal — it's the one thing they can't perform."
//
// He has never recorded it. Not once. Grep the vault: "Q10" appears in exactly
// one file — the question bank itself. Concorda has THREE call notes; the only
// use of "commitment" in call two is "$3M round with full commitments secured",
// a fundraising fact. No call two has ever opened with call one's promise.
//
// Why this lives in Stu and not in the vault or a scheduled task:
//   The vault holds DOCUMENTS. The workup task writes an excellent one every
//   night. But a commitment is not a document — it's STATE. It has a clock, it
//   changes, it comes due, it gets kept or broken. A markdown file can record
//   that a promise was made; only a database can tell you it's three days late.
//   That is the entire reason Stu exists as a surface over the tasks.
//
// And it's how movement 2 gets earned. A founder SAYING they update is
// self-report. Watching what they did against what they said is an observation.
// Execution & Learning Velocity is one of the two STRONG-evidence movements and
// it cannot honestly be scored off one call. It can be scored off the delta.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');

const OWED_BY = { THEM: 'them', ME: 'me' };

// A commitment's life. Deliberately small — five states, no workflow engine.
const STATUS = {
  OPEN: 'open', // said, not yet due, not yet done
  KEPT: 'kept', // they did it (or you did)
  BROKEN: 'broken', // the window passed and it didn't happen
  RELEASED: 'released', // no longer matters — the deal died, the need changed
};

/**
 * The delta. This is the whole point of the table.
 * Returns what the founder said, what happened, and how long it took —
 * which is the only measurement of learning velocity that isn't self-report.
 */
function deltaFor(founderId) {
  const rows = db.prepare(`
    SELECT * FROM commitments
    WHERE founder_id = ? AND owed_by = 'them'
    ORDER BY stated_at ASC
  `).all(founderId);

  const closed = rows.filter((r) => r.status === 'kept' || r.status === 'broken');
  const kept = closed.filter((r) => r.status === 'kept');

  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'open').length,
    kept: kept.length,
    broken: closed.length - kept.length,
    // Null, not 0 or 100, when nothing has closed yet. An unmeasured founder is
    // not a perfect founder — the same rule the conviction engine enforces.
    kept_rate: closed.length ? Math.round((kept.length / closed.length) * 100) : null,
    // Median days late across kept commitments, when a due date existed.
    slip_days: medianSlip(kept),
    rows,
  };
}

function medianSlip(kept) {
  const slips = kept
    .filter((r) => r.due_at && r.closed_at)
    .map((r) => Math.round((new Date(r.closed_at) - new Date(r.due_at)) / 86400000))
    .sort((a, b) => a - b);
  if (!slips.length) return null;
  const mid = Math.floor(slips.length / 2);
  return slips.length % 2 ? slips[mid] : Math.round((slips[mid - 1] + slips[mid]) / 2);
}

/**
 * Record a commitment. `quote` is required and must be verbatim — a commitment
 * without the line that proves it is a paraphrase, and a paraphrase of a promise
 * is exactly the thing that can be performed.
 */
function record({ founderId, assessmentId, owedBy, commitment, quote, statedAt, dueAt, sourceRef, createdBy }) {
  if (!commitment || !quote) throw new Error('a commitment needs both the commitment and the verbatim line');
  if (!Object.values(OWED_BY).includes(owedBy)) throw new Error(`owed_by must be them|me, got ${owedBy}`);

  // Idempotency. The workup task re-reads "this week" every night, so the same
  // promise will be seen ~7 times. Without this the ledger fills with duplicates
  // and Danny stops trusting it by Thursday.
  const key = dedupeKey(founderId, commitment);
  const existing = db.prepare('SELECT id FROM commitments WHERE dedupe_key = ?').get(key);
  if (existing) return { id: existing.id, created: false };

  const r = db.prepare(`
    INSERT INTO commitments
      (founder_id, assessment_id, owed_by, commitment, quote, stated_at, due_at, source_ref, status, dedupe_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(founderId, assessmentId || null, owedBy, commitment, quote, statedAt, dueAt || null, sourceRef || null, key, createdBy);
  return { id: r.lastInsertRowid, created: true };
}

// Normalised enough to catch the same promise phrased slightly differently across
// two nightly runs; specific enough not to collapse two real promises.
function dedupeKey(founderId, commitment) {
  const norm = String(commitment).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return `${founderId}:${norm}`;
}

function close(id, status, closedAt, userId) {
  if (![STATUS.KEPT, STATUS.BROKEN, STATUS.RELEASED].includes(status)) throw new Error(`bad status ${status}`);
  if (userId == null) throw new Error('close requires a userId — commitments are per-user');
  // Owner-scoped: a user can only close their own commitments. Without the
  // created_by predicate, any authenticated user could close anyone's rows.
  const r = db.prepare('UPDATE commitments SET status = ?, closed_at = ? WHERE id = ? AND created_by = ?')
    .run(status, closedAt || new Date().toISOString().slice(0, 10), id, userId);
  if (!r.changes) throw new Error('commitment not found');
}

/**
 * Everything that needs Danny today, in decay order.
 * Deliberately NOT "everything open" — a list that never empties is a list you
 * stop reading.
 */
function due({ withinDays = 7, userId = 1 } = {}) {
  const horizon = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const mine = db.prepare(`
    SELECT c.*, f.name AS founder_name, f.company AS founder_company
    FROM commitments c LEFT JOIN founders f ON c.founder_id = f.id
    WHERE c.status = 'open' AND c.owed_by = 'me' AND c.created_by = ?
      AND (c.due_at IS NULL OR c.due_at <= ?)
    ORDER BY COALESCE(c.due_at, c.stated_at) ASC
  `).all(userId, horizon);

  const theirs = db.prepare(`
    SELECT c.*, f.name AS founder_name, f.company AS founder_company
    FROM commitments c LEFT JOIN founders f ON c.founder_id = f.id
    WHERE c.status = 'open' AND c.owed_by = 'them' AND c.created_by = ?
      AND (c.due_at IS NOT NULL AND c.due_at <= ?)
    ORDER BY c.due_at ASC
  `).all(userId, today);

  return {
    i_owe: mine.map((r) => ({ ...r, overdue: !!(r.due_at && r.due_at < today) })),
    // `overdue: true` was HARDCODED here while the query above selects
    // `due_at <= today` — so a promise due TODAY came back overdue and rendered
    // under a header reading "Promises past due", with meta "owed since
    // 2026-07-16". The Cadrian deck is due today. It is not past due.
    //
    // Small, and it matters more than its size: this file's entire moral
    // authority is that it does not overstate. A ledger that calls a live promise
    // broken is the ledger crying wolf on day one — and the first thing Danny
    // would do is stop believing the number.
    they_owe: theirs.map((r) => ({ ...r, overdue: !!(r.due_at && r.due_at < today) })),
  };
}

module.exports = { OWED_BY, STATUS, record, close, due, deltaFor, dedupeKey, medianSlip };
