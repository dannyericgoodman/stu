'use strict';
// ══════════════════════════════════════════════════════════════════════════
// redFlags — the one place the disqualifying-flag list and its check live.
//
// Originally only in pipeline/sourcing-engine.js, where the LLM scoring pass uses it
// to clamp confidence_score/caliber_tier (STU-34). founderFit.js (the ranking rubric
// in lib/) needs the same check — a structured, already-enforced signal, not narrative
// prose — so it lives here instead of being duplicated or pulled in from pipeline/,
// which lib/ must not depend on. See STU-35.
// ══════════════════════════════════════════════════════════════════════════

// Red flags that hard-clamp relevance to a pass and cap caliber.
const DISQUALIFYING_FLAGS = [
  'student', 'recruiter', 'consultant', 'service provider', 'agency',
  'job seeker', 'job-seeker', 'no commercial', 'series a', 'series b',
  'fractional', 'coach', 'advisor only',
];

function hasDisqualifyingFlag(redFlags = []) {
  return (redFlags || []).some(rf =>
    DISQUALIFYING_FLAGS.some(d => String(rf).toLowerCase().includes(d))
  );
}

// red_flags is stored as a JSON TEXT column (db.js) — parse it the same way the rest
// of the codebase parses its other JSON array columns (pedigree_signals, tags, ...).
function parseRedFlags(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

module.exports = { DISQUALIFYING_FLAGS, hasDisqualifyingFlag, parseRedFlags };
