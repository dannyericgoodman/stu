'use strict';
/**
 * Manual add — pure validation, normalization, dedup and insert for
 * POST /api/sourcing/add.
 *
 * Kept dependency-free (db is injected) so it can be unit-tested without
 * better-sqlite3. The route file wraps these three steps.
 */

const VALID_TIERS = ['S', 'A', 'B', 'C'];
const SIGNAL_COLS = ['tags', 'pedigree_signals', 'builder_signals', 'caliber_signals'];

function linkedinSlug(url) {
  if (!url) return null;
  const u = String(url).toLowerCase().split('?')[0].replace(/\/+$/, '');
  const slug = u.split('/in/')[1];
  return slug ? slug.split('/')[0] : null;
}

function normUrl(u) {
  if (u == null) return null;
  const t = String(u).trim();
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
}

function strOrNull(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}

// validateManualAdd(body, { validTieTypes }) -> { error } | { clean }
// clean holds DB-ready values: signal columns JSON-encoded, tier uppercased,
// urls normalized, linkedin slug extracted.
function validateManualAdd(body, { validTieTypes = [] } = {}) {
  const b = body || {};
  const name = strOrNull(b.name);
  if (!name) return { error: 'name is required' };

  const clean = {
    name,
    company: strOrNull(b.company),
    role: strOrNull(b.role),
    linkedin_url: normUrl(b.linkedin_url),
    headline: strOrNull(b.headline),
    company_one_liner: strOrNull(b.company_one_liner),
    website_url: normUrl(b.website_url),
    chicago_connection: strOrNull(b.chicago_connection),
    location_type: null,
    caliber_tier: null,
    tags: null, pedigree_signals: null, builder_signals: null, caliber_signals: null,
    linkedin_slug: null,
  };

  for (const c of SIGNAL_COLS) {
    const v = b[c];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
      return { error: `${c} must be an array of strings` };
    clean[c] = JSON.stringify(v);
  }

  if (b.caliber_tier != null) {
    const tier = String(b.caliber_tier).toUpperCase();
    if (!VALID_TIERS.includes(tier)) return { error: 'caliber_tier must be S, A, B or C' };
    clean.caliber_tier = tier;
  }
  if (b.location_type != null) {
    const lt = String(b.location_type);
    if (!validTieTypes.includes(lt)) return { error: `location_type must be one of: ${validTieTypes.join(', ')}` };
    clean.location_type = lt;
  }
  clean.linkedin_slug = linkedinSlug(clean.linkedin_url);
  return { clean };
}

// findDuplicate(db, clean, userId) -> existing row ({id,name,company,status}) or null.
// LinkedIn slug first, then normalized name+company. Any status blocks re-adding.
function findDuplicate(db, clean, userId) {
  if (clean.linkedin_slug) {
    const hit = db.prepare(
      'SELECT id, name, company, status FROM sourced_founders WHERE LOWER(linkedin_url) LIKE ? AND user_id = ?'
    ).get(`%/in/${clean.linkedin_slug}%`, userId);
    if (hit) return hit;
  }
  return db.prepare(
    `SELECT id, name, company, status FROM sourced_founders
     WHERE user_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     AND COALESCE(LOWER(TRIM(company)), '') = COALESCE(LOWER(TRIM(?)), '')`
  ).get(userId, clean.name, clean.company) || null;
}

function insertManualAdd(db, clean, userId) {
  const info = db.prepare(`
    INSERT INTO sourced_founders (
      name, company, role, linkedin_url, headline, source, status,
      company_one_liner, website_url, location_type, chicago_connection,
      tags, pedigree_signals, builder_signals, caliber_signals, caliber_tier,
      user_id
    ) VALUES (?, ?, ?, ?, ?, 'manual', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clean.name, clean.company, clean.role, clean.linkedin_url, clean.headline,
    clean.company_one_liner, clean.website_url, clean.location_type, clean.chicago_connection,
    clean.tags, clean.pedigree_signals, clean.builder_signals, clean.caliber_signals,
    clean.caliber_tier, userId
  );
  return db.prepare('SELECT id, name, company, status FROM sourced_founders WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { validateManualAdd, findDuplicate, insertManualAdd, SIGNAL_COLS };
