'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-discovery.js — cold pool, GitHub-native. When warm is thin, find the
// best IL-tied builders for a role directly from the builder graph.
//
// This is the sibling of pipeline/github-source.js (founder sourcing), reusing its
// exact three-gate shape and the same libs verbatim (computeGithubSlope, verifyIlTie,
// ghGet) — but with ONE deliberate difference, and it's the whole point:
//
//   github-source gates on a FOUNDER "building" signal (bio says founder / a repo is
//   inflecting) because it's hunting people about to start companies. HIRING wants the
//   opposite tail too: the employed senior engineer at Citadel with a strong GitHub and
//   a UChicago degree is a perfect first hire and a terrible founder lead. So there is
//   NO building/founder gate here. The gates are: (1) verified IL tie [hard], (2) real
//   builder activity [has public work], (3) stack/function fit to the role.
//
// tech_stack is captured from the person's repo languages — the concrete evidence a
// stack match can be grounded on, which the founder engine never needed.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { computeGithubSlope, ghLoginFromUrl } = require('./github-activity');
const { verifyIlTie } = require('../lib/ilTie');
const { ghGet } = require('../lib/githubClient');

// IL location qualifiers for GitHub user search. verifyIlTie is the real gate, so a
// loose query just widens the funnel it then narrows. Kept compact to bound API spend.
const IL_LOCATIONS = ['Chicago', 'Illinois', '"Chicago, IL"', 'Evanston', 'Champaign', 'Urbana', 'Naperville'];

// Role stack token → GitHub `language:` qualifier. GitHub user search can filter by a
// user's dominant language; frameworks/tools (React, AWS, Postgres) aren't languages,
// so they don't become qualifiers — they're matched later against captured repo langs
// and the profile text by the matcher.
const LANGUAGE_MAP = {
  python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', 'node.js': 'JavaScript', node: 'JavaScript',
  go: 'Go', golang: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', 'c++': 'C++', 'c#': 'C#',
  ruby: 'Ruby', php: 'PHP', scala: 'Scala', elixir: 'Elixir', 'objective-c': 'Objective-C', dart: 'Dart', r: 'R',
  solidity: 'Solidity', haskell: 'Haskell', clojure: 'Clojure', julia: 'Julia',
};

// A role's must-have stack → the distinct GitHub languages worth querying on.
function roleLanguages(role) {
  const out = [];
  for (const tok of parseArr(role.must_have_stack).concat(parseArr(role.nice_to_have_stack))) {
    const lang = LANGUAGE_MAP[String(tok).toLowerCase().trim()];
    if (lang && !out.includes(lang)) out.push(lang);
  }
  return out;
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

/**
 * GitHub user-search queries for a role: IL location × role language. If the role
 * names no known language, fall back to location-only (slope + function then filter).
 * Pure + testable. Capped so a run can't fan out unboundedly.
 */
function buildQueries(role, { maxQueries = 8 } = {}) {
  const langs = roleLanguages(role);
  const out = [];
  for (const loc of IL_LOCATIONS) {
    if (langs.length) {
      for (const lang of langs) out.push(`location:${loc} language:${lang} type:user`);
    } else {
      out.push(`location:${loc} type:user`);
    }
    if (out.length >= maxQueries) break;
  }
  return out.slice(0, maxQueries);
}

// Tally a repos payload into top languages (concrete tech_stack evidence). Pure.
function topLanguages(repos, max = 6) {
  const counts = {};
  for (const r of repos || []) {
    if (!r || r.fork || !r.language) continue;
    counts[r.language] = (counts[r.language] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, max).map(([l]) => l);
}

const gh = (login) => `https://github.com/${login}`;
function cleanCompany(c) {
  if (!c) return null;
  const s = String(c).replace(/@/g, '').split(/[,/|]/)[0].trim();
  return s && s.length <= 60 ? s : null;
}

/**
 * Assess one GitHub login for a HIRING role. Gates: verified IL tie (hard), real
 * builder activity (has public repos or non-zero slope — but NO founder gate), and we
 * capture repo languages for stack matching. Returns an insert-ready row or {skip}.
 */
async function assessForHiring(login, role, token, deps = {}) {
  const get = deps.ghGet || ghGet;
  const slopeFn = deps.computeGithubSlope || computeGithubSlope;

  const p = (await get(`/users/${login}`, token)).data;
  if (!p || !p.login) return { skip: 'no profile' };

  // Gate 1 — verified IL tie (hard). GitHub location is self-reported ("earth", "remote"
  // included), so this also throws out the noise.
  const tieText = [p.location, p.bio, p.company, p.name].filter(Boolean).join(' • ');
  const tie = verifyIlTie(tieText);
  if (!tie.verified || tie.weak) return { skip: 'no verified IL tie' };

  // Gate 2 — real builder (has public work). NO founder/building gate: an employed
  // senior engineer is exactly who we want, and they won't say "building something".
  const repos = (await get(`/users/${login}/repos?sort=pushed&direction=desc&per_page=30`, token)).data;
  const repoList = Array.isArray(repos) ? repos : [];
  const langs = topLanguages(repoList);
  if ((p.public_repos || 0) < 2 && !repoList.length) return { skip: 'no public work' };

  const slope = await slopeFn(gh(login), token);
  if (slope && slope.failed) return { skip: 'slope fetch failed' }; // transient — don't insert a false 0
  const s = slope ? slope.slope_score : 0;

  return {
    row: {
      name: p.name || p.login,
      headline: (p.bio || '').slice(0, 300),
      github_url: gh(login),
      website_url: p.blog || null,
      current_company: cleanCompany(p.company),
      location_city: tie.place || p.location || null,
      location_state: null,
      tech_stack: JSON.stringify(langs),
      role_function: JSON.stringify(inferFunction(role, langs, p.bio)),
      tier: 'cold',
      source: 'github_builders',
      il_tie_type: tie.type,
      il_tie_place: tie.place,
      il_tie_evidence: tie.evidence,
      github_slope_score: s,
      github_slope_data: JSON.stringify(slope ? { ...slope.data, evidence: slope.evidence } : {}),
      external_id: `gh:${login}`,
      raw_data: JSON.stringify({ login: p.login, followers: p.followers, public_repos: p.public_repos, languages: langs }),
    },
    slope: s,
    evidence: slope && slope.evidence,
  };
}

// Best-effort function tag for a GitHub find, so the matcher's function gate has
// something to work with. Defaults to the role's own function (we searched for it),
// nudged to 'data' when the languages/bio say ML/data.
function inferFunction(role, langs, bio) {
  const t = `${(langs || []).join(' ')} ${bio || ''}`.toLowerCase();
  if (/\b(ml|machine learning|data scien|ai engineer|pytorch|tensorflow)\b/.test(t)) return ['data'];
  return [role.role_function || 'engineering'];
}

// Upsert a cold candidate by (user_id, github_url). A re-discovery refreshes slope/
// stack without duplicating, and never resurrects a trashed row.
const UPSERT_COLS = [
  'name', 'headline', 'github_url', 'website_url', 'current_company', 'location_city', 'location_state',
  'tech_stack', 'role_function', 'tier', 'source', 'il_tie_type', 'il_tie_place', 'il_tie_evidence',
  'github_slope_score', 'github_slope_data', 'external_id', 'raw_data',
];
function upsert(userId, row) {
  const existing = db.prepare('SELECT id FROM hiring_candidates WHERE user_id = ? AND github_url = ?').get(userId, row.github_url);
  if (existing) {
    const sets = UPSERT_COLS.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE hiring_candidates SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...UPSERT_COLS.map((c) => row[c] ?? null), existing.id);
    return 'updated';
  }
  const cols = ['user_id', ...UPSERT_COLS];
  db.prepare(`INSERT INTO hiring_candidates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(userId, ...UPSERT_COLS.map((c) => row[c] ?? null));
  return 'inserted';
}

/**
 * Discover cold IL builders for a role from GitHub. Sweeps IL×language queries,
 * assesses candidates, inserts the keepers. Bounded by candidatesPerQuery/maxKeep to
 * cap free-but-rate-limited API spend.
 */
async function discoverForRole({ userId = 1, roleId, token, candidatesPerQuery = 12, maxKeep = 30, deps = {} } = {}) {
  const role = db.prepare('SELECT * FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, userId);
  if (!role) return { error: 'Role not found' };
  if (!token) return { error: 'No GitHub token configured — add one in Settings to discover cold builders.' };
  const get = deps.ghGet || ghGet;

  const out = { considered: 0, added: 0, updated: 0, kept: 0, skipped: {} };
  const seen = new Set();
  const queries = buildQueries(role);

  for (const q of queries) {
    if (out.kept >= maxKeep) break;
    const r = await get(`/search/users?q=${encodeURIComponent(q)}&sort=followers&order=desc&per_page=${candidatesPerQuery}`, token);
    const items = (r.data && r.data.items) || [];
    for (const u of items) {
      if (out.kept >= maxKeep) break;
      if (seen.has(u.login)) continue;
      seen.add(u.login);
      out.considered++;
      let a;
      try { a = await assessForHiring(u.login, role, token, deps); }
      catch (e) { out.skipped[e.message] = (out.skipped[e.message] || 0) + 1; continue; }
      if (!a || a.skip) { const k = (a && a.skip) || 'error'; out.skipped[k] = (out.skipped[k] || 0) + 1; continue; }
      const res = upsert(userId, a.row);
      out[res]++; out.kept++;
      await new Promise((res2) => setTimeout(res2, 200)); // polite between profile+repos+slope bursts
    }
    await new Promise((res2) => setTimeout(res2, 1000)); // between search pages (search RL is tighter)
  }

  try {
    db.prepare(`INSERT INTO hiring_runs (user_id, role_id, kind, cold_considered, summary) VALUES (?, ?, 'discovery', ?, ?)`)
      .run(userId, roleId, out.considered, `cold discovery for "${role.title}": ${out.considered} considered → ${out.added} new + ${out.updated} refreshed IL builders`);
  } catch { /* run-log best-effort */ }

  return out;
}

module.exports = { discoverForRole, assessForHiring, buildQueries, roleLanguages, topLanguages, inferFunction, LANGUAGE_MAP, IL_LOCATIONS };
