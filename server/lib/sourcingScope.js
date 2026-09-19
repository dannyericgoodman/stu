'use strict';
/**
 * sourcingScope.js — shared sourcing-query scope helpers.
 *
 * Extracted verbatim from server/routes/sourcing.js (no behavior change) so the
 * REST queue and the MCP VC-sourcing tools filter on exactly the same definitions:
 * the verified-Illinois-tie clause and the caliber-tier floor. Single source of
 * truth is the engine's VALID_TIE_TYPES, so the display filter can't drift from
 * intake — that invariant is preserved here, not in the route.
 */
const { VALID_TIE_TYPES } = require('../pipeline/sourcing-engine');

// Hard rule: the Pipeline only ever shows founders with a VERIFIED Chicago/IL tie.
// Two conditions, BOTH required: (1) a canonical tie type, AND (2) actual connection
// evidence text — a founder with a tie type but no substantiating connection (the false
// "Chicago · current" failure mode) is treated as unverified and hidden.
const TIE_IN = VALID_TIE_TYPES.map(() => '?').join(',');
const TIE_CLAUSE = `location_type IN (${TIE_IN}) AND chicago_connection IS NOT NULL AND TRIM(chicago_connection) != '' AND LOWER(chicago_connection) NOT LIKE '%no verified tie%' AND LOWER(chicago_connection) != 'any'`;

// Caliber tiers, best first.
const CALIBER_ORDER = { S: 4, A: 3, B: 2, C: 1 };

// Minimum-caliber filter: 'A' means S+A, 'B' means S+A+B, etc.
// Returns the allowed tier list, or null for an unrecognized tier (caller ignores).
function caliberFloor(tier) {
  const floor = CALIBER_ORDER[String(tier || '').toUpperCase()];
  if (!floor) return null;
  return Object.keys(CALIBER_ORDER).filter((t) => CALIBER_ORDER[t] >= floor);
}

// ORDER BY fragment: caliber S → A → B → C.
const CALIBER_RANK = `CASE caliber_tier WHEN 'S' THEN 4 WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END`;

module.exports = { VALID_TIE_TYPES, TIE_CLAUSE, CALIBER_ORDER, CALIBER_RANK, caliberFloor };
