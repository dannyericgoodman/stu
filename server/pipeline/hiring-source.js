'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-source.js — one action, the whole engine. "Find matches" should not rank
// a preloaded list; it should GO SOURCE. This orchestrates that, in the background:
//
//   1. warm-ensure   — if the warm pool is empty, import it (Danny's real network).
//   2. Exa source     — actively find people whose experience aligns with the JD.
//   3. GitHub source  — IL builders by stack (when a GitHub token is configured).
//   4. rank + explain — warm-first, IL-tied, grounded shortlist.
//
// Runs async (Exa + LLM extraction take 20-40s); the caller gets a run_id back
// immediately and the client polls the run's status — the same background+poll
// pattern the assessment engine uses. Every stage is best-effort: one source failing
// (no key, a timeout) never sinks the run — it just narrows the pool.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { resolveKey } = require('../lib/providerKeys');
const { importWarmPool } = require('./hiring-warm');
const { sourceViaExa } = require('./hiring-exa');
const { discoverForRole } = require('./hiring-discovery');
const { runMatch } = require('./hiring-match');

function updateRun(runId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE hiring_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), runId);
}

// The background worker. Never throws — records the outcome on the run row.
async function runSourcing(runId, userId, roleId) {
  const notes = [];
  let found = 0;
  try {
    const role = db.prepare('SELECT * FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, userId);
    if (!role) throw new Error('Role not found');

    // 1. Warm-ensure. Only import if the pool is empty (a refresh is a separate action).
    const warmCount = db.prepare("SELECT COUNT(*) AS n FROM hiring_candidates WHERE user_id = ? AND tier = 'warm' AND is_deleted = 0").get(userId).n;
    if (warmCount === 0) {
      try { const w = await importWarmPool({ userId }); if (!w.error) notes.push(`warm: ${w.inserted || 0} imported`); }
      catch (e) { notes.push(`warm import skipped: ${e.message}`); }
    }

    // 2. Exa — active semantic sourcing from the description. The engine's new muscle.
    try {
      const exa = await sourceViaExa({ userId, role });
      if (exa.error === 'no_exa_key') notes.push('Exa sourcing skipped (no Exa key)');
      else { found += (exa.inserted || 0); notes.push(`Exa: ${exa.inserted || 0} new (${exa.considered || 0} considered, ${exa.il_tied || 0} IL)`); }
      updateRun(runId, { found });
    } catch (e) { notes.push(`Exa sourcing failed: ${e.message}`); }

    // 3. GitHub — IL builders by stack, when a token is configured.
    const ghToken = resolveKey(userId, 'github');
    if (ghToken) {
      try { const g = await discoverForRole({ userId, roleId, token: ghToken }); found += (g.added || 0); notes.push(`GitHub: ${g.added || 0} new IL builders`); updateRun(runId, { found }); }
      catch (e) { notes.push(`GitHub discovery failed: ${e.message}`); }
    } else { notes.push('GitHub discovery skipped (no token)'); }

    // 4. Rank + explain — warm-first, grounded shortlist.
    const match = await runMatch({ userId, roleId, explain: true });
    updateRun(runId, {
      status: 'done', finished_at: new Date().toISOString(),
      warm_considered: match.warm_considered || 0, cold_considered: match.cold_considered || 0,
      shortlisted: match.shortlisted || 0, found,
      summary: `${match.summary}. ${notes.join('; ')}`,
    });
  } catch (e) {
    updateRun(runId, { status: 'error', finished_at: new Date().toISOString(), error: e.message, summary: notes.join('; ') });
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
  return db.prepare("SELECT id, status, found, warm_considered, cold_considered, shortlisted, summary, error, run_at, finished_at FROM hiring_runs WHERE user_id = ? AND role_id = ? AND kind = 'source' ORDER BY id DESC LIMIT 1").get(userId, roleId);
}

module.exports = { startSourcing, runSourcing, latestRun, updateRun };
