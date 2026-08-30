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

// ── THE BASE MOVED (2026-08-30) ──
// Danny scoped Stu to `appxd2l3BXJAdTWSQ` ("Superior Studios Ecosystem"). The base
// Stu had always read, `appfE9DVrSUOrkkpu`, is the one his team has since renamed
// "[OLD] Superior Studios Ecosystem" — and the two credentials are disjoint: the
// old PAT can see only the old base, the new PAT only the new one. So this was not
// a permission widening, it was a cutover, and there is no window where both work.
//
// It is also NOT a base-id swap. The old base was an ADMISSIONS funnel keyed on
// founder name, with one combined `Admission Status` ("Stage 3: Evaluating
// (Investment + Resident)"). The new base is an INVESTMENT CRM keyed on company,
// and it splits that single axis into two orthogonal ones — `Investment Status`
// and `Resident Status` — with a `Pipeline Stage` formula composing them. Every
// field name Stu read also changed. lib/airtableVocab carries the new vocabulary;
// services/airtable-import carries the new field names.
const DEFAULT_BASE_ID = 'appxd2l3BXJAdTWSQ';

const BASE_ID = (process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID).trim();

// Every table Stu reads or writes, named. Verbatim from the live base schema
// (re-read 2026-08-30 via the meta/tables endpoint, which is why the comments
// carry row-shape rather than guesses).
const TABLE = {
  // The funnel AND the deal board, in one table. The old base kept these apart
  // (Founder Ecosystem + Investment Pipeline, joined by hand); here one row is a
  // company with both a Resident Status and an Investment Status. FOUNDERS and
  // DEALS are kept as aliases so existing call sites read naturally, but they are
  // deliberately the SAME id — there is no second table to drift from.
  PIPELINE: 'tbl9MulpgagFUmNQf',          // Pipeline — 205 rows, primary field "Company / Founder"
  FOUNDERS: 'tbl9MulpgagFUmNQf',          // alias of PIPELINE
  DEALS: 'tbl9MulpgagFUmNQf',             // alias of PIPELINE
  PORTFOLIO: 'tblNTDbEFvNldghAR',         // Portfolio — 8 rows, the executed investments
  PORTFOLIO_UPDATES: 'tblExMxA9WRhSQkCD', // Portfolio Updates — 11 rows
  FOUNDER_ASKS: 'tblOGkUswaHwQgatb',      // Founder Asks — 5 rows, the action board
  ADVISOR_NETWORK: 'tbldAFI0vzfRdFaRm',   // Advisor Network — 11 rows
  INVESTOR_NETWORK: 'tblgbIBQyFeDDBCbF',  // Investor Network — 99 rows
};

// ── TABLES THAT NO LONGER EXIST ──
// The old base carried `Talent Database` (tblyt6dR0VIVuk5yg) and `Master Contacts`
// (tblN8XIy0s5oOqWAL); pipeline/hiring-warm.js read both to build the warm pool.
// The authorized base has NEITHER. Naming them here — rather than deleting the
// knowledge — is what lets hiring-warm fail with "the warm-pool tables are not in
// the authorized base" instead of a bare 404 nobody can diagnose. It also stops a
// future reader from "restoring" them as TABLE entries and issuing requests for
// tables that are not there.
const ABSENT_TABLES = {
  TALENT: 'Talent Database — not present in appxd2l3BXJAdTWSQ (was tblyt6dR0VIVuk5yg in the old base)',
  MASTER_CONTACTS: 'Master Contacts — not present in appxd2l3BXJAdTWSQ (was tblN8XIy0s5oOqWAL in the old base)',
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
  BASE_ID, DEFAULT_BASE_ID, TABLE, ABSENT_TABLES, API_KEY,
  isConfigured, recordsUrl, recordUrl, authHeaders,
};
