'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The exit marker is the heaviest signal in the rubric, so it is the one worth
// attacking. These pin the three real cases found on the live Illinois inbox
// 2026-08-28, plus the academic gate that came out of the same pass.
//
// The failure they encode: "was acquired" appearing ANYWHERE in a profile used to
// score a prior exit, with no attribution. That put a chemistry professor at the top
// of the shortlist. The fix is sentence-scoped attribution — and the risk of that fix
// is dropping real founders, which is why two of these three tests assert INCLUSION.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const ff = require('../lib/founderFit');

const evalText = (headline, extra = {}) =>
  ff.evaluate({ id: 0, name: 'T', headline, chicago_connection: 'current: Chicago', ...extra });

// ── The professor. An exit he consulted on is not his exit. ──
test('an exit the person only CONSULTED on does not score as their exit', () => {
  const r = evalText(
    'Ken Suslick received his Ph.D. from Stanford and came to the University of Illinois. ' +
    'He has published more than 500 scientific papers and holds 71 patents. ' +
    'He was the lead consultant for Molecular Biosystems Inc. and part of the team; the company was acquired.'
  );
  assert.ok(!r.markers.some((m) => m.key === 'prior_exit'), 'consulted-on exit must not fire prior_exit');
  assert.strictEqual(r.tier, null, 'a professor with no operating evidence is not meet-worthy');
  assert.strictEqual(r.academic, true, 'should be caught by the academic gate');
});

// ── The academic gate must NOT catch a real spinout founder. ──
test('a professor who actually spun a company out still qualifies', () => {
  const r = evalText(
    'Professor of Robotics at Northwestern. Co-founder and CEO of a stealth spinout ' +
    'commercialising the lab work. Previously founded a company acquired by Google.',
    { company: 'Helix Robotics' }
  );
  assert.strictEqual(r.academic, false, 'operating evidence must override the academic read');
  assert.ok(r.meetWorthy, 'deep-tech spinout founders are in scope');
});

// ── Inclusion: attribution spanning a long clause. ──
test('a founder-attributed exit is kept even when the exit is a full clause away', () => {
  const r = evalText(
    "I co-founded Revvin (formerly MortgageHippo), a digital mortgage platform that grew " +
    "to serve more than 150 financial institutions before being acquired by Maxwell in 2023. " +
    "Today I'm building a company at the intersection of personal finance and healthcare."
  );
  const exit = r.markers.find((m) => m.key === 'prior_exit');
  assert.ok(exit, 'co-founded ... acquired by X in the same sentence is a real exit');
  assert.strictEqual(r.tier, 'must-meet');
});

// ── Inclusion: the self-described exit. ──
test('"Founder with Successful Exit" is a self-attributed exit', () => {
  const r = evalText('CPG Founder with Successful Exit | CMO-CRO | Food & Bev Start-up Expert. Building (stealth).');
  assert.ok(r.markers.some((m) => m.key === 'prior_exit'), 'self-described exit must count');
});

// ── The employer's exit is not the employee's. ──
test("an employer's acquisition does not become the candidate's exit", () => {
  const r = evalText('Senior engineer. I worked at Ring, which was acquired by Amazon. Now building something new.');
  assert.ok(!r.markers.some((m) => m.key === 'prior_exit'), 'no founder frame in the sentence → no exit');
});

// ── Timing ranks but never qualifies. ──
test('"just left" boosts rank but cannot put anyone on the shortlist alone', () => {
  const r = evalText('Just left Google. Building something new in Chicago.');
  const timing = r.markers.find((m) => m.key === 'recently_departed');
  assert.ok(timing, 'the timing marker should fire');
  assert.strictEqual(timing.modifier, true, 'timing must be rank-only');
  const hyper = r.markers.find((m) => m.key === 'hyperscale');
  // Hyperscaler is the core marker here; timing must not add a second "independent
  // signal" and manufacture a must-meet out of one real credential plus a date.
  if (hyper) assert.strictEqual(r.tier, 'strong', 'one credential + timing is Strong, not Must-meet');
});

// ── School is a graduation signal, and can never qualify anyone by itself. ──
test('school alone never reaches the shortlist, and is labelled as a graduation signal', () => {
  const r = evalText('Northwestern University graduate. Interested in startups.');
  assert.ok(!r.meetWorthy, 'a degree is not a track record');
  const school = ff.MARKERS.find((m) => m.key === 'il_elite_school');
  assert.strictEqual(school.modifier, true);
  assert.strictEqual(school.graduation, true);
});

// ── YC outranks the unmeasured programs. ──
test('YC is weighted above programs with no published outcome data', () => {
  const w = (k) => ff.MARKERS.find((m) => m.key === k).weight;
  assert.ok(w('yc') > w('speedrun_zfellows'), 'YC has measured Series A lift; Speedrun/Z do not');
  assert.ok(w('yc') > w('spc'));
});

// ── The cache must invalidate when the rubric moves. ──
test('the rubric carries a version so stored verdicts can be invalidated', () => {
  assert.ok(typeof ff.RUBRIC_VERSION === 'string' && ff.RUBRIC_VERSION.length > 0);
});
