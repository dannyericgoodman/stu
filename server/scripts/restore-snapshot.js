'use strict';
// ══════════════════════════════════════════════════════════════════════════
// restore-snapshot.js — rebuild a fresh Stu from the API snapshot taken 2026-08-29.
//
// Context: the Railway account hosting Stu could not be signed into, so the database
// was never reachable as a file. It was pulled through the app's own REST API
// instead. That shapes what can and cannot be restored, and the distinction matters
// more than the row counts:
//
//   RESTORED — assessments and their inputs, and the founders/pipeline board.
//     The assessment payloads came back COMPLETE: panel_output (all nine lenses),
//     conviction, synthesis, bear, agenda, plus the legacy columns on pre-panel runs.
//     These are multi-agent Opus runs. They cost real money, they would not reproduce
//     identically, and nothing else in the system can regenerate them.
//
//   NOT RESTORED — the 2,234-row sourcing inbox, deliberately.
//     /api/pipeline/inbox strips raw_data, enriched_data and linkedin_data for
//     performance, and those blobs are exactly what lib/founderFit reads to compute
//     markers. Importing the rows without them would produce an inbox whose verdicts
//     cite evidence that is no longer present — and the stored verdicts themselves
//     predate today's rubric fixes, so they still carry the professor bug.
//     The nightly scout re-sources this inbox from YC, Speedrun, Exa and school
//     discovery with full blobs, under the corrected rubric. Rebuilding it is a few
//     nights of a job that already runs; faking it is permanent.
//
// Usage:  node scripts/restore-snapshot.js /path/to/superior-os-prod-backup-2026-08-29
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const db = require('../db');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('Usage: node scripts/restore-snapshot.js <snapshot-dir>');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// Insert only keys that are real columns, so a snapshot taken against a slightly
// different schema version degrades to "fewer fields" instead of throwing.
function insertRow(table, row, { skip = [] } = {}) {
  const valid = cols(table);
  const keys = Object.keys(row).filter((k) => valid.has(k) && !skip.includes(k) && row[k] !== undefined);
  if (!keys.length) return false;
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  db.prepare(sql).run(...keys.map((k) => (typeof row[k] === 'object' ? asText(row[k]) : row[k])));
  return true;
}

let founders = 0, assessments = 0, inputs = 0;

// ── Founders / the pipeline board ──
const fPath = path.join(dir, 'founders.json');
if (fs.existsSync(fPath)) {
  const raw = readJson(fPath);
  const rows = Array.isArray(raw) ? raw : (raw.founders || raw.rows || []);
  const tx = db.transaction((list) => {
    for (const r of list) {
      // The API nests derived read-models the table has no columns for.
      const { fit, assessment, decision, stu_read, ...flat } = r;
      if (insertRow('founders', flat)) founders++;
    }
  });
  tx(rows);
}

// ── Assessments + their inputs ──
const aDir = path.join(dir, 'assessments');
if (fs.existsSync(aDir)) {
  const files = fs.readdirSync(aDir).filter((f) => /^\d+\.json$/.test(f));
  const tx = db.transaction((list) => {
    for (const f of list) {
      const a = readJson(path.join(aDir, f));
      // Strip the parsed conveniences the route adds on read — the durable columns
      // (panel_output, conviction_output, …) are already in the payload.
      const { panel, agenda, bear, memo_7m, defensibility, company, decision, inputs: _in, ...row } = a;
      if (insertRow('opportunity_assessments', row)) assessments++;

      const ip = path.join(aDir, f.replace('.json', '-inputs.json'));
      if (fs.existsSync(ip)) {
        const raw = readJson(ip);
        const list2 = Array.isArray(raw) ? raw : (raw.inputs || raw.rows || []);
        for (const inp of list2) {
          if (insertRow('assessment_inputs', { ...inp, assessment_id: a.id }, { skip: ['id'] })) inputs++;
        }
      }
    }
  });
  tx(files);
}

console.log(JSON.stringify({ founders, assessments, inputs }));
