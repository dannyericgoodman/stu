/**
 * a16z-speedrun.js — SourceConnector for the a16z Speedrun accelerator, directory-based.
 *
 * Unlike the fragile web-search cohort connectors, Speedrun publishes a clean, stable REST API
 * (the backend behind speedrun.a16z.com/companies) that returns every company WITH its founders
 * embedded — name, title, a real bio (`introduction`), LinkedIn, and the company's city/state and
 * cohort. So we resolve Speedrun to FOUNDER level exactly like YC: each founder's bio + company
 * location flow through the shared geo gate to detect an Illinois tie (school/hometown/work), and
 * IL-tied founders land in the pipeline while the rest go to the national frontier watch.
 *
 * Free, no key, no scraping guesswork. Defaults to the most recent cohorts (the "before they're
 * known" window); older cohorts are available via SPEEDRUN_COHORTS. Already-ingested founders are
 * skipped so the daily run never re-enriches the same person.
 */
const https = require('https');

const API = process.env.SPEEDRUN_API || 'https://speedrun-be.a16z.com/api/companies/companies/';
// Recent cohorts by default (SR006 is newest). Set SPEEDRUN_COHORTS='' to ingest all.
// Default: the LATEST three cohorts the API itself reports. This was hard-coded to
// SR004–006, so every cohort a16z ran after the line was written was silently skipped
// (2026-11 sourcing inspection). An explicit SPEEDRUN_COHORTS still wins.
const COHORTS = process.env.SPEEDRUN_COHORTS
  ? process.env.SPEEDRUN_COHORTS.split(',').map(s => s.trim()).filter(Boolean)
  : 'auto';
const AUTO_LATEST = 3;
function latestCohorts(codes, n = AUTO_LATEST) {
  const num = (c) => { const m = /(\d+)/.exec(String(c || '')); return m ? parseInt(m[1], 10) : -1; };
  return [...new Set(codes.filter(Boolean))].sort((a, b) => num(b) - num(a)).slice(0, n);
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'SuperiorStudios-Stu/1.0', Accept: 'application/json', ...headers } }, (res) => {
        let out = ''; res.on('data', c => out += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, data: null }); } });
      });
      req.on('error', () => resolve({ status: 0, data: null })); req.end();
    } catch { resolve({ status: 0, data: null }); }
  });
}

// One Speedrun founder (within a company) → a founder-level RawRecord.
function normalizeFounder(company, f) {
  if (!company || !f) return null;
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ').trim();
  if (!name) return null;
  const cohort = company.cohort || '';
  return {
    name,
    entity_name: null,
    company: company.name || null,
    role: f.title || 'Founder',
    headline: `${f.title || 'Founder'}, ${company.name || ''}${cohort ? ` (a16z Speedrun ${cohort})` : ''}`.trim(),
    // Founder bio drives the IL tie (school/hometown/prior work), like a YC founder bio.
    bio: [f.introduction, company.description].filter(Boolean).join(' · ').slice(0, 1000),
    location_city: company.city || null,
    location_state: company.state || null,
    linkedin_url: f.linkedin_url || null,
    website_url: null, // co-founders share the company site; keep it off so dedup keeps both
    url: f.linkedin_url || (company.slug && f.slug ? `https://speedrun.a16z.com/companies/${company.slug}/${f.slug}` : company.website_url || null),
    evidence: `a16z Speedrun ${cohort} · ${company.name} · ${name}: ${(f.introduction || '').slice(0, 140)}`.trim(),
    raw: { company: company.slug, founder: f.slug, cohort },
  };
}

// Page through the API, collecting founder records from the requested cohorts.
async function fetchAll({ deps = {}, cohorts = COHORTS } = {}) {
  const getJson = deps.getJson || httpGetJson;
  const companies = [];
  let url = `${API}?limit=100&offset=0&ordering=name`;
  let guard = 0;
  while (url && guard++ < 25) {
    const { status, data } = await getJson(url);
    if (status !== 200 || !data) break;
    companies.push(...(data.results || []));
    url = data.next || null;
  }
  const wanted = cohorts === 'auto' ? latestCohorts(companies.map((c) => c.cohort)) : cohorts;
  const out = [];
  for (const c of companies) {
    if (wanted.length && !wanted.includes(c.cohort)) continue;
    for (const f of (c.founder_set || [])) { const r = normalizeFounder(c, f); if (r) out.push(r); }
  }
  return out;
}

// Skip founders already ingested for this user (so we don't re-enrich known people every run).
function loadSeen(db, userId) {
  const seen = new Set();
  if (!db || userId == null) return seen;
  try {
    const rows = db.prepare("SELECT LOWER(linkedin_url) li, LOWER(name) nm, LOWER(IFNULL(company,'')) co FROM sourced_founders WHERE user_id = ? AND source = 'a16z_speedrun'").all(userId);
    for (const r of rows) { if (r.li) seen.add('li:' + r.li); seen.add('nc:' + r.nm + '|' + r.co); }
  } catch { /* ignore */ }
  return seen;
}

async function fetch({ deps = {}, userId, opts = {} } = {}) {
  const cohorts = opts.cohorts || COHORTS;
  const recs = await fetchAll({ deps, cohorts });
  const db = deps.db !== undefined ? deps.db : (() => { try { return require('../../db'); } catch { return null; } })();
  const seen = loadSeen(db, userId);
  if (!seen.size) return recs;
  return recs.filter(r => {
    const li = r.linkedin_url ? 'li:' + r.linkedin_url.toLowerCase() : null;
    if (li && seen.has(li)) return false;
    if (seen.has('nc:' + (r.name || '').toLowerCase() + '|' + (r.company || '').toLowerCase())) return false;
    return true;
  });
}

module.exports = {
  key: 'a16z_speedrun',
  label: 'a16z Speedrun',
  emits: 'a16z_speedrun',
  free: true,
  cadence: 'weekly',
  nationalWatchlist: true,
  fetch,
  // exported for tests
  normalizeFounder,
  fetchAll,
  latestCohorts,
};
