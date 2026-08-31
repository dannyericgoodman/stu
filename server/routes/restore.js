'use strict';
// ══════════════════════════════════════════════════════════════════════════
// restore.js — a ONE-TIME import path for the host migration off Railway.
//
// Why this exists at all: the production database was never reachable as a file
// (see scripts/snapshot-prod.js), so the only copy of the data is a JSON snapshot
// sitting on a laptop. Getting it into the new host needs either a shell on the
// container or a way to push rows over HTTP. There is no shell — no SSH key, no
// CLI — so this is the way in.
//
// ── It is NOT mounted unless RESTORE_TOKEN is set ──
// index.js registers this router only when the env var exists. Delete the variable
// and the route is gone from the app entirely — not merely guarded, absent. That is
// deliberate: a permanent unauthenticated-adjacent write path into the founders
// table is exactly the kind of thing that quietly outlives its purpose.
//
// Two further guards, because "temporary" code is rarely as temporary as intended:
//   * the token is compared in constant time, so it cannot be probed byte-by-byte;
//   * only the tables in ALLOWED are writable, so a stray call cannot reach users,
//     payments, or api keys.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// The snapshot only ever carries these. Everything else — users, settings, tokens,
// payment rows — is off limits regardless of what a caller asks for.
const ALLOWED = new Set([
  'founders',
  'opportunity_assessments',
  'assessment_inputs',
  'founder_notes',
  'founder_memos',
  'call_logs',
  // The sourcing inbox. Restoring it needs user_id stamped on every row (the inbox
  // query is `WHERE user_id = ? AND status IN (...) AND list_scope = ?`), and the
  // snapshot does not carry that column — the read API never exposed it. Rows
  // inserted without it are invisible to every user, which looks exactly like the
  // restore silently doing nothing.
  'sourced_founders',
  // Hiring + Talent. These were never in the original snapshot — snapshot-prod.js
  // crawled founders, assessments and the inbox and never touched these routes, so
  // the migration silently left both products empty. Recovered separately on
  // 2026-08-31 while the old host was still reachable by IP.
  'hiring_roles',
  'hiring_candidates',
  'hiring_matches',
  'talent_roles',
  'talent_candidates',
  'talent_matches',
  'talent_portfolio_companies',
  'talent_criteria',
  // Decks, call notes and filings. Also absent from the original snapshot, and the
  // reason "Evaluate a Founder" had no targets: readTargets requires a company_sources
  // row with content_text, and there were none to require.
  'company_sources',
]);

function tokenOk(header) {
  const expected = process.env.RESTORE_TOKEN || '';
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  // timingSafeEqual throws on length mismatch, so compare digests of equal width.
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return expected.length > 0 && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!tokenOk(req.headers.authorization)) return res.status(401).json({ error: 'bad restore token' });
  next();
});

const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// Column-filtered insert — the snapshot was taken from a slightly older schema, so a
// payload key with no column degrades to "one fewer field" instead of throwing and
// losing the whole batch.
function insertRow(table, row, skip = []) {
  const valid = colsOf(table);
  const keys = Object.keys(row).filter((k) => valid.has(k) && !skip.includes(k) && row[k] !== undefined);
  if (!keys.length) return false;
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  db.prepare(sql).run(...keys.map((k) => (typeof row[k] === 'object' ? asText(row[k]) : row[k])));
  return true;
}

// ── GET /api/restore/status — row counts, so the push script can verify itself ──
router.get('/status', (req, res) => {
  const counts = {};
  for (const t of ALLOWED) {
    // Ranges matter as much as totals here: the snapshot is inserted at its ORIGINAL
    // ids so notes and assessments stay attached to the right founder, which is only
    // safe if this host's own auto-sourced rows do not already occupy those ids.
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c, MIN(id) AS lo, MAX(id) AS hi FROM ${t}`).get();
      counts[t] = { count: r.c, minId: r.lo, maxId: r.hi };
    } catch (e) { counts[t] = null; } // table absent in this schema version
  }
  res.json({ ok: true, counts });
});

// ── POST /api/restore/rows  { table, rows, skip? } ──
router.post('/rows', (req, res) => {
  const { table, rows, skip = [] } = req.body || {};
  if (!ALLOWED.has(table)) return res.status(400).json({ error: `table not allowed: ${table}` });
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
  try { colsOf(table); } catch (e) { return res.status(400).json({ error: `no such table: ${table}` }); }

  let written = 0;
  const tx = db.transaction((list) => { for (const r of list) if (insertRow(table, r, skip)) written++; });
  try {
    tx(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message, written });
  }
  res.json({ ok: true, table, received: rows.length, written });
});

// ── POST /api/restore/reset-admin ──
// The new host booted once before the data arrived, which seeded owner user #1 with a
// random password that was never printed — so the account is real but unreachable.
// SEED_ADMIN_PASSWORD only applies to an EMPTY users table, so it can never take
// effect on its own here. This applies it to the existing owner instead, which avoids
// deleting and recreating the row that every founder/note/setting foreign-keys to.
router.post('/reset-admin', (req, res) => {
  const pw = process.env.SEED_ADMIN_PASSWORD;
  if (!pw) return res.status(400).json({ error: 'SEED_ADMIN_PASSWORD is not set on this host' });
  const bcrypt = require('bcryptjs');
  const row = db.prepare('SELECT id, email FROM users WHERE id = 1').get();
  if (!row) return res.status(404).json({ error: 'owner user #1 does not exist' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(bcrypt.hashSync(pw, 10));
  res.json({ ok: true, email: row.email });
});

// ── GET /api/restore/diagnostics ──
// Read-only. Exists because debugging a host you cannot log into means guessing, and
// guessing is what turns a ten-minute fix into an afternoon. Reports the three things
// that actually explain a "my data is gone" report: what rows exist, WHO owns them
// (a board filtered by created_by looks empty when you are signed in as user 2), and
// what the scout has been doing.
router.get('/diagnostics', (req, res) => {
  const out = { counts: {}, users: [], sourcing_runs: [], inbox_by_user: [] };

  const TABLES = [
    'founders', 'opportunity_assessments', 'assessment_inputs', 'founder_notes',
    'founder_memos', 'call_logs', 'sourced_founders', 'users', 'decisions', 'commitments',
  ];
  for (const t of TABLES) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c, MIN(id) AS lo, MAX(id) AS hi FROM ${t}`).get();
      out.counts[t] = { count: r.c, minId: r.lo, maxId: r.hi };
    } catch (e) { out.counts[t] = null; }
  }

  try { out.users = db.prepare('SELECT id, email, role, created_at, last_login FROM users ORDER BY id').all(); }
  catch (e) { out.users = [{ error: e.message }]; }

  // Ownership is the usual culprit, so report it directly rather than making the
  // reader infer it from totals.
  try {
    out.founders_by_owner = db.prepare(
      'SELECT created_by, COUNT(*) AS c, SUM(is_deleted) AS deleted FROM founders GROUP BY created_by'
    ).all();
  } catch (e) { out.founders_by_owner = [{ error: e.message }]; }

  try {
    out.inbox_by_user = db.prepare(
      "SELECT user_id, list_scope, status, COUNT(*) AS c FROM sourced_founders GROUP BY user_id, list_scope, status"
    ).all();
  } catch (e) { out.inbox_by_user = [{ error: e.message }]; }

  try {
    out.sourcing_runs = db.prepare(
      'SELECT id, run_at, founders_found, founders_added, founders_deduplicated, errors FROM sourcing_runs ORDER BY run_at DESC LIMIT 8'
    ).all();
  } catch (e) { out.sourcing_runs = [{ error: e.message }]; }

  res.json(out);
});

// ── GET /api/restore/board ──
// Read-only. Runs the SAME query the Pipeline board runs, plus the counts behind
// Assess and Hiring, so "the page looks empty" can be answered with the number the
// page itself would compute rather than by reasoning about what ought to be there.
router.get('/board', (req, res) => {
  const userId = Number(req.query.user || 1);
  const out = { userId };

  // The board's own WHERE clause, verbatim from routes/pipeline.js.
  try {
    const rows = db.prepare(
      'SELECT id, stage, status, is_deleted, investment_amount, deal_status, admissions_status, stage_status FROM founders WHERE created_by = ? AND is_deleted = 0'
    ).all(userId);
    const byStage = {};
    for (const r of rows) { const k = r.stage == null || r.stage === '' ? '(none)' : r.stage; byStage[k] = (byStage[k] || 0) + 1; }
    out.pipeline_visible_rows = rows.length;
    out.pipeline_by_stage = byStage;
    out.pipeline_with_stage = rows.filter((r) => r.stage != null && r.stage !== '').length;
  } catch (e) { out.pipeline_error = e.message; }

  try {
    out.assessments_by_status = db.prepare(
      'SELECT assessment_type, status, COUNT(*) AS c FROM opportunity_assessments WHERE is_deleted = 0 GROUP BY assessment_type, status'
    ).all();
  } catch (e) { out.assessments_error = e.message; }

  for (const t of ['hiring_roles', 'hiring_candidates', 'hiring_matches', 'hiring_runs',
                   'talent_roles', 'talent_candidates', 'talent_matches', 'talent_criteria']) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch (e) { out[t] = null; }
  }

  res.json(out);
});

module.exports = router;
