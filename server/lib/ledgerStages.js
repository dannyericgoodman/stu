// ── Danny's personal pipeline stages ──
// 2026-09-17 — Danny: "keep Airtable as my always on team record and Pipeline as
// a ledger of founders I've seen in inbox that I like that goes from Stage 1:
// Identified to Stage 2: Outreach Sent to Stage 3: Meeting Set Stage 4a: Add to
// Investment Pipeline or Stage 4b: Pass"
//
// This is deliberately NOT stage_status. stage_status is Airtable's vocabulary —
// the team's record, mirrored by the 6am sync. ledger_stage is Danny's own
// workflow, Stu-only, and never syncs anywhere. A row is in his personal ledger
// iff ledger_stage IS NOT NULL.
const LEDGER_STAGES = [
  { key: 'identified', label: 'Stage 1: Identified', hint: 'Fresh arrivals — from the inbox or + New. Worth a look?' },
  { key: 'outreach', label: 'Stage 2: Outreach Sent', hint: 'You reached out. Waiting to hear back.' },
  { key: 'meeting', label: 'Stage 3: Meeting Set', hint: 'Talking or just talked — decide what happens next.' },
  { key: 'invest_pipeline', label: 'Stage 4a: Investment Pipeline', hint: 'The keepers — you add these to Airtable yourself.' },
  { key: 'pass', label: 'Stage 4b: Pass', hint: 'Not for us. Kept as a record, not a maybe.' },
];

const KEYS = LEDGER_STAGES.map((s) => s.key);
const LABELS = Object.fromEntries(LEDGER_STAGES.map((s) => [s.key, s.label]));

function isLedgerStage(key) {
  return KEYS.includes(key);
}

module.exports = { LEDGER_STAGES, LEDGER_STAGE_KEYS: KEYS, LEDGER_STAGE_LABELS: LABELS, isLedgerStage };
