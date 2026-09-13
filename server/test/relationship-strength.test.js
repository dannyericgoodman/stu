'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Every case here is a real row from Danny's export (2026-07-21), because the
// judgement calls in this scorer were made against these specific people.
//
// The two that matter most:
//   · Stephanie Krantz — 226 messages, dead even both ways, last touched 2021.
//     Proves depth and recency must stay separate fields. A single time-decayed
//     score reads this as weak, which is false: it is deep and cold, and those
//     take different actions.
//   · Haley Sonenthal — 203 messages but 169 of them sent by Danny. Proves
//     BALANCE has to matter inside reciprocity, or chasing looks like closeness.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const rs = require('../lib/relationshipStrength');

const NOW = new Date('2026-09-03T00:00:00Z');

test('a deep but dormant relationship stays strong, and reports its dormancy', () => {
  const r = rs.score({
    sent: 112, received: 114, threads: 3,
    last_at: '2021-05-27', is_connection: true, now: NOW,
  });
  assert.strictEqual(r.tier, 'strong');
  assert.ok(r.warmth >= 75, `226 balanced messages should score high, got ${r.warmth}`);
  assert.ok(r.months_since > 48, 'and must still report that it is years stale');
  assert.strictEqual(rs.stalenessLabel(r.months_since), 'dormant');
});

test('a lopsided thread scores below a balanced one of similar volume', () => {
  const chased = rs.score({ sent: 169, received: 34, threads: 1, last_at: '2026-04-30', is_connection: true, now: NOW });
  const even = rs.score({ sent: 100, received: 103, threads: 1, last_at: '2026-04-30', is_connection: true, now: NOW });
  assert.ok(even.warmth > chased.warmth,
    'a balanced exchange must outrank one Danny carried, at comparable volume');
  assert.strictEqual(chased.tier, 'strong', 'it is still a real relationship');
});

test('messages sent with no reply never reach a warm tier', () => {
  const r = rs.score({ sent: 6, received: 0, threads: 1, last_at: '2026-06-01', is_connection: true, now: NOW });
  assert.strictEqual(r.reciprocal, false);
  assert.strictEqual(r.tier, 'light', 'no reply is not a warm path, however many times he tried');
  assert.strictEqual(r.components.reciprocity, 0);
  assert.match(r.receipt, /no reply/, 'the receipt must say so plainly');
});

test('a bare connection is thin and says exactly that', () => {
  const r = rs.score({ sent: 0, received: 0, threads: 0, is_connection: true, connected_on: '2024-03-11', now: NOW });
  assert.strictEqual(r.tier, 'thin');
  assert.match(r.receipt, /never messaged/);
  assert.strictEqual(r.months_since, null, 'no messages means no last-contact date to report');
});

test('someone in the graph with no connection and no messages is name_only', () => {
  const r = rs.score({ sent: 0, received: 0, threads: 0, is_connection: false, now: NOW });
  assert.strictEqual(r.tier, 'name_only');
  assert.strictEqual(r.warmth, 0);
});

test('multiple threads outrank a single thread of the same volume', () => {
  const many = rs.score({ sent: 5, received: 5, threads: 3, last_at: '2026-01-01', now: NOW });
  const one = rs.score({ sent: 5, received: 5, threads: 1, last_at: '2026-01-01', now: NOW });
  assert.ok(many.warmth > one.warmth, 're-engaging over time is a durability signal');
});

test('an inbound-only contact is credited, not zeroed', () => {
  const r = rs.score({ sent: 0, received: 3, threads: 1, last_at: '2026-02-01', is_connection: true, now: NOW });
  assert.ok(r.components.reciprocity > 0, 'they reached out — that is real information');
  assert.match(r.receipt, /never answered/);
});

test('receipts state counts and direction, never adjectives', () => {
  const r = rs.score({ sent: 12, received: 9, threads: 2, last_at: '2026-05-18', is_connection: true, now: NOW });
  assert.match(r.receipt, /21 messages both ways \(12 sent, 9 received\) across 2 threads, last May 2026/);
});

test('warmth is bounded and monotonic in volume', () => {
  const small = rs.score({ sent: 1, received: 1, threads: 1, last_at: '2026-08-01', now: NOW });
  const big = rs.score({ sent: 60, received: 60, threads: 4, last_at: '2026-08-01', now: NOW });
  assert.ok(big.warmth > small.warmth);
  assert.ok(big.warmth <= 100 && small.warmth >= 0);
});

// ── The saturation bug, found by importing the real book. ──
// A 9× volume coefficient hit its 25-point ceiling at SIX messages, flattening
// every real relationship above that into a tie and letting recency decide. The
// live symptom: a six-message chat from last month outranked 226 messages with
// Danny's closest contact. The cap belongs at the top of the distribution.
test('a deep relationship outranks a brief recent one', () => {
  const deep = rs.score({ sent: 112, received: 114, threads: 3, last_at: '2021-05-27', is_connection: true, now: NOW });
  const brief = rs.score({ sent: 3, received: 3, threads: 1, last_at: '2026-07-15', is_connection: true, now: NOW });
  assert.ok(deep.warmth > brief.warmth,
    `226 messages must outrank 6, even four years stale (${deep.warmth} vs ${brief.warmth})`);
});

test('volume keeps discriminating well past a handful of messages', () => {
  const at = (n) => rs.score({ sent: n / 2, received: n / 2, threads: 1, last_at: '2026-08-01', now: NOW }).components.volume;
  assert.ok(at(50) > at(10), 'the scorer must still have an opinion at 50 messages');
  assert.ok(at(200) > at(50), 'and at 200');
});
