'use strict';
// The builder-radar pipeline — the whole weekly slope loop in one place, so the cron
// and a manual "run now" trigger share the exact same code. Order matters:
//   backfill (free GitHub links from the scrape)
//   → resolve (corroborated LinkedIn→GitHub, bounded)
//   → score   (compute slope for everyone who now has a github_url)
//   → discover (source new IL builders natively from GitHub)
//   → snapshot (capture state so slope becomes a week-over-week delta)
// Every step is wrapped so one failing connector can't sink the run.

const { recordJobRun } = require('./health');

// Resolves the GitHub token through providerKeys: the user's saved key, or the
// platform env key for the owner only. The old default (`token =
// process.env.GITHUB_TOKEN`) handed EVERY user the platform token once the
// scheduler started iterating paid users — exactly the cost-shifting leak
// providerKeys exists to prevent.
function resolveGithubToken(userId) {
  try { return require('./providerKeys').resolveKey(userId, 'github'); }
  catch { return null; }
}

async function runBuilderRadar({ userId = 1, token = undefined } = {}) {
  const ghToken = token !== undefined ? token : resolveGithubToken(userId);
  const out = { backfilled: 0, resolved: 0, scored: 0, discovered: 0, snapshotted: 0, errors: [] };

  try {
    // Purge any name-inconsistent backfill URLs first (the aidenybai class), then
    // backfill fresh with the name-consistency guard in place.
    const { backfillGithubFromScrape, revalidateBackfill } = require('../pipeline/github-source');
    out.purged = revalidateBackfill({ userId }).cleared;
    out.backfilled = backfillGithubFromScrape({ userId }).github_url_set;
  } catch (e) { out.errors.push(`backfill: ${e.message}`); }

  // Resolve is the heaviest step (each founder = 1 search + up to 5 profile calls),
  // so it's bounded small — otherwise it monopolizes GitHub's rate limit for 10+ min
  // and starves the score/discover steps. 20/week fills the pool steadily.
  try {
    const { resolveGithubHandles } = require('../pipeline/github-resolve');
    out.resolved = (await resolveGithubHandles({ userId, token: ghToken, limit: 20 })).resolved;
  } catch (e) { out.errors.push(`resolve: ${e.message}`); }

  try {
    const { scoreGithubSlope } = require('../pipeline/github-activity');
    let guard = 0;
    for (;;) {
      const r = await scoreGithubSlope({ userId, githubToken: ghToken, limit: 40 });
      out.scored += r.scored;
      if (r.remaining === 0 || r.scored === 0 || ++guard >= 15) break;
    }
  } catch (e) { out.errors.push(`score: ${e.message}`); }

  try {
    const { discoverGithubBuilders } = require('../pipeline/github-source');
    out.discovered = (await discoverGithubBuilders({ userId, token: ghToken, candidatesPerQuery: 20, pages: 1 })).added;
  } catch (e) { out.errors.push(`discover: ${e.message}`); }

  try {
    const { captureSnapshots } = require('./slope-snapshots');
    out.snapshotted = captureSnapshots({ userId }).captured;
  } catch (e) { out.errors.push(`snapshot: ${e.message}`); }

  // Pre-commit a dated prediction for every Must-meet founder — the falsifiable loop.
  try {
    const { captureForMustMeet } = require('./predictions');
    const d = new Date(); d.setMonth(d.getMonth() + 18);
    out.predictions = captureForMustMeet({ userId, resolveBy: d.toISOString().slice(0, 10) }).created;
  } catch (e) { out.errors.push(`predictions: ${e.message}`); }

  const summary = `${out.backfilled} backfilled, ${out.resolved} resolved, ${out.scored} scored, ${out.discovered} new builders, ${out.snapshotted} snapshotted`;
  recordJobRun('slope_refresh', out.errors.length ? 'error' : 'ok', out.errors.length ? `${summary}; errors: ${out.errors.join('; ')}` : summary, userId);
  return { ...out, summary };
}

module.exports = { runBuilderRadar };
