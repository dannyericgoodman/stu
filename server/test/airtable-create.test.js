'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const airtableSync = require('../services/airtable-sync');
const vocab = require('../lib/airtableVocab');

const founder = {
  id: 42, name: 'Test Founder', company: 'TestCo',
  linkedin_url: 'https://linkedin.com/in/test', website_url: 'https://testco.example',
  email: 'f@testco.example', company_one_liner: 'Does testing',
};

// 1. Gated: no explicit flag → skipped, and the post stub is never called.
test('createPipelineRecord is gated: no explicit → skipped, no network', async () => {
  let called = false;
  const r = await airtableSync.createPipelineRecord(founder, {
    post: async () => { called = true; return { id: 'rec1' }; },
  });
  assert.deepStrictEqual(r, { skipped: 'not_explicit' });
  assert.ok(!called, 'post must not run without explicit');
});

// 2. Payload: the right table, Airtable's own vocabulary for the status,
//    descriptive fields by name, and the record id comes back.
test('createPipelineRecord posts a Watching row to the Pipeline table', async () => {
  let seen = null;
  const r = await airtableSync.createPipelineRecord(founder, {
    explicit: true,
    post: async (tableId, fields) => { seen = { tableId, fields }; return { id: 'recXYZ' }; },
  });
  assert.deepStrictEqual(r, { created: true, recordId: 'recXYZ' });
  assert.strictEqual(seen.tableId, vocab.FOUNDER_TABLE);
  assert.strictEqual(seen.fields['Company / Founder'], 'TestCo');
  assert.strictEqual(seen.fields['Founder'], 'Test Founder');
  assert.strictEqual(seen.fields[vocab.FIELD.INVESTMENT_STATUS], 'Watching');
  assert.strictEqual(seen.fields['LinkedIn'], 'https://linkedin.com/in/test');
  assert.strictEqual(seen.fields['One-liner'], 'Does testing');
});

// 3. Company missing → falls back to the founder name for the primary field.
test('createPipelineRecord falls back to name when company is absent', async () => {
  let seen = null;
  await airtableSync.createPipelineRecord({ id: 7, name: 'Solo Founder' }, {
    explicit: true,
    post: async (tableId, fields) => { seen = fields; return { id: 'rec2' }; },
  });
  assert.strictEqual(seen['Company / Founder'], 'Solo Founder');
});

// 4. Airtable refuses → the error is returned, not thrown.
test('createPipelineRecord returns the error when Airtable rejects', async () => {
  const r = await airtableSync.createPipelineRecord(founder, {
    explicit: true,
    post: async () => { throw new Error('Airtable 422: bad option'); },
  });
  assert.ok(r.error.includes('422'), 'error must name the refusal');
});
