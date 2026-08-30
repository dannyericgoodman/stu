'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Airtable's vocabulary, verbatim. The ONLY copy.
//
// Danny maintains the funnel by hand in the team's Airtable base and asked for
// Stu's board to read exactly like it: "Investment and/or Admissions Pipeline
// should be a badge I can edit on each card, similar to what I have in Airtable.
// Use Airtable right now as the source of truth for the correct stage."
//
// So there is no translation layer here, on purpose. Stu used to keep a parallel
// vocabulary ('Sourced', 'Outreach', 'First Call Scheduled') and map onto these
// strings — and that mapping is what silently destroyed four months of his stage
// changes and put 22 declined founders back on the live board as prospects.
// A second vocabulary is a second thing to drift. These strings are Airtable's.
//
// ── REWRITTEN FOR THE AUTHORIZED BASE (2026-08-30) ──
// Everything below used to describe `appfE9DVrSUOrkkpu`, which Danny's team has
// renamed "[OLD] Superior Studios Ecosystem". Stu is now scoped to
// `appxd2l3BXJAdTWSQ`, whose funnel is shaped differently in a way that matters:
//
//   OLD: one `Admission Status` field, 12 combined values that fused two ideas.
//        "Stage 3: Evaluating (Investment + Resident)" is a residency state AND an
//        investment state welded into one string — which is why it needed values
//        like "(Investment-Only)" and still could not express "invested, and never
//        a resident".
//   NEW: two orthogonal fields, `Investment Status` (6 values) and `Resident
//        Status` (6 values), each free to be blank. A `Pipeline Stage` FORMULA
//        composes them into the single ordered axis the board sorts on.
//
// Transcribed from the live base schema 2026-08-30 via meta/tables. If Danny adds
// a select option in Airtable it must be added here too — test/airtable-vocab.test.js
// fails loudly when they diverge, so this cannot rot quietly.
// ══════════════════════════════════════════════════════════════════════════

// The header above says "the ONLY copy," and for the VALUES below that was true.
// It was not true of the ADDRESS: this file declared the base and table literals,
// and so did five other files. That half now lives in lib/airtableBase and is
// re-exported here, so existing importers keep working and the claim stops being
// aspirational.
const { BASE_ID, TABLE } = require('./airtableBase');
const FOUNDER_TABLE = TABLE.PIPELINE;

// Field ids, so a rename in Airtable's UI doesn't break the write path.
const FIELD = {
  INVESTMENT_STATUS: 'fldCucmNaHQfZRAch',
  RESIDENT_STATUS: 'fld3wjkjGCoggjYvR',
  NEXT_STEP: 'fldnSKCBYivMZ4sE2',
  TRACK: 'fldiRSHqOkg4Z0ftq',
  // READ-ONLY. A formula field; Airtable rejects any attempt to write it. It is
  // named here so readers can address it, and so that the one thing you must not
  // do with it is stated at the point of temptation.
  PIPELINE_STAGE: 'fld9u56VzFYuVduel',
};

// ── The two axes Danny actually edits ──
const INVESTMENT_STATUSES = [
  'Under Consideration',
  'Watching',
  'Diligence',
  'IC',
  'Invested',
  'Passed',
];

const RESIDENT_STATUSES = [
  'Identified',
  'Interviewed',
  'Admitted',
  'Hold',
  'Not admitted',
  'Density',
];

// ── The composed axis the board reads ──
// These strings are the OUTPUT of Airtable's `Pipeline Stage` formula, character
// for character — the separator is U+00B7 MIDDLE DOT and the resident dash is
// U+2014 EM DASH. They are compared against values Airtable computed, so a
// lookalike ASCII '-' here would silently never match. Listed in the formula's own
// numeric order, which is the order the board sorts.
const STAGES = [
  '1 · IC',
  '2 · Diligence',
  '3 · Under Consideration',
  '4 · Watching',
  '5 · Resident — Admitted',
  '5 · Resident — Density',
  '6 · Resident — Identified',
  '6 · Resident — Interviewed',
  '7 · Resident — Hold',
  '8 · Invested',
  '9 · Passed',
  '9 · Resident — Not admitted',
];

// Airtable's formula emits this when BOTH axes are blank. It arrives on real rows
// (one today), so it is a known value rather than a parse failure — but it is not
// selectable and nothing may write toward it.
const NO_STAGE = '—';

// ── The formula, reimplemented ──
// Stu has to predict the stage a write will produce, which means owning a copy of
// Airtable's precedence rule. Transcribed from the live formula:
//
//   IF(Investment Status = "IC", "1 · IC", ... six investment branches ...,
//     IF(Resident Status = "Admitted", "5 · Resident — Admitted", ... six resident
//     branches ..., "—"))
//
// The load-bearing fact is the PRECEDENCE: Investment Status wins outright. A row
// with Investment Status "Passed" reads "9 · Passed" no matter what its Resident
// Status says. See stageWriteFor() — that asymmetry is a trap for the write path.
const INVESTMENT_TO_STAGE = {
  'IC': '1 · IC',
  'Diligence': '2 · Diligence',
  'Under Consideration': '3 · Under Consideration',
  'Watching': '4 · Watching',
  'Invested': '8 · Invested',
  'Passed': '9 · Passed',
};

const RESIDENT_TO_STAGE = {
  'Admitted': '5 · Resident — Admitted',
  'Density': '5 · Resident — Density',
  'Interviewed': '6 · Resident — Interviewed',
  'Identified': '6 · Resident — Identified',
  'Hold': '7 · Resident — Hold',
  'Not admitted': '9 · Resident — Not admitted',
};

/** Compose the two axes exactly as Airtable's formula does. */
function pipelineStage(investmentStatus, residentStatus) {
  const inv = investmentStatus == null ? '' : String(investmentStatus).trim();
  const res = residentStatus == null ? '' : String(residentStatus).trim();
  return INVESTMENT_TO_STAGE[inv] || RESIDENT_TO_STAGE[res] || NO_STAGE;
}

// Which underlying field a stage is written through. `Pipeline Stage` is a formula
// — writing it is a 422 — so every board drag has to be decomposed back into the
// axis that produced it. Exactly one field per stage, no ambiguity.
const STAGE_WRITE = {};
for (const [value, stage] of Object.entries(INVESTMENT_TO_STAGE)) {
  STAGE_WRITE[stage] = { field: FIELD.INVESTMENT_STATUS, value, axis: 'investment' };
}
for (const [value, stage] of Object.entries(RESIDENT_TO_STAGE)) {
  STAGE_WRITE[stage] = { field: FIELD.RESIDENT_STATUS, value, axis: 'resident' };
}

/**
 * The patch that moves a row to `stage`, or null if `stage` isn't writable.
 *
 * `current` is the row's existing { investmentStatus }, and it is a parameter
 * because of the precedence trap: setting Resident Status on a row that already
 * carries ANY Investment Status changes the stored value but NOT the Pipeline
 * Stage the board shows. Reporting success there would tell Danny his drag landed
 * while the card sat still. Callers get `shadowed: true` and can refuse.
 */
function stageWriteFor(stage, current = {}) {
  const w = STAGE_WRITE[stage];
  if (!w) return null;
  const inv = current.investmentStatus == null ? '' : String(current.investmentStatus).trim();
  const shadowed = w.axis === 'resident' && Boolean(INVESTMENT_TO_STAGE[inv]);
  return { ...w, shadowed, shadowedBy: shadowed ? INVESTMENT_TO_STAGE[inv] : null };
}

// The badge. Airtable calls the residency track "Resident"; Stu's own
// `pipeline_tracks` column has always spelled it "admissions". Same thing, two
// words, and the board shows Danny Airtable's word.
const TRACKS = ['Resident', 'Investment'];

const NEXT_STEPS = [
  'Target',
  'Convert to SSFI Applicant',
  'Scheduling 1st Mtg',
  '1st Mtg Scheduled',
  'Scheduling 2nd Mtg',
  '2nd Mtg Scheduled',
  'Scheduling 3rd Mtg',
  '3rd Mtg Scheduled',
  'Active Evaluation',
  'HOLD',
];

// The funding-round axis, Airtable's `Stage` field. Distinct from STAGES above —
// this is how much money the company has raised, not where it stands with Superior.
// Two fields, both called some form of "stage", is exactly the kind of false friend
// that gets mapped onto the wrong column, so they are named apart here.
const FUNDING_STAGES = ['Pre-raise', 'Angel', 'Pre-seed', 'Seed', 'Series A'];

// ── The one mapping that has to exist ──
// `pipeline_tracks` is a Stu column with Stu's words in it on 187 live rows.
// Rewriting the column is a migration with no upside; translating at the edge is
// two functions. These are the edge.
const TRACK_TO_STU = { Resident: 'admissions', Investment: 'investment' };
const STU_TO_TRACK = { admissions: 'Resident', investment: 'Investment' };

/** 'admissions,investment' → ['Resident','Investment'] */
function tracksFromStu(csv) {
  return String(csv || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => STU_TO_TRACK[s])
    .filter(Boolean);
}

/** ['Resident','Investment'] → 'admissions,investment' (Stu's storage order) */
function tracksToStu(list) {
  const set = new Set((list || []).map((t) => TRACK_TO_STU[t]).filter(Boolean));
  return ['admissions', 'investment'].filter((t) => set.has(t)).join(',');
}

// ── Reading the OLD base's vocabulary ──
// Stu's `stage_status` / `airtable_admission_status` columns hold the old base's
// strings on thousands of rows imported before the cutover. Those rows are not
// re-importable — the credential that could read them is out of scope now — so the
// strings must be translated in place rather than re-fetched. This table is what
// scripts/migrate-stage-vocab.js applies once.
//
// Two folds are lossy, and deliberately so. "Stage 3: Evaluating (Investment +
// Resident)" carried both axes in one string; in the new base that is an Investment
// Status plus a Resident Status, and only the investment half survives into the
// composed stage — so the investment half is what is kept. And the two distinct old
// rejections ("Not Admitted", "Legacy Density Not Admitted SSFI") collapse into
// one, because the new base has exactly one resident rejection.
const LEGACY_STAGE_TO_STAGE = {
  'Stage 0: Legacy (Density)': '5 · Resident — Density',
  'Stage 1: Identified': '6 · Resident — Identified',
  'Stage 2: Interviewed': '6 · Resident — Interviewed',
  'Stage 3: Evaluating (Investment-Only)': '3 · Under Consideration',
  'Stage 3: Evaluating (Resident-Only)': '6 · Resident — Interviewed',
  'Stage 3: Evaluating (Investment + Resident)': '3 · Under Consideration',
  'Stage 4: Admitted (Resident)': '5 · Resident — Admitted',
  'Stage 4: Admitted (Resident + Investment)': '5 · Resident — Admitted',
  'Stage 5: Hold / Nurture': '7 · Resident — Hold',
  'Stage 5: Not Admitted': '9 · Resident — Not admitted',
  'Stage 5: Legacy Density Not Admitted SSFI': '9 · Resident — Not admitted',
  'Stage 5: Pass on Investment': '9 · Passed',
};

/** An old-base stage string → the new vocabulary, or null if it isn't one. */
function fromLegacyStage(v) {
  return LEGACY_STAGE_TO_STAGE[String(v || '').trim()] || null;
}

function isStage(v) { return STAGES.includes(v); }
function isInvestmentStatus(v) { return INVESTMENT_STATUSES.includes(v); }
function isResidentStatus(v) { return RESIDENT_STATUSES.includes(v); }

// Stages that mean the opportunity is finished. The board still shows them; the
// attention engine and every "live pipeline" count must not.
//
// "8 · Invested" is deliberately NOT terminal — that is a portfolio company Stu
// keeps working, and it is the outcome the whole system exists to produce. Neither
// is "5 · Resident — Density": a Density resident is a live relationship.
const TERMINAL_STAGES = [
  '9 · Passed',
  '9 · Resident — Not admitted',
];
function isTerminal(v) { return TERMINAL_STAGES.includes(v); }

module.exports = {
  BASE_ID, FOUNDER_TABLE, FIELD,
  STAGES, NO_STAGE, TRACKS, NEXT_STEPS, FUNDING_STAGES,
  INVESTMENT_STATUSES, RESIDENT_STATUSES,
  INVESTMENT_TO_STAGE, RESIDENT_TO_STAGE, pipelineStage,
  STAGE_WRITE, stageWriteFor,
  TRACK_TO_STU, STU_TO_TRACK, tracksFromStu, tracksToStu,
  LEGACY_STAGE_TO_STAGE, fromLegacyStage,
  isStage, isInvestmentStatus, isResidentStatus,
  TERMINAL_STAGES, isTerminal,
};
