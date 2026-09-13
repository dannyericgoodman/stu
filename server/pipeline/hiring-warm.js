'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-warm.js — the warm pool. Danny's real network, read-only from Airtable.
//
// The VC's edge is warm-before-cold: a person Danny already knows always outranks
// an equal stranger. This module builds that pool from two Airtable tables in the
// Superior base (appfE9DVrSUOrkkpu, the same base + key services/airtable-import.js
// already uses):
//   · Talent Database (tblyt6dR0VIVuk5yg)   — First/Last, LinkedIn, One-Line Bio,
//       Function(s), and "Joined Database Via" (the provenance).
//   · Master Contacts (tblN8XIy0s5oOqWAL)   — Full Name, LinkedIn, Bio. (Empty today;
//       wired read-only so it flows the moment it fills.)
//
// ── THE WARMTH RULE (Danny's call, and the honest one) ──
// The Talent Database has 469 rows, but ~460 carry "Joined Database Via: Talent
// Engine" — that is the OLD engine's own output, written back to Airtable. It is NOT
// a relationship, and importing it as "warm network" would launder a machine's guess
// into a personal connection — the exact dishonesty this whole product refuses. So a
// row is warm ONLY if its provenance is a real touchpoint (an event). "Talent Engine"
// rows are skipped entirely; they are not imported here at all. Cold inventory comes
// from GitHub discovery (Phase 4), earned on the spot, not from the frozen database.
//
// READ-ONLY, always. This module never writes to Airtable — it only reads.
// ══════════════════════════════════════════════════════════════════════════

const https = require('https');
const db = require('../db');
const { verifyIlTie } = require('../lib/ilTie');

// Base and table ids come from lib/airtableBase, not from a literal re-typed here.
const { TABLE, ABSENT_TABLES, BASE_ID, recordsUrl } = require('../lib/airtableBase');

// ══════════════════════════════════════════════════════════════════════════
// THE WARM SOURCE IS GONE, AND THIS MODULE HAD NO IDEA.
//
// The 2026-08-30 base cutover moved Stu from `appfE9DVrSUOrkkpu` to
// `appxd2l3BXJAdTWSQ`, and the new base has NEITHER Talent Database nor Master
// Contacts. lib/airtableBase recorded that correctly — it moved both ids out of
// TABLE and into ABSENT_TABLES, precisely so a reader would fail with a sentence
// instead of a 404.
//
// This file kept reading `TABLE.TALENT`. That is now `undefined`, so every warm
// import called `recordsUrl(undefined)` and died inside assertKnownTable:
//
//   Warm import failed: [airtableBase] Refusing to build a URL for unknown
//   table "undefined". Add it to TABLE in lib/airtableBase.js if it is
//   genuinely part of Stu's scope.
//
// A 500 carrying a message about editing a source file is not an error a user can
// act on, and the advice in it is wrong: the table is not missing from TABLE by
// oversight, it is missing from the BASE. Adding it back would issue requests for
// a table that does not exist.
//
// Why no test caught it: test/hiring-warm.test.js injects deps.fetchTable, so the
// table ids are never resolved in test. The unit tests all pass against a source
// that cannot be reached. There is now a test that resolves the ids themselves.
//
// So: resolve the ids ONCE, here, and report their absence as a fact about the
// base rather than as a crash. The 16 warm rows already in SQLite are untouched —
// a dead refresh button must not also look like an empty pool.
// ══════════════════════════════════════════════════════════════════════════
const TALENT_DB = TABLE.TALENT || null;
const MASTER_CONTACTS = TABLE.MASTER_CONTACTS || null;

// Which warm tables this base actually has. Empty = the pool has no live source.
function availableTables() {
  return [
    { id: TALENT_DB, key: 'TALENT', label: 'Talent Database', map: mapTalentRow, source: 'airtable_talent_db' },
    { id: MASTER_CONTACTS, key: 'MASTER_CONTACTS', label: 'Master Contacts', map: mapMasterRow, source: 'airtable_master_contacts' },
  ].filter((t) => !!t.id);
}

// The message a human can act on, built from what airtableBase already knows.
function absentTablesError() {
  const missing = ['TALENT', 'MASTER_CONTACTS']
    .filter((k) => !TABLE[k])
    .map((k) => ABSENT_TABLES[k] || k);
  return `The warm-pool tables are not in the authorized Airtable base (${BASE_ID}). ${missing.join(' ')} `
    + `Nothing was changed — the warm candidates already in Stu are intact. `
    + `To restore refreshes, add a talent table to the authorized base and register it in lib/airtableBase.js, `
    + `or build the warm pool from the Network module instead.`;
}

// A row is warm only if its provenance is a real touchpoint. Everything the old
// engine wrote back carries this exact string — the one value we exclude.
const NOT_WARM_PROVENANCE = /talent engine/i;

// Airtable Function(s) → the canonical function vocabulary the matcher speaks.
const FUNCTION_MAP = {
  'eng': 'engineering', 'data/ai': 'data', 'product': 'product', 'design': 'design',
  'sales/bd': 'gtm', 'marketing': 'marketing', 'finance/bizops': 'finance',
  'ops': 'ops', 'other': 'other',
};
function mapFunctions(fns) {
  const arr = Array.isArray(fns) ? fns : (fns ? [fns] : []);
  const out = [];
  for (const f of arr) {
    const k = String(f).toLowerCase().trim();
    const mapped = FUNCTION_MAP[k] || 'other';
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

// Airtable's free-text LinkedIn field is messy: trailing spaces, missing scheme,
// bare "linkedin.com/xxx". Normalize so dedup works and the link opens.
function normLinkedIn(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  s = s.replace(/\s+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}

// ── Airtable REST fetch (field values keyed by NAME, the default). Paginated. ──
// Mirrors services/airtable-import.js — same base, same key, read-only GET.
function fetchTable(tableId, apiKey) {
  return new Promise((resolve, reject) => {
    const rows = [];
    function page(offset) {
      const url = recordsUrl(tableId, { pageSize: 100, offset: offset || undefined });
      https.get(url, { headers: { Authorization: `Bearer ${apiKey}` } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Airtable ${tableId} HTTP ${res.statusCode}: ${b.slice(0, 200)}`));
          let data; try { data = JSON.parse(b); } catch { return reject(new Error('Airtable non-JSON')); }
          rows.push(...(data.records || []));
          if (data.offset) page(data.offset);
          else resolve(rows);
        });
      }).on('error', reject);
    }
    page(null);
  });
}

// Attach an IL-tie receipt from whatever profile text we have — but only if
// verifyIlTie actually confirms it. A warm contact with no verifiable Illinois
// evidence imports with a blank tie (honest), not a guessed one.
function ilTieFrom(...parts) {
  const text = parts.filter(Boolean).join(' • ');
  const v = verifyIlTie(text);
  if (v.verified && !v.weak) return { il_tie_type: v.type, il_tie_place: v.place, il_tie_evidence: v.evidence };
  return { il_tie_type: null, il_tie_place: null, il_tie_evidence: null };
}

// Map one Talent Database record → a warm candidate row (or null to skip).
function mapTalentRow(rec) {
  const f = rec.fields || {};
  const via = f['Joined Database Via'] || '';
  if (!via || NOT_WARM_PROVENANCE.test(via)) return null; // old-engine writeback / no provenance → not warm
  const name = [f['First Name'], f['Last Name']].filter(Boolean).join(' ').trim();
  if (!name) return null;
  const bio = f['One Line Bio'] || null;
  const conn = f['Superior Connection'] || null;
  return {
    name,
    headline: bio,
    linkedin_url: normLinkedIn(f['LinkedIn']),
    email: f['Email'] || null,
    role_function: JSON.stringify(mapFunctions(f['Function(s)'])),
    tier: 'warm',
    source: 'airtable_talent_db',
    warm_source: String(via).replace(/^event\s*-\s*/i, '').trim() || 'Superior network',
    superior_connection: conn,
    external_id: rec.id,
    ...ilTieFrom(bio, conn),
    raw_data: JSON.stringify(f),
  };
}

// Map one Master Contacts record → a warm candidate row.
function mapMasterRow(rec) {
  const f = rec.fields || {};
  const name = String(f['Full Name'] || '').trim();
  if (!name) return null;
  const bio = f['Bio'] || null;
  return {
    name,
    headline: bio,
    linkedin_url: normLinkedIn(f['LinkedIn']),
    email: f['Email'] || null,
    role_function: JSON.stringify([]),
    tier: 'warm',
    source: 'airtable_master_contacts',
    warm_source: 'Master Contact',
    superior_connection: null,
    external_id: rec.id,
    ...ilTieFrom(bio),
    raw_data: JSON.stringify(f),
  };
}

// Upsert a warm candidate by (user_id, external_id). Re-import refreshes the row
// (a bio edited in Airtable flows through) without duplicating. Returns 'inserted'
// | 'updated'. Deliberately does NOT touch is_deleted — if Danny trashed a warm
// candidate, a re-import shouldn't silently resurrect it.
const UPSERT_COLS = [
  'name', 'headline', 'linkedin_url', 'email', 'role_function', 'tier', 'source',
  'warm_source', 'superior_connection', 'il_tie_type', 'il_tie_place', 'il_tie_evidence', 'raw_data',
];
function upsert(userId, row) {
  const existing = db.prepare('SELECT id FROM hiring_candidates WHERE user_id = ? AND external_id = ?').get(userId, row.external_id);
  if (existing) {
    const sets = UPSERT_COLS.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE hiring_candidates SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...UPSERT_COLS.map((c) => row[c] ?? null), existing.id);
    return 'updated';
  }
  const cols = ['user_id', 'external_id', ...UPSERT_COLS];
  const vals = [userId, row.external_id, ...UPSERT_COLS.map((c) => row[c] ?? null)];
  db.prepare(`INSERT INTO hiring_candidates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  return 'inserted';
}

/**
 * Import the warm pool from Airtable into hiring_candidates.
 * @param apiKey   Airtable key (defaults to env; owner-billed, read-only).
 * @param deps     { fetchTable } injectable for tests.
 * @returns { inserted, updated, skipped, il_tied, sources } — counts reported, never silent.
 */
async function importWarmPool({ userId = 1, apiKey = process.env.AIRTABLE_API_KEY, deps = {} } = {}) {
  if (!apiKey) return { error: 'No AIRTABLE_API_KEY configured — warm import needs the Superior base key.' };
  const fetch = deps.fetchTable || fetchTable;

  // No live warm table in this base → say so, and change nothing. This is a stated
  // fact about the base, not a failure to retry, so it returns `error` + `code`
  // rather than throwing: the route answers 400 with a sentence, and the existing
  // warm rows stay exactly as they are.
  const tables = deps.tables || availableTables();
  if (!tables.length) {
    return { error: absentTablesError(), code: 'warm_source_absent', inserted: 0, updated: 0, skipped: 0, il_tied: 0, sources: {} };
  }

  const out = { inserted: 0, updated: 0, skipped: 0, il_tied: 0, sources: {} };
  const tally = (src, res, row) => {
    out[res]++;
    out.sources[src] = out.sources[src] || { inserted: 0, updated: 0 };
    out.sources[src][res]++;
    if (row.il_tie_type) out.il_tied++;
  };

  // Each table is best-effort and reported by name. One table erroring must not
  // discard the rows another already imported, and must not be silent either —
  // a warm refresh that half-worked has to say which half.
  let considered = 0;
  for (const t of tables) {
    let recs = [];
    try { recs = await fetch(t.id, apiKey); }
    catch (e) {
      out.errors = out.errors || {};
      out.errors[t.label] = e.message;
      continue;
    }
    considered += recs.length;
    for (const rec of recs) {
      const row = t.map(rec);
      if (!row) { out.skipped++; continue; }
      tally(t.source, upsert(userId, row), row);
    }
  }

  // Log the run so a warm refresh is auditable alongside match/discovery runs.
  try {
    const errNote = out.errors ? ` — errors: ${Object.entries(out.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '';
    db.prepare(`INSERT INTO hiring_runs (user_id, kind, warm_considered, summary) VALUES (?, 'warm_import', ?, ?)`)
      .run(userId, considered,
        `warm import: ${out.inserted} new, ${out.updated} refreshed, ${out.skipped} skipped (not warm), ${out.il_tied} with IL tie${errNote}`);
  } catch { /* run-log failure must never break the import */ }

  return out;
}

module.exports = {
  importWarmPool, mapTalentRow, mapMasterRow, mapFunctions, normLinkedIn, ilTieFrom, FUNCTION_MAP,
  availableTables, absentTablesError,
};
