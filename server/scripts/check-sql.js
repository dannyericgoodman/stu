#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Static SQL check — every literal statement in server/ is prepared against the
// real schema, so a column that doesn't exist fails HERE instead of at 6am.
//
// ── WHY THIS EXISTS ──
// pipeline/github-source.js read and wrote `founders.github_slope_score`. That
// column was only ever declared on `sourced_founders`. Nothing caught it: it isn't
// on any HTTP route, so hitting every endpoint stayed green, and the only code path
// that reached it was the weekly slope refresh — which failed every run with
// `no such column: github_slope_score` into a log nobody reads. A real ranking
// input silently stopped updating and the only visible symptom was a job_runs row.
//
// SQLite's prepare() resolves table and column names at prepare time without
// running anything, so this gets that whole class of bug for the cost of a parse.
//
// ── WHAT IT CANNOT CHECK, AND WHY THAT'S STATED NOT HIDDEN ──
// SQL built by string interpolation (`... WHERE ${cond}`) isn't a fixed statement,
// so there is nothing to prepare. Those are counted and reported as SKIPPED rather
// than passed over in silence — a checker that quietly ignores what it can't handle
// reads as "all clear" when it isn't.
//
//   node scripts/check-sql.js     → exit 1 if any statement fails to resolve
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

// Build the schema in a throwaway in-memory DB by running db.js against it, so the
// check always reflects the CURRENT migrations rather than whatever a dev's local
// file happens to hold.
const tmp = path.join(require('os').tmpdir(), `stu-sqlcheck-${process.pid}.db`);
process.env.DATABASE_PATH = tmp;
delete process.env.NODE_ENV;
let db;
try {
  db = require('../db');
} catch (e) {
  console.error('FATAL: db.js failed to build a schema:', e.message);
  process.exit(1);
}

const SQL_START = /^\s*(SELECT|INSERT\s+INTO|INSERT\s+OR\s+\w+\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;

// `test/` is excluded, not overlooked: those files build their own fixture schemas
// in their own in-memory databases (approve-atomicity creates a stripped `sourced`
// table), so checking them against the production schema reports tables that are
// absent on purpose. Application code is the subject here.
const SKIP_DIRS = new Set(['node_modules', 'test']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Pull out backtick, single- and double-quoted literals. Crude on purpose: anything
// that isn't valid SQL simply fails the SQL_START filter or the syntax check below.
function literals(src) {
  const out = [];
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0];
    out.push({ text: raw.slice(1, -1), interpolated: raw[0] === '`' && /\$\{/.test(raw), index: m.index });
  }
  return out;
}

const files = walk(ROOT);
let checked = 0, skipped = 0;
const failures = [];

for (const file of files) {
  // This checker and the migration file that DEFINES the schema are not subjects.
  if (file.endsWith(path.join('scripts', 'check-sql.js')) || file === path.join(ROOT, 'db.js')) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const lit of literals(src)) {
    const sql = lit.text;
    if (!SQL_START.test(sql)) continue;
    if (lit.interpolated) { skipped++; continue; }
    checked++;
    try {
      db.prepare(sql);
    } catch (e) {
      // A syntax error means the literal isn't a whole statement (a fragment
      // concatenated elsewhere), not that the schema is wrong. Only name
      // resolution failures are real findings.
      if (!/no such (column|table)/i.test(e.message)) { skipped++; checked--; continue; }
      const line = src.slice(0, lit.index).split('\n').length;
      failures.push({ file: path.relative(ROOT, file), line, msg: e.message, sql: sql.replace(/\s+/g, ' ').slice(0, 140) });
    }
  }
}

console.log(`Checked ${checked} literal SQL statements across ${files.length} files.`);
console.log(`Skipped ${skipped} (interpolated or fragments — not statically checkable).`);
if (!failures.length) {
  console.log('OK — every checkable statement resolves against the schema.');
} else {
  console.log(`\n${failures.length} statement(s) reference something the schema does not have:\n`);
  for (const f of failures) console.log(`  ${f.file}:${f.line}\n    ${f.msg}\n    ${f.sql}\n`);
}
try { db.close(); } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }
process.exit(failures.length ? 1 : 0);
