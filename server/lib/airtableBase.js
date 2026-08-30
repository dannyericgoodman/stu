'use strict';
// ══════════════════════════════════════════════════════════════════════════
// WHICH Airtable — the base, the tables, and the only two URL builders.
//
// Not the same job as lib/airtableVocab. That file owns Airtable's VALUES (stage
// names, track names, field ids) — what the strings mean. This owns the ADDRESS —
// which base and which table those strings live in. They were tangled because
// airtableVocab declared BASE_ID under a header calling itself "the ONLY copy,"
// while five other files declared the same literal independently.
//
// ── WHY THIS EXISTS ──
// `appfE9DVrSUOrkkpu` was written out by hand in six files: airtableVocab,
// airtable-import, airtable-sync, hiring-warm, migrate-from-airtable, and
// backfill-airtable-ids. Two of those WRITE to Airtable — the team's shared,
// hand-maintained base. Six independent copies of a write target is six chances
// for one of them to point somewhere nobody audited, and no way to answer "what
// base does Stu touch?" except by grepping and trusting the grep.
//
// Danny scoped this explicitly: Stu gets access to ONE named base and no other.
// A scope like that has to be enforceable in one place or it isn't a scope, it's
// a hope. test/airtable-base.test.js fails if any file under server/ builds an
// api.airtable.com URL or writes a base/table id literal outside this module.
//
// ── ENV-OVERRIDABLE ON PURPOSE ──
// AIRTABLE_BASE_ID repoints every reader and writer at once. That is the whole
// migration path if the team moves bases: set one variable, restart, done — no
// code change, and no possibility of moving four call sites and forgetting the
// fifth. The default stays the base Stu has always used, so an unset env is not
// a behavior change.
//
// The table ids are NOT env-overridable. They're only meaningful relative to a
// specific base, so exposing them as independent knobs would let a half-applied
// override point a table id from one base at another — silent, and worse than
// the duplication this replaces. Moving bases means re-reading the schema and
// editing TABLE here, deliberately.
// ══════════════════════════════════════════════════════════════════════════

const DEFAULT_BASE_ID = 'appfE9DVrSUOrkkpu';

const BASE_ID = (process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID).trim();

// Every table Stu reads or writes, named. Verbatim from the live base schema
// (re-read 2026-08-30 via the meta/tables endpoint, which is why the comments
// carry row-shape rather than guesses).
const TABLE = {
  FOUNDERS: 'tblWkJzy5qpw7FP2M',        // Superior Founder Ecosystem — the funnel
  DEALS: 'tblCWTVyowHgp4YuR',           // Investment Pipeline
  TALENT: 'tblyt6dR0VIVuk5yg',          // Talent Database — hiring-warm's warm pool
  MASTER_CONTACTS: 'tblN8XIy0s5oOqWAL', // Master Contacts
};

// The API key lives here too, so "is Airtable configured at all" is one question
// with one answer instead of five modules each reading process.env and each
// deciding on its own what missing means.
const API_KEY = process.env.AIRTABLE_API_KEY || null;
function isConfigured() { return Boolean(API_KEY); }

function assertKnownTable(tableId) {
  const known = Object.values(TABLE);
  if (!known.includes(tableId)) {
    // Deliberately fatal rather than a warning. The alternative is issuing a
    // request against an unreviewed table in a base Danny's team maintains by
    // hand, which is exactly the blast radius this module exists to bound.
    throw new Error(
      `[airtableBase] Refusing to build a URL for unknown table "${tableId}". ` +
      `Add it to TABLE in lib/airtableBase.js if it is genuinely part of Stu's scope.`
    );
  }
}

/**
 * URL for a table's records (list/create). `params` is a plain object appended
 * as the query string.
 */
function recordsUrl(tableId, params = {}) {
  assertKnownTable(tableId);
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
}

/** URL for one record (read/update/delete). */
function recordUrl(tableId, recordId) {
  assertKnownTable(tableId);
  return new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recordId}`);
}

/** Auth header, in one place so no call site hand-rolls the Bearer prefix. */
function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, ...extra };
}

module.exports = {
  BASE_ID, DEFAULT_BASE_ID, TABLE, API_KEY,
  isConfigured, recordsUrl, recordUrl, authHeaders,
};
