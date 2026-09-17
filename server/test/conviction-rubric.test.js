// Generic-rubric coverage for the conviction engine.
// The legacy 51 tests in conviction.test.js cover Danny's Founder Rubric as the
// default; these cover arbitrary dimension sets, custom gates, and the veto.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeConviction, RUNG } = require('../lib/conviction');

const DEEPTECH = [
  { key: 'technical_risk', label: 'Technical Risk & Feasibility', blurb: '', weight: 5, needs: 2, load_bearing: true },
  { key: 'founder_depth', label: 'Founder Technical Depth', blurb: '', weight: 4, needs: 2, load_bearing: true },
  { key: 'defensibility', label: 'Defensibility Path', blurb: '', weight: 3, needs: 3, load_bearing: false },
  { key: 'why_now', label: 'Why Now', blurb: '', weight: 2, needs: 2, load_bearing: false },
];

const mv = (scores) => Object.fromEntries(
  Object.entries(scores).map(([k, s]) => [k, { score: s, evidence: 'e', quotes: [] }])
);

describe('computeConviction — generic rubrics', () => {
  it('scores a custom rubric off its load-bearing dimensions', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 8, founder_depth: 7, defensibility: 9, why_now: 6 }),
      rung: RUNG.OBSERVED,
    });
    assert.equal(r.determinate, true);
    // base 7.5, differentiator (7.5-5.5)/4.5 → +0.44 → 7.9 → memo band (8+ is top-quartile)
    assert.equal(r.score, 7.9);
    assert.equal(r.band.key, 'memo');
    assert.equal(r.cleared_gate, true);
  });

  it('a weak load-bearing dimension gates the score on any rubric', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 5, founder_depth: 9, defensibility: 10, why_now: 10 }),
      rung: RUNG.OBSERVED,
    });
    // base (5+9)/2=7 + diff (10-5.5)/4.5=+1 → 8 → gate caps to 6.9
    assert.equal(r.cleared_gate, false);
    assert.equal(r.score, 6.9);
    assert.equal(r.gate_applied, true);
    assert.equal(r.band.key, 'monitor');
  });

  it('honors a custom gate_threshold', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      gate_threshold: 7,
      movements: mv({ technical_risk: 6, founder_depth: 9, defensibility: 10, why_now: 10 }),
      rung: RUNG.OBSERVED,
    });
    // min(6,9)=6 < 7 → capped
    assert.equal(r.cleared_gate, false);
    assert.equal(r.score, 6.9);
  });

  it('goes indeterminate when a load-bearing dimension is unscorable, naming it', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 8, founder_depth: null, defensibility: 9, why_now: 6 }),
      rung: RUNG.OBSERVED,
    });
    assert.equal(r.determinate, false);
    assert.equal(r.score, null);
    assert.deepEqual(r.missing_load_bearing, ['Founder Technical Depth']);
  });

  it('a veto forces the band to Pass while keeping the computed score', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 9, founder_depth: 9, defensibility: 9, why_now: 9 }),
      rung: RUNG.OBSERVED,
      veto: { present: true, reason: 'Founder is running three companies.' },
    });
    assert.equal(r.determinate, true);
    assert.ok(r.score >= 8, `score=${r.score}`);
    assert.equal(r.band.key, 'pass');
    assert.equal(r.vetoed, true);
    assert.equal(r.veto_reason, 'Founder is running three companies.');
    assert.match(r.calculation, /VETO/);
  });

  it('a non-present veto changes nothing', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 9, founder_depth: 9, defensibility: 9, why_now: 9 }),
      rung: RUNG.OBSERVED,
      veto: { present: false, reason: '' },
    });
    assert.equal(r.vetoed, false);
    assert.notEqual(r.band.key, 'pass');
  });

  it('works with a single load-bearing dimension', () => {
    const dims = [
      { key: 'a', label: 'A', blurb: '', weight: 5, needs: 1, load_bearing: true },
      { key: 'b', label: 'B', blurb: '', weight: 3, needs: 1, load_bearing: false },
    ];
    const r = computeConviction({
      dimensions: dims,
      movements: mv({ a: 8, b: 10 }),
      rung: RUNG.PUBLIC,
    });
    assert.equal(r.determinate, true);
    // base 8 + (10-5.5)/4.5=+1 → 9
    assert.equal(r.score, 9);
  });

  it('dimensions missing from the agent output abstain rather than crash', () => {
    const r = computeConviction({
      dimensions: DEEPTECH,
      movements: mv({ technical_risk: 8, founder_depth: 7 }), // rest absent
      rung: RUNG.OBSERVED,
    });
    assert.equal(r.determinate, true);
    assert.equal(r.score, 7.5); // no differentiator
  });
});
