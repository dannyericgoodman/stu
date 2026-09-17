'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The personal ledger (2026-09-17).
//
// Danny: "keep Airtable as my always on team record and Pipeline as a ledger
// of founders I've seen in inbox that I like that goes from Stage 1:
// Identified to Stage 2: Outreach Sent to Stage 3: Meeting Set
// Stage 4a: Add to Investment Pipeline or Stage 4b: Pass"
//
// The contract under test:
//   1. Exactly five stages, defined once, and the server rejects anything else.
//   2. Stages 1–3 and 4b are Stu-local: no Airtable write, ever.
//   3. Stage 4a is the ONLY publish-to-team action: it writes the founder to
//      the team's Airtable base as Under Consideration, and it asks nothing
//      else to do it. Non-owners are gated out.
//   4. "Add to Pipeline" from Source lands at Stage 1, privately.
//   5. The backfill seeds only his inbox picks — never the team's book.
//
// Real sqlite (scratch file), real routers, real HTTP. Airtable is stubbed at
// the service boundary and asserts on how it was called, because "no Airtable
// write" is the whole point and must be observed, not assumed.
// ══════════════════════════════════════════════════════════════════════════
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DB_FILE = '/tmp/stu-ledger-test.db';
try { fs.unlinkSync(DB_FILE); } catch { /* fresh */ }
process.env.DATABASE_PATH = DB_FILE;

const express = require('express');
const db = require('../db');
const ledgerStages = require('../lib/ledgerStages');
const airtableSync = require('../services/airtable-sync');
const pipelineRouter = require('../routes/pipeline');
const sourcingRouter = require('../routes/sourcing');

// ── Airtable spy ──
// Any call is recorded. Tests assert the call count to prove "no write".
const airtableCalls = [];
const realCreate = airtableSync.createPipelineRecord;
const realPush = airtableSync.pushStage;
airtableSync.createPipelineRecord = async (founder, opts) => {
  airtableCalls.push({ op: 'create', founderId: founder.id, opts });
  return { created: true, recordId: 'recTEST123', stage: opts?.investmentStatus };
};
airtableSync.pushStage = async (founder, stage, opts) => {
  airtableCalls.push({ op: 'push', founderId: founder.id, stage, opts });
  return { pushed: true, stage };
};

let baseUrl;
let currentUser = null;
let server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/sourcing', sourcingRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Two users: the owner (Danny) and a paying seat. isOwner reads the role.
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', 'x')")
    .run('owner@test.dev', 'Owner');
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'member', 'x')")
    .run('seat@test.dev', 'Seat');
});

after(() => { if (server) server.close(); });

function asUser(email) {
  currentUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  assert.ok(currentUser, `test user ${email} exists`);
}

async function api(method, url, body) {
  const r = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

function mkFounder(over = {}) {
  const r = db.prepare(`
    INSERT INTO founders (name, company, created_by, ledger_stage, stage_status, sourced_from_id, is_deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    over.name || 'Test Founder', over.company || 'TestCo',
    over.created_by ?? 1,
    over.ledger_stage ?? null,
    over.stage_status ?? null,
    over.sourced_from_id ?? null,
    over.is_deleted ?? 0,
  );
  return r.lastInsertRowid;
}

// ── 1. The five stages ──────────────────────────────────────────────────
test('the ledger has exactly the five stages Danny named', () => {
  assert.deepStrictEqual(ledgerStages.LEDGER_STAGE_KEYS,
    ['identified', 'outreach', 'meeting', 'invest_pipeline', 'pass']);
  const labels = Object.fromEntries(ledgerStages.LEDGER_STAGES.map((s) => [s.key, s.label]));
  assert.strictEqual(labels.identified, 'Stage 1: Identified');
  assert.strictEqual(labels.outreach, 'Stage 2: Outreach Sent');
  assert.strictEqual(labels.meeting, 'Stage 3: Meeting Set');
  assert.strictEqual(labels.invest_pipeline, 'Stage 4a: Investment Pipeline');
  assert.strictEqual(labels.pass, 'Stage 4b: Pass');
  assert.ok(ledgerStages.isLedgerStage('identified'));
  assert.ok(!ledgerStages.isLedgerStage('Watching'));
  assert.ok(!ledgerStages.isLedgerStage('4 · Watching'));
  assert.ok(!ledgerStages.isLedgerStage(''));
  assert.ok(!ledgerStages.isLedgerStage(null));
});

// ── 2. The backfill seeds only his picks ────────────────────────────────
test('backfill: inbox picks and Watching land at Stage 1; the team book and deleted rows do not', () => {
  // Extract the actual backfill SQL from db.js — this test runs the shipped
  // statement, not a copy of it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const m = src.match(/DEFERRED_BACKFILLS\.push\(`\s*UPDATE founders SET ledger_stage = 'identified'[\s\S]*?;\s*`\)/);
  assert.ok(m, 'the ledger backfill statement exists in db.js');

  const inboxPick = mkFounder({ sourced_from_id: 99 });
  const watched = mkFounder({ stage_status: '4 · Watching' });
  const teamRow = mkFounder({ stage_status: '3 · Under Consideration', airtable_founder_record_id: 'recX' });
  db.prepare('UPDATE founders SET airtable_founder_record_id = ? WHERE id = ?').run('recX', teamRow);
  const deletedPick = mkFounder({ sourced_from_id: 100, is_deleted: 1 });
  const already = mkFounder({ sourced_from_id: 101, ledger_stage: 'meeting' });

  db.exec(m[0].replace(/DEFERRED_BACKFILLS\.push\(`([\s\S]*)`\)/, '$1'));
  // …and a second run must change nothing (idempotent: every boot replays it).
  db.exec(m[0].replace(/DEFERRED_BACKFILLS\.push\(`([\s\S]*)`\)/, '$1'));

  const stageOf = (id) => db.prepare('SELECT ledger_stage FROM founders WHERE id = ?').get(id).ledger_stage;
  assert.strictEqual(stageOf(inboxPick), 'identified');
  assert.strictEqual(stageOf(watched), 'identified');
  assert.strictEqual(stageOf(teamRow), null, 'a team-base row is not his pick');
  assert.strictEqual(stageOf(deletedPick), null, 'deleted rows stay out');
  assert.strictEqual(stageOf(already), 'meeting', 'an existing stage is never overwritten');
});

// ── 3. The ledger read ──────────────────────────────────────────────────
test('GET /ledger returns only ledger members, with the stage vocabulary', async () => {
  asUser('owner@test.dev');
  const mine = mkFounder({ name: 'Ledger One', company: 'L1', ledger_stage: 'identified', created_by: currentUser.id });
  mkFounder({ name: 'Not Mine', company: 'NM', ledger_stage: null, created_by: currentUser.id });
  mkFounder({ name: 'Deleted', company: 'D', ledger_stage: 'identified', created_by: currentUser.id, is_deleted: 1 });

  const { status, json } = await api('GET', '/api/pipeline/ledger');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(json.stages.map((s) => s.key),
    ['identified', 'outreach', 'meeting', 'invest_pipeline', 'pass']);
  const ids = json.rows.map((r) => r.id);
  assert.ok(ids.includes(mine), 'ledger member is listed');
  assert.ok(!json.rows.some((r) => r.company === 'NM'), 'non-member is excluded');
  assert.ok(!json.rows.some((r) => r.company === 'D'), 'deleted is excluded');
});

// ── 4. Private moves never touch Airtable ───────────────────────────────
test('private drags (1→2→3) write the ledger column only — no Airtable call', async () => {
  asUser('owner@test.dev');
  const id = mkFounder({ ledger_stage: 'identified', stage_status: null, created_by: currentUser.id });
  airtableCalls.length = 0;

  for (const next of ['outreach', 'meeting']) {
    const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: next });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.ledger_stage, next);
  }
  assert.strictEqual(airtableCalls.length, 0, 'no Airtable call on private moves');
  const row = db.prepare('SELECT ledger_stage, stage_status FROM founders WHERE id = ?').get(id);
  assert.strictEqual(row.ledger_stage, 'meeting');
  assert.strictEqual(row.stage_status, null, 'the mirror column is untouched');
});

test('an invalid stage is rejected and changes nothing', async () => {
  asUser('owner@test.dev');
  const id = mkFounder({ ledger_stage: 'identified', created_by: currentUser.id });
  const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: 'Watching' });
  assert.strictEqual(status, 400);
  assert.deepStrictEqual(json.allowed, ['identified', 'outreach', 'meeting', 'invest_pipeline', 'pass']);
  assert.strictEqual(db.prepare('SELECT ledger_stage FROM founders WHERE id = ?').get(id).ledger_stage, 'identified');
});

// ── 5. Pass (4b) is a verdict, still private ────────────────────────────
test('4b Pass records the triage verdict and never publishes', async () => {
  asUser('owner@test.dev');
  const id = mkFounder({ ledger_stage: 'meeting', created_by: currentUser.id });
  airtableCalls.length = 0;

  const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: 'pass' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ledger_stage, 'pass');
  assert.strictEqual(airtableCalls.length, 0, 'no Airtable call on a pass');
  const triage = db.prepare('SELECT verdict FROM founder_triage WHERE founder_id = ? AND user_id = ?')
    .get(id, currentUser.id);
  assert.strictEqual(triage?.verdict, 'pass');
});

// ── 6. Stage 4a: the publish-to-team action ─────────────────────────────
test('4a as a non-owner moves the ledger but is gated out of Airtable', async () => {
  asUser('seat@test.dev');
  const id = mkFounder({ ledger_stage: 'meeting', created_by: currentUser.id });
  airtableCalls.length = 0;

  const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: 'invest_pipeline' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ledger_stage, 'invest_pipeline');
  assert.strictEqual(json.airtable.skipped, 'not_owner');
  assert.strictEqual(airtableCalls.length, 0, 'a paying seat never writes the team base');
});

test('4a as the owner publishes to Airtable as Under Consideration', async () => {
  asUser('owner@test.dev');
  const id = mkFounder({ name: 'Publish Me', company: 'PM', ledger_stage: 'meeting', created_by: currentUser.id });
  airtableCalls.length = 0;

  const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: 'invest_pipeline' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ledger_stage, 'invest_pipeline');
  assert.strictEqual(airtableCalls.length, 1, 'exactly one Airtable write');
  assert.strictEqual(airtableCalls[0].op, 'create');
  assert.strictEqual(airtableCalls[0].opts.investmentStatus, 'Under Consideration');
  assert.strictEqual(airtableCalls[0].opts.explicit, true);
  const row = db.prepare('SELECT airtable_founder_record_id FROM founders WHERE id = ?').get(id);
  assert.strictEqual(row.airtable_founder_record_id, 'recTEST123', 'the link back is recorded');
});

test('4a on a founder the team already has pushes the stage instead of duplicating', async () => {
  asUser('owner@test.dev');
  const id = mkFounder({ name: 'Known', company: 'K', ledger_stage: 'outreach', created_by: currentUser.id });
  db.prepare('UPDATE founders SET airtable_founder_record_id = ? WHERE id = ?').run('recKNOWN', id);
  airtableCalls.length = 0;

  const { status, json } = await api('PATCH', `/api/pipeline/${id}/ledger-stage`, { stage: 'invest_pipeline' });
  assert.strictEqual(status, 200);
  assert.strictEqual(airtableCalls.length, 1);
  assert.strictEqual(airtableCalls[0].op, 'push');
  assert.strictEqual(airtableCalls[0].stage, '3 · Under Consideration');
  const row = db.prepare('SELECT airtable_founder_record_id FROM founders WHERE id = ?').get(id);
  assert.strictEqual(row.airtable_founder_record_id, 'recKNOWN', 'no second record created');
});

// ── 7. Source "Add to Pipeline" ─────────────────────────────────────────
test('watch from Source lands at Stage 1, privately — no Airtable publish', async () => {
  asUser('owner@test.dev');
  const s = db.prepare(`
    INSERT INTO sourced_founders (user_id, name, company, source, status, list_scope)
    VALUES (?, 'Inbox Founder', 'InboxCo', 'Test', 'pending', 'pipeline')
  `).run(currentUser.id);
  airtableCalls.length = 0;

  const { status, json } = await api('POST', `/api/sourcing/watch/${s.lastInsertRowid}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ledger_stage, 'identified');
  assert.strictEqual(json.stage_status, null, 'no Airtable-stage lie on a private row');
  assert.strictEqual(json.airtable.skipped, 'ledger_is_personal');
  assert.strictEqual(airtableCalls.length, 0, 'the inbox click no longer publishes');
  const st = db.prepare('SELECT status FROM sourced_founders WHERE id = ?').get(s.lastInsertRowid).status;
  assert.strictEqual(st, 'watching', 'the inbox pointer still advances');
});

test('approve from Source also lands at Stage 1', async () => {
  asUser('owner@test.dev');
  const s = db.prepare(`
    INSERT INTO sourced_founders (user_id, name, company, source, status, list_scope)
    VALUES (?, 'Approve Founder', 'ApproveCo', 'Test', 'pending', 'pipeline')
  `).run(currentUser.id);

  const { status, json } = await api('POST', `/api/sourcing/approve/${s.lastInsertRowid}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ledger_stage, 'identified');
});
