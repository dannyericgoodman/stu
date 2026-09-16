'use strict';
// Airtable owner-gate — the team's shared base is written only by the owner.
//
// publish-to-team's whole job is writing to the team base, so a non-owner gets
// a 403 (nothing to fall back to). watch/stage degrade to Stu-local changes with
// airtable.skipped = 'not_owner' — covered by inspection of the call sites, which
// pin `isOwner(req.user.id)` at the write.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const TAG = 'TEST::atgate-';
let app, server, base, outsiderId, founderId;

before(async () => {
  const r = db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, 'Airtable Gate', 'member', ?)")
    .run(`${TAG}@t.t`, bcrypt.hashSync('x', 4));
  outsiderId = r.lastInsertRowid;
  founderId = db.prepare("INSERT INTO founders (name, created_by, is_deleted) VALUES (?, ?, 0)")
    .run(`${TAG} Founder`, outsiderId).lastInsertRowid;

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user']) }; next(); });
  app.use('/api/founders', require('../routes/founders'));
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}/api/founders`;
});

after(() => {
  db.prepare('DELETE FROM founders WHERE name LIKE ?').run(`${TAG}%`);
  db.prepare('DELETE FROM users WHERE id = ?').run(outsiderId);
  server.close();
});

test('non-owner gets 403 on publish-to-team', async () => {
  const res = await fetch(`${base}/${founderId}/publish-to-team`, {
    method: 'POST',
    headers: { 'x-test-user': String(outsiderId) },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /owner/i);
});

test('central gate: explicit but non-owner is refused at the sync layer', async () => {
  const airtableSync = require('../services/airtable-sync');
  const founder = db.prepare('SELECT * FROM founders WHERE id = ?').get(founderId);
  // Even with explicit: true, a non-owner userId cannot reach Airtable.
  const r = await airtableSync.pushStage(founder, '4 · Watching', { explicit: true, userId: outsiderId });
  assert.equal(r.skipped, 'not_owner');
  // Missing userId fails closed too.
  const r2 = await airtableSync.pushStage(founder, '4 · Watching', { explicit: true });
  assert.equal(r2.skipped, 'not_owner');
});

test('central gate: owner passes the gate (no Airtable record → next check)', async () => {
  const airtableSync = require('../services/airtable-sync');
  const founder = db.prepare('SELECT * FROM founders WHERE id = ?').get(founderId);
  const r = await airtableSync.pushStage(founder, '4 · Watching', { explicit: true, userId: 1 });
  // Gate passed; the founder just has no Airtable record id in this fixture.
  assert.equal(r.skipped, 'no_airtable_record');
});
