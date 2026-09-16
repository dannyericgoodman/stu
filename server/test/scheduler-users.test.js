'use strict';
// schedulerUsers — the crons iterate PAID users, and only those whose own keys
// resolve. A non-owner without a saved key is skipped (never billed to the
// platform key); the owner falls back to env via providerKeys.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { paidUserIds, usersWithKeys } = require('../lib/schedulerUsers');

const TAG = 'TEST::sched-';
let withKey, withoutKey, unpaid;

function mkUser(tag, paid) {
  const r = db.prepare("INSERT INTO users (email, name, role, password_hash, has_paid) VALUES (?, ?, 'member', ?, ?)")
    .run(`${TAG}${tag}@t.t`, `Sched ${tag}`, bcrypt.hashSync('x', 4), paid ? 1 : 0);
  return r.lastInsertRowid;
}

before(() => {
  withKey = mkUser('withkey', true);
  withoutKey = mkUser('withoutkey', true);
  unpaid = mkUser('unpaid', false);
  // Saved key, plaintext in dev (no SETTINGS_ENC_KEY here) — same as Settings writes.
  db.prepare('INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)')
    .run(withKey, 'api_key_exa', JSON.stringify('test-exa-key'));
});

after(() => {
  for (const id of [withKey, withoutKey, unpaid]) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
});

test('paidUserIds includes paid, excludes unpaid', () => {
  const ids = paidUserIds();
  assert.ok(ids.includes(withKey), 'paid user listed');
  assert.ok(ids.includes(withoutKey), 'paid user listed');
  assert.ok(!ids.includes(unpaid), 'unpaid user excluded');
});

test('usersWithKeys only returns users whose keys resolve', () => {
  const ids = usersWithKeys('exa').map((u) => u.id);
  assert.ok(ids.includes(withKey), 'user with saved key runs');
  assert.ok(!ids.includes(withoutKey), 'paid user without key is skipped, not failed');
  assert.ok(!ids.includes(unpaid), 'unpaid user never runs');
});
