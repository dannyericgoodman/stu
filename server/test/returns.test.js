'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The returns math is arithmetic, so it is tested arithmetic. Same reason
// conviction is tested: a number that quietly drifts is worse than no number.
// ══════════════════════════════════════════════════════════════════════════
const { test } = require('node:test');
const assert = require('node:assert');
const { computeReturns, toUsd, resolvePostMoney } = require('../lib/returns');

test('toUsd coerces the loose shapes a founder record actually holds', () => {
  assert.equal(toUsd(5_000_000), 5_000_000);
  assert.equal(toUsd('$5M'), 5_000_000);
  assert.equal(toUsd('5m'), 5_000_000);
  assert.equal(toUsd('$20,000,000'), 20_000_000);
  assert.equal(toUsd('20'), 20_000_000);        // a bare cap is written in millions
  assert.equal(toUsd('250k'), 250_000);
  assert.equal(toUsd(''), null);
  assert.equal(toUsd(null), null);
  assert.equal(toUsd(0), null);
});

test('a SAFE cap is read as post-money by default', () => {
  const r = resolvePostMoney('$5M', null, 'SAFE');
  assert.equal(r.postMoney, 5_000_000);
  assert.equal(r.basis, 'cap-as-post');
});

test('an explicit pre-money valuation adds the round', () => {
  const r = resolvePostMoney('$20M', '$4.5M', 'priced pre-money');
  assert.equal(r.postMoney, 24_500_000);
  assert.equal(r.basis, 'pre+round');
});

test('no priced round → need_inputs, not a fabricated table', () => {
  const r = computeReturns({ securityType: 'SAFE' });
  assert.equal(r.status, 'need_inputs');
  assert.ok(r.missing.length > 0);
  assert.ok(!r.scenarios);
});

test('ownership and exit-to-return-fund match the memo arithmetic (Yeet: $250K at $24.5M post)', () => {
  const r = computeReturns({ valuation: '$24.5M', securityType: 'SAFE', investmentAmount: '$250K' });
  assert.equal(r.status, 'ok');
  assert.equal(r.inputs.post_money, 24_500_000);
  // entry ownership = 250k / 24.5m ≈ 1.02% — the memo's "~1% of Yeet today"
  assert.ok(Math.abs(r.entry.entry_ownership - 250_000 / 24_500_000) < 1e-9);
  // diluted half → exit ownership ≈ 0.51%
  assert.ok(Math.abs(r.entry.exit_ownership - r.entry.entry_ownership * 0.5) < 1e-9);
  // exit to return a $10M fund on a 0.51% stake ≈ $1.96B
  const expected = 10_000_000 / (r.entry.entry_ownership * 0.5);
  assert.ok(Math.abs(r.entry.exit_to_return_fund - expected) < 1);
});

test('the scenario table always includes our check plus the three standard checks, deduped', () => {
  const r = computeReturns({ valuation: '$20M', investmentAmount: '$250K' });
  const checks = r.scenarios.map((s) => s.check);
  assert.deepEqual(checks, [150_000, 250_000, 400_000]); // 250K is ours AND a standard — not duplicated
  const r2 = computeReturns({ valuation: '$20M', investmentAmount: '$300K' });
  assert.deepEqual(r2.scenarios.map((s) => s.check), [150_000, 250_000, 300_000, 400_000]);
});

test('a smaller post-money means more ownership and a smaller exit to return the fund', () => {
  const low = computeReturns({ valuation: '$12M', investmentAmount: '$400K' }).entry;
  const high = computeReturns({ valuation: '$30M', investmentAmount: '$400K' }).entry;
  assert.ok(low.entry_ownership > high.entry_ownership);
  assert.ok(low.exit_to_return_fund < high.exit_to_return_fund);
});
