// ══════════════════════════════════════════════════════════════════════════
// company-enrich.js — the company half of enrichment. None of this existed.
//
// Danny, 2026-07-15: "I want the same level of insight (for example, company
// pages on LinkedIn show how many people work there and have been hired at these
// companies over time). You can see where the founders previously worked, etc.
// I'll pay for enrichment."
//
// Only PERSON enrichment was wired (linkedin-enrich.js -> /api/v2/profile).
// Company-level data — headcount, growth, funding — was nowhere in the codebase.
//
// ── THE CONTRACT, verified against EnrichLayer's live docs 2026-07-15 ──
// Not assumed. The USPTO connector in this same repo calls an endpoint that has
// never existed and returns 0 forever because nobody checked, and the Form D
// connector shipped `locationCode` (singular) which EDGAR silently ignores —
// returning identical nationwide results for every state. Two bugs, one cause:
// an endpoint written from memory. So every path and parameter below is quoted
// from the docs.
//
//   GET /api/v2/company
//     url* , funding_data=include (+1cr), exit_data, acquisitions, extra, use_cache
//     -> company_size [min,max], company_size_on_linkedin, founded_year,
//        industry, hq{}, funding_data
//
//   GET /api/v2/company/employees/count
//     url* , at_date=YYYY-MM-DD (+1cr Growth tier / +5cr otherwise),
//     employment_status=current|past|all, estimated_employee_count=include (+1cr)
//     -> { estimated_employee_count, verified_employee_count }
//
// Auth: `Authorization: Bearer <key>` on both. Base cost 1 credit each.
//
// ── HEADCOUNT OVER TIME IS N CALLS, NOT ONE ──
// The endpoint returns a SNAPSHOT. `at_date` time-travels to one date. So a
// growth curve is one call per point, and the cost is linear in resolution. We
// take 4 points over 12 months (now, -3, -6, -12) — enough to see a slope, cheap
// enough to run across the whole pipeline. Danny's read is "are they hiring?",
// which needs a direction, not a daily series.
// ══════════════════════════════════════════════════════════════════════════

const https = require('https');
const db = require('../db');

let resolveKey, recordCost;
try { ({ resolveKey, recordCost } = require('../lib/providerKeys')); }
catch { resolveKey = () => null; recordCost = () => {}; }

const BASE = 'https://enrichlayer.com';

// EnrichLayer bills in credits. usage_events stores DOLLARS. Converting at the
// boundary rather than at the call site is the whole reason the previous version
// would have logged a 50-person roster as $202 instead of $2.02.
const CREDIT_USD = 0.01;

function httpGetJson(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
        (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(out) }); }
            catch { resolve({ status: res.statusCode, data: null }); }
          });
        }
      );
      req.on('error', () => resolve({ status: 0, data: null }));
      req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, data: null }); });
      req.end();
    } catch { resolve({ status: 0, data: null }); }
  });
}

const iso = (d) => d.toISOString().slice(0, 10);
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return iso(d); };

// ══════════════════════════════════════════════════════════════════════════
// THE ROSTER — one call that replaces the whole at_date approach.
//
// Danny, on LinkedIn Premium's "400% employee growth" card: "They have employee
// growth data in LinkedIn. I think you can learn these insights cheaply."
//
// He was right, and I'd built it the expensive way. `at_date` buys ONE crude
// snapshot per credit and can never say who those people are. The employee
// listing costs 3cr/employee (+1 to enrich) and returns every employee's
// START DATE — from which the EXACT headcount at any date is arithmetic, free,
// forever. For a 2-10 person company (Danny's entire book) that's ~12-40 credits
// for strictly more than at_date could ever give:
//
//   · the exact curve, not 4 sampled points
//   · WHO each person is, and when they joined
//   · WHERE THEY WORKED BEFORE  <- Danny's explicit ask; at_date cannot answer it
//   · recent hires, which is LinkedIn's own card
//
// Verified live on Permute AI (2026-07-15), 3 employees, one call:
//   Scott Nelson   CEO,  joined 2025-07, prev: Density Collective, Scout Space
//   Eric Mills     CTO,  joined 2025-08, prev: Density Collective, BlackInk AI
//   Parsia Hedayat AI,   joined 2026-03, prev: Integral Ad Science
//
// Cost notes from the docs, which shape every default below:
//   sort_by (non-"none") is +50 base +10/employee — ruinous, and pointless when
//   we hold every start date and can sort in memory for free. Never send it.
//   page_size is capped at 10 when enriching, so >10 employees needs paging.
// ══════════════════════════════════════════════════════════════════════════

/** GET /api/v2/company/employees/ — the roster, with each person's history. */
async function fetchRoster(linkedinUrl, key, { deps = {}, pageSize = 10, enrich = true } = {}) {
  const get = deps.getJson || httpGetJson;
  const p = new URLSearchParams({
    url: linkedinUrl,
    use_cache: 'if-present',
    employment_status: 'current',
    page_size: String(pageSize),
  });
  if (enrich) p.set('enrich_profiles', 'enrich');
  // NOT sort_by — see the cost note above. We sort from starts_at ourselves.
  const { status, data } = await get(`${BASE}/api/v2/company/employees/?${p}`, {
    Authorization: `Bearer ${key}`,
  });
  if (status !== 200 || !data) return null;
  return Array.isArray(data.employees) ? data.employees : [];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Turn the raw roster into people + the exact headcount curve.
 * `companyName` is used to find each person's tenure AT THIS COMPANY inside their
 * experiences array — the API returns their whole history, not just this job.
 */
function rosterToPeople(employees, companyName) {
  const target = norm(companyName);
  const people = [];

  for (const e of employees || []) {
    const p = e.profile || {};
    const exps = Array.isArray(p.experiences) ? p.experiences : [];

    // Their job HERE. Match on normalised company name; fall back to the most
    // recent role with no end date, since the listing already told us they're
    // current — a name mismatch must not silently drop a real employee.
    const here =
      exps.find((x) => target && norm(x.company).includes(target)) ||
      exps.find((x) => !x.ends_at) ||
      null;

    const s = here?.starts_at;
    people.push({
      name: p.full_name || null,
      title: here?.title || p.occupation || null,
      linkedin_url: e.profile_url || p.public_identifier || null,
      joined: s?.year ? `${s.year}-${String(s.month || 1).padStart(2, '0')}` : null,
      // Where they were before. Danny: "You can see where the founders previously
      // worked." Deduped, this-company excluded, most recent first.
      previously: [
        ...new Set(
          exps
            .filter((x) => !(target && norm(x.company).includes(target)))
            .map((x) => x.company)
            .filter(Boolean)
        ),
      ].slice(0, 6),
      education: [...new Set((p.education || []).map((x) => x.school).filter(Boolean))].slice(0, 3),
    });
  }
  return people;
}

/**
 * The exact curve, derived from start dates. Zero extra API calls.
 * Returns one point per month for `months` back, plus the delta.
 */
// `now` is injectable so the curve is testable. It used to read the wall clock
// directly, which made the shape of the series depend on the day you ran it — the
// fixture test asserting delta === 2 passed until Scott's 2025-07 start date aged
// out of the trailing window, then failed for a reason that had nothing to do with
// the code. A function whose output changes overnight needs its clock passed in.
function curveFromPeople(people, { months = 12, asOf = new Date() } = {}) {
  const dated = people.filter((p) => p.joined);
  if (!dated.length) return null;

  const series = [];
  for (let i = months; i >= 0; i--) {
    const d = new Date(asOf.getTime());
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // Headcount at month M = everyone whose start month is <= M. Leavers are out
    // of scope: we asked for employment_status=current, so this is the curve of
    // the CURRENT team's arrival, not true historical headcount. Anyone who
    // joined and left is invisible here — which is why this is labelled
    // `team_arrival`, not `headcount`. Naming it honestly is the whole job.
    series.push({ at: key, count: dated.filter((p) => p.joined <= key).length });
  }

  const now = series[series.length - 1].count;
  const then = series[0].count;
  return { series, now, delta: now - then, months };
}


/** GET /api/v2/company — profile + optional funding. */
async function fetchCompanyProfile(linkedinUrl, key, { funding = true, deps = {} } = {}) {
  const get = deps.getJson || httpGetJson;
  const p = new URLSearchParams({ url: linkedinUrl, use_cache: 'if-present' });
  if (funding) p.set('funding_data', 'include');
  const { status, data } = await get(`${BASE}/api/v2/company?${p}`, { Authorization: `Bearer ${key}` });
  return status === 200 && data ? data : null;
}

/** GET /api/v2/company/employees/count at one date. Omit `at` for today. */
async function fetchHeadcountAt(linkedinUrl, key, at = null, { deps = {} } = {}) {
  const get = deps.getJson || httpGetJson;
  const p = new URLSearchParams({ url: linkedinUrl, use_cache: 'if-present', estimated_employee_count: 'include' });
  if (at) p.set('at_date', at);
  const { status, data } = await get(`${BASE}/api/v2/company/employees/count?${p}`, {
    Authorization: `Bearer ${key}`,
  });
  if (status !== 200 || !data) return null;
  // Prefer verified; fall back to estimated. Record WHICH — a verified 12 and an
  // estimated 12 are not the same claim, and a growth curve that silently mixes
  // them is a curve that can move without anyone being hired.
  const n = data.verified_employee_count ?? data.estimated_employee_count ?? null;
  if (n == null) return null;
  return { at: at || iso(new Date()), count: n, verified: data.verified_employee_count != null };
}

/**
 * The headcount curve. 4 points over 12 months.
 *
 * Returns { series, now, growth_12mo_pct, hiring } where `hiring` is a direction,
 * not a score. Deliberately coarse: Danny's question is "are they hiring?", and a
 * 3-person company going to 5 is +67% — a percentage on tiny numbers is noise
 * wearing precision's clothes. So the DELTA is reported alongside, and a slope
 * from fewer than 2 real points is null rather than 0.
 */
async function fetchHeadcountSeries(linkedinUrl, key, { deps = {}, points = [0, 3, 6, 12] } = {}) {
  const series = [];
  for (const m of points) {
    const pt = await fetchHeadcountAt(linkedinUrl, key, m === 0 ? null : monthsAgo(m), { deps });
    if (pt) series.push({ ...pt, months_ago: m });
  }
  if (!series.length) return null;

  const now = series.find((s) => s.months_ago === 0) || series[0];
  const oldest = series[series.length - 1];
  const span = oldest.months_ago - now.months_ago;

  // Null, not 0, when there's nothing to compare. An unmeasured company is not a
  // flat company — the same rule the conviction engine enforces on evidence.
  let growth = null, delta = null;
  if (series.length >= 2 && span > 0 && oldest.count > 0) {
    delta = now.count - oldest.count;
    growth = Math.round((delta / oldest.count) * 100);
  }

  // ── Suppress the percentage at pre-seed scale. ──
  // The first live run proved this: Permute went 1 -> 2 -> 3 -> 3 over 12 months
  // and the honest arithmetic is "+200% growth". True, and useless — they hired
  // two people. Danny's whole book is 2-10 person companies, so a percentage off
  // a base this small will ALWAYS be noise, and a number that reads as precise
  // while meaning nothing is worse than no number: it invites a comparison
  // between a 1->3 and a 40->120 that the arithmetic supports and reality does
  // not.
  //
  // So below a base of 5, the percentage is withheld and the DELTA is the
  // headline. "+2 people" is the whole truth about a seed-stage hire.
  const PCT_MIN_BASE = 5;
  const pctIsMeaningful = oldest.count >= PCT_MIN_BASE;

  return {
    series: series.sort((a, b) => b.months_ago - a.months_ago),
    now: now.count,
    verified: now.verified,
    // The headline at this stage. Always report the count of humans.
    delta_12mo: delta,
    // Null when the base is too small to carry a ratio. Not zero — unknowable.
    growth_12mo_pct: pctIsMeaningful ? growth : null,
    pct_suppressed: delta != null && !pctIsMeaningful ? `base of ${oldest.count} is too small for a percentage` : null,
    hiring: delta == null ? null : delta > 0 ? 'growing' : delta < 0 ? 'shrinking' : 'flat',
  };
}

/**
 * Enrich one company. Returns the blob we persist, or null if nothing came back.
 * Never throws — an enrichment failure must not take down a page load.
 */
async function enrichCompany(linkedinUrl, { userId = 1, deps = {}, withSeries = true } = {}) {
  // `'key' in deps` — NOT `deps.key || resolveKey(...)`.
  //
  // The || form cannot express "no key": passing key:null falls through to the
  // database and finds the real one, so a caller trying to run dormant makes a
  // live billable call instead. The dormancy test passed for a year only because
  // no key was configured; the moment Danny's landed on 2026-07-15 it went red
  // and exposed this. A test that only passes when a feature is switched off is
  // not testing the feature.
  const key = 'key' in deps ? deps.key : resolveKey ? resolveKey(userId, 'enrichlayer') : null;
  if (!key || !linkedinUrl) return null;

  const profile = await fetchCompanyProfile(linkedinUrl, key, { deps });
  if (!profile) return null;

  // The roster replaces the at_date sampling entirely: one call yields the exact
  // curve AND who each person is AND where they worked before. fetchHeadcountAt /
  // fetchHeadcountSeries are kept for the rare big company where 3cr/employee
  // beats a handful of snapshots, but they are no longer the default path.
  let people = null, curve = null;
  if (withSeries) {
    const raw = await fetchRoster(linkedinUrl, key, { deps });
    if (raw && raw.length) {
      people = rosterToPeople(raw, profile.name || null);
      curve = curveFromPeople(people);
    }
  }

  // ── Cost, recorded properly. My previous version recorded NOTHING. ──
  //
  // It called `recordCost(userId, 'enrichlayer', credits)` — positional args
  // against a signature that destructures an object:
  //     recordCost(userId, { provider, feature, estCostUsd, count })
  // So `provider` destructured off the string 'enrichlayer' → undefined → the
  // INSERT hit `NOT NULL constraint failed: usage_events.provider` → swallowed by
  // BOTH my try/catch and recordCost's own. Zero rows, silently, forever. The
  // comment above it read "Recorded so the spend cap is real rather than
  // decorative" and it was neither.
  //
  // And the second bug behind the first: `credits` would have landed in
  // estCostUsd, so a 50-person roster would have recorded $202 instead of $2.02.
  // EnrichLayer bills in credits (~$0.01 each); usage_events stores DOLLARS.
  if (recordCost) {
    const credits = 2 + (people ? people.length * 4 : 0);
    try {
      recordCost(userId, {
        provider: 'enrichlayer',
        feature: 'company-enrich',
        estCostUsd: credits * CREDIT_USD,
      });
    } catch { /* metering must never break a request */ }
  }

  return {
    fetched_at: new Date().toISOString(),
    name: profile.name || null,
    tagline: profile.tagline || null,
    description: profile.description || null,
    website: profile.website || null,
    industry: profile.industry || null,
    founded_year: profile.founded_year || null,
    // company_size is a [min,max] RANGE; company_size_on_linkedin is an integer.
    // They disagree constantly. Keep both rather than pick — the range is
    // LinkedIn's self-reported bucket, the integer is the actual profile count.
    size_range: profile.company_size || null,
    size_on_linkedin: profile.company_size_on_linkedin ?? null,
    hq: profile.hq || null,
    linkedin_url: linkedinUrl,
    funding: profile.funding_data || null,
    // The team, by name, with tenure and history. This is the thing worth having.
    people,
    // Named `team_arrival`, not `headcount`. It's built from CURRENT employees'
    // start dates, so anyone who joined and left is invisible. Calling it
    // headcount would be a quiet lie of exactly the kind this codebase keeps
    // getting burned by.
    team_arrival: curve,
    verified_count: people ? people.length : null,
  };
}

/** Persist onto a founder row. Column added lazily in db.js. */
function saveCompanyEnrichment(founderId, blob) {
  // The blob stays — the card reads it and should show the newest reading.
  db.prepare('UPDATE founders SET company_enrichment = ?, company_enriched_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(blob), founderId);

  // ...but this UPDATE used to be the ONLY write, which made every refetch a
  // permanent deletion of the previous reading. 44 companies were enriched on
  // 2026-07-16 and the next run would have destroyed all of it. Headcount over
  // time is the thing Danny asked for on day one and the one asset that cannot be
  // bought or backfilled — see the note in db.js. Append first, then overwrite.
  try {
    require('../lib/snapshots').recordSnapshot({ founderId, source: 'enrichlayer', blob });
  } catch (e) {
    // Never let the history write break the fetch Danny paid credits for.
    console.error('[Snapshot] enrichlayer:', e.message);
  }
}

function getCompanyEnrichment(founderId) {
  const r = db.prepare('SELECT company_enrichment FROM founders WHERE id = ?').get(founderId);
  if (!r?.company_enrichment) return null;
  try { return JSON.parse(r.company_enrichment); } catch { return null; }
}

module.exports = {
  enrichCompany,
  fetchCompanyProfile,
  // The roster path — the default. One call: curve + people + prior employers.
  fetchRoster,
  rosterToPeople,
  curveFromPeople,
  // The at_date path — retained for large companies where 3cr/employee is worse
  // than a few snapshots. Not used by enrichCompany.
  fetchHeadcountAt,
  fetchHeadcountSeries,
  saveCompanyEnrichment,
  getCompanyEnrichment,
};
