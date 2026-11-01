'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { VALID_TIE_TYPES } = require('../pipeline/sourcing-engine');

// Mirror the exact WHERE the queue route applies: status + user + verified tie.
const TIE_CLAUSE = `location_type IN (${VALID_TIE_TYPES.map(() => '?').join(',')})`;

function seed() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE sourced_founders(id INTEGER PRIMARY KEY, name TEXT, user_id INT, status TEXT, location_type TEXT)");
  const ins = db.prepare("INSERT INTO sourced_founders(name, user_id, status, location_type) VALUES (?,1,'pending',?)");
  ins.run('Current Chicagoan', 'current');
  ins.run('Works in Chicago', 'working');
  ins.run('Northwestern alum', 'school_alumni');
  ins.run('Grew up here', 'hometown');
  ins.run('Chicago company', 'chicago_company');
  ins.run('No tie at all', 'none');     // should be hidden
  ins.run('Null tie', null);            // should be hidden
  ins.run('Empty tie', '');             // should be hidden
  ins.run('Bogus value', 'maybe');      // should be hidden
  return db;
}

test('Pipeline queue shows ONLY founders with a verified Chicago/IL tie', () => {
  const db = seed();
  const rows = db.prepare(`SELECT name FROM sourced_founders WHERE status='pending' AND user_id=? AND ${TIE_CLAUSE}`)
    .all(1, ...VALID_TIE_TYPES);
  const names = rows.map(r => r.name).sort();
  assert.deepStrictEqual(names, ['Chicago company', 'Current Chicagoan', 'Grew up here', 'Northwestern alum', 'Works in Chicago']);
});

test('unclear / missing ties are hidden (none, null, empty, bogus)', () => {
  const db = seed();
  const hidden = db.prepare(`SELECT name FROM sourced_founders WHERE status='pending' AND user_id=? AND NOT (${TIE_CLAUSE})`)
    .all(1, ...VALID_TIE_TYPES);
  // NOT IN excludes NULL by SQL semantics, so count null separately.
  const total = db.prepare('SELECT COUNT(*) c FROM sourced_founders').get().c;
  const shown = db.prepare(`SELECT COUNT(*) c FROM sourced_founders WHERE ${TIE_CLAUSE}`).get(...VALID_TIE_TYPES).c;
  assert.strictEqual(shown, 5, 'exactly the 5 valid-tie rows are shown');
  assert.strictEqual(total - shown, 4, 'the 4 unclear rows are all hidden');
  assert.ok(!hidden.map(r => r.name).includes('Current Chicagoan'));
});

test('VALID_TIE_TYPES is the canonical set and excludes none/empty', () => {
  // Both vocabularies: the sweep's legacy one and lib/ilTie's (2026-11 inspection —
  // connector rows typed worked/school/cofounder were invisible to TIE_CLAUSE).
  assert.deepStrictEqual([...VALID_TIE_TYPES].sort(),
    ['chicago_company', 'cofounder', 'current', 'hometown', 'school', 'school_alumni', 'worked', 'working']);
  assert.ok(!VALID_TIE_TYPES.includes('mention'), 'a bare "Illinois" mention is never a verified tie');
  assert.ok(!VALID_TIE_TYPES.includes('none'));
  assert.ok(!VALID_TIE_TYPES.includes(''));
});
