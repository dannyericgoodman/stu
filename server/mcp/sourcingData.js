'use strict';
/**
 * sourcingData.js — scoped, read-only VC-sourcing data access for the MCP tools.
 *
 * Every function takes a userId and filters strictly to that user's OWN
 * sourced_founders rows. The MCP surface NEVER reaches the pipeline founders,
 * assessments, notes, or memos — only the caller's own sourcing surface, which
 * is what "Stu for Muse — sourcing for every VC" sells.
 *
 * The db handle is injected (dbOverride) so tests can run against an in-memory
 * database; in production it falls back to the real Stu database. Ranking and
 * scope semantics mirror GET /api/sourcing/queue exactly (see lib/sourcingScope).
 */
const { TIE_CLAUSE, VALID_TIE_TYPES, CALIBER_RANK, caliberFloor } = require('../lib/sourcingScope');
const { vcTextFilters } = require('../lib/vcFilters');
const founderFit = require('../lib/founderFit');

function dbOf(dbOverride) {
  return dbOverride || require('../db');
}

function clampLimit(n, def, max) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x) || x <= 0) return def;
  return Math.min(x, max);
}

// Compact outreach row: everything an agent needs to pitch the founder, nothing more.
// The fit evaluation runs on FIT_FIELDS (a superset) — same as /api/sourcing/queue,
// which evaluates the full row, not the projected one. location_city + tags are
// included so region/sector stage filters can run without a second query.
const FIT_FIELDS = `id, name, company, company_one_liner, role, headline, linkedin_url,
  caliber_tier, caliber_score, confidence_score, affinity_score, chicago_connection,
  location_city, location_type, list_scope, pedigree_signals, builder_signals,
  caliber_signals, tags, raw_data, enriched_data, created_at`;

// Minimum-caliber filter: 'A' means S+A (the default — the outreach list is a
// quality bar), 'B' means S+A+B, etc. Legacy 'S+A' is accepted as 'A'.
function outreachTiers(tier) {
  const norm = String(tier || 'A').toUpperCase().replace(/\s+/g, '');
  return caliberFloor(norm === 'S+A' ? 'A' : norm) || ['S', 'A'];
}

function pickFit(f) {
  return { meetWorthy: f.meetWorthy, priority: f.priority, stage: f.stage, why: f.why };
}

// Presets: named lenses that pre-fill the general filters. Danny's Chicago
// pre-seed lens is ONE preset, not the default — the default is unfiltered
// national scope (any region, any stage, any sector), S/A minimum caliber.
const PRESETS = {
  'illinois-preseed': {
    tier: 'A', illinois_tie: true, scope: 'pipeline', excludeLate: true,
  },
};

// ── The flagship: "give me my morning founder outreach list" ──
// Sourcing for every VC: defaults to unfiltered national scope (stealth→growth,
// any sector, any region) at S/A minimum caliber, ranked caliber → affinity →
// fit → recency. Narrow it with tier, stage, sector, region, illinois_tie,
// scope, or the 'illinois-preseed' preset (Danny's Chicago pre-seed lens).
// excludeLate drops founders the stage gate says are past earliest-stage
// (computed fresh per row, same as the queue's ?hideLate=1); it defaults OFF
// nationally because growth VCs want late-stage founders — the preset turns it
// on. Taste exemplars (is_exemplar=1) are never targets.
function getOutreachList(userId, opts = {}, dbOverride) {
  const db = dbOf(dbOverride);
  const preset = PRESETS[opts.preset] || {};
  const limit = opts.limit ?? 10;
  const tier = opts.tier ?? preset.tier ?? 'A';
  const scope = String(opts.scope ?? preset.scope ?? 'all').toLowerCase();
  const illinois_tie = opts.illinois_tie ?? preset.illinois_tie ?? false;
  const excludeLate = opts.excludeLate ?? preset.excludeLate ?? false;
  const textFilter = vcTextFilters(opts);

  const tiers = outreachTiers(tier);
  const lim = clampLimit(limit, 10, 25);
  const params = [userId];
  let where = `user_id = ? AND status = 'pending' AND COALESCE(is_exemplar, 0) = 0`;
  if (illinois_tie) {
    where += ` AND ${TIE_CLAUSE}`;
    params.push(...VALID_TIE_TYPES);
  }
  if (scope === 'watchlist') {
    where += ` AND list_scope = 'watchlist'`;
  } else if (scope === 'pipeline' || illinois_tie) {
    // The IL tie clause only ever applied to the pipeline surface on REST;
    // keep that pairing when the tie gate is on.
    where += ` AND (list_scope IS NULL OR list_scope = 'pipeline')`;
  }
  where += ` AND caliber_tier IN (${tiers.map(() => '?').join(',')})`;
  params.push(...tiers);
  // Over-fetch: excludeLate and the stage/region/sector text filters are applied
  // per-row below, so pull headroom and slice after.
  const fetch = Math.min(lim * (textFilter ? 12 : 4), 200);
  const rows = db.prepare(
    `SELECT ${FIT_FIELDS} FROM sourced_founders WHERE ${where}
     ORDER BY ${CALIBER_RANK} DESC, COALESCE(affinity_score, 0) DESC, confidence_score DESC, created_at DESC
     LIMIT ?`
  ).all(...params, fetch);

  const out = [];
  for (const row of rows) {
    if (textFilter && !textFilter(row)) continue;
    const f = founderFit.evaluate(row);
    if (excludeLate && f.stageTooLate) continue;
    out.push({
      id: row.id,
      name: row.name,
      company: row.company,
      company_one_liner: row.company_one_liner,
      caliber_tier: row.caliber_tier,
      linkedin_url: row.linkedin_url,
      location_city: row.location_city,
      chicago_connection: row.chicago_connection,
      confidence_score: row.confidence_score,
      fit: pickFit(f),
    });
    if (out.length >= lim) break;
  }
  return out;
}

// ── Full detail on one of the caller's sourced founders ──
// Returns null when the id doesn't exist or belongs to someone else (caller maps to 404).
function getSourcedFounder(userId, id, dbOverride) {
  const db = dbOf(dbOverride);
  const row = db.prepare(
    `SELECT * FROM sourced_founders WHERE id = ? AND user_id = ?`
  ).get(parseInt(id, 10), userId);
  if (!row) return null;
  let enr = {};
  try { enr = row.enrichment ? JSON.parse(row.enrichment) : {}; } catch { /* keep {} */ }
  const f = founderFit.evaluate(row);
  return {
    ...row,
    summary: enr.summary ?? null,
    why_line: enr.why ?? null,
    contactability: enr.contactability ?? null,
    fit: {
      meetWorthy: f.meetWorthy,
      tier: f.tier,
      priority: f.priority,
      stage: f.stage,
      stageTooLate: f.stageTooLate,
      why: f.why,
      markers: f.markers,
    },
  };
}

// Shared by talentData.searchSourcedFounders: minimum-caliber SQL + Illinois-tie scope.
// Returns { clause, params } to splice into a WHERE chain (params in order).
function tierAndTieFilters({ tier = null, illinois_tie = false } = {}) {
  let clause = '';
  const params = [];
  const floors = tier ? caliberFloor(tier) : null;
  if (floors) {
    clause += ` AND caliber_tier IN (${floors.map(() => '?').join(',')})`;
    params.push(...floors);
  }
  if (illinois_tie) {
    clause += ` AND ${TIE_CLAUSE} AND (list_scope IS NULL OR list_scope = 'pipeline')`;
    params.push(...VALID_TIE_TYPES);
  }
  return { clause, params };
}

module.exports = { getOutreachList, getSourcedFounder, tierAndTieFilters, outreachTiers, PRESETS };
