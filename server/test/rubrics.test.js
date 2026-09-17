/**
 * Rubric data layer + Assessment Architect wiring tests.
 *
 * Covers: preset seeding, resolveRubric fallback chain, ownership, CRUD
 * lifecycle, draft validation, prompt JSON-example validity, and the
 * equivalence guarantee — a pre-seed preset passed explicitly through the
 * generic engine must score IDENTICALLY to the legacy four-movement path.
 *
 * DB-touching; cleanup runs in after(). better-sqlite3 v11 on Node 24 can
 * abort at process teardown (known flake, unrelated to these assertions).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const {
  getPreset,
  resolveRubric,
  createRubric,
  updateRubric,
  deleteRubric,
  setDefaultRubric,
  duplicateRubric,
  validateRubric,
} = require('../lib/rubrics');
const { buildRubricPrompt } = require('../agents/prompts');
const { computeConviction } = require('../lib/conviction');

const TEST_USER = 1; // Danny's owner account — tests use unique names and clean up
const createdIds = [];

function exampleJsonOf(rubric) {
  const sys = buildRubricPrompt(rubric).system;
  const m = sys.match(/Return JSON \(no markdown wrapping\):\s*(\{[\s\S]*\})\s*$/);
  assert.ok(m, `${rubric.name}: no JSON example found in prompt`);
  const ex = m[1]
    .replace(/"score": 1-10 or null/g, '"score": null')
    .replace(/"present": true\/false\/null/g, '"present": true')
    .replace(/"direction": "work" \| "people" \| null/g, '"direction": null')
    .replace(/: true\/false,/g, ': false,')
    .replace(/"present": true\/false/g, '"present": false')
    .replace(/"pursue" \| "watch" \| "pass"/g, '"watch"');
  return JSON.parse(ex); // throws if invalid
}

test.after(() => {
  for (const id of createdIds) {
    try { db.prepare('DELETE FROM assessment_rubrics WHERE id = ?').run(id); } catch {}
  }
  try { db.prepare('DELETE FROM user_rubric_defaults WHERE user_id = ?').run(TEST_USER); } catch {}
});

test('presets: four are seeded with question-based dimensions', () => {
  for (const key of ['founder-preseed', 'deep-tech', 'fintech', 'consumer']) {
    const p = getPreset(key);
    assert.ok(p, `preset ${key} missing`);
    assert.ok(p.dimensions.length >= 4 && p.dimensions.length <= 7, `${key}: dimension count`);
    for (const d of p.dimensions) {
      assert.ok(d.question && d.question.length > 10, `${key}/${d.key}: question required`);
      assert.ok(d.weight >= 1 && d.weight <= 5, `${key}/${d.key}: weight 1-5`);
      assert.ok(d.min_rung >= 1 && d.min_rung <= 3, `${key}/${d.key}: min_rung 1-3`);
    }
    assert.ok(p.dimensions.some((d) => d.load_bearing), `${key}: at least one load-bearing`);
  }
});

test('pre-seed preset carries Danny\'s legacy extras', () => {
  const p = getPreset('founder-preseed');
  assert.ok(p.extras.drive_lens, 'drive lens present');
  const flagKeys = (p.extras.yellow_flags || []).map((f) => f.key);
  assert.ok(flagKeys.includes('charisma_over_substance'), 'charisma flag');
  assert.ok(flagKeys.includes('grievance_grandiosity'), 'grievance flag');
});

test('resolveRubric: null falls back to the pre-seed preset', () => {
  const r = resolveRubric(TEST_USER, null);
  assert.equal(r.preset_key, 'founder-preseed');
});

test('resolveRubric: unknown id falls back to default, never bricks the flow', () => {
  // A deleted or mistyped rubric must not brick the assess flow — resolveRubric
  // falls through to the default (→ pre-seed) rather than throwing.
  const r = resolveRubric(TEST_USER, 987654321);
  assert.equal(r.preset_key, 'founder-preseed');
});

test('resolveRubric: ownership is enforced on explicit ids', () => {
  const mine = createRubric(TEST_USER, {
    name: 'Ownership Probe ' + Date.now(),
    dimensions: [
      { key: 'q1', label: 'Q1', question: 'Question one?', weight: 3, min_rung: 2, load_bearing: true },
    ],
    gate_threshold: 6,
  });
  createdIds.push(mine.id);
  // Another user asking for my rubric must NOT get my rubric — they fall back
  // to their own default. Silence here is a brick-wall, not a leak.
  const theirs = resolveRubric(2, mine.id);
  assert.notEqual(theirs.id, mine.id);
  assert.equal(theirs.preset_key, 'founder-preseed');
  const back = resolveRubric(TEST_USER, mine.id);
  assert.equal(back.id, mine.id);
});

test('CRUD lifecycle: create → update → default → duplicate → delete', () => {
  const r = createRubric(TEST_USER, {
    name: 'Lifecycle ' + Date.now(),
    description: 'a test framework',
    dimensions: [
      { key: 'q1', label: 'Q1', question: 'First question?', weight: 3, min_rung: 2, load_bearing: true },
      { key: 'q2', label: 'Q2', question: 'Second question?', weight: 2, min_rung: 1, load_bearing: false },
    ],
    extras: { yellow_flags: [{ key: 'hype', label: 'Hype', blurb: 'Sizzle only', dock: 0.5 }] },
    gate_threshold: 5,
  });
  createdIds.push(r.id);

  const updated = updateRubric(TEST_USER, r.id, { name: r.name + ' v2' });
  assert.equal(updated.name, r.name + ' v2');

  setDefaultRubric(TEST_USER, r.id);
  assert.equal(resolveRubric(TEST_USER, null).id, r.id);

  const dupe = duplicateRubric(TEST_USER, r.id);
  createdIds.push(dupe.id);
  assert.ok(dupe.name.includes('copy'), 'duplicate is marked as a copy');
  assert.equal(dupe.dimensions.length, 2);

  deleteRubric(TEST_USER, r.id);
  // deleted → falls back, never bricks
  assert.notEqual(resolveRubric(TEST_USER, r.id).id, r.id);
  createdIds.splice(createdIds.indexOf(r.id), 1);
  // default fell back to pre-seed after the default rubric was deleted
  assert.equal(resolveRubric(TEST_USER, null).preset_key, 'founder-preseed');
});

test('validateRubric rejects bad shapes', () => {
  assert.ok(validateRubric({ name: '', dimensions: [] }).length > 0, 'empty rejected');
  assert.ok(validateRubric({ name: 'x', dimensions: [{ key: 'a', label: 'A', question: 'Q?', weight: 0, min_rung: 2, load_bearing: true }] }).length > 0, 'zero weight rejected');
  assert.ok(validateRubric({ name: 'x', dimensions: [{ key: 'a', label: 'A', question: 'Q?', weight: 3, min_rung: 9, load_bearing: true }] }).length > 0, 'bad rung rejected');
  assert.ok(validateRubric({ name: 'x', dimensions: [{ key: 'a', label: 'A', question: 'Q?', weight: 3, min_rung: 2, load_bearing: false }] }).length > 0, 'no load-bearing rejected');
  const ok = validateRubric({ name: 'x', dimensions: [{ key: 'a', label: 'A', question: 'Is this a real question?', weight: 3, min_rung: 2, load_bearing: true }] });
  assert.equal(ok.length, 0, 'good shape passes: ' + JSON.stringify(ok));
});

test('buildRubricPrompt: example JSON is valid for every preset and a bare custom rubric', () => {
  const customs = [{
    name: 'Bare custom', blurb: '', description: '', gate_threshold: 6,
    dimensions: [
      { key: 'a', label: 'Alpha', question: 'Question?', weight: 3, min_rung: 2, load_bearing: true },
      { key: 'b', label: 'Beta', question: 'Question?', weight: 2, min_rung: 1, load_bearing: false },
    ],
    extras: {},
  }];
  for (const key of ['founder-preseed', 'deep-tech', 'fintech', 'consumer']) {
    const ex = exampleJsonOf(getPreset(key));
    assert.ok(ex.movements && ex.veto && ex.flags && ex.recommendation, `${key}: contract fields`);
  }
  const bare = exampleJsonOf(customs[0]);
  assert.ok(bare.movements.a && bare.movements.b, 'bare custom movements');
  assert.ok(!('chip_on_shoulder' in bare), 'no drive lens slot when rubric has none');
});

test('equivalence: pre-seed preset through the generic engine scores like the legacy path', () => {
  const preset = getPreset('founder-preseed');
  const scores = {
    earned_insight: { score: 8 },
    execution_velocity: { score: 7 },
    nonconsensus_vision: { score: 6 },
    talent_magnetism: { score: 7 },
  };
  const legacy = computeConviction({ movements: scores, rung: 3, flags: { charisma_over_substance: true } });
  const generic = computeConviction({
    movements: scores,
    rung: 3,
    flags: { charisma_over_substance: true },
    dimensions: preset.dimensions.map((d) => ({
      key: d.key, label: d.label, weight: d.weight, needs: d.min_rung, load_bearing: !!d.load_bearing,
    })),
    gate_threshold: preset.gate_threshold,
    flag_defs: (preset.extras.yellow_flags || []).map((f) => ({ key: f.key, label: f.label, why: f.blurb, amount: f.dock })),
  });
  assert.equal(generic.score, legacy.score, `scores match (${legacy.score})`);
  assert.equal(generic.band.key, legacy.band.key, 'bands match');
});

test('veto forces the band to Pass while preserving the score', () => {
  const preset = getPreset('deep-tech');
  const c = computeConviction({
    movements: Object.fromEntries(preset.dimensions.map((d) => [d.key, { score: 8 }])),
    rung: 3,
    dimensions: preset.dimensions.map((d) => ({
      key: d.key, label: d.label, weight: d.weight, needs: d.min_rung, load_bearing: !!d.load_bearing,
    })),
    gate_threshold: preset.gate_threshold,
    veto: { present: true, reason: 'Fabricated traction' },
  });
  assert.equal(c.band.key, 'pass');
  assert.ok(c.vetoed && c.veto_reason, 'veto surfaced in output');
  assert.ok(c.score > 7, 'numeric score preserved under veto');
});
