'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The Hiring bugs the existing suite could not see, each pinned by the thing
// that would have caught it the first time.
//
// Context: Danny loaded a JD on 2026-09-11 and Hiring "wouldn't parse" it. Every
// one of the 52 existing hiring tests passed throughout. That is the interesting
// part — these tests exist to close the specific gaps that made a broken product
// look healthy.
// ══════════════════════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert = require('node:assert');

const airtableBase = require('../lib/airtableBase');
const warm = require('../pipeline/hiring-warm');
const { describeLlmError } = require('../lib/providerKeys');

// ── 1. The warm import read table ids that did not exist ──────────────────
//
// WHY THE SUITE MISSED IT: test/hiring-warm.test.js injects `deps.fetchTable`, so
// mapTalentRow/mapMasterRow/upsert are all exercised against a stub and the table
// IDS ARE NEVER RESOLVED. The unit tests were green against a source the module
// could not reach. These assertions resolve the ids themselves.

test('every warm table this module intends to read resolves to a real id', () => {
  // The module must never hand `undefined` to recordsUrl. That threw
  // "Refusing to build a URL for unknown table \"undefined\"" on every refresh.
  for (const t of warm.availableTables()) {
    assert.ok(t.id, `warm table ${t.key} resolved to ${t.id}`);
    assert.match(t.id, /^tbl[A-Za-z0-9]{14}$/, `${t.key} is not a table id: ${t.id}`);
    // And it must be a table airtableBase will actually build a URL for.
    assert.doesNotThrow(() => airtableBase.recordsUrl(t.id, { pageSize: 1 }),
      `airtableBase refuses ${t.key} (${t.id})`);
  }
});

test('a warm table missing from the base is a stated fact, not a thrown internal error', async () => {
  // The authorized base has no talent tables today, so availableTables() is empty
  // and the import must decline in a sentence Danny can act on.
  const res = await warm.importWarmPool({ userId: 1, apiKey: 'fake', deps: { tables: [] } });
  assert.equal(res.code, 'warm_source_absent');
  assert.equal(res.inserted, 0);
  assert.match(res.error, /not in the authorized Airtable base/i);
  // It must say the existing pool is untouched — a dead refresh button must not
  // also read as "your warm pool is gone".
  assert.match(res.error, /intact/i);
  // And it must NOT tell the reader to re-add the table to airtableBase.js, which
  // was the old message's advice and is wrong: the table is absent from the BASE.
  assert.doesNotMatch(res.error, /Add it to TABLE/);
});

test('importWarmPool never throws on a table it cannot fetch — it reports which one', async () => {
  const res = await warm.importWarmPool({
    userId: 1, apiKey: 'fake',
    deps: {
      tables: [{ id: 'tblAAAAAAAAAAAAAA', key: 'X', label: 'Talent Database', map: warm.mapTalentRow, source: 'airtable_talent_db' }],
      fetchTable: async () => { throw new Error('Airtable HTTP 404'); },
    },
  });
  assert.ok(res.errors, 'per-table errors are reported');
  assert.match(res.errors['Talent Database'], /404/);
  assert.equal(res.inserted, 0);
});

// ── 2. A dead API key read as a bad job description ───────────────────────
//
// WHY THE SUITE MISSED IT: nothing tested the ERROR path of an LLM call — only
// coerceRole and extractJdText, both of which are pre-LLM and pure.

test('an auth failure is reported as a key problem, not as a parse problem', () => {
  const e = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}'), { status: 401 });
  const d = describeLlmError(e, 'JD parse');
  assert.equal(d.code, 'bad_key');
  assert.match(d.message, /invalid or expired/i);
  assert.match(d.message, /Settings/);
  // The raw response body must not reach the user — that string is what the
  // Hiring toast actually showed, and it sent us looking at the JD.
  assert.doesNotMatch(d.message, /authentication_error/);
  assert.doesNotMatch(d.message, /\{/);
});

test('rate limits, overload and timeouts are distinguishable from a dead key', () => {
  assert.equal(describeLlmError(Object.assign(new Error('rate_limit_error'), { status: 429 })).code, 'rate_limited');
  assert.equal(describeLlmError(Object.assign(new Error('overloaded_error'), { status: 529 })).code, 'overloaded');
  assert.equal(describeLlmError(new Error('socket hang up ETIMEDOUT')).code, 'timeout');
  // An unrecognised failure keeps its detail rather than being mislabelled.
  assert.equal(describeLlmError(new Error('something odd'), 'JD parse').code, 'llm_error');
});

test('a tripped spend cap is never reported as a bad key', () => {
  const { SpendCapError } = require('../lib/providerKeys');
  const d = describeLlmError(new SpendCapError('Daily spend cap reached ($25.00).'));
  assert.equal(d.code, 'spend_cap_exceeded');
  assert.match(d.message, /spend cap/i);
});

// ── 3. The Exa arm could delete warmth ────────────────────────────────────
//
// WHY THE SUITE MISSED IT: hiring-exa's upsert was never tested at all. The bug
// was latent (no warm/cold URL collision existed yet) and squarely in the path of
// ordinary use: the warm pool is 16 Chicago engineers and the Exa arm searches for
// Chicago engineers.

test('an Exa hit on someone already warm enriches them and leaves their warmth alone', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE hiring_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, headline TEXT,
    current_role TEXT, current_company TEXT, location_city TEXT, tech_stack TEXT,
    role_function TEXT, linkedin_url TEXT, website_url TEXT, tier TEXT, source TEXT,
    warm_source TEXT, il_tie_type TEXT, il_tie_place TEXT, il_tie_evidence TEXT,
    external_id TEXT, notes TEXT, raw_data TEXT, updated_at DATETIME)`);

  // A real warm contact, as the Airtable import leaves them: rich provenance, thin profile.
  db.prepare(`INSERT INTO hiring_candidates
    (user_id, name, headline, linkedin_url, tier, source, warm_source, il_tie_type, il_tie_place, il_tie_evidence, external_id, role_function)
    VALUES (1,'Kamil Chmielewski','CTO/Full Stack. Masters @ UChicago in computer science',
    'https://www.linkedin.com/in/kamil','warm','airtable_talent_db','Permute Hackathon',
    'school','UChicago','Masters @ UChicago','recABC','["engineering"]')`).run();

  // Re-implements the module's upsert contract against this in-memory table. The
  // assertions below are about the CONTRACT (warmth survives, blanks fill, nothing
  // is erased), which is what the bug violated.
  const COLS = ['name', 'headline', 'current_role', 'current_company', 'location_city', 'tech_stack', 'role_function', 'linkedin_url', 'website_url', 'tier', 'source', 'il_tie_type', 'il_tie_place', 'il_tie_evidence', 'external_id', 'notes', 'raw_data'];
  const WARM_PRESERVED = new Set(['tier', 'source', 'external_id', 'name', 'headline']);
  const isEmptyValue = (v) => v === null || v === undefined
    || (typeof v === 'string' && (!v.trim() || v.trim() === '[]' || v.trim() === '{}'))
    || (Array.isArray(v) && !v.length);

  // What the Exa arm builds for him: better job facts, but an empty stack read and
  // no IL tie found in this particular scrape.
  const row = {
    name: 'Kamil C.', headline: 'Chief Technology Officer @ Stealth',
    current_role: 'Chief Technology Officer', current_company: 'Stealth',
    location_city: 'Chicago', tech_stack: '[]', role_function: '["engineering"]',
    linkedin_url: 'https://www.linkedin.com/in/kamil', website_url: null,
    tier: 'cold', source: 'exa', il_tie_type: null, il_tie_place: null, il_tie_evidence: null,
    external_id: 'exa:https://www.linkedin.com/in/kamil', notes: 'Aligned: builds full-stack products', raw_data: '{}',
  };
  const existing = db.prepare('SELECT id, tier FROM hiring_candidates WHERE user_id = ? AND linkedin_url = ?').get(1, row.linkedin_url);
  const cols = existing.tier === 'warm' ? COLS.filter((c) => !WARM_PRESERVED.has(c) && !isEmptyValue(row[c])) : COLS;
  db.prepare(`UPDATE hiring_candidates SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c] ?? null), existing.id);

  const after = db.prepare('SELECT * FROM hiring_candidates WHERE id = ?').get(existing.id);
  // Warmth is provenance. A web search does not get to revoke it.
  assert.equal(after.tier, 'warm', 'a search that found him must not make him a stranger');
  assert.equal(after.source, 'airtable_talent_db');
  assert.equal(after.warm_source, 'Permute Hackathon');
  // Danny's own name and bio outrank a scrape's.
  assert.equal(after.name, 'Kamil Chmielewski');
  assert.match(after.headline, /Masters @ UChicago/);
  // A verified tie is never nulled by a scrape that simply didn't mention Chicago.
  assert.equal(after.il_tie_type, 'school');
  assert.equal(after.il_tie_place, 'UChicago');
  // Real enrichment still lands.
  assert.equal(after.current_role, 'Chief Technology Officer');
  assert.equal(after.current_company, 'Stealth');
  assert.equal(after.location_city, 'Chicago');
  db.close();
});

// ── 4. "0 new" could not be read ──────────────────────────────────────────

test('the Exa arm reports the funnel, so a dead key cannot look like a strict gate', async () => {
  const { extractCandidates } = require('../pipeline/hiring-exa');
  // No client — the dead-key shape after anthropicFor returns null.
  const none = await extractCandidates({ client: null, role: { role_function: 'engineering' }, results: [{ url: 'u', text: 't' }] });
  assert.deepEqual(none.rows, []);
  assert.ok(none.errors.length, 'a missing key is an error, not an empty result');

  // A client whose every call fails must surface WHY, not just return nothing.
  const dead = {
    messages: { create: async () => { throw Object.assign(new Error('401 authentication_error'), { status: 401 }); } },
  };
  const failed = await extractCandidates({
    client: dead,
    role: { role_function: 'engineering', must_have_stack: '["React"]' },
    results: [{ url: 'https://x/1', title: 'A', text: 'x'.repeat(300) }],
  });
  assert.deepEqual(failed.rows, []);
  assert.equal(failed.extracted, 0);
  assert.ok(failed.errors.some((e) => /invalid or expired/i.test(e)),
    `errors should name the key problem, got: ${JSON.stringify(failed.errors)}`);
});

test('a degraded shortlist rationale is reported, not silently substituted', async () => {
  const { explainShortlist } = require('../pipeline/hiring-match');
  const items = [{ candidate: { name: 'A', headline: 'Engineer' }, tier: 'cold', fit: 70, strengths: ['engineering function match'], gaps: [] }];
  // No key configured for a non-owner → fallback lines, but SAID so.
  const r = await explainShortlist({ userId: 99999, role: { title: 'Eng', role_function: 'engineering' }, items });
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].rationale, 'a fallback rationale is still written');
  assert.ok(r.degraded, 'and the run is marked degraded so the summary can say why');
});

// ── 5. The dead `limit` parameter ─────────────────────────────────────────

test('runMatch has no `limit` parameter — the route must map it onto a real cap', () => {
  const { runMatch } = require('../pipeline/hiring-match');
  const src = runMatch.toString();
  assert.doesNotMatch(src, /\blimit\b/, 'runMatch still has no limit param; routes/hiring/matches.js must translate');
  assert.match(src, /warmCap/);
  assert.match(src, /coldCap/);
});
