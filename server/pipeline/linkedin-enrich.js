/**
 * linkedin-enrich.js — the reliability lever: read each sourced founder's REAL LinkedIn (via
 * EnrichLayer) to (1) promote buried Illinois ties and (2) flag non-founder noise.
 *
 * Two failure modes this fixes, both seen in the live sprint:
 *   - Buried tie: a founder genuinely IL-rooted (Jensen — Aurora/Oswego) whose sourced bio was
 *     company-focused, so the geo gate missed the tie and dropped them to the national watchlist.
 *     Their LinkedIn plainly says the school/location → we detect it and PROMOTE them to the pipeline.
 *   - Noise: a professor/exec/investor the school-anchored search over-caught. Their LinkedIn shows
 *     they aren't actually building a company → we FLAG them so the pipeline stays clean.
 *
 * Targeted + capped + cached: watchlist rows first (most promotion upside), only rows with a
 * LinkedIn URL not already enriched, N per run. BYOK (EnrichLayer key), spend-capped; dormant
 * without a key. The `assessProfile` core is pure and unit-tested; the HTTP call is injectable.
 */
const https = require('https');
const db = require('../db');
const { userGeoCriteria } = require('../lib/geoFilter');
const { verifyLocation } = require('./sourcing-engine');

let resolveKey, recordCost;
try { ({ resolveKey, recordCost } = require('../lib/providerKeys')); } catch { resolveKey = () => null; recordCost = () => {}; }

function httpGetJson(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
        let out = ''; res.on('data', c => out += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, data: null }); } });
      });
      req.on('error', () => resolve({ status: 0, data: null })); req.end();
    } catch { resolve({ status: 0, data: null }); }
  });
}

async function fetchProfile(linkedinUrl, apiKey, deps = {}) {
  if (deps.fetchProfile) return deps.fetchProfile(linkedinUrl);
  if (!apiKey || !linkedinUrl) return null;
  // EnrichLayer v2 (Proxycurl-compatible): Bearer auth, /api/v2/profile. The old /v1 + x-api-key
  // path 404s now — verified live.
  const { status, data } = await httpGetJson(
    `https://enrichlayer.com/api/v2/profile?url=${encodeURIComponent(linkedinUrl)}&use_cache=if-present`,
    { Authorization: `Bearer ${apiKey}` });
  return status === 200 && data ? data : null;
}

const FOUNDER_TITLE = /\b(founder|co-?founder|ceo|cto|coo|building)\b/i;
// Primary identity that means "not a pre-seed founder we should surface".
const NON_FOUNDER = /\b(professor|lecturer|postdoc|phd student|partner at|general partner|venture partner|investor|analyst at|recruiter|consultant|advisor)\b/i;

// Pure core: given an EnrichLayer profile + IL criteria, decide tie + whether they're a founder.
// Returns { tie, isFounder, roleFlag, schools, city, state, title }.
function assessProfile(profile, criteria) {
  if (!profile) return { tie: { verified: false }, isFounder: false, roleFlag: 'no profile' };
  const schools = (profile.education || []).map(e => e && (e.school || e.school_name)).filter(Boolean);
  const city = profile.city || null;
  const state = profile.state || null;
  const exps = profile.experiences || profile.experience || [];
  const current = Array.isArray(exps) ? exps[0] : null;
  const title = (current && (current.title || current.role)) || profile.occupation || profile.headline || '';
  const company = (current && (current.company || current.company_name)) || '';

  // Text the geo gate reads — schools + a "Based in City, State" phrase are what promote a tie.
  const locPhrase = [city, state].filter(Boolean).length ? `Based in ${[city, state].filter(Boolean).join(', ')}. ` : '';
  const text = (locPhrase + [profile.headline, profile.summary, title, company, ...schools].filter(Boolean).join(' • ')).trim();
  const tie = verifyLocation(text, profile.headline || title || '', criteria);

  // Founder check: a current founder-ish title, and not primarily an academic/investor/etc.
  const roleText = `${title} ${profile.headline || ''} ${profile.occupation || ''}`;
  const isFounder = FOUNDER_TITLE.test(roleText) && !NON_FOUNDER.test(roleText);
  const roleFlag = isFounder ? null : `LinkedIn role: ${(title || profile.headline || 'unclear').slice(0, 60)}`;

  return { tie, isFounder, roleFlag, schools, city, state, title };
}

// The capped, cached DB pass. Returns a summary; never throws.
async function runLinkedInEnrichment({ userId = 1, limit = 25, deps = {} } = {}) {
  // `'enrichKey' in deps` — NOT `deps.enrichKey || resolveKey(...)`.
  //
  // The || form cannot express "no key". Passing enrichKey:null fell through to
  // the database, found the real key, and made live billable calls — the dormancy
  // test ran for 8.4 SECONDS against the network the moment Danny's key was
  // configured on 2026-07-15. It had passed for months only because no key
  // existed, i.e. it was asserting the absence of a key rather than the code's
  // handling of one. Identical bug lived in company-enrich.js; fixed there too.
  const key = 'enrichKey' in deps ? deps.enrichKey : resolveKey ? resolveKey(userId, 'enrichlayer') : null;
  if (!key && !deps.fetchProfile) return { skipped: 'no EnrichLayer key', enriched: 0, promoted: 0, flagged: 0 };

  const criteria = userGeoCriteria(userId);
  // Watchlist rows first (promotion upside), then pipeline (confirmation). Only un-enriched w/ a URL.
  const rows = db.prepare(`SELECT id, linkedin_url, list_scope FROM sourced_founders
    WHERE user_id = ? AND status = 'pending' AND linkedin_url IS NOT NULL AND linkedin_enriched_at IS NULL
    ORDER BY CASE WHEN list_scope = 'watchlist' THEN 0 ELSE 1 END, id DESC LIMIT ?`).all(userId, limit);

  const markEnriched = db.prepare("UPDATE sourced_founders SET linkedin_enriched_at = CURRENT_TIMESTAMP, linkedin_data = ? WHERE id = ?");
  const promote = db.prepare("UPDATE sourced_founders SET list_scope = 'pipeline', location_type = ?, chicago_connection = ? WHERE id = ?");
  const flag = db.prepare("UPDATE sourced_founders SET red_flags = ? WHERE id = ?");
  const rescore = db.prepare("UPDATE sourced_founders SET breakout_score = ?, breakout_signals = ? WHERE id = ?");

  let enriched = 0, promoted = 0, flagged = 0;
  for (const r of rows) {
    const profile = await fetchProfile(r.linkedin_url, key, deps);
    markEnriched.run(JSON.stringify(profile || {}), r.id);
    enriched++;
    if (userId != null) recordCost(userId, { provider: 'enrichlayer', feature: 'linkedin-enrich', estCostUsd: 0.01 });
    if (!profile) continue;
    const a = assessProfile(profile, criteria);
    // The re-score after enrichment now belongs to lib/fitIndex, which the nightly
    // scout runs immediately after this step (Arm 4) and which re-reads exactly the
    // rows enrichment just touched. Scoring here as well produced a SECOND, weaker
    // verdict from a flattened blob — the thing that made "hyperscale experience"
    // hallucinate off customer logos. founderFit reads experiences[] structurally.
    if (a.tie && a.tie.verified && a.tie.type !== 'broad' && r.list_scope === 'watchlist') {
      promote.run(a.tie.type, `${a.tie.type}: ${a.tie.location}`, r.id);
      promoted++;
    }
    if (!a.isFounder && a.roleFlag) { flag.run(JSON.stringify([a.roleFlag]), r.id); flagged++; }
  }
  return { enriched, promoted, flagged };
}

module.exports = { runLinkedInEnrichment, assessProfile, fetchProfile };
