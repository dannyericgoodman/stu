'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-source.js — one action, the whole engine. "Find matches" goes and sources,
// the way founder Sourcing does, pointed at one job description:
//
//   1. network   — people Danny actually knows whose titles fit (the Network book).
//   2. web       — Exa people search, ~10 distinct queries × 25 results.
//   3. GitHub    — builders by stack, when a token is configured.
//   4. LinkedIn  — read the real profile of the ~40 worth reading (EnrichLayer).
//   5. grade     — every candidate checked against the JD's requirements, quote-gated.
//
// Runs in the background; the client polls the run row, which carries a `stage` in
// plain words so a four-minute run does not look like a hang. Every stage is
// best-effort and reports its own outcome — a missing key narrows the run and says
// so in the summary, it never sinks it silently.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { resolveKey } = require('../lib/providerKeys');
const { sourceViaExa } = require('./hiring-exa');
const { discoverForRole } = require('./hiring-discovery');
const { sourceFromNetwork } = require('./hiring-network');
const { enrichCandidatesForRole } = require('./hiring-linkedin');
const { runMatch, selectForGrading } = require('./hiring-match');

const NETWORK_LIMIT = 15;   // network picks are a title-level prefilter; they must not crowd out the web

function updateRun(runId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE hiring_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), runId);
}

// The background worker. Never throws — records the outcome on the run row.
async function runSourcing(runId, userId, roleId, deps = {}) {
  const notes = [];
  let found = 0;
  const stage = (text) => updateRun(runId, { stage: text });
  try {
    const role = db.prepare('SELECT * FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, userId);
    if (!role) throw new Error('Role not found');
    const priority = [];

    // 1. Network — Danny's own people first.
    stage('Searching your network…');
    try {
      const n = (deps.sourceFromNetwork || sourceFromNetwork)({ userId, role, limit: NETWORK_LIMIT });
      if (n.skipped) notes.push(`network: ${n.skipped}`);
      else notes.push(`network: ${n.qualified} of ${n.considered} fit on title → ${n.ids.length} pulled (${n.warm} warm)`);
      priority.push(...n.ids);
      found += n.inserted || 0;
      updateRun(runId, { found });
    } catch (e) { notes.push(`network search failed: ${e.message}`); }

    // 2. Web — Exa people search.
    stage('Searching the web…');
    try {
      const exa = await (deps.sourceViaExa || sourceViaExa)({ userId, role });
      if (exa.error === 'no_exa_key') notes.push('web search skipped (no Exa key)');
      else {
        found += (exa.inserted || 0);
        priority.push(...(exa.ids || []));
        notes.push(
          `web: ${(exa.queries || []).length} queries → ${exa.considered || 0} profiles, ${exa.read || 0} read → `
          + `${exa.extracted || 0} extracted, ${exa.ungrounded_dropped || 0} dropped (no receipt), `
          + `${exa.inserted || 0} new + ${exa.updated || 0} refreshed`
          + (exa.errors && exa.errors.length ? ` — ERRORS: ${exa.errors.join(' | ')}` : '')
        );
      }
      updateRun(runId, { found });
    } catch (e) { notes.push(`web search failed: ${e.message}`); }

    // 3. GitHub — builders by stack, when a token is configured.
    const ghToken = resolveKey(userId, 'github');
    if (ghToken) {
      stage('Searching GitHub…');
      try { const g = await discoverForRole({ userId, roleId, token: ghToken }); found += (g.added || 0); notes.push(`GitHub: ${g.added || 0} new builders`); updateRun(runId, { found }); }
      catch (e) { notes.push(`GitHub discovery failed: ${e.message}`); }
    }

    // 4. LinkedIn — read the profiles of the candidates worth grading.
    const pool = db.prepare('SELECT * FROM hiring_candidates WHERE user_id = ? AND is_deleted = 0').all(userId);
    const matches = db.prepare('SELECT candidate_id, status FROM hiring_matches WHERE role_id = ? AND is_deleted = 0').all(roleId);
    const selected = selectForGrading({ role, pool, matches, priorityIds: priority });
    stage(`Reading LinkedIn for ${selected.length} candidates…`);
    try {
      const li = await (deps.enrichCandidatesForRole || enrichCandidatesForRole)({ userId, candidates: selected });
      if (li.skipped) notes.push(`LinkedIn not read (${li.skipped} — add one in Settings)`);
      else notes.push(`LinkedIn: ${li.enriched} read, ${li.reused} recent reads reused, ${li.failed} unavailable, ${li.ties_added} Illinois ties found`);
    } catch (e) { notes.push(`LinkedIn read failed: ${e.message}`); }

    // 5. Grade + rank.
    stage(`Grading ${selected.length} candidates against the job description…`);
    const match = await (deps.runMatch || runMatch)({ userId, roleId, explain: true, priorityIds: priority });
    if (match.error) throw new Error(match.error);
    updateRun(runId, {
      status: 'done', stage: null, finished_at: new Date().toISOString(),
      warm_considered: match.warm_considered || 0, cold_considered: match.cold_considered || 0,
      shortlisted: match.shortlisted || 0, found,
      summary: `${match.summary}. ${notes.join('; ')}`,
    });
  } catch (e) {
    updateRun(runId, { status: 'error', stage: null, finished_at: new Date().toISOString(), error: e.message, summary: notes.join('; ') });
  }
}

/**
 * Kick off sourcing for a role. Creates the run row synchronously (so the caller gets
 * a run_id to poll), then runs the work in the background. Returns { runId }.
 */
function startSourcing({ userId = 1, roleId }) {
  const runId = db.prepare("INSERT INTO hiring_runs (user_id, role_id, kind, status, found) VALUES (?, ?, 'source', 'running', 0)").run(userId, roleId).lastInsertRowid;
  // Fire-and-forget — the response returns immediately; the client polls the run.
  runSourcing(runId, userId, roleId).catch((e) => updateRun(runId, { status: 'error', error: e.message }));
  return { runId };
}

// Latest sourcing run for a role — what the client polls.
function latestRun(userId, roleId) {
  return db.prepare("SELECT id, status, stage, found, warm_considered, cold_considered, shortlisted, summary, error, run_at, finished_at FROM hiring_runs WHERE user_id = ? AND role_id = ? AND kind = 'source' ORDER BY id DESC LIMIT 1").get(userId, roleId);
}

module.exports = { startSourcing, runSourcing, latestRun, updateRun };
