'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const airtableSync = require('../services/airtable-sync');

// 1. The writers must REFUSE without an explicit publish flag — even with a valid
//    record id present (which would otherwise trigger a real Airtable PATCH).
test('pushAdmissionsChange is gated: no explicit → skipped, no network', async () => {
  const founder = { id: 1, name: 'Test Founder', airtable_founder_record_id: 'rec123', admissions_status: 'Sourced', pipeline_tracks: '' };
  const r = await airtableSync.pushAdmissionsChange(founder, null); // no opts
  assert.deepStrictEqual(r, { skipped: 'not_explicit' });
});

test('pushDealChange is gated: no explicit → skipped, no network', async () => {
  const founder = { id: 1, name: 'Test Founder', airtable_deal_record_id: 'rec456', deal_status: 'Active' };
  const r = await airtableSync.pushDealChange(founder, null); // no opts
  assert.deepStrictEqual(r, { skipped: 'not_explicit' });
});

// 2. Static guard: no route may auto-push to Airtable. The sourcing approve route must
//    never push at all; the founders route may only push inside an explicit publish call.
function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

test('sourcing approve route never writes to Airtable', () => {
  const src = read('routes/sourcing.js');
  assert.ok(!/pushAdmissionsChange|pushDealChange|createPipelineRecord/.test(
    src.split("router.post('/watch/:id'")[0]
  ), 'the approve half of sourcing.js must not call Airtable');
});

test('sourcing watch route only creates the Airtable row with explicit flag', () => {
  const src = read('routes/sourcing.js');
  const watchHalf = src.split("router.post('/watch/:id'")[1] || '';
  const calls = [...watchHalf.matchAll(/createPipelineRecord\s*\(/g)];
  assert.ok(calls.length >= 1, 'watch route must publish via createPipelineRecord');
  for (const m of calls) {
    const window = watchHalf.slice(m.index, m.index + 200);
    assert.ok(/explicit:\s*true/.test(window), 'watch route Airtable create must pass { explicit: true }');
  }
});

test('founders route only pushes to Airtable with explicit flag', () => {
  const src = read('routes/founders.js');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/push(Admissions|Deal)Change\s*\(/.test(lines[i])) {
      const window = lines.slice(i, i + 3).join(' ');
      assert.ok(/explicit:\s*true/.test(window), `Airtable push at founders.js:${i + 1} must pass { explicit: true }`);
    }
  }
});
