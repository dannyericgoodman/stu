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

// ── User-configurable stages (2026-09-17) ──
// The five above are the DEFAULT: they stay pinned exactly as-is (ledger.test.js
// pins them) and are what every user without a saved setting sees. Users can
// redefine their own steps via the `pipeline_stages` user setting, an array of:
//   { id, label, subtitle, is_entry, is_pass }
// Exactly one stage is the ENTRY stage (where new cards land) and exactly one is
// the PASS stage (which records a triage verdict). Labels/subtitles are plain
// copy; the client carries no default of its own.
//
// Settings are per-user rows in user_settings (keyed on user_id) — the same
// pattern as every other setting in server/routes/settings.js.

const PIPELINE_STAGES_KEY = 'pipeline_stages';

// Canonical default: the five LEDGER_STAGES in the user-facing shape.
function defaultStages() {
  return LEDGER_STAGES.map((s) => ({
    id: s.key,
    label: s.label,
    subtitle: s.hint,
    is_entry: s.key === 'identified',
    is_pass: s.key === 'pass',
  }));
}

// Parse + normalize a stored pipeline_stages value. Returns null when there is
// no usable config (caller falls back to defaultStages()).
function normalizeStages(raw) {
  let arr = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const stages = arr
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: String(s.id || s.key || '').trim(),
      label: String(s.label ?? s.name ?? '').trim(),
      subtitle: String(s.subtitle ?? s.hint ?? ''),
      is_entry: !!s.is_entry,
      is_pass: !!s.is_pass,
    }))
    .filter((s) => s.id && s.label);
  if (stages.length === 0) return null;
  // Exactly one entry stage and one pass stage, no matter what was stored.
  const entryIdx = stages.findIndex((s) => s.is_entry);
  const passIdx = stages.findIndex((s) => s.is_pass);
  stages.forEach((s, i) => {
    s.is_entry = entryIdx >= 0 ? i === entryIdx : i === 0;
    const fallbackPass = stages.findIndex((s2) => s2.id === 'pass');
    s.is_pass = passIdx >= 0 ? i === passIdx : i === (fallbackPass >= 0 ? fallbackPass : stages.length - 1);
  });
  return stages;
}

function getStages(userId) {
  try {
    const db = require('../db');
    const row = db
      .prepare('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?')
      .get(userId, PIPELINE_STAGES_KEY);
    const parsed = row ? normalizeStages(row.setting_value) : null;
    return parsed || defaultStages();
  } catch {
    return defaultStages();
  }
}

function getEntryStage(userId) {
  const stages = getStages(userId);
  return (stages.find((s) => s.is_entry) || stages[0]).id;
}

function getPassStage(userId) {
  const stages = getStages(userId);
  return (stages.find((s) => s.is_pass) || stages[stages.length - 1]).id;
}

// Wire shape for /api/pipeline/ledger: the {key,label,hint} the board already
// renders, plus the entry/pass flags so the client needs no lookup.
function toWireStages(stages) {
  return stages.map((s) => ({
    key: s.id,
    id: s.id,
    label: s.label,
    hint: s.subtitle,
    subtitle: s.subtitle,
    is_entry: s.is_entry,
    is_pass: s.is_pass,
  }));
}

module.exports = {
  LEDGER_STAGES,
  LEDGER_STAGE_KEYS: KEYS,
  LEDGER_STAGE_LABELS: LABELS,
  isLedgerStage,
  PIPELINE_STAGES_KEY,
  defaultStages,
  normalizeStages,
  getStages,
  getEntryStage,
  getPassStage,
  toWireStages,
};
