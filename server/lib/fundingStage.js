'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The funding-round `stage` column — one spelling per stage.
//
// NOT the same axis as lib/airtableVocab. That file owns `admissions_status`
// ("Stage 3: Evaluating (Investment-Only)") — where a founder stands in Danny's
// funnel. This owns `founders.stage` — what round the COMPANY is raising. Two
// different questions that both got called "stage", which is most of why this
// drifted without anyone noticing.
//
// ── WHY THIS EXISTS ──
// Production held BOTH 'Pre-seed' (5,339 rows) and 'Pre-Seed' (84 rows) as
// distinct values. SQLite's = is case-sensitive, so every `WHERE stage =
// 'Pre-seed'` filter and every GROUP BY silently dropped or split those 84 rows.
// Not a crash — just a number quietly 1.5% wrong everywhere, forever.
//
// The 84 came in through services/airtable-import, which passed Airtable's own
// spelling straight through. That sync runs DAILY at 5:45am CT, so normalizing
// the existing rows once would have been undone by the next morning's run. The
// data migration in db.js and the call at the import edge are one fix in two
// places; neither works alone.
//
// ── THE RULE: CANONICALIZE, NEVER INVENT ──
// An unrecognized value passes through UNCHANGED (trimmed). This normalizer only
// ever collapses spellings of stages already in CANONICAL — it does not map
// unknown strings onto a guess. A stage nobody has seen before should show up in
// the data looking strange, so it gets noticed and added here on purpose. Silently
// rewriting it to 'Pre-seed' is exactly the kind of invisible lossy mapping that
// airtableVocab's header warns about.
// ══════════════════════════════════════════════════════════════════════════

// Every spelling the rest of the codebase writes. Sourced by grepping for the
// literals actually passed to founders.stage — db.js's column DEFAULT, the
// AddFounder/FounderDetail/Settings <option> lists, sourcing-engine, and the
// importers. If a new round is added to any of those, add it here too.
const CANONICAL = [
  'Pre-idea',
  'Pre-seed',
  'Bootstrapped / Pre-Raise',
  'Angel',
  'Seed',
  'Series A',
  'Series B+',
];

// lowercased spelling → canonical. Built from CANONICAL so the two can't drift.
const BY_LOWER = new Map(CANONICAL.map((s) => [s.toLowerCase(), s]));

// Spellings that are NOT just a casing difference but mean an existing stage.
// Deliberately short: each entry is a real value observed in the data or written
// by code, not a speculative alias.
//
// 'Service' is here because services/airtable-import and migrate-from-airtable
// both already special-cased it inline ("'Service' isn't a fundraising stage;
// Stu's `stage` column only speaks rounds"). Same decision, stated once.
const ALIASES = new Map([
  ['preseed', 'Pre-seed'],
  ['pre seed', 'Pre-seed'],
  ['service', 'Pre-seed'],
  ['pre-raise', 'Bootstrapped / Pre-Raise'],
  ['bootstrapped', 'Bootstrapped / Pre-Raise'],
  ['bootstrapped / pre-raise', 'Bootstrapped / Pre-Raise'],
  ['series b', 'Series B+'],
]);

/**
 * Collapse a stage string to its one canonical spelling.
 * Returns null for empty input; returns the trimmed input unchanged when the
 * value isn't recognized (see "CANONICALIZE, NEVER INVENT" above).
 */
function normalizeStage(v) {
  if (v === null || v === undefined) return null;
  const trimmed = String(v).trim();
  if (!trimmed) return null;
  const k = trimmed.toLowerCase();
  return BY_LOWER.get(k) || ALIASES.get(k) || trimmed;
}

module.exports = { CANONICAL, normalizeStage };
