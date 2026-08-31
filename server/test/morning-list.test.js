'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The morning list must show who arrived last night.
//
// Danny: "I don't need the newly sourced founders to be emailed to me. If they
// could just appear on Stu's homepage every morning that's fine." They could not,
// for two reasons that are independent — fixing either alone still leaves a
// homepage that never shows a new founder, so both are pinned here.
//
//  1. TIMING. job_runs.ran_at is written when the scout FINISHES, after it has
//     inserted its founders. `created_at >= lastRun` is therefore false for every
//     row that run added. This is the bug that made `new_today` permanently 0 and
//     the "new" badge dead UI — both of which shipped correct and were simply
//     never handed a true value.
//
//  2. RANKING. Ten slots ordered by tier → priority over a pool that only drains
//     when Danny dispositions someone. On the real 932-row database: 82 eligible,
//     17 must-meet, and 9 of the 10 rows on screen sourced on one day six weeks
//     earlier. A new founder had to out-rank the 17th incumbent to be seen.
//
// Both tests below fail against the original implementation.
// ══════════════════════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { pickShortlist, newBoundary } = require('../lib/morningList');

function db0() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sourced_founders(
      id INTEGER PRIMARY KEY, user_id INT, name TEXT, status TEXT,
      do_not_resurface INT DEFAULT 0, list_scope TEXT DEFAULT 'pipeline',
      fit_meet INT DEFAULT 1, fit_stage_late INT DEFAULT 0,
      fit_tier TEXT, fit_priority INT, created_at TEXT);
    CREATE TABLE job_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, job TEXT,
      status TEXT, detail TEXT, ran_at DATETIME);
  `);
  return db;
}

const addFounder = (db, name, tier, priority, created_at, over = {}) =>
  db.prepare(
    `INSERT INTO sourced_founders(user_id,name,status,fit_tier,fit_priority,created_at,
       list_scope,fit_meet,fit_stage_late,do_not_resurface)
     VALUES (1,?,'pending',?,?,?,?,?,?,?)`
  ).run(name, tier, priority, created_at,
    over.list_scope ?? 'pipeline', over.fit_meet ?? 1,
    over.fit_stage_late ?? 0, over.do_not_resurface ?? 0);

const addRun = (db, ran_at, status = 'ok') =>
  db.prepare(`INSERT INTO job_runs(user_id,job,status,ran_at) VALUES (1,'nightly_scout',?,?)`)
    .run(status, ran_at);

const names = (db, ids) => ids.map((id) =>
  db.prepare('SELECT name FROM sourced_founders WHERE id = ?').get(id).name);

// ── 1. The timing bug, reproduced exactly as production creates it ──

test('a founder inserted BEFORE the run that recorded it still counts as new', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');            // yesterday's list
  // Last night's scout: rows land at 04:31, the job row is written at 04:35.
  addFounder(db, 'Arrived last night', 'strong', 5, '2026-08-30 04:31:00');
  addRun(db, '2026-08-30 04:35:00');

  const { isNew, ids } = pickShortlist(db, 1, 10);
  const id = ids[0];
  assert.strictEqual(names(db, [id])[0], 'Arrived last night');
  assert.strictEqual(isNew(id), true,
    'created_at (04:31) precedes its own run row (04:35) — comparing against the latest ' +
    'run marks every freshly sourced founder as old, which is why new_today was always 0');
});

test('a founder from the previous cycle is not new', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  addFounder(db, 'Seen yesterday', 'strong', 5, '2026-08-29 04:31:00');
  addRun(db, '2026-08-30 04:35:00');

  const { isNew, ids } = pickShortlist(db, 1, 10);
  assert.strictEqual(isNew(ids[0]), false, 'he already saw this one on yesterday morning list');
});

test('a missed night widens the window instead of dropping the arrivals', () => {
  const db = db0();
  addRun(db, '2026-08-28 04:35:00');
  addFounder(db, 'Sourced the 29th', 'strong', 5, '2026-08-29 04:31:00');
  addFounder(db, 'Sourced the 30th', 'strong', 5, '2026-08-30 04:31:00');
  addRun(db, '2026-08-30 04:35:00');           // the 29th never ran

  const { isNew, ids } = pickShortlist(db, 1, 10);
  assert.deepStrictEqual(ids.map(isNew), [true, true],
    'if the scout skips a night, the next morning must still show what it missed');
});

test('errored runs do not define the boundary', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00', 'ok');
  addRun(db, '2026-08-30 04:35:00', 'error');   // showed him nothing
  const boundary = newBoundary(db, 1);
  assert.ok(boundary < '2026-08-29 04:35:01',
    'a run that failed before inserting anything never showed a list, so it cannot ' +
    'be the line between seen and unseen');
});

// ── 2. The ranking bug, at the real shape of the data ──

test('new arrivals appear even when out-ranked by a wall of incumbents', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  // The measured production shape: 17 must-meet incumbents for 10 slots.
  for (let i = 0; i < 17; i++) {
    addFounder(db, `Incumbent ${i}`, 'must-meet', 100 - i, '2026-07-15 17:00:00');
  }
  // Last night's find: real, gated, and lower-ranked than all 17.
  addFounder(db, 'Sourced last night', 'strong', 5, '2026-08-30 04:31:00');
  addRun(db, '2026-08-30 04:35:00');

  const { ids, isNew } = pickShortlist(db, 1, 10);
  const shown = names(db, ids);
  assert.ok(shown.includes('Sourced last night'),
    'ordering by tier then priority alone can never surface a new founder while ' +
    '17 must-meet incumbents sit above 10 slots and nothing dispositions them');
  assert.strictEqual(shown.length, 10, 'the list stays capped');
  assert.strictEqual(ids.filter(isNew).length, 1);
});

test('arrivals lead the list, backlog fills the rest', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  for (let i = 0; i < 10; i++) addFounder(db, `Old ${i}`, 'must-meet', 50 - i, '2026-07-15 17:00:00');
  addFounder(db, 'New A', 'strong', 9, '2026-08-30 04:31:00');
  addFounder(db, 'New B', 'strong', 8, '2026-08-30 04:31:00');
  addRun(db, '2026-08-30 04:35:00');

  const shown = names(db, pickShortlist(db, 1, 10).ids);
  assert.deepStrictEqual(shown.slice(0, 2), ['New A', 'New B'],
    'a morning list is read top-down and abandoned early — new goes where it is seen');
  assert.strictEqual(shown.length, 10);
  assert.strictEqual(new Set(shown).size, 10, 'no founder occupies two slots');
});

test('reserved slots are capped at half the list', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  for (let i = 0; i < 40; i++) addFounder(db, `New ${i}`, 'strong', 10, '2026-08-30 04:31:00');
  for (let i = 0; i < 10; i++) addFounder(db, `Old ${i}`, 'must-meet', 99, '2026-07-15 17:00:00');
  addRun(db, '2026-08-30 04:35:00');

  const shown = names(db, pickShortlist(db, 1, 10).ids);
  assert.strictEqual(shown.filter((n) => n.startsWith('New')).length, 5,
    'a noisy night must not evict the entire standing list');
  assert.strictEqual(shown.filter((n) => n.startsWith('Old')).length, 5);
});

// ── 3. Nothing else moved ──

test('with no arrivals the list is exactly the old ranked backlog', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  addRun(db, '2026-08-30 04:35:00');
  addFounder(db, 'Top', 'must-meet', 30, '2026-07-15 17:00:00');
  addFounder(db, 'Mid', 'must-meet', 20, '2026-07-15 17:00:00');
  addFounder(db, 'Low', 'strong', 90, '2026-07-15 17:00:00');

  const { ids, isNew } = pickShortlist(db, 1, 10);
  assert.deepStrictEqual(names(db, ids), ['Top', 'Mid', 'Low'],
    'tier outranks priority, exactly as before');
  assert.strictEqual(ids.filter(isNew).length, 0);
});

test('the quality gates still apply to new arrivals', () => {
  const db = db0();
  addRun(db, '2026-08-29 04:35:00');
  addFounder(db, 'New but not meet-worthy', 'strong', 9, '2026-08-30 04:31:00', { fit_meet: 0 });
  addFounder(db, 'New but late stage', 'strong', 9, '2026-08-30 04:31:00', { fit_stage_late: 1 });
  addFounder(db, 'New but dismissed', 'strong', 9, '2026-08-30 04:31:00', { do_not_resurface: 1 });
  addFounder(db, 'New but talent scope', 'strong', 9, '2026-08-30 04:31:00', { list_scope: 'talent' });
  addFounder(db, 'New and eligible', 'strong', 9, '2026-08-30 04:31:00');
  addRun(db, '2026-08-30 04:35:00');

  assert.deepStrictEqual(names(db, pickShortlist(db, 1, 10).ids), ['New and eligible'],
    'being new buys a slot in the ranking, never an exemption from the gates');
});
