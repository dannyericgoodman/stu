const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════
// Every literal SQL statement must resolve against the real schema.
//
// WHY THIS EXISTS: pipeline/github-source.js read and wrote
// `founders.github_slope_score`. That column was only ever declared on
// `sourced_founders`. The weekly slope refresh therefore failed EVERY run with
// `no such column: github_slope_score`, GitHub momentum — a real ranking input —
// silently stopped updating, and the suite stayed green because no test and no
// HTTP route ever touched that code path. The only symptom was one error row in
// job_runs.
//
// The same run found routes/newsletter.js writing VALUES (?, ?, "email", ?, 1).
// Double quotes are an IDENTIFIER in SQL, and better-sqlite3 ships with the
// double-quoted-string-literal fallback off, so adding a newsletter source threw
// on every call and had never once succeeded — which is the actual reason
// newsletter_sources and newsletter_items were empty tables.
//
// Both are the same bug class: SQL that is wrong about the schema, on a path no
// test exercises. sqlite's prepare() resolves table and column names WITHOUT
// running the statement, so the whole class is catchable for the cost of a parse.
// This is the sibling of routes-load.test.js — that one proves every route parses
// as JavaScript, this one proves every query parses as SQL against the schema.
//
// See scripts/check-sql.js for what it deliberately cannot check (interpolated
// SQL), which it reports as SKIPPED rather than passing over silently.
// ══════════════════════════════════════════════════════════════════════════

test('every literal SQL statement resolves against the schema', () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-sql.js');
  let out;
  try {
    out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Non-zero exit means real findings; surface the checker's own report as the
    // assertion message so the failure names the file, line, and column.
    assert.fail(`scripts/check-sql.js found unresolvable SQL:\n\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /OK — every checkable statement resolves against the schema\./);
});
