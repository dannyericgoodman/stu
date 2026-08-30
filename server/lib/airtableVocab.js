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
// Pulled from the live base schema 2026-07-16 (base appfE9DVrSUOrkkpu,
// table tblWkJzy5qpw7FP2M). If Danny adds a select option in Airtable, it must be
// added here too — test/airtable-vocab.test.js fails loudly when they diverge, so
// this cannot rot quietly.
// ══════════════════════════════════════════════════════════════════════════

// The header above says "the ONLY copy," and for the VALUES below that was true.
// It was not true of the ADDRESS: this file declared the base and table literals,
// and so did five other files. That half now lives in lib/airtableBase and is
// re-exported here, so existing importers keep working and the claim stops being
// aspirational.
const { BASE_ID, TABLE } = require('./airtableBase');
const FOUNDER_TABLE = TABLE.FOUNDERS;

// Field ids, so a rename in Airtable's UI doesn't break the write path.
const FIELD = {
  ADMISSION_STATUS: 'fldhgAoYfpmvy4Skh',
  PIPELINE: 'fldlxRWlSMPQxKHxO',
  NEXT_STEP: 'fldN6myD2cRJSe0G6',
};

// The stage axis, in Airtable's own order — which is lifecycle order, so the
// board reads left to right the way the funnel actually runs.
const STAGES = [
  'Stage 0: Legacy (Density)',
  'Stage 1: Identified',
  'Stage 2: Interviewed',
  'Stage 3: Evaluating (Investment-Only)',
  'Stage 3: Evaluating (Resident-Only)',
  'Stage 3: Evaluating (Investment + Resident)',
  'Stage 4: Admitted (Resident)',
  'Stage 4: Admitted (Resident + Investment)',
  'Stage 5: Hold / Nurture',
  'Stage 5: Not Admitted',
  'Stage 5: Legacy Density Not Admitted SSFI',
  'Stage 5: Pass on Investment',
];

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
  'Active Evaluation',
  'HOLD',
];

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

// ── Folding Airtable's SECOND table into the one board ──
// 26 cards come from Airtable's separate "Investment Pipeline" table and have no
// Founder Ecosystem record, so Airtable has no Admission Status for them. They
// are not stage-less, though — that table's Status says where they stand, and
// Airtable's own stage list already has words for both investment-only states.
// This is used ONCE to backfill them onto the merged board, never on live sync.
const DEAL_STATUS_TO_STAGE = {
  'Passed': 'Stage 5: Pass on Investment',
  'Under Consideration': 'Stage 3: Evaluating (Investment-Only)',
  'Active': 'Stage 3: Evaluating (Investment-Only)',
  'First Meeting': 'Stage 2: Interviewed',
  'Partner Call': 'Stage 3: Evaluating (Investment-Only)',
  'Memo Draft': 'Stage 3: Evaluating (Investment-Only)',
  'IC Review': 'Stage 3: Evaluating (Investment-Only)',
  'Committed': 'Stage 4: Admitted (Resident + Investment)',
  'Not Started': 'Stage 1: Identified',
};

function isStage(v) { return STAGES.includes(v); }

// Stages that mean the opportunity is finished. The board still shows them; the
// attention engine and every "live pipeline" count must not.
const TERMINAL_STAGES = [
  'Stage 5: Not Admitted',
  'Stage 5: Pass on Investment',
  'Stage 5: Legacy Density Not Admitted SSFI',
];
function isTerminal(v) { return TERMINAL_STAGES.includes(v); }

module.exports = {
  BASE_ID, FOUNDER_TABLE, FIELD,
  STAGES, TRACKS, NEXT_STEPS,
  TRACK_TO_STU, STU_TO_TRACK, tracksFromStu, tracksToStu,
  DEAL_STATUS_TO_STAGE, isStage, TERMINAL_STAGES, isTerminal,
};
