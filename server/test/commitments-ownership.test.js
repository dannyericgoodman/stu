'use strict';
// commitments.close is owner-scoped — a user can only close their own rows.
// Without the created_by predicate, any authenticated user could close anyone's
// commitments; the route now passes req.user.id and the lib throws otherwise.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const db = require('../db');
const commitments = require('../lib/commitments');

const TAG = 'TEST::close-';
let alice, bob, cid;

before(() => {
  for (const [tag, holder] of [[`${TAG}a@t.t`, 'a'], [`${TAG}b@t.t`, 'b']]) {
    const r = db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'member', ?)")
      .run(tag, `Close ${holder}`, bcrypt.hashSync('x', 4));
    if (holder === 'a') alice = r.lastInsertRowid; else bob = r.lastInsertRowid;
  }
  cid = commitments.record({
    owedBy: 'me', commitment: `${TAG} ship the thing`, quote: `${TAG} I will ship it`,
    statedAt: '2026-09-16', createdBy: alice,
  }).id;
});

after(() => {
  db.prepare(`DELETE FROM commitments WHERE commitment LIKE '${TAG}%'`).run();
  for (const id of [alice, bob]) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
});

test('close without a userId throws', () => {
  assert.throws(() => commitments.close(cid, 'kept', null), /requires a userId/);
});

test("bob cannot close alice's commitment", () => {
  assert.throws(() => commitments.close(cid, 'kept', null, bob), /not found/);
  const row = db.prepare('SELECT status FROM commitments WHERE id = ?').get(cid);
  assert.equal(row.status, 'open', 'row untouched');
});

test('alice can close her own commitment', () => {
  commitments.close(cid, 'kept', null, alice);
  const row = db.prepare('SELECT status FROM commitments WHERE id = ?').get(cid);
  assert.equal(row.status, 'kept');
});
