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
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch (e) { counts[t] = null; } // table absent in this schema version
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

module.exports = router;
