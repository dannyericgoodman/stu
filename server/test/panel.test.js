'use strict';
// The expert panel — the nine named lenses, their shared honesty contract, and the
// deterministic grounding that keeps a lens from laundering a fabrication into the
// room. The LLM's judgment needs a model; the grounding gate and the room's shape do
// not, and those are what must never silently drift.
const { test } = require('node:test');
const assert = require('node:assert');

const prompts = require('../agents/prompts');
const { verifyLensCard, verifyPanel, buildContextIndex } = require('../agents/verify');
const { runPool } = require('../routes/assessments')._internal;

// ── The room is always nine, always the same ──

test('PANEL: the room is nine — eight named lenses plus The Bear', () => {
  assert.equal(prompts.LENSES.length, 8, 'eight named-tradition lenses');
  assert.ok(prompts.bear, 'The Bear is the ninth voice');
  // Locked naming: labelled as the LENS in a tradition, never "<Person> says".
  for (const lens of prompts.LENSES) {
    assert.match(lens.label, /tradition\)$/, `${lens.key} names the tradition, not the person`);
    assert.ok(lens.weighs && lens.question, `${lens.key} declares what it weighs on and the question it forces`);
    assert.equal(typeof lens.prompt.user, 'function');
    // Every lens carries the two hard rules and the shared schema.
    assert.match(lens.prompt.system, /ABSTAIN HONESTLY/, `${lens.key} can abstain`);
    assert.match(lens.prompt.system, /NEVER FABRICATE/, `${lens.key} is honesty-gated`);
    assert.match(lens.prompt.system, /"owner": "Founder \| SME \| Expert call \| Desktop/, `${lens.key} buckets its questions by owner`);
  }
});

test('PANEL: the panel covers Team, Product, and Market across the room', () => {
  const weighs = prompts.LENSES.map((l) => l.weighs).join(' ');
  for (const pillar of ['Team', 'Product', 'Market']) {
    assert.match(weighs, new RegExp(pillar), `some lens weighs on ${pillar}`);
  }
});

test('PANEL: only the Unit-Economics (Gurley) lens owns structurally_dead', () => {
  // This is the one lens field that reaches the conviction score (the dead-market dock),
  // inherited from the retired market agent. It must live on exactly one lens.
  const owners = prompts.LENSES.filter((l) => /structurally_dead/.test(l.prompt.system));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].key, 'unit_economics');
});

// ── The grounding gate — reused verbatim from the quote trust layer ──

const SOURCE = 'On the founder call Dan said we closed four customers in six weeks. ' +
  'The deck says the market is 12 billion dollars. He ran claims ops for six years.';

test('PANEL: a verbatim quote is verified; a fabricated one is not', () => {
  const idx = buildContextIndex(SOURCE);
  const lens = {
    key: 'founder_edge', applies: true, read: 'Earned edge from operating (founder call).',
    quotes: ['closed four customers in six weeks', 'closed forty customers in two days'],
    strengths: [], risks: [],
  };
  verifyLensCard(lens, idx);
  assert.equal(lens.quote_verification[0].verification, 'verbatim');
  assert.equal(lens.quote_verification[1].verification, 'unverified', 'the invented quote is caught');
  assert.equal(lens.quote_integrity.has_unverified, true);
});

test('PANEL: an invented number in a lens read is flagged', () => {
  const idx = buildContextIndex(SOURCE);
  const lens = {
    key: 'unit_economics', applies: true,
    read: 'They claim 50 million dollars in ARR already.', // not in the source
    quotes: [], strengths: [], risks: ['Burn implies a 90 percent gross margin claim.'],
  };
  verifyLensCard(lens, idx);
  assert.ok(lens.unsupported_numbers.includes('50'), 'the invented ARR is surfaced');
  assert.equal(lens.quote_integrity.has_unsupported_numbers, true);
});

test('PANEL: an abstaining lens is left untouched — nothing to verify', () => {
  const idx = buildContextIndex(SOURCE);
  const lens = { key: 'deep_tech', applies: false, abstain_reason: 'Not a deep-tech deal.' };
  const before = JSON.stringify(lens);
  verifyLensCard(lens, idx);
  assert.equal(JSON.stringify(lens), before, 'abstention makes no claims, so the gate adds nothing');
});

test('PANEL: verifyPanel grounds every non-errored card and skips the dead ones', () => {
  const panel = [
    { key: 'monopoly', applies: true, read: 'A real secret (deck slide 4).', quotes: ['closed four customers in six weeks'], strengths: [], risks: [] },
    { key: 'networks', error: 'Could not parse JSON output' }, // a voice that went dark
    { key: 'inflection', applies: false, abstain_reason: 'No why-now stated.' },
  ];
  verifyPanel(panel, SOURCE);
  assert.equal(panel[0].quote_integrity.verbatim, 1, 'the live card is grounded');
  assert.equal(panel[1].quote_integrity, undefined, 'the errored card is skipped, not crashed on');
  assert.equal(panel[2].quote_integrity, undefined, 'the abstaining card is skipped');
});

// ── The concurrency pool that paces the room ──

test('PANEL: runPool runs all thunks, preserves order, and never rejects on a throw', async () => {
  const thunks = [
    () => Promise.resolve('a'),
    () => Promise.reject(new Error('boom')),
    () => Promise.resolve('c'),
  ];
  const results = await runPool(thunks, 2);
  assert.equal(results.length, 3);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value, 'a');
  assert.equal(results[1].status, 'rejected', 'a thrown thunk settles as rejected, matching Promise.allSettled');
  assert.equal(results[2].value, 'c', 'order is preserved regardless of concurrency');
});

test('PANEL: runPool bounds concurrency to the requested width', async () => {
  let inFlight = 0, peak = 0;
  const thunk = () => new Promise((res) => {
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight--; res(true); }, 5);
  });
  await runPool(Array.from({ length: 9 }, () => thunk), 4);
  assert.ok(peak <= 4, `peak concurrency ${peak} stayed within the pool width`);
  assert.ok(peak > 1, 'and it actually ran things in parallel');
});
