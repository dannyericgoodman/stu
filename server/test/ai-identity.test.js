'use strict';
// Per-user AI identity — Danny's fund context must never leak to outside seats.
//
// buildAiSystem(1) keeps the full Superior Studios thesis/team context (explicit
// owner handling). Any other user gets a neutral investor identity: their name,
// their fund name when set in Settings, and no mention of Superior, its team, or
// its private doctrine. Same rule for the shorter scorer persona.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { buildAiSystem, buildScorerPersona } = require('../lib/aiIdentity');

const TAG = 'TEST::ident-';
let outsiderId;

before(() => {
  const r = db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, 'Outsider Investor', 'member', ?)")
    .run(`${TAG}@t.t`, bcrypt.hashSync('x', 4));
  outsiderId = r.lastInsertRowid;
});

after(() => {
  db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).run(outsiderId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(outsiderId);
});

const PRIVATE = ['Superior Studios', 'Brandon Cruz', 'Eric Hutt', 'Rob Schinske', 'Artist Founder'];
function assertNoLeak(s, who) {
  for (const p of PRIVATE) assert.ok(!s.includes(p), `${who}: leaked "${p}"`);
}

test('owner keeps the full Superior Studios context', () => {
  const s = buildAiSystem(1);
  assert.ok(s.includes('Superior Studios'), 'owner prompt names the fund');
  assert.ok(s.includes('Danny Goodman'), 'owner prompt names Danny');
});

test('outsider gets a neutral identity with no private context', () => {
  const s = buildAiSystem(outsiderId);
  assertNoLeak(s, 'outsider');
  assert.ok(s.includes('Outsider Investor'), 'prompt uses the user\u2019s name');
  assert.ok(/pre-seed investor/i.test(s), 'neutral investor framing');
});

test('outsider with a fund name gets it in the identity', () => {
  db.prepare('INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)')
    .run(outsiderId, 'profile_fund_name', JSON.stringify('Acme Ventures'));
  const s = buildAiSystem(outsiderId);
  assertNoLeak(s, 'outsider with fund');
  assert.ok(s.includes('Acme Ventures'), 'prompt names the user\u2019s fund');
});

test('scorer persona follows the same owner rule', () => {
  assert.ok(buildScorerPersona(1).includes('Superior Studios'));
  assertNoLeak(buildScorerPersona(outsiderId), 'outsider scorer');
  assert.ok(buildScorerPersona(outsiderId).includes('Acme Ventures'));
});
