'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-network.js — the warm pool, drawn from the people Danny actually knows.
//
// The old warm pool read two Airtable tables that left the authorized base in the
// 2026-08-30 cutover, so it froze at sixteen people. The Network book holds Danny's
// whole LinkedIn graph — ~3,100 people with a relationship score computed from real
// message history — so Hiring reads it instead.
//
// Selection is the Network matcher itself (lib/networkMatch, a `hire` ask built from
// the role), not a second, weaker relevance test. That keeps "who in my network fits
// this" answering the same way on both screens. It is a PREFILTER only: it reads
// titles, so it decides who is worth reading and grading, never who gets shortlisted.
//
// ── WARMTH IS NOT A LABEL YOU GIVE A NAME ──
// A 1st-degree connection Danny has never messaged is not warm, and calling them
// warm on a card he forwards to a founder would be false. Only relationships with
// real two-way or inbound history (strong / real / light) enter as tier 'warm'. Thin
// connections can still be found and graded, as tier 'cold', with the receipt kept.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { matchNeed } = require('../lib/networkMatch');
const { loadBook } = require('../lib/networkBook');
const { verifyIlTie } = require('../lib/ilTie');

const WARM_TIERS = new Set(['strong', 'real', 'light']);

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

/** The role, phrased as a Network `hire` ask. Pure. */
function roleAsNeed(role) {
  const text = [
    role.title,
    role.role_function,
    role.domain,
    ...parseArr(role.must_haves),
    ...parseArr(role.must_have_stack),
  ].filter(Boolean).join('. ');
  return { type: 'hire', text };
}

const slugOf = (url) => {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
};

/** One network match → a hiring_candidates row. Pure. */
function rowFromMatch(m) {
  const warm = WARM_TIERS.has(m.warmth_tier);
  const tie = verifyIlTie([m.title, m.company].filter(Boolean).join(' • '));
  return {
    name: String(m.name || '').slice(0, 120),
    headline: [m.title, m.company].filter(Boolean).join(' @ ') || null,
    current_role: m.title || null,
    current_company: m.company || null,
    linkedin_url: m.linkedin_url || null,
    tier: warm ? 'warm' : 'cold',
    source: 'network',
    warm_source: warm ? m.how_you_know_them : null,
    superior_connection: m.how_you_know_them || null,
    warmth: m.warmth || 0,
    warmth_tier: m.warmth_tier || null,
    network_person_id: m.person_id,
    external_id: `network:${m.person_id}`,
    il_tie_type: tie.verified && !tie.weak ? tie.type : null,
    il_tie_place: tie.verified && !tie.weak ? tie.place : null,
    il_tie_evidence: tie.verified && !tie.weak ? tie.evidence : null,
  };
}

/**
 * Upsert a network candidate. Matches an existing row by external id, then by
 * LinkedIn slug (the same person found by Exa, or already warm from Airtable).
 *
 * Relationship facts always refresh — they come from the book and the book is the
 * authority on them. An existing warm row keeps its tier and its Airtable provenance;
 * an existing cold row is promoted when the book shows a real relationship, because
 * a web search finding someone first does not make Danny a stranger to them.
 * Identity fields are only filled, never overwritten.
 */
function upsertNetworkCandidate(userId, row) {
  let existing = db.prepare('SELECT id, tier, source, current_role, current_company, headline, linkedin_url, il_tie_type FROM hiring_candidates WHERE user_id = ? AND external_id = ?').get(userId, row.external_id);
  if (!existing && row.linkedin_url) {
    const slug = slugOf(row.linkedin_url);
    if (slug) {
      existing = db.prepare("SELECT id, tier, source, current_role, current_company, headline, linkedin_url, il_tie_type FROM hiring_candidates WHERE user_id = ? AND is_deleted = 0 AND lower(linkedin_url) LIKE ?")
        .all(userId, `%/in/${slug}%`)
        .find((r) => slugOf(r.linkedin_url) === slug);
    }
  }

  if (existing) {
    const sets = { warmth: row.warmth, warmth_tier: row.warmth_tier, network_person_id: row.network_person_id, superior_connection: row.superior_connection };
    if (existing.tier !== 'warm' && row.tier === 'warm') { sets.tier = 'warm'; sets.warm_source = row.warm_source; }
    for (const k of ['current_role', 'current_company', 'headline', 'linkedin_url']) if (!existing[k] && row[k]) sets[k] = row[k];
    if (!existing.il_tie_type && row.il_tie_type) Object.assign(sets, { il_tie_type: row.il_tie_type, il_tie_place: row.il_tie_place, il_tie_evidence: row.il_tie_evidence });
    const cols = Object.keys(sets);
    db.prepare(`UPDATE hiring_candidates SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...cols.map((c) => sets[c] ?? null), existing.id);
    return { id: existing.id, result: 'updated' };
  }

  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO hiring_candidates (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(userId, ...cols.map((c) => row[c] ?? null));
  return { id: info.lastInsertRowid, result: 'inserted' };
}

/**
 * Pull the people in Danny's book who plausibly fit this role into the hiring pool.
 * @returns {{ ids: number[], considered, qualified, warm, inserted, updated, skipped?: string }}
 */
function sourceFromNetwork({ userId = 1, role, limit = 30, deps = {} }) {
  const book = (deps.loadBook || loadBook)(userId);
  if (!book.length) return { ids: [], considered: 0, qualified: 0, warm: 0, inserted: 0, updated: 0, skipped: 'Network book is empty — upload a LinkedIn export on the Network page' };

  const r = matchNeed(roleAsNeed(role), book, { limit });
  const out = { ids: [], considered: r.considered, qualified: r.qualified, warm: 0, inserted: 0, updated: 0 };
  for (const m of r.results) {
    if (!m.name) continue;
    const row = rowFromMatch(m);
    const { id, result } = upsertNetworkCandidate(userId, row);
    out.ids.push(Number(id));
    out[result]++;
    if (row.tier === 'warm') out.warm++;
  }
  return out;
}

module.exports = { sourceFromNetwork, roleAsNeed, rowFromMatch, upsertNetworkCandidate, WARM_TIERS };
