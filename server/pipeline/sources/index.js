/**
 * sources/index.js — the SourceConnector registry + one shared ingest pipeline.
 *
 * Every early-signal source (USPTO trademarks today; SBIR/grants, OpenCorporates, CT
 * logs next) implements a tiny connector { key, label, emits, free, cadence, fetch }.
 * They all flow through ONE pipeline here, so each new source inherits geo-filtering,
 * enrichment, dedup, and persistence for free:
 *
 *   fetch → normalize → geo-filter → enrich (user key) → dedup → persist to the queue
 *
 * Geo-filter honors the user's own criteria (owner = hard Chicago/IL tie; none = open),
 * exactly like discovery. Persisted records carry the connector's signal + its evidence.
 */
const db = require('../../db');
const { userGeoCriteria, geoPartition, hasPreference } = require('../../lib/geoFilter');
const { loadUserApiKeys, assertWithinBudget } = require('../../lib/providerKeys');

const REGISTRY = {};
function register(connector) { REGISTRY[connector.key] = connector; return connector; }
function get(key) { return REGISTRY[key]; }
function list() {
  return Object.values(REGISTRY).map(({ key, label, emits, free, cadence }) => ({
    key, label, emits, free: !!free, cadence: cadence || 'daily',
  }));
}

// ══════════════════════════════════════════════════════════════════════
// A PROGRAM IS NOT A COMPANY.
//
// The cohort connectors resolve people who are IN a program, so the program's name
// is all over their search result. lib/cohortDiscovery no longer puts it in the
// headline (that was the original bug), but the enrichment pass reads whatever text
// exists and can still answer `company: "Z Fellows"` for someone whose bio is mostly
// the fellowship. That produced rows like "Cory Levy | Z Fellows" — he runs it.
//
// So the last thing before persist is a check against the connector's OWN label and
// the handful of program names the enricher actually returns. Nulling the field is
// the honest outcome: we do not know what they're building, and an empty company
// column says that. The program itself is already carried in `evidence` and in the
// `source` column, so nothing is lost.
// ══════════════════════════════════════════════════════════════════════
const PROGRAM_NAMES = new Set([
  'y combinator', 'yc', 'a16z speedrun', 'speedrun', 'thiel fellowship', 'thiel fellows',
  'z fellows', 'zfellows', 'neo', 'neo scholars', 'the residency', 'emergent ventures',
  'techstars', 'on deck', 'entrepreneur first', 'antler', 'south park commons',
]);
const normCo = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function scrubProgramCompany(rows, connector) {
  if (!Array.isArray(rows)) return rows;
  const own = normCo(connector && connector.label);
  for (const p of rows) {
    const co = normCo(p.company);
    if (!co) continue;
    if (co === own || PROGRAM_NAMES.has(co)) p.company = null;
  }
  return rows;
}

// Run one connector for a user. fetch → geo-filter → enrich → dedup → persist.
async function ingest(key, { userId, since = null, enrich = true, persist = true, limit = 50, deps = {} } = {}) {
  const c = REGISTRY[key];
  if (!c) throw Object.assign(new Error(`Unknown source: ${key}`), { status: 404 });
  assertWithinBudget(userId); // throws SpendCapError if the user is over their daily cap

  const criteria = userGeoCriteria(userId);
  const keys = loadUserApiKeys(userId);

  // 1. Fetch raw records (connector-specific, defensive — a failure yields 0, never throws).
  let raw = [];
  try { raw = (await c.fetch({ since, criteria, keys, limit, deps, userId })) || []; }
  catch (e) { return { source: key, fetched: 0, geoKept: 0, enriched: false, persisted: 0, error: e.message }; }

  // 2. Normalize each RawRecord to the common profile shape.
  let profiles = raw.map(r => ({
    name: r.name || null,
    company: r.entity_name || r.company || null,
    role: r.role || null,
    headline: r.headline || r.entity_name || null,
    bio: r.evidence || '',
    linkedin_url: r.linkedin_url || null,
    website_url: r.url || null,
    location_city: r.location_city || null,
    location_state: r.location_state || null,
    _evidence: r.evidence || null,
  }));

  // 3. Partition by geo. Verified ties → deal pipeline; the rest → national frontier watch
  //    (only for connectors that opt in via `nationalWatchlist` AND when the user actually
  //    has a geo preference — otherwise broad mode already passed everyone into `passed`).
  const { passed, rejected } = geoPartition(profiles, criteria);
  const watchOptIn = !!c.nationalWatchlist && hasPreference(criteria);
  const pipelineRows = passed;
  const watchRows = watchOptIn ? rejected : [];
  const geoKept = pipelineRows.length;

  // ══════════════════════════════════════════════════════════════════════
  // 4. DEDUP FIRST, THEN ENRICH. The order here is the whole cost story.
  //
  // This used to enrich everything and THEN check for duplicates at persist —
  // paying an LLM to describe 144 YC founders every night, then discarding all
  // 144 because they were already in the table from the night before.
  //
  // Only a16z-speedrun.js had a DB-level seen-check. yc-directory and
  // pre-program build a `seen` Set that is within-batch only — it never queries
  // sourced_founders — and il-school-discovery, cohort-rosters and
  // uspto-trademark have none at all. So once the sources saturate (they have:
  // 647 rows), the 11:30 cron was ~$0.55/day of Anthropic spend buying zero new
  // rows. $16.50/month, forever, for nothing.
  //
  // Now the dupe check runs BEFORE the money. The lookups are the same three
  // prepared statements persist uses — hoisted, so there is exactly one
  // definition of "already have this" and the two can't drift apart.
  // ══════════════════════════════════════════════════════════════════════
  const byLinkedin = db.prepare('SELECT id FROM sourced_founders WHERE user_id = ? AND LOWER(linkedin_url) = LOWER(?)');
  const byWebsite = db.prepare('SELECT id FROM sourced_founders WHERE user_id = ? AND LOWER(website_url) = LOWER(?)');
  const byIdentity = db.prepare("SELECT id FROM sourced_founders WHERE user_id = ? AND source = ? AND LOWER(name) = LOWER(?) AND LOWER(IFNULL(company,'')) = LOWER(?)");
  const isDupe = (p) => {
    if (p.linkedin_url) return !!byLinkedin.get(userId, p.linkedin_url);
    if (p.website_url) return !!byWebsite.get(userId, p.website_url);
    return !!byIdentity.get(userId, c.key, p.name || p.company || 'Unknown', p.company || '');
  };

  const pipelineNew = pipelineRows.filter((p) => !isDupe(p));
  const watchNew = watchRows.filter((p) => !isDupe(p));
  const skippedAsDupe = (pipelineRows.length - pipelineNew.length) + (watchRows.length - watchNew.length);

  // 5. Enrich + score on the user's key — ONLY the rows we're actually keeping.
  //    Pipeline and watch are enriched independently so their scope tags stay 1:1.
  let enriched = false;
  async function enrichGroup(rows) {
    if (!enrich || !rows.length) return rows;
    const e = await require('../enrichment').enrichProfiles(userId, rows, { feature: `source:${c.key}` });
    if (e) { enriched = true; return e; }
    return rows;
  }
  const pipelineEnriched = scrubProgramCompany(await enrichGroup(pipelineNew), c);
  const watchEnriched = scrubProgramCompany(await enrichGroup(watchNew), c);

  // 6. Persist, tagged by scope. isDupe still runs here as well as above — the
  //    two calls are cheap SELECTs, and re-checking closes the window where a
  //    concurrent run inserted the same row while we were paying to enrich it.
  let persisted = 0, watchlisted = 0;
  if (persist) {
    const insert = db.prepare(`INSERT INTO sourced_founders
      (user_id, name, company, role, headline, linkedin_url, website_url, source, status, builder_signals, signal_captured_at, unicorn_score, enrichment, company_one_liner, chicago_connection, location_type, list_scope, breakout_score, breakout_signals)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const persistRows = db.transaction((rows, scope) => {
      let n = 0;
      for (const p of rows) {
        try {
          if (isDupe(p)) continue;
          const enr = JSON.stringify({ summary: p.summary || null, why: p.why || null, contactability: p.contactability || null, evidence: p._evidence || null });
          // location_type is what the Pipeline/queue display filter reads (VALID_TIE_TYPES);
          // write the verified IL tie type so IL-tied cohort/YC founders actually surface.
          const tieType = (p.tie && p.tie.type && p.tie.type !== 'broad') ? p.tie.type : null;
          // NO SECOND SCORER HERE. This used to compute a `breakoutScore` — a regex over
          // a text blob that rewarded a technical title, the word "dropped out", and an
          // elite school, then sat in the API payload next to fit_tier as a competing
          // opinion. Every one of those three is contradicted by outcome data (about
          // half of unicorn founding CEOs are non-technical; the median founder is 34,
          // not a dropout; school splits ~36/28/36 across top-10 / middle / outside
          // top-100). lib/founderFit is the one ranking, and lib/fitIndex writes it
          // right after this — with structured LinkedIn employment instead of a blob.
          insert.run(userId, p.name || p.company || 'Unknown', p.company || null, p.role || null, p.headline || null,
            p.linkedin_url || null, p.website_url || null, c.key, JSON.stringify([c.emits]),
            p.unicorn_score ?? null, enr, p.why || null, p.chicago_connection || null, tieType, scope,
            null, null);
          n++;
        } catch { /* skip dupes/bad rows */ }
      }
      return n;
    });
    persisted = persistRows(pipelineEnriched, 'pipeline');
    watchlisted = persistRows(watchEnriched, 'watchlist');
  }

  // `skippedAsDupe` is reported so the saving is VISIBLE. Once a source
  // saturates, a healthy run looks like "fetched 144, skipped 144, spent $0" —
  // and without that number it's indistinguishable from a broken connector. The
  // cron writes this into its ledger line.
  // Score what just landed. Same reason as the sweep: the inbox reads a stored
  // verdict, and an unscored row is invisible in every filtered view.
  if (persisted || watchlisted) {
    try { require('../../lib/fitIndex').rescoreStale({ userId }); }
    catch (e) { console.error(`[Sources][${key}] fit scoring failed (rows still saved):`, e.message); }
  }

  return {
    source: key, fetched: raw.length, geoKept, watchlisted, enriched, persisted,
    skippedAsDupe,
    results: pipelineEnriched.slice(0, limit),
  };
}

// Run every registered connector for a user (used by the daily cron). Dormant connectors
// (e.g. USPTO without a key) simply return 0 and are harmless.
async function ingestAll({ userId, since = null } = {}) {
  const out = [];
  for (const key of Object.keys(REGISTRY)) {
    try { out.push(await ingest(key, { userId, since })); }
    catch (e) { out.push({ source: key, error: e.message }); }
  }
  return out;
}

// ── Register connectors ──
register(require('./uspto-trademark'));
register(require('./yc-directory'));
register(require('./a16z-speedrun')); // directory-based (structured API), like YC
register(require('./il-school-discovery')); // highest-yield IL source: school-anchored search
register(require('./pre-program-discovery')); // Breakout Radar: elite pedigree, no program tag yet
for (const c of require('./cohort-rosters').connectors) register(c);

module.exports = { register, get, list, ingest, ingestAll, REGISTRY };
