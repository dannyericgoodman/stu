'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { geoFilter } = require('../lib/geoFilter');
const uspto = require('../pipeline/sources/uspto-trademark');
const { computeCaliber } = require('../pipeline/sourcing-engine');

test('geoFilter broad mode (no criteria) passes everyone', () => {
  const rows = [{ name: 'A', headline: 'Founder in Berlin' }, { name: 'B', headline: 'Founder in SF' }];
  const out = geoFilter(rows, { locations: [], schools: [] });
  assert.equal(out.length, 2);
});

test('geoFilter with IL criteria keeps IL ties, drops others', () => {
  const criteria = { locations: ['chicago', 'illinois', 'evanston'], schools: ['northwestern', 'university of chicago'] };
  const rows = [
    { name: 'IL guy', location_city: 'Chicago', location_state: 'IL', headline: 'Founder' },
    { name: 'SF guy', headline: 'Founder based in San Francisco' },
    { name: 'NU alum', headline: 'Founder', bio: 'Studied at Northwestern University' },
  ];
  const out = geoFilter(rows, criteria);
  const names = out.map(o => o.name);
  assert.ok(names.includes('IL guy'), 'structured Chicago/IL address passes');
  assert.ok(names.includes('NU alum'), 'IL school passes');
  assert.ok(!names.includes('SF guy'), 'SF founder is dropped');
  assert.ok(out.find(o => o.name === 'IL guy').chicago_connection, 'verified tie is attached');
});

test('USPTO normalize maps an individual owner + state + evidence + url', () => {
  const rec = { serialNumber: '99123456', filingDate: '2026-06-01', markText: 'ACME AI', owners: [{ name: 'Jane Founder', ownerType: '1', address: { city: 'Chicago', state: 'IL' } }] };
  const n = uspto.normalize(rec);
  assert.equal(n.name, 'Jane Founder');      // individual owner → named person
  assert.equal(n.location_state, 'IL');
  assert.match(n.evidence, /ACME AI/);
  assert.ok(n.url && n.url.includes('99123456'));
  assert.equal(n.emits === undefined, true); // normalize returns a RawRecord, not the connector
});

test('USPTO normalize handles a company owner (no person name)', () => {
  const rec = { serialNumber: '1', markText: 'FOO', owners: [{ name: 'Foo Labs Inc', ownerType: '3', address: { state: 'CA' } }] };
  const n = uspto.normalize(rec);
  assert.equal(n.name, null);
  assert.equal(n.entity_name, 'Foo Labs Inc');
  assert.equal(n.location_state, 'CA');
});

test('USPTO fetch is dormant without an API key', async () => {
  const prev = process.env.USPTO_API_KEY;
  delete process.env.USPTO_API_KEY;
  const out = await uspto.fetch({ criteria: { locations: ['chicago'] } });
  assert.deepEqual(out, []);
  if (prev !== undefined) process.env.USPTO_API_KEY = prev;
});

// ── STU-36: connector rows must not persist with caliber_tier permanently NULL ──
// founderGate/isTooFarAlong/scoreFounder (the LLM call) only ever ran for source='exa'
// (sourcing-engine.js's own runSourcingEngine). Every connector — yc_directory,
// pre_program, il_school_discovery, cohort-rosters, uspto — flowed through this
// shared ingest() instead, whose INSERT never touched caliber_tier/confidence_score
// at all, so those columns sat at NULL forever for ~450+ rows and growing weekly.
// This is a static guard (no live DB write) proving the persist path now runs the
// same deterministic computeCaliber() used to backfill exa's own pre-caliber rows
// (migrations/backfill-caliber.js), instead of leaving the column untouched.
test('sources/index.js persist path computes and inserts caliber_tier (STU-36)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'sources', 'index.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/sourcing-engine['"]\)/.test(src), 'must import computeCaliber from sourcing-engine.js, not reimplement it');
  assert.ok(/computeCaliber\(/.test(src), 'must call computeCaliber() before persisting');
  const insertMatch = src.match(/INSERT INTO sourced_founders\s*\(([\s\S]*?)\)/);
  assert.ok(insertMatch, 'must find the sourced_founders INSERT');
  const cols = insertMatch[1];
  for (const col of ['caliber_tier', 'caliber_score', 'caliber_rationale', 'caliber_signals']) {
    assert.ok(cols.includes(col), `INSERT must write ${col}`);
  }
});

test('computeCaliber grades a real connector bio instead of leaving it unscored', () => {
  // The Navid Aghasadeghi case from STU-34/STU-36: PhD ECE UIUC, ex-Boston Dynamics
  // Senior Staff, YC S26 — his real bio text is what STU-34 (commit 1bf02b3) wired
  // into raw_data; this proves that text now actually produces a non-null tier.
  const c = computeCaliber(
    'PhD in Electrical & Computer Engineering, UIUC. Previously Senior Staff Engineer at Boston Dynamics.',
    'Founder, YC S26',
    []
  );
  assert.ok(['S', 'A', 'B', 'C'].includes(c.tier));
  assert.notEqual(c.tier, null);
  assert.ok(c.rationale);
});
