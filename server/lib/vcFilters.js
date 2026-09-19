'use strict';
/**
 * vcFilters.js — best-effort stage / region / sector matchers for the MCP
 * VC-sourcing tools (get_outreach_list, search_sourced_founders).
 *
 * These make Stu's sourcing surface usable by ANY VC (stealth→growth, any
 * sector, any region), not just Danny's Chicago pre-seed lens. They are
 * deliberately PURE (no DB, no network) so they are cheap to unit-test.
 *
 * ── Honesty contract (do not overclaim in tool copy) ─────────────────────
 * sourced_founders has NO structured stage/region/sector columns. The matchers
 * infer from free text: location_city, headline, company, company_one_liner,
 * chicago_connection, and the engine-written tags JSON. Coverage is
 * best-effort by construction:
 *   - region:  matched against location_city + headline + tags; NOT a verified
 *              location. Distinct from illinois_tie, which IS a verified tie
 *              (lib/sourcingScope TIE_CLAUSE).
 *   - sector:  tags first (engine-written), then headline/company keywords.
 *   - stage:   inferred from stage mentions in profile text (stealth / pre-seed
 *              / seed / Series A / Series B-E / IPO). We NEVER invent a stage:
 *              rows with no detectable stage signal are skipped when you filter
 *              by stage.
 * Unknown slugs fall back to a word-boundary keyword match of the slug itself
 * (dashes become spaces), so agents can try regions/sectors we didn't curate.
 */

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRe(phrase) {
  return new RegExp(`\\b${esc(phrase).replace(/\s+/g, '\\s+')}\\b`, 'i');
}

// ── Regions ────────────────────────────────────────────────────────────────
// slug → location phrases that count as that region. Short tokens ('sf', 'la')
// are matched with word boundaries so they don't fire inside other words.
const REGIONS = {
  'sf-bay': ['san francisco', 'sf', 'bay area', 'silicon valley', 'palo alto', 'mountain view',
    'menlo park', 'san jose', 'berkeley', 'oakland', 'redwood city', 'sunnyvale', 'santa clara',
    'cupertino', 'fremont'],
  'nyc': ['new york', 'nyc', 'brooklyn', 'manhattan', 'queens', 'new york city'],
  'la': ['los angeles', 'la', 'santa monica', 'pasadena', 'culver city', 'venice beach'],
  'austin': ['austin', 'round rock'],
  'boston': ['boston', 'cambridge', 'somerville', 'watertown'],
  'chicago': ['chicago', 'illinois', 'il', 'evanston', 'naperville', 'oak park', 'schaumburg',
    'arlington heights', 'skokie'],
  'seattle': ['seattle', 'bellevue', 'redmond', 'kirkland'],
  'remote': ['remote', 'distributed', 'worldwide', 'anywhere'],
};
const REGION_SLUGS = Object.keys(REGIONS);

// ── Sectors ────────────────────────────────────────────────────────────────
// slug → keyword evidence. Tags (engine-written) are checked first for an exact
// slug hit; then the text blob is scanned for keywords.
const SECTORS = {
  'ai': ['ai', 'artificial intelligence', 'machine learning', 'llm', 'genai', 'deep learning',
    'foundation model', 'ml ops', 'mlops'],
  'fintech': ['fintech', 'payments', 'banking', 'lending', 'insurtech', 'wealth management',
    'trading', 'financial services', 'neobank'],
  'devtools': ['devtools', 'developer tools', 'infrastructure', 'api', 'sdk', 'open source',
    'devops', 'ci/cd'],
  'saas': ['saas', 'b2b', 'enterprise software', 'workflow', 'productivity'],
  'health': ['health', 'biotech', 'medtech', 'pharma', 'clinical', 'digital health',
    'healthcare', 'life sciences'],
  'consumer': ['consumer', 'd2c', 'marketplace', 'social app', 'creator'],
  'crypto': ['crypto', 'web3', 'blockchain', 'defi', 'nft'],
  'climate': ['climate', 'clean energy', 'sustainability', 'carbon', 'solar', 'battery'],
  'defense': ['defense', 'aerospace', 'govtech', 'national security'],
  'edtech': ['edtech', 'education', 'learning', 'tutoring'],
  'robotics': ['robotics', 'robot', 'automation', 'drones'],
  'hardware': ['hardware', 'iot', 'semiconductor', 'chip', 'wearable'],
};
const SECTOR_SLUGS = Object.keys(SECTORS);

// ── Stages ─────────────────────────────────────────────────────────────────
// slug → regex evidence. Checked in order; a row can carry multiple stages
// (e.g. "stealth" + "pre-seed"), so detection returns a set.
const STAGE_PATTERNS = [
  ['stealth', /\bstealth\b/i],
  ['pre-seed', /\bpre[-\s]?seed\b/i],
  ['pre-seed', /\bpre[-\s]?launch\b/i],
  ['pre-seed', /\bday\s?(one|1|zero|0)\b/i],
  ['pre-seed', /\bjust\s(started|incorporated|founded)\b/i],
  ['series-a', /\bseries\s*a\b/i],
  ['growth', /\bseries\s*[b-e]\b/i],
  ['growth', /\bipo\b/i],
  ['growth', /\bpublicly\s+traded\b/i],
  ['growth', /\bnasdaq\b|\bnyse\b/i],
  ['growth', /\bgrowth[-\s]?stage\b/i],
];
const STAGE_SLUGS = ['stealth', 'pre-seed', 'seed', 'series-a', 'growth'];
// 'seed' is checked last: strip pre-seed mentions first so "pre-seed" doesn't
// count as "seed", then look for a standalone seed mention or a seed raise.
const SEED_RAISE = /\b(raised|closed|announced)\b[^.]{0,40}\bseed\b/i;

// Text blob: everything the matchers are allowed to read. Mirrors the fields
// the REST queue evaluates — never LinkedIn URLs (link plumbing pollutes).
function textBlob(row) {
  const parts = [
    row.headline, row.company, row.company_one_liner, row.role, row.location_city,
    row.chicago_connection, row.builder_signals, row.pedigree_signals, row.caliber_signals,
  ];
  const tags = parseTags(row.tags);
  parts.push(...tags);
  return parts.filter(Boolean).map(String).join(' • ');
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  try {
    const t = JSON.parse(tags);
    return Array.isArray(t) ? t.map(String) : [];
  } catch { return []; }
}

// Detect the stage slugs with textual evidence on this row. Never invents:
// returns [] when nothing matches.
function detectStages(row) {
  const blob = textBlob(row);
  const found = new Set();
  for (const [slug, re] of STAGE_PATTERNS) {
    if (re.test(blob)) found.add(slug);
  }
  const noPreseed = blob.replace(/\bpre[-\s]?seed\b/gi, ' ');
  if (/\bseed\b/i.test(noPreseed) || SEED_RAISE.test(blob)) found.add('seed');
  return [...found];
}

function matchStage(row, stage) {
  const slug = normSlug(stage);
  if (!slug) return false;
  return detectStages(row).includes(slug);
}

function matchRegion(row, region) {
  const slug = normSlug(region);
  if (!slug) return false;
  const blob = textBlob(row);
  const phrases = REGIONS[slug];
  if (phrases) return phrases.some((p) => wordRe(p).test(blob));
  return wordRe(slug).test(blob); // unknown slug → keyword fallback
}

function matchSector(row, sector) {
  const slug = normSlug(sector);
  if (!slug) return false;
  const tags = parseTags(row.tags).map((t) => t.toLowerCase());
  if (tags.includes(slug)) return true;
  const blob = textBlob(row);
  const kws = SECTORS[slug];
  if (kws) return kws.some((k) => wordRe(k).test(blob));
  return wordRe(slug).test(blob); // unknown slug → keyword fallback
}

function normSlug(s) {
  const v = String(s || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return v || null;
}

function asList(v) {
  if (v == null) return null;
  const list = (Array.isArray(v) ? v : [v]).map(normSlug).filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

// Build a single row predicate from the optional filters. Returns null when
// no filter was given (caller skips post-filtering).
function vcTextFilters({ stage = null, region = null, sector = null } = {}) {
  const stages = asList(stage);
  const regions = asList(region);
  const sectors = asList(sector);
  if (!stages && !regions && !sectors) return null;
  return (row) =>
    (!stages || stages.some((s) => matchStage(row, s))) &&
    (!regions || regions.some((r) => matchRegion(row, r))) &&
    (!sectors || sectors.some((s) => matchSector(row, s)));
}

module.exports = {
  REGIONS, REGION_SLUGS, SECTORS, SECTOR_SLUGS, STAGE_SLUGS,
  textBlob, parseTags, detectStages, matchStage, matchRegion, matchSector,
  vcTextFilters, asList,
};
