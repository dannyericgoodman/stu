/**
 * Health service — durable job-run logging + a 5-second green/red board.
 * Every job records its outcome via recordJobRun; buildHealthReport reads the latest
 * state of each subsystem so a failure is visible, never swallowed.
 */
const db = require('../db');

function recordJobRun(job, status, detail = '', userId = null) {
  try {
    db.prepare('INSERT INTO job_runs (user_id, job, status, detail) VALUES (?, ?, ?, ?)')
      .run(userId, job, status, String(detail).slice(0, 500));
  } catch (e) {
    console.error('[health] recordJobRun failed:', e.message);
  }
}

function lastRun(job, userId = null) {
  if (userId != null) {
    return db.prepare('SELECT * FROM job_runs WHERE job = ? AND (user_id = ? OR user_id IS NULL) ORDER BY ran_at DESC LIMIT 1').get(job, userId);
  }
  return db.prepare('SELECT * FROM job_runs WHERE job = ? ORDER BY ran_at DESC LIMIT 1').get(job);
}

async function buildHealthReport(userId) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Datastore
  try { db.prepare('SELECT 1 AS ok').get(); add('Database', 'green', 'SQLite connected'); }
  catch (e) { add('Database', 'red', e.message); }

  // ══════════════════════════════════════════════════════════════════════
  // 2. API keys — VERIFIED, not merely present.
  //
  // This said `configured`/`green` for any non-empty string, and /api/health's
  // `has_anthropic` did the same. So when the Anthropic key expired, the board
  // stayed green while every LLM feature in Stu returned a raw 401: JD parse,
  // shortlist rationale, Exa extraction, assessments. The one page whose job is
  // to answer "is anything broken" confidently said no.
  //
  // One authenticated GET (models.list, cached 5 min in providerKeys) turns that
  // into a real answer. A key that resolves but does not work is RED — it is
  // strictly worse than a missing one, because a missing key at least surfaces
  // "configure your key" at the call site.
  // ══════════════════════════════════════════════════════════════════════
  const { resolveKey, verifyAnthropicKey } = require('../lib/providerKeys');
  const hasExa = !!resolveKey(userId, 'exa');
  const ak = await verifyAnthropicKey(userId).catch((e) => ({ configured: true, ok: false, detail: e.message }));
  add('Claude API key',
    !ak.configured ? 'red' : ak.ok ? 'green' : 'red',
    !ak.configured ? 'missing — scoring/extraction will degrade'
      : ak.ok ? `verified against the API${ak.cached ? ' (cached)' : ''}`
        : `PRESENT BUT NOT WORKING — ${ak.detail}`);
  add('Exa API key (sourcing)', hasExa ? 'green' : 'yellow', hasExa ? 'configured' : 'missing — sourcing runs will no-op');

  // Hiring — the warm pool has a live source, or it does not. The base cutover
  // took the Airtable talent tables away and nothing said so; a refresh button
  // that 500s is not a status.
  try {
    const { availableTables } = require('../pipeline/hiring-warm');
    const warm = db.prepare("SELECT COUNT(*) AS n FROM hiring_candidates WHERE user_id = ? AND tier = 'warm' AND is_deleted = 0").get(userId);
    const live = availableTables();
    add('Hiring warm pool',
      live.length ? 'green' : (warm.n ? 'yellow' : 'red'),
      live.length
        ? `${warm.n} warm · source: ${live.map((t) => t.label).join(', ')}`
        : `${warm.n} warm in Stu, but NO live Airtable source in the authorized base — refreshes cannot add anyone`);
    const ghToken = !!resolveKey(userId, 'github');
    add('Hiring cold discovery (GitHub)', ghToken ? 'green' : 'yellow',
      ghToken ? 'token configured' : 'no GitHub token — the GitHub sourcing arm is skipped on every run');
  } catch (e) { add('Hiring warm pool', 'red', e.message); }

  // 3. Jobs — last run status
  const jobLabels = {
    newsletter_sync: 'Daily Brief sync',
    sourcing_run: 'Sourcing run',
    notion_push: 'Notion mirror push',
  };
  for (const [job, label] of Object.entries(jobLabels)) {
    const r = lastRun(job, userId);
    if (!r) { add(label, 'gray', 'never run'); continue; }
    const when = new Date(r.ran_at + 'Z').toLocaleString();
    const color = r.status === 'ok' ? 'green' : r.status === 'partial' ? 'yellow' : 'red';
    add(label, color, `${r.status} · ${when}${r.detail ? ' · ' + r.detail : ''}`);
  }

  // Talent sourcing — read the REAL table (talent_sourcing_runs), not job_runs, so this
  // reflects what actually happened on the last "Source for this role".
  try {
    const tr = db.prepare('SELECT * FROM talent_sourcing_runs WHERE user_id = ? ORDER BY run_at DESC LIMIT 1').get(userId);
    if (!tr) {
      add('Talent sourcing', 'gray', 'never run');
    } else {
      const when = new Date(tr.run_at + 'Z').toLocaleString();
      let sum = {}; try { sum = JSON.parse(tr.summary || '{}') || {}; } catch {}
      if (sum.error) {
        add('Talent sourcing', 'red', `${when} · couldn't run: ${sum.error}`);
      } else {
        const found = tr.candidates_found ?? 0, added = tr.candidates_added ?? 0, matches = tr.matches_generated ?? 0;
        let note = added === 0 && found > 0 ? ' — found people but none passed AI verification (check Anthropic credits)' : (found === 0 ? ' — search returned nobody' : '');
        if (found === 0) {
          const errs = (sum.queryLog || []).filter(q => q.err).slice(0, 2).map(q => q.err);
          if (errs.length) note += ` · Exa error: ${errs.join(' | ')}`;
          else if ((sum.queryLog || []).length) note += ` (${sum.queryLog.length} queries, all 0 results)`;
        }
        add('Talent sourcing', matches > 0 ? 'green' : 'yellow',
          `${when} · found ${found} · added ${added} · ${matches} matches${note}`);
      }
    }
  } catch (e) { add('Talent sourcing', 'gray', 'unavailable'); }

  // 4. Newsletter source health
  const srcs = db.prepare("SELECT name, last_status FROM newsletter_sources WHERE user_id = ? AND enabled = 1 AND is_deleted = 0").all(userId);
  if (srcs.length) {
    const failing = srcs.filter(s => (s.last_status || '').toLowerCase().startsWith('error'));
    add('Newsletter sources', failing.length ? 'yellow' : 'green',
      `${srcs.length} enabled${failing.length ? ` · ${failing.length} failing: ${failing.map(s => s.name).join(', ')}` : ' · all healthy'}`);
  } else {
    add('Newsletter sources', 'gray', 'none configured');
  }

  // 5. Data integrity quick checks
  const dupes = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT LOWER(linkedin_url) u FROM founders
      WHERE created_by = ? AND is_deleted = 0 AND linkedin_url IS NOT NULL AND linkedin_url != ''
      GROUP BY u HAVING COUNT(*) > 1
    )`).get(userId).c;
  add('Duplicate founders', dupes > 0 ? 'yellow' : 'green', dupes > 0 ? `${dupes} LinkedIn duplicate(s)` : 'none');

  const suspect = db.prepare("SELECT COUNT(*) c FROM opportunity_assessments WHERE created_by = ? AND is_deleted = 0 AND deck_status = 'suspect'").get(userId).c;
  add('Assessment decks', suspect > 0 ? 'yellow' : 'green', suspect > 0 ? `${suspect} suspect — re-upload PDF` : 'all ingested cleanly');

  const overall = checks.some(c => c.status === 'red') ? 'red' : checks.some(c => c.status === 'yellow') ? 'yellow' : 'green';
  return { overall, checks, at: new Date().toISOString() };
}

module.exports = { recordJobRun, lastRun, buildHealthReport };
