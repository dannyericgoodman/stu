'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The Source inbox's promises, pinned:
//   · the STORED fit verdict is the same verdict founderFit computes — a cache,
//     never a second implementation that can drift.
//   · a fellowship is never written into the company field.
//   · a cohort hit we know nothing about is not a lead.
//   · the nightly scout's readiness gate reads the OWNER'S SAVED KEY, not the
//     environment, and /api/health reports that same answer rather than a second one.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const ff = require('../lib/founderFit');
const fitIndex = require('../lib/fitIndex');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The cache must not drift from the rubric ────────────────────────────
test('the stored fit verdict equals what founderFit computes, row for row', () => {
  const rows = db.prepare(`
    SELECT * FROM sourced_founders
    WHERE fit_scored_at IS NOT NULL
      AND (linkedin_enriched_at IS NULL OR fit_scored_at >= linkedin_enriched_at)
      AND (github_slope_scored_at IS NULL OR fit_scored_at >= github_slope_scored_at)
    LIMIT 300
  `).all();
  if (!rows.length) return; // nothing scored in this database yet — nothing to pin

  for (const r of rows) {
    const live = ff.evaluate(r);
    assert.strictEqual(!!r.fit_meet, live.meetWorthy, `${r.name}: meetWorthy drifted`);
    assert.strictEqual(r.fit_tier, live.tier || null, `${r.name}: tier drifted`);
    assert.strictEqual(r.fit_priority, live.priority || 0, `${r.name}: priority drifted`);
    assert.strictEqual(!!r.fit_stage_late, live.stageTooLate, `${r.name}: stage gate drifted`);
    assert.deepStrictEqual(JSON.parse(r.fit_why || '[]'), live.why || [], `${r.name}: reasons drifted`);
  }
});

test('verdictOf stores only what evaluate() returned — no invented fields', () => {
  const row = {
    id: 0, name: 'Test Founder',
    headline: 'Founder at Acme. Previously acquired by Stripe. Stealth.',
    chicago_connection: 'school: University of Chicago',
  };
  const v = fitIndex.verdictOf(row);
  const live = ff.evaluate(row);
  assert.strictEqual(v.tier, live.tier || null);
  assert.strictEqual(v.reason, live.tierReason || null);
  assert.deepStrictEqual(JSON.parse(v.why), live.why);
  assert.strictEqual(v.markerCount, live.markers.length);
});

// ── The fellowship-as-company bug ──────────────────────────────────────
test('a cohort hit never takes the program name as its headline', async () => {
  const { cohortDiscover } = require('../lib/cohortDiscovery');
  const recs = await cohortDiscover({
    exaKey: 'test',
    queries: ['"Emergent Ventures" grantee founder'],
    markers: ['emergent ventures'],
    cohortLabel: 'Emergent Ventures',
    deps: {
      exaSearch: async () => ({
        results: [
          // A real person with a real bio — kept.
          { url: 'https://linkedin.com/in/real-person', title: 'Ada Ramirez',
            text: 'Ada Ramirez is an Emergent Ventures grantee building a protein design startup in Chicago after a PhD at UIUC.' },
          // A bare name with nothing but the program marker — this is the row that
          // used to arrive as "Name | Emergent Ventures | Emergent Ventures".
          { url: 'https://linkedin.com/in/bare-name', title: 'Piyush Jha', text: 'Emergent Ventures' },
        ],
      }),
    },
  });

  for (const r of recs) {
    assert.notStrictEqual(r.headline, 'Emergent Ventures', 'the cohort label is not a headline');
    assert.ok(r.bio && r.bio.trim(), 'a kept record always has something to read');
  }
  assert.ok(!recs.some((r) => r.name === 'Piyush Jha'), 'a name with no bio is not a lead');
});

test('a program name is scrubbed out of the company field before persist', () => {
  const src = read('pipeline/sources/index.js');
  assert.ok(/function scrubProgramCompany/.test(src), 'the scrub exists');
  assert.ok(/scrubProgramCompany\(await enrichGroup\(pipelineNew\), c\)/.test(src),
    'and it runs on the pipeline rows after enrichment, which is where the label gets in');
  assert.ok(/scrubProgramCompany\(await enrichGroup\(watchNew\), c\)/.test(src),
    'and on the watchlist rows too');
});

test('the historical cleanup only ever nulls the company, never the headline', () => {
  const { isProgram } = require('../migrations/cleanup-program-company');
  assert.strictEqual(isProgram('Z Fellows'), true);
  assert.strictEqual(isProgram('emergent ventures'), true);
  assert.strictEqual(isProgram('Zaplar'), false, 'a real company is not a program');
  const src = read('migrations/cleanup-program-company.js');
  assert.ok(!/SET headline = NULL/.test(src),
    '"Thiel Fellow" as a headline is a true statement — misfiled, not false');
});

// ── The readiness gate ─────────────────────────────────────────────────
test('the scout readiness gate reads the saved key, not the environment', () => {
  const src = read('index.js');
  const gate = src.slice(src.indexOf('function scoutArmed()'), src.indexOf('const app = express()'));
  assert.ok(/loadUserApiKeys\(1\)/.test(gate),
    'readiness resolves keys the same way the engines do');
  assert.ok(!/process\.env\.EXA_API_KEY/.test(gate),
    'EXA_API_KEY is not where the key lives — that lookup is the whole bug');
  assert.ok(/PIPELINE_ENABLED === 'false'/.test(gate),
    'PIPELINE_ENABLED is a kill switch, never something you must remember to turn on');
});

test('/api/health reports the scheduler\'s OWN answer, not a second one', () => {
  // The health endpoint used to compute `sourcing_armed` from env vars while the
  // scheduler resolved saved keys — so it could confidently report armed on a deploy
  // where the cron had declined to schedule, which is the exact class of bug (two
  // answers to one question, the louder one wrong) this change exists to remove.
  const src = read('index.js');
  assert.ok(/sourcing_armed: scoutArmed\(\)\.ready/.test(src),
    'health calls the scheduler\'s check rather than re-deriving it');
  assert.ok(!/sourcing_armed: process\.env\.PIPELINE_ENABLED/.test(src),
    'the old env-only copy is gone');
});

test('the scout writes one ledger row whether or not it found anyone', () => {
  const src = read('index.js');
  const scout = src.slice(src.indexOf("cron.schedule('30 4 * * *'"), src.indexOf('Nightly scout scheduled'));
  assert.ok(/recordJobRun\(\s*'nightly_scout'/.test(scout), 'it records a run');
  // The record must not be inside a success branch — silence is what taught Danny
  // the automation didn't exist.
  assert.ok(!/if \(added\)[\s\S]{0,80}recordJobRun/.test(scout), 'the ledger write is unconditional');
  assert.ok(/isMonday/.test(scout), 'rosters run weekly, the sweep runs nightly');
});
