'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateManualAdd, findDuplicate, markExemplar, insertManualAdd } = require('../lib/manualAdd');

const TIES = ['current', 'working', 'school_alumni', 'hometown', 'chicago_company'];

// Minimal stub db: records prepares, returns canned rows.
function stubDb({ dupBySlug = null, dupByName = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        get: (...args) => {
          if (sql.includes('LOWER(linkedin_url) LIKE')) return dupBySlug;
          if (sql.includes('LOWER(TRIM(name))')) return dupByName;
          if (sql.includes('WHERE id = ?')) return { id: 42, name: args[0] && 'X', company: null, status: 'pending' };
          return undefined;
        },
        run: (...args) => { calls.push(['run', args.slice(0, 3)]); return { lastInsertRowid: 42 }; },
      };
    },
  };
}

test('validate: name is required', () => {
  assert.strictEqual(validateManualAdd({}, { validTieTypes: TIES }).error, 'name is required');
  assert.strictEqual(validateManualAdd({ name: '  ' }, { validTieTypes: TIES }).error, 'name is required');
});

test('validate: tier and tie enums are enforced', () => {
  assert.match(validateManualAdd({ name: 'A', caliber_tier: 'Z' }, { validTieTypes: TIES }).error, /caliber_tier/);
  assert.match(validateManualAdd({ name: 'A', location_type: 'moon' }, { validTieTypes: TIES }).error, /location_type/);
  const ok = validateManualAdd({ name: 'A', caliber_tier: 'a', location_type: 'current' }, { validTieTypes: TIES });
  assert.ok(!ok.error);
  assert.strictEqual(ok.clean.caliber_tier, 'A');
});

test('validate: signal columns must be string arrays, JSON-encoded on success', () => {
  assert.match(validateManualAdd({ name: 'A', tags: 'nope' }, { validTieTypes: TIES }).error, /tags/);
  assert.match(validateManualAdd({ name: 'A', tags: [1] }, { validTieTypes: TIES }).error, /tags/);
  const ok = validateManualAdd({ name: 'A', tags: ['fintech', 'chicago'], caliber_signals: ['Repeat founder'] }, { validTieTypes: TIES });
  assert.ok(!ok.error);
  assert.strictEqual(ok.clean.tags, JSON.stringify(['fintech', 'chicago']));
  assert.strictEqual(ok.clean.caliber_signals, JSON.stringify(['Repeat founder']));
  assert.strictEqual(ok.clean.pedigree_signals, null);
});

test('validate: urls normalized, linkedin slug extracted', () => {
  const { clean } = validateManualAdd(
    { name: 'A', linkedin_url: 'linkedin.com/in/ashtynabell/', website_url: 'gil.com' },
    { validTieTypes: TIES }
  );
  assert.strictEqual(clean.linkedin_url, 'https://linkedin.com/in/ashtynabell/');
  assert.strictEqual(clean.linkedin_slug, 'ashtynabell');
  assert.strictEqual(clean.website_url, 'https://gil.com');
});

test('findDuplicate: linkedin slug match blocks re-adding regardless of status', () => {
  const db = stubDb({ dupBySlug: { id: 7, name: 'Ashtyn Bell', company: 'Gil', status: 'dismissed' } });
  const { clean } = validateManualAdd({ name: 'Ashtyn Bell', linkedin_url: 'https://www.linkedin.com/in/ashtynabell/' }, { validTieTypes: TIES });
  const dup = findDuplicate(db, clean, 1);
  assert.strictEqual(dup.id, 7);
  // name+company query must NOT run once the slug hit — one prepare only
  assert.strictEqual(db.calls.length, 1);
});

test('findDuplicate: falls back to normalized name+company', () => {
  const db = stubDb({ dupByName: { id: 9, name: 'Sid Sinha', company: 'Avant Health', status: 'starred' } });
  const { clean } = validateManualAdd({ name: 'Sid Sinha', company: 'Avant Health' }, { validTieTypes: TIES });
  const dup = findDuplicate(db, clean, 1);
  assert.strictEqual(dup.id, 9);
});

test('findDuplicate: returns null when clean', () => {
  const db = stubDb();
  const { clean } = validateManualAdd({ name: 'New Person', company: 'NewCo' }, { validTieTypes: TIES });
  assert.strictEqual(findDuplicate(db, clean, 1), null);
});

test('insertManualAdd: writes source=manual, status pending, returns the row', () => {
  const db = stubDb();
  const { clean } = validateManualAdd(
    { name: 'Ashtyn Bell', company: 'Gil', linkedin_url: 'https://www.linkedin.com/in/ashtynabell/', tags: ['fintech'] },
    { validTieTypes: TIES }
  );
  const row = insertManualAdd(db, clean, 1);
  assert.strictEqual(row.id, 42);
  assert.strictEqual(row.status, 'pending');
  const insertSql = db.calls.find((c) => typeof c === 'string' && c.includes('INSERT INTO sourced_founders'));
  assert.ok(insertSql.includes("'manual'") && insertSql.includes("'pending'"), 'must hard-code source and status');
});

// Static guard: the route must delegate to the lib (validation, dedup, insert) and
// must not invent its own status/source values.
test('route delegates to manualAdd lib', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sourcing.js'), 'utf8');
  const add = src.slice(src.indexOf("router.post('/add'"), src.indexOf("router.post('/run'"));
  assert.ok(/validateManualAdd/.test(add), 'route must validate via the lib');
  assert.ok(/findDuplicate/.test(add), 'route must dedup via the lib');
  assert.ok(/insertManualAdd/.test(add), 'route must insert via the lib');
  assert.ok(/markExemplar/.test(add), 'route must upgrade the exemplar flag on a dedup hit');
});

// Static guards: exemplars are taste models, never prospects. They stay starred
// for learning but must be invisible on prospect surfaces.
test('exemplars are excluded from prospect surfaces', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sourcing.js'), 'utf8');
  const starred = src.slice(src.indexOf("router.get('/starred'"));
  assert.ok(/is_exemplar/.test(starred), 'starred-for-review must exclude exemplars');
  const stats = src.slice(src.indexOf("router.get('/stats'"));
  assert.ok(/is_exemplar/.test(stats), 'stats starred count must exclude exemplars');
});

test('validate: is_exemplar defaults to 0, truthy values become 1', () => {
  assert.strictEqual(validateManualAdd({ name: 'A' }, { validTieTypes: TIES }).clean.is_exemplar, 0);
  assert.strictEqual(validateManualAdd({ name: 'A', is_exemplar: true }, { validTieTypes: TIES }).clean.is_exemplar, 1);
  assert.strictEqual(validateManualAdd({ name: 'A', is_exemplar: 'yes' }, { validTieTypes: TIES }).clean.is_exemplar, 0);
});

test('markExemplar: upgrades an existing row to exemplar', () => {
  const db = stubDb({ dupByName: { id: 7, name: 'Jensen Coonradt', company: 'Crebit', status: 'starred', is_exemplar: 0 } });
  const { clean } = validateManualAdd({ name: 'Jensen Coonradt', is_exemplar: true }, { validTieTypes: TIES });
  const dup = findDuplicate(db, clean, 1);
  assert.strictEqual(dup.is_exemplar, 0);
  const row = markExemplar(db, dup.id);
  assert.strictEqual(row.id, 42); // stub returns the re-selected row
  const updateSql = db.calls.find((c) => typeof c === 'string' && c.includes('SET is_exemplar = 1'));
  assert.ok(updateSql, 'must flag the row as exemplar');
});
