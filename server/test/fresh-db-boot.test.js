'use strict';
// ══════════════════════════════════════════════════════════════════════════
// THE TEST THAT SHOULD HAVE EXISTED.
//
// db.js interleaves CREATE TABLE with ALTER TABLE, CREATE INDEX, and one-time data
// backfills. On any database that already has the schema, the order of those
// statements is invisible. On an EMPTY one it is fatal — and every deploy in this
// app's life inherited a volume that already had the schema, so the ordering was
// never once exercised.
//
// The first time Stu was deployed to a brand-new host it crash-looped four times, on
// four different statements, each hidden behind the last:
//   1. addColumn('company_sources', …)        — table created 236 lines later
//   2. CREATE INDEX … ON company_sources(…)   — same table, same problem
//   3. CREATE INDEX … ON sourced_founders(user_id, …) — column added later
//   4. UPDATE company_sources … company_signals      — a backfill over both
//
// Fixing them one at a time meant one failed deploy per bug. The fix is structural:
// columns, indexes and backfills are QUEUED and replayed once the schema is complete.
// This test asserts the property directly, against a real empty file, so the next
// person to add a statement in the wrong place learns about it here.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('db.js builds a complete schema from an EMPTY database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stu-freshdb-'));
  const dbPath = path.join(dir, 'fresh.db');
  try {
    // A child process, because db.js runs its whole migration at require() time and
    // this test suite has already required it against the dev database.
    const script = `
      process.env.DATABASE_PATH = ${JSON.stringify(dbPath)};
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'fresh-db-boot-test';
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      // Nothing may be left queued — a statement still waiting is a statement that
      // never ran, which is the silent version of the crash this test exists for.
      const tables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
      const indexes = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get().n;
      console.log(JSON.stringify({ tables, indexes }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const { tables, indexes } = JSON.parse(line);

    assert.ok(tables > 30, `expected a full schema, got ${tables} tables`);
    // Every deferred index must have been replayed. If the flush is ever removed or
    // moved above the CREATE TABLE block, this is what catches it.
    assert.ok(indexes >= 40, `expected the deferred indexes to be created, got ${indexes}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the deferred queues are drained, not merely populated', () => {
  // Reading db.js as source: the flush must be called, and called AFTER the last
  // CREATE TABLE. A flush that runs too early would pass the boot test on a database
  // that happens to already exist and fail on a new one — the exact trap this whole
  // file is about.
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const lines = src.split('\n');
  const lastCreate = lines.reduce((acc, l, i) => (/CREATE TABLE IF NOT EXISTS/.test(l) ? i : acc), -1);
  const flushCall = lines.findIndex((l) => /^\s*flushDeferredColumns\(\);/.test(l));
  assert.ok(flushCall > -1, 'flushDeferredColumns() must be called');
  assert.ok(flushCall > lastCreate, 'the flush must run after the last CREATE TABLE');
});
