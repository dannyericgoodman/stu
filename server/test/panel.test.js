'use strict';
// The expert panel — the nine named lenses, their shared honesty contract, and the
// deterministic grounding that keeps a lens from laundering a fabrication into the
// room. The LLM's judgment needs a model; the grounding gate and the room's shape do
// not, and those are what must never silently drift.
const { test } = require('node:test');
const assert = require('node:assert');

const prompts = require('../agents/prompts');
const { verifyLensCard, verifyPanel, buildContextIndex } = require('../agents/verify');
const { runPool, buildMemo7M, buildDefensibility } = require('../routes/assessments')._internal;

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

// ── The honesty gate reaches the Bear's nested risk prose ──

test('PANEL: an invented number in the Bear\'s risk prose is flagged, not laundered', () => {
  const { verifyAllAgents } = require('../agents/verify');
  const source = 'On the call the founder said they closed four customers in six weeks.';
  const bear = {
    // The Bear asserts most numbers in these nested fields — the flat field list never
    // reached them before, so an invented figure here used to sail through.
    primary_risks: [{ risk: 'Customer concentration', detail: 'Roughly 90 percent of revenue rides on one logo.' }],
    twelve_month_kill: { scenario: 'A competitor raises 50 million dollars and undercuts them.' },
    narrative: 'Adversarial read of the opportunity.',
  };
  verifyAllAgents({ bear }, source);
  const flagged = (bear.quote_integrity?.unsupported_numbers || []).flatMap((x) => x.numbers || []);
  assert.ok(flagged.includes('90'), 'the invented concentration figure is caught');
  assert.ok(flagged.includes('50'), 'the invented raise figure is caught');
  assert.equal(bear.quote_integrity.has_unsupported_numbers, true);
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

// ── Read-back: the 7-M memo and defensibility now source from the room ──

const panelRow = () => ({
  panel_output: JSON.stringify([
    { key: 'monopoly', label: 'Thiel', applies: true, verdict: 'A 10x on claims ops.', read: 'Secret: payers insource (deck slide 4).' },
    { key: 'unit_economics', label: 'Gurley', applies: true, verdict: 'Math works.', read: 'TAM credible (deck).', structurally_dead: false },
    { key: 'founder_edge', label: 'Rabois', applies: true, verdict: 'A barrel.', read: 'Ran claims ops six years (founder call).' },
    { key: 'hard_problems', label: 'Lonsdale', applies: true, verdict: 'Hard.', read: 'Regulatory moat (deck).' },
    { key: 'long_game', label: 'Housel', applies: false, abstain_reason: 'No behavioral read yet.' },
    { key: 'deep_tech', label: 'Wolfe', applies: false, abstain_reason: 'Not a deep-tech deal.' },
    { key: 'networks', label: 'Hoffman', applies: true, verdict: 'No network effect.', read: 'Linear growth (site).' },
    { key: 'inflection', label: 'Maples', applies: true, verdict: 'Real why-now.', read: '2024 rule change (deck).' },
  ]),
  bear_agent_output: JSON.stringify({ primary_risks: ['Customer concentration'], bundling_risk: { assessment: 'Stripe could bundle' }, kill_shot_risk: 'Platform dependency' }),
  synthesis_output: JSON.stringify({ executive_summary: 'Claims-ops insider building payer automation.', one_liner: 'Domain insider, 4 customers in 6 weeks.' }),
  agenda_output: JSON.stringify({ top_priorities: ['How did you find this problem?'], founder: [{ q: 'Who committed before proof?', why: 'talent magnetism' }] }),
});

test('PANEL: the 7-M memo is sourced from the room, not the legacy columns', () => {
  const memo = buildMemo7M(panelRow());
  assert.equal(memo.length, 7, 'all seven M sections filled from the panel');
  assert.match(memo.find((s) => s.key === 'mgmt').body, /Ran claims ops/, 'Management ← Founder-Edge/Rabois');
  assert.match(memo.find((s) => s.key === 'market').body, /rule change/, 'Market ← Inflection/Maples');
  assert.match(memo.find((s) => s.key === 'conditions').body, /find this problem/, 'Conditions ← the diligence agenda');
  assert.ok(!JSON.stringify(memo).includes('No behavioral read'), 'an abstaining lens contributes nothing to the memo');
});

test('PANEL: defensibility is the moat lenses (Thiel/Wolfe/Lonsdale/Bear)', () => {
  const d = buildDefensibility(panelRow());
  assert.deepEqual(d.map((p) => p.label), ['Moat', 'Build vs buy', 'Kill shot', 'Gets bundled']);
  assert.match(d.find((p) => p.label === 'Moat').body, /payers insource/, 'Moat ← the Monopoly lens');
  assert.match(d.find((p) => p.label === 'Gets bundled').body, /Stripe could bundle/, 'Bundling ← The Bear');
});

test('PANEL: read-back still serves pre-panel assessments from the legacy columns', () => {
  // A pre-panel assessment has no panel_output; the mis-named columns still drive it.
  const legacy = {
    founder_agent_output: JSON.stringify({ the_read: 'A strong operator who closed four customers.' }), // Team
    market_agent_output: JSON.stringify({ product_thesis: 'A wedge product.' }),                        // Product
    economics_agent_output: JSON.stringify({ why_now: 'Regulatory change in 2024.' }),                  // Market
    bear_agent_output: JSON.stringify({ primary_risks: ['Thin moat'] }),
    synthesis_output: JSON.stringify({ one_liner: 'Legacy read.' }),
  };
  const memo = buildMemo7M(legacy);
  assert.ok(memo.length >= 3, 'the legacy path still builds the memo');
  assert.match(memo.find((s) => s.key === 'mgmt').body, /closed four customers/, 'Management ← the mis-named Team column');
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
