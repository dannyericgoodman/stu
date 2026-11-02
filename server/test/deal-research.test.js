'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The research layer's honesty gate: a finding survives only if its source_url is a
// page Exa actually returned. A citation the model invented names a page that isn't in
// the set, so it dies. Same spirit as the verbatim-quote gate.
// ══════════════════════════════════════════════════════════════════════════
const { test } = require('node:test');
const assert = require('node:assert');
const { gateResearch, buildResearchQueries } = require('../pipeline/deal-research');

const urlSet = new Set(['https://pitchbook.com/a', 'https://news.co/b']);

test('a finding citing a retrieved page survives', () => {
  const r = gateResearch({ comps: [{ name: 'Camber', source_url: 'https://pitchbook.com/a' }] }, urlSet);
  assert.equal(r.findings.comps.length, 1);
  assert.equal(r.status, 'ok');
});

test('a finding citing a page we never retrieved is dropped', () => {
  const r = gateResearch({ comps: [{ name: 'Ghost', source_url: 'https://invented.example/x' }] }, urlSet);
  assert.equal(r.findings.comps.length, 0);
  assert.equal(r.dropped, 1);
  assert.equal(r.status, 'empty');
});

test('a finding with no source_url is dropped', () => {
  const r = gateResearch({ why_now: [{ event: 'something', point: 'no url' }] }, urlSet);
  assert.equal(r.findings.why_now.length, 0);
  assert.equal(r.dropped, 1);
});

test('mixed real and invented citations: only the real ones survive', () => {
  const r = gateResearch({
    comps: [
      { name: 'Real', source_url: 'https://pitchbook.com/a' },
      { name: 'Fake', source_url: 'https://invented.example/y' },
    ],
    market_size: [{ figure: '$10B', source_url: 'https://news.co/b' }],
  }, urlSet);
  assert.equal(r.findings.comps.length, 1);
  assert.equal(r.findings.comps[0].name, 'Real');
  assert.equal(r.findings.market_size.length, 1);
  assert.equal(r.dropped, 1);
  assert.deepEqual([...r.sources].sort(), ['https://news.co/b', 'https://pitchbook.com/a']);
});

test('an errored or empty extraction returns empty findings, never throws', () => {
  assert.equal(gateResearch({ error: 'parse failed' }, urlSet).status, 'empty');
  assert.equal(gateResearch(null, urlSet).status, 'empty');
  assert.deepEqual(gateResearch(undefined, urlSet).findings.comps, []);
});

test('research queries need a subject; they key off the company name/domain', () => {
  assert.equal(buildResearchQueries({}).length, 0);
  const q = buildResearchQueries({ name: 'Permute', domain: 'mid-market ERP data' });
  assert.ok(q.length >= 2);
  assert.ok(q.some((s) => s.includes('Permute')));
  assert.ok(q.some((s) => /valuation 2026/i.test(s))); // the standing benchmark query
});
