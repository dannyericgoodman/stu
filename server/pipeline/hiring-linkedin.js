'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-linkedin.js — read the real LinkedIn profile of the candidates worth reading.
//
// Sourcing has done this for founders since July (pipeline/linkedin-enrich.js, via
// EnrichLayer). Hiring never did: it judged people from a 1,200-character search
// excerpt, which is a headline and a paragraph — no work history, no certifications,
// no dates. You cannot tell whether someone has "2+ years of case management" from
// that, and the grader should not be asked to.
//
// Targeted, capped, cached — the same three properties as the founder version:
//   · targeted  the caller passes the candidates most worth reading, in priority order;
//   · capped    at most `limit` per run (default 40, ~$0.40 at EnrichLayer's rate);
//   · cached    a profile read within FRESH_DAYS is not paid for again.
//
// It also re-checks the Illinois tie on the LinkedIn text. An IL-only role hard-filters
// on a verified tie, and a search excerpt often omits location that the profile
// states plainly — that is the "buried tie" failure the founder enricher was built
// for. A tie is only ever ADDED here; a profile that happens not to mention Chicago
// never removes one verified elsewhere.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { resolveKey, recordCost } = require('../lib/providerKeys');
const { fetchProfile } = require('./linkedin-enrich');
const { verifyIlTie } = require('../lib/ilTie');
const { linkedinText, runPool } = require('../lib/hiringGrade');

const FRESH_DAYS = 30;
const CONCURRENCY = 5;
const COST_PER_PROFILE = 0.01;

/** Is a stored read recent enough to reuse? Pure, for tests. */
function isFresh(enrichedAt, now = new Date()) {
  if (!enrichedAt) return false;
  const t = new Date(String(enrichedAt).replace(' ', 'T') + (String(enrichedAt).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(t.getTime())) return false;
  return (now.getTime() - t.getTime()) < FRESH_DAYS * 86400000;
}

/**
 * What to write back for one profile. Pure: profile in, column updates out.
 * Never nulls a field we already had, and never removes an IL tie.
 */
function updatesFromProfile(cand, profile) {
  const out = { linkedin_data: JSON.stringify(profile || {}) };
  if (!profile) return out;
  const exps = Array.isArray(profile.experiences) ? profile.experiences : [];
  const current = exps.find((e) => e && !e.ends_at) || exps[0] || null;
  if (!cand.current_role && current && current.title) out.current_role = String(current.title).slice(0, 200);
  if (!cand.current_company && current && current.company) out.current_company = String(current.company).slice(0, 200);
  if (!cand.headline && profile.headline) out.headline = String(profile.headline).slice(0, 240);
  if (!cand.location_city && profile.city) out.location_city = String(profile.city).slice(0, 120);
  if (!cand.location_state && profile.state) out.location_state = String(profile.state).slice(0, 120);

  if (!cand.il_tie_type) {
    const loc = [profile.city, profile.state].filter(Boolean).join(', ');
    const tie = verifyIlTie([loc ? `Based in ${loc}.` : '', linkedinText(profile)].filter(Boolean).join(' '));
    if (tie.verified && !tie.weak) {
      out.il_tie_type = tie.type;
      out.il_tie_place = tie.place;
      out.il_tie_evidence = `LinkedIn: ${tie.evidence}`;
    }
  }
  return out;
}

/**
 * Read LinkedIn for up to `limit` of the given candidates (already in priority order).
 * @returns {{ enriched, reused, failed, ties_added, skipped?: string }} — never throws.
 */
async function enrichCandidatesForRole({ userId = 1, candidates, limit = 40, deps = {} }) {
  const key = 'enrichKey' in deps ? deps.enrichKey : resolveKey(userId, 'enrichlayer');
  const fetch = deps.fetchProfile || ((url) => fetchProfile(url, key));
  const out = { enriched: 0, reused: 0, failed: 0, ties_added: 0 };
  if (!key && !deps.fetchProfile) return { ...out, skipped: 'no EnrichLayer key' };

  const withUrl = candidates.filter((c) => c && /linkedin\.com\/in\//i.test(String(c.linkedin_url || '')));
  const todo = [];
  for (const c of withUrl) {
    if (isFresh(c.linkedin_enriched_at, deps.now)) { out.reused++; continue; }
    if (todo.length >= limit) break;
    todo.push(c);
  }

  await runPool(todo.map((c) => async () => {
    let profile = null;
    try { profile = await fetch(c.linkedin_url); } catch { profile = null; }
    if (userId != null) recordCost(userId, { provider: 'enrichlayer', feature: 'hiring_linkedin', estCostUsd: COST_PER_PROFILE });
    if (!profile) {
      // Stamp the attempt so a dead or private profile is not re-paid on every run.
      db.prepare('UPDATE hiring_candidates SET linkedin_enriched_at = CURRENT_TIMESTAMP WHERE id = ?').run(c.id);
      out.failed++;
      return;
    }
    const u = updatesFromProfile(c, profile);
    if (u.il_tie_type) out.ties_added++;
    const cols = Object.keys(u);
    db.prepare(`UPDATE hiring_candidates SET ${cols.map((k) => `${k} = ?`).join(', ')}, linkedin_enriched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...cols.map((k) => u[k]), c.id);
    out.enriched++;
  }), CONCURRENCY);

  return out;
}

module.exports = { enrichCandidatesForRole, updatesFromProfile, isFresh, FRESH_DAYS };
