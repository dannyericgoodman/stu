'use strict';
// ══════════════════════════════════════════════════════════════════════════
// VC-sourcing MCP tools, positioned for ANY VC (stealth→growth, any sector,
// any region): get_outreach_list, get_sourced_founder, the tier / illinois_tie
// / stage / region / sector filters on search_sourced_founders, and the pure
// matchers in lib/vcFilters.
//
// Fully hermetic: every query runs against an in-memory database injected via
// dbOverride. Requiring the server modules opens the existing dev database file
// read-mostly (the repo's own test convention), but no test row is ever written
// there. The in-memory DB is closed explicitly at the end, which finalizes
// prepared statements and dodges the better-sqlite3 v11 / Node 24 teardown
// flake on this repo.
// ══════════════════════════════════════════════════════════════════════════

const { test, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const sourcing = require('../mcp/sourcingData');
const talent = require('../mcp/talentData');
const scope = require('../lib/sourcingScope');
const vc = require('../lib/vcFilters');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE sourced_founders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INT, name TEXT, company TEXT, company_one_liner TEXT, role TEXT,
    headline TEXT, linkedin_url TEXT, github_url TEXT, location_city TEXT,
    caliber_tier TEXT, caliber_score INT, unicorn_score INT, enrichment TEXT,
    confidence_score INT, affinity_score INT, pedigree_signals TEXT,
    builder_signals TEXT, caliber_signals TEXT, tags TEXT,
    departure_recency_months INT, github_activity_score INT,
    chicago_connection TEXT, location_type TEXT, list_scope TEXT,
    status TEXT DEFAULT 'pending', is_exemplar INT DEFAULT 0,
    raw_data TEXT, enriched_data TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
after(() => {
  // Finalize every prepared statement while the V8 isolate is still alive:
  // better-sqlite3 v11 on Node 24 aborts at process exit if a Statement is
  // GC'd after env teardown (RemoveEnvironmentCleanupHook assertion). Closing
  // both handles (the hermetic memdb AND the dev DB opened read-mostly by
  // require('../db') via talentData) plus a forced GC makes the exit clean.
  // Run with `node --expose-gc` for the gc() calls to take effect.
  db.close();
  try { require('../db').close(); } catch { /* never fail the suite on cleanup */ }
  if (global.gc) { global.gc(); global.gc(); }
});

const IL_TIE = 'Based in Chicago, IL — verified';

const add = (over = {}) => db.prepare(`INSERT INTO sourced_founders
  (user_id, name, company, company_one_liner, role, headline, linkedin_url,
   caliber_tier, caliber_score, confidence_score, affinity_score, location_type,
   chicago_connection, list_scope, status, is_exemplar, location_city, tags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  over.user_id ?? 1,
  over.name ?? 'Unnamed',
  over.company ?? 'Acme',
  over.company_one_liner ?? 'Early stage venture',
  over.role ?? 'Founder',
  over.headline ?? 'Founder',
  over.linkedin_url ?? 'https://linkedin.com/in/x',
  over.caliber_tier ?? 'A',
  over.caliber_score ?? 5,
  over.confidence_score ?? 7,
  over.affinity_score ?? 50,
  over.location_type ?? null,
  over.chicago_connection ?? null,
  over.list_scope ?? 'pipeline',
  over.status ?? 'pending',
  over.is_exemplar ?? 0,
  over.location_city ?? null,
  over.tags ?? null,
).lastInsertRowid;

const ilTie = (over = {}) => ({ location_type: 'current', chicago_connection: IL_TIE, location_city: 'Chicago, IL', ...over });

// ── Seed: discriminating rows for the general-VC filters ──
const idSTop = add(ilTie({ name: 'S IL Pre', affinity_score: 90, confidence_score: 9, caliber_tier: 'S',
  headline: 'Co-founder, pre-seed AI — stealth mode, ex-Uber', tags: '["ai"]' }));
add(ilTie({ name: 'S IL 2', caliber_tier: 'S', affinity_score: 10, confidence_score: 5 }));
add(ilTie({ name: 'A IL', caliber_tier: 'A', affinity_score: 80, confidence_score: 8 }));
add(ilTie({ name: 'B IL', caliber_tier: 'B' }));
add({ name: 'S SF AI Seed', caliber_tier: 'S', affinity_score: 50, location_city: 'San Francisco, CA',
  headline: 'Co-founder — seed-stage AI startup for sales teams', tags: '["ai"]' });
add({ name: 'A NYC Fintech A', caliber_tier: 'A', affinity_score: 40, location_city: 'New York, NY',
  headline: 'Founder — raised $8M Series A, payments platform', tags: '["fintech"]' });
add({ name: 'S Austin Stealth', caliber_tier: 'S', affinity_score: 30, location_city: 'Austin, TX',
  headline: 'Stealth devtools founder, ex-Cloudflare', tags: '["devtools"]' });
add({ name: 'A Growth Health', caliber_tier: 'A', affinity_score: 20, location_city: 'Boston, MA',
  headline: 'CEO — Series C digital health, 400 employees', tags: '["health"]' });
add({ name: 'S Watchlist', caliber_tier: 'S', affinity_score: 60, list_scope: 'watchlist',
  location_city: 'Austin, TX', chicago_connection: 'Based in Austin, TX' });
add({ name: 'S Exemplar', caliber_tier: 'S', is_exemplar: 1 });
add({ name: 'S Dismissed', caliber_tier: 'S', status: 'dismissed' });
add({
  name: 'S Late IL', caliber_tier: 'S', affinity_score: 95, confidence_score: 9,
  headline: 'Co-founder & CEO — just raised $12M Series B, 150 employees, building in Chicago',
  ...ilTie({}),
});
const idOther = add({ name: 'S Other User', caliber_tier: 'S', user_id: 2 });

const names = (rows) => rows.map((r) => r.name);
const outreach = (userId, opts) => sourcing.getOutreachList(userId, opts, db);
const search = (userId, opts) => talent.searchSourcedFounders(userId, opts, db);
const detail = (userId, id) => sourcing.getSourcedFounder(userId, id, db);

// ── lib/sourcingScope unit ──
test('caliberFloor: minimum-tier semantics', () => {
  assert.deepStrictEqual(scope.caliberFloor('S'), ['S']);
  assert.deepStrictEqual(scope.caliberFloor('A'), ['S', 'A']);
  assert.deepStrictEqual(scope.caliberFloor('B'), ['S', 'A', 'B']);
  assert.deepStrictEqual(scope.caliberFloor('C'), ['S', 'A', 'B', 'C']);
  assert.deepStrictEqual(scope.caliberFloor('a'), ['S', 'A']); // case-insensitive
  assert.strictEqual(scope.caliberFloor('zzz'), null);
  assert.strictEqual(scope.caliberFloor(null), null);
});

test('outreachTiers: minimum caliber, legacy S+A accepted', () => {
  assert.deepStrictEqual(sourcing.outreachTiers('S'), ['S']);
  assert.deepStrictEqual(sourcing.outreachTiers('A'), ['S', 'A']);
  assert.deepStrictEqual(sourcing.outreachTiers('S+A'), ['S', 'A']); // legacy
  assert.deepStrictEqual(sourcing.outreachTiers('B'), ['S', 'A', 'B']);
  assert.deepStrictEqual(sourcing.outreachTiers('bogus'), ['S', 'A']); // safe default
});

// ── lib/vcFilters: pure matchers, no DB ──
test('vcFilters: region matching against location_city and headline', () => {
  assert.ok(vc.matchRegion({ location_city: 'San Francisco, CA' }, 'sf-bay'));
  assert.ok(vc.matchRegion({ location_city: 'Palo Alto' }, 'sf-bay'));
  assert.ok(!vc.matchRegion({ location_city: 'Austin, TX' }, 'sf-bay'));
  assert.ok(vc.matchRegion({ headline: 'Building in stealth in Brooklyn' }, 'nyc'));
  assert.ok(vc.matchRegion({ location_city: 'Remote' }, 'remote'));
  assert.ok(vc.matchRegion({ location_city: 'Denver, CO' }, 'denver'), 'unknown slug → keyword fallback');
  assert.ok(!vc.matchRegion({ location_city: 'Denver, CO' }, 'sf-bay'));
  assert.ok(!vc.matchRegion({}, 'sf-bay'), 'no location evidence → no match');
});

test('vcFilters: sector matching prefers tags, falls back to keywords', () => {
  assert.ok(vc.matchSector({ tags: '["ai"]' }, 'ai'));
  assert.ok(vc.matchSector({ tags: ['fintech'] }, 'fintech'));
  assert.ok(vc.matchSector({ headline: 'Founder, payments platform' }, 'fintech'));
  assert.ok(!vc.matchSector({ headline: 'Coffee shop owner' }, 'ai'));
  assert.ok(vc.matchSector({ headline: 'Quantum computing founder' }, 'quantum'), 'unknown slug → keyword fallback');
  assert.ok(!vc.matchSector({}, 'ai'), 'no evidence → no match');
});

test('vcFilters: stage detection never invents a stage', () => {
  assert.deepStrictEqual(vc.detectStages({ headline: 'Stealth startup, pre-seed' }).sort(), ['pre-seed', 'stealth']);
  const preseed = vc.detectStages({ headline: 'pre-seed AI founder' });
  assert.ok(preseed.includes('pre-seed') && !preseed.includes('seed'), 'pre-seed is not seed');
  assert.ok(vc.detectStages({ headline: 'raised a $2M seed round' }).includes('seed'));
  assert.ok(vc.detectStages({ headline: 'raised $8M Series A' }).includes('series-a'));
  assert.ok(vc.detectStages({ headline: 'Series C, 400 employees' }).includes('growth'));
  assert.deepStrictEqual(vc.detectStages({ headline: 'Founder' }), [], 'no evidence → no stage');
  assert.ok(vc.matchStage({ headline: 'Stealth devtools founder' }, 'stealth'));
  assert.ok(!vc.matchStage({ headline: 'Founder' }, 'seed'));
});

test('vcFilters: vcTextFilters combines stage+region+sector, null when empty', () => {
  assert.strictEqual(vc.vcTextFilters({}), null);
  const f = vc.vcTextFilters({ stage: 'seed', region: 'sf-bay', sector: 'ai' });
  assert.ok(f({ location_city: 'San Francisco, CA', headline: 'seed-stage AI startup', tags: '["ai"]' }));
  assert.ok(!f({ location_city: 'Austin, TX', headline: 'seed-stage AI startup', tags: '["ai"]' }));
  const multi = vc.vcTextFilters({ region: ['sf-bay', 'nyc'] });
  assert.ok(multi({ location_city: 'New York, NY' }));
  assert.ok(!multi({ location_city: 'Austin, TX' }));
});

// ── get_outreach_list: national default ──
test('outreach default: national scope — untied, watchlist, and late-stage rows included; quality bar S/A', () => {
  assert.deepStrictEqual(names(outreach(1, {})), [
    'S Late IL', 'S IL Pre', 'S Watchlist', 'S SF AI Seed', 'S Austin Stealth',
    'S IL 2', 'A IL', 'A NYC Fintech A', 'A Growth Health',
  ]);
});

test('outreach default still excludes exemplar, dismissed, B-tier, other-user rows', () => {
  const n = names(outreach(1, { limit: 25 }));
  for (const bad of ['S Exemplar', 'S Dismissed', 'B IL', 'S Other User']) {
    assert.ok(!n.includes(bad), `should exclude ${bad}`);
  }
});

test("outreach tier 'S': S-tier only; tier 'B' adds B-tier", () => {
  assert.ok(names(outreach(1, { tier: 'S', limit: 25 })).every((n) => n.startsWith('S ')));
  assert.ok(names(outreach(1, { tier: 'B', limit: 25 })).includes('B IL'));
});

test("outreach preset 'illinois-preseed': Danny's lens — IL pipeline, S/A, earliest-stage", () => {
  assert.deepStrictEqual(names(outreach(1, { preset: 'illinois-preseed' })), ['S IL Pre', 'S IL 2', 'A IL']);
  const n = names(outreach(1, { preset: 'illinois-preseed', limit: 25 }));
  for (const bad of ['S Watchlist', 'S SF AI Seed', 'S Late IL', 'B IL']) {
    assert.ok(!n.includes(bad), `preset should exclude ${bad}`);
  }
});

test('outreach preset can be overridden explicitly', () => {
  // excludeLate is on in the preset; an explicit false brings the late IL founder back.
  const n = names(outreach(1, { preset: 'illinois-preseed', excludeLate: false, limit: 25 }));
  assert.ok(n.includes('S Late IL'));
});

test('outreach region filter', () => {
  assert.deepStrictEqual(names(outreach(1, { region: 'sf-bay' })), ['S SF AI Seed']);
  assert.deepStrictEqual(names(outreach(1, { region: 'austin' })), ['S Watchlist', 'S Austin Stealth']);
});

test('outreach sector filter', () => {
  assert.deepStrictEqual(names(outreach(1, { sector: 'ai' })), ['S IL Pre', 'S SF AI Seed']);
  assert.deepStrictEqual(names(outreach(1, { sector: 'fintech' })), ['A NYC Fintech A']);
});

test('outreach stage filter', () => {
  assert.deepStrictEqual(names(outreach(1, { stage: 'seed' })), ['S SF AI Seed']);
  assert.deepStrictEqual(names(outreach(1, { stage: 'series-a' })), ['A NYC Fintech A']);
  assert.deepStrictEqual(names(outreach(1, { stage: 'growth' })), ['S Late IL', 'A Growth Health']);
  assert.deepStrictEqual(names(outreach(1, { stage: 'stealth' })), ['S IL Pre', 'S Austin Stealth']);
});

test('outreach excludeLate:true drops past-earliest rows nationally', () => {
  const n = names(outreach(1, { excludeLate: true, limit: 25 }));
  for (const late of ['S Late IL', 'A NYC Fintech A', 'A Growth Health']) {
    assert.ok(!n.includes(late), `excludeLate should drop ${late}`);
  }
  assert.ok(n.includes('S SF AI Seed'), 'earliest-stage rows survive');
});

test('outreach illinois_tie:true gates to the verified-tie pipeline', () => {
  const n = names(outreach(1, { illinois_tie: true, limit: 25 }));
  assert.ok(n.includes('S IL Pre'));
  assert.ok(!n.includes('S SF AI Seed'), 'untied national row excluded');
  assert.ok(!n.includes('S Watchlist'), 'watchlist excluded from tie pipeline');
});

test('outreach limit is honored and rows are compact with the fit verdict', () => {
  assert.strictEqual(outreach(1, { limit: 1 }).length, 1);
  const [row] = outreach(1, { limit: 1 });
  assert.deepStrictEqual(Object.keys(row).sort(), [
    'caliber_tier', 'chicago_connection', 'company', 'company_one_liner',
    'confidence_score', 'fit', 'id', 'linkedin_url', 'location_city', 'name',
  ].sort());
  assert.deepStrictEqual(Object.keys(row.fit).sort(), ['meetWorthy', 'priority', 'stage', 'why'].sort());
  assert.ok(Array.isArray(row.fit.why));
});

// ── get_sourced_founder ──
test('get_sourced_founder: full detail for own row', () => {
  const f = detail(1, idSTop);
  assert.ok(f);
  assert.strictEqual(f.name, 'S IL Pre');
  assert.strictEqual(f.caliber_tier, 'S');
  assert.ok(f.fit && typeof f.fit.meetWorthy === 'boolean');
  assert.ok(Array.isArray(f.fit.why));
  assert.ok('stageTooLate' in f.fit);
});

test("get_sourced_founder: other user's row and missing id → null", () => {
  assert.strictEqual(detail(1, idOther), null);
  assert.strictEqual(detail(1, 999999), null);
  assert.ok(detail(2, idOther), 'owner can still read their own row');
});

// ── search_sourced_founders: new filters ──
test("search tier 'A' means S+A (excludes B)", () => {
  const n = names(search(1, { tier: 'A', limit: 50 }));
  assert.ok(n.includes('S IL Pre') && n.includes('A IL'));
  assert.ok(!n.includes('B IL'));
});

test('search region / sector / stage filters', () => {
  assert.deepStrictEqual(names(search(1, { region: 'nyc' })), ['A NYC Fintech A']);
  assert.deepStrictEqual(names(search(1, { sector: 'devtools' })), ['S Austin Stealth']);
  assert.deepStrictEqual(names(search(1, { stage: 'growth', limit: 50 })).sort(), ['A Growth Health', 'S Late IL']);
  assert.deepStrictEqual(names(search(1, { stage: 'seed', region: 'sf-bay', sector: 'ai' })), ['S SF AI Seed']);
});

test('search illinois_tie keeps the IL pipeline, drops untied + watchlist', () => {
  const n = names(search(1, { illinois_tie: true, limit: 50 }));
  assert.ok(n.includes('S IL Pre'));
  assert.ok(!n.includes('S SF AI Seed'), 'untied row excluded');
  assert.ok(!n.includes('S Watchlist'), 'watchlist row excluded from pipeline scope');
});

test('search without new filters is unchanged (back-compat)', () => {
  const n = names(search(1, { query: 'IL', limit: 50 }));
  assert.ok(n.includes('S IL Pre') && n.includes('A IL') && n.includes('B IL'));
  assert.ok(n.includes('S IL 2') && n.includes('S Late IL'));
});

test('search stays user-scoped with the new filters', () => {
  const n = names(search(1, { tier: 'S', region: 'sf-bay', limit: 50 }));
  assert.ok(!n.includes('S Other User'));
});
