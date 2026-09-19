/**
 * talentData.js — scoped, read-mostly data access for the MCP tools.
 *
 * Every function takes a userId and filters strictly to that user's own rows. The MCP
 * surface reaches the caller's OWN Talent and Sourcing data only — never the pipeline
 * founders, assessments, notes, or memos. Filtering by builder signals is deterministic
 * (no LLM), so search is cheap and needs no API key.
 */
const db = require('./../db');
const { filterBySignals, detectSignals, VALID_SIGNAL_KEYS } = require('../lib/builderSignals');
const { tierAndTieFilters } = require('./sourcingData');
const { vcTextFilters } = require('../lib/vcFilters');

const CANDIDATE_FIELDS = `id, name, headline, linkedin_url, github_url, current_company, current_role,
  tenure_months, years_experience, location_city, location_state, tech_stack, pedigree_signals,
  builder_signals, leap_signals, band_fit, overall_score, unicorn_score, enrichment, one_liner, status, starred,
  departure_recency_months, role_function`;

const SOURCED_FIELDS = `id, name, company, role, headline, linkedin_url, github_url, location_city,
  caliber_tier, caliber_score, unicorn_score, enrichment, confidence_score, pedigree_signals, builder_signals,
  departure_recency_months, github_activity_score, chicago_connection, status, tags`;

function clampLimit(n, def = 25, max = 100) {
  const x = parseInt(n);
  if (!Number.isFinite(x) || x <= 0) return def;
  return Math.min(x, max);
}

function validTypes(signals) {
  if (!signals) return null;
  const arr = Array.isArray(signals) ? signals : [signals];
  const clean = arr.filter(s => VALID_SIGNAL_KEYS.includes(s));
  return clean.length ? clean : null;
}

// ── Talent candidates ──
function searchTalentCandidates(userId, { query = '', signals = null, mode = 'any', roleId = null, minConfidence = 0, limit = 25 } = {}) {
  const types = validTypes(signals);
  const params = [userId];
  let sql = `SELECT ${CANDIDATE_FIELDS} FROM talent_candidates WHERE user_id = ? AND is_deleted = 0`;
  if (query && query.trim()) {
    sql += ' AND (LOWER(name) LIKE ? OR LOWER(headline) LIKE ? OR LOWER(current_company) LIKE ?)';
    const q = `%${query.trim().toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (roleId) {
    // Restrict to candidates matched to this role (still user-scoped).
    sql = `SELECT ${CANDIDATE_FIELDS.split(',').map(f => 'c.' + f.trim()).join(', ')}
           FROM talent_candidates c JOIN talent_matches m ON m.candidate_id = c.id
           WHERE c.user_id = ? AND c.is_deleted = 0 AND m.role_id = ? AND m.is_deleted = 0`;
    params.length = 0; params.push(userId, parseInt(roleId));
    if (query && query.trim()) {
      sql += ' AND (LOWER(c.name) LIKE ? OR LOWER(c.headline) LIKE ?)';
      const q = `%${query.trim().toLowerCase()}%`; params.push(q, q);
    }
  }
  // Pull a generous candidate set, then signal-filter in JS (deterministic detectors).
  sql += ' ORDER BY overall_score DESC LIMIT ?';
  const rawLimit = types ? 400 : clampLimit(limit);
  params.push(rawLimit);
  const rows = db.prepare(sql).all(...params);

  if (!types) return rows.slice(0, clampLimit(limit)).map(r => ({ ...r, matched_signals: [] }));

  const filtered = filterBySignals(rows, { types, source: 'talent', mode, minConfidence });
  return filtered.slice(0, clampLimit(limit)).map(({ row, signals: sig }) => ({ ...row, matched_signals: sig }));
}

function getTalentCandidate(userId, id) {
  const row = db.prepare(`SELECT * FROM talent_candidates WHERE id = ? AND user_id = ? AND is_deleted = 0`).get(parseInt(id), userId);
  if (!row) return null;
  const { matched } = detectSignals(row, { types: VALID_SIGNAL_KEYS, source: 'talent' });
  return { ...row, matched_signals: matched };
}

function listTalentRoles(userId) {
  return db.prepare(
    `SELECT r.id, r.title, r.band, r.role_function, r.status, r.location_pref, r.priority,
            c.name AS company
     FROM talent_roles r LEFT JOIN talent_portfolio_companies c ON c.id = r.portfolio_company_id
     WHERE r.user_id = ? AND r.is_deleted = 0 ORDER BY r.status, r.priority DESC, r.created_at DESC`
  ).all(userId);
}

function getRoleMatches(userId, roleId) {
  return db.prepare(
    `SELECT m.id, m.match_score, m.status, m.strengths, m.gaps,
            c.id AS candidate_id, c.name, c.headline, c.current_company, c.linkedin_url, c.overall_score
     FROM talent_matches m JOIN talent_candidates c ON c.id = m.candidate_id
     WHERE m.user_id = ? AND m.role_id = ? AND m.is_deleted = 0
     ORDER BY m.match_score DESC LIMIT 100`
  ).all(userId, parseInt(roleId));
}

// ── Sourced founders (the user's own sourcing queue) ──
// INTENTIONAL design: this MCP surface applies NO Chicago/IL "tie" gate. That gate lives
// only in the owner's web Sourcing queue (routes/sourcing.js TIE_CLAUSE), which keeps the
// owner's instance IL-locked. External users source on their own criteria (any geography),
// so their MCP/discovery queue is tie-exempt by design. Always user_id-scoped either way.
function searchSourcedFounders(userId, { query = '', signals = null, mode = 'any', status = null, minConfidence = 0, limit = 25, tier = null, illinois_tie = false, stage = null, region = null, sector = null } = {}, dbOverride) {
  const d = dbOverride || db;
  const types = validTypes(signals);
  const textFilter = vcTextFilters({ stage, region, sector });
  const params = [userId];
  let sql = `SELECT ${SOURCED_FIELDS} FROM sourced_founders WHERE user_id = ?`;
  if (status) { sql += ' AND status = ?'; params.push(status); }
  // VC filters: minimum caliber tier ('A' means S+A) and verified-Illinois-tie scope.
  // Same definitions as the REST queue (lib/sourcingScope) — no drift.
  const { clause, params: extra } = tierAndTieFilters({ tier, illinois_tie });
  sql += clause; params.push(...extra);
  if (query && query.trim()) {
    sql += ' AND (LOWER(name) LIKE ? OR LOWER(headline) LIKE ? OR LOWER(company) LIKE ?)';
    const q = `%${query.trim().toLowerCase()}%`; params.push(q, q, q);
  }
  sql += ' ORDER BY caliber_score DESC, confidence_score DESC LIMIT ?';
  params.push((types || textFilter) ? 400 : clampLimit(limit));
  const rows = d.prepare(sql).all(...params);

  let filtered = rows;
  if (types) filtered = filterBySignals(filtered, { types, source: 'sourcing', mode, minConfidence }).map(({ row, signals: sig }) => ({ ...row, matched_signals: sig }));
  else filtered = filtered.map((r) => ({ ...r, matched_signals: [] }));
  // stage/region/sector are best-effort text matchers (lib/vcFilters): rows with
  // no detectable signal are skipped when the filter is set.
  if (textFilter) filtered = filtered.filter(textFilter);
  return filtered.slice(0, clampLimit(limit));
}

// Load a saved person (talent candidate or sourced founder), scoped to the user, with
// any stored enrichment ({summary, why, contactability}) flattened in. Used by outreach
// and enrichment in both the MCP and REST layers.
function getPerson(userId, { candidateId, founderId } = {}) {
  const flatten = (row, extra) => {
    if (!row) return null;
    let enr = {}; try { enr = row.enrichment ? JSON.parse(row.enrichment) : {}; } catch {}
    return { ...row, ...extra, summary: enr.summary, why: enr.why, contactability: enr.contactability };
  };
  if (candidateId) {
    const r = db.prepare('SELECT * FROM talent_candidates WHERE id = ? AND user_id = ? AND is_deleted = 0').get(parseInt(candidateId), userId);
    return flatten(r, { company: r && r.current_company, role: r && r.current_role });
  }
  if (founderId) {
    const r = db.prepare('SELECT * FROM sourced_founders WHERE id = ? AND user_id = ?').get(parseInt(founderId), userId);
    return flatten(r, {});
  }
  return null;
}

module.exports = {
  searchTalentCandidates, getTalentCandidate, listTalentRoles, getRoleMatches, searchSourcedFounders, getPerson,
};
