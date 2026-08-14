// Load .env in dev; Railway injects env vars directly in production
// override: true ensures .env values win over empty system env vars (e.g. ANTHROPIC_API_KEY="")
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

// Railway containers have no IPv6 egress — Google's SMTP/DNS often resolves to IPv6 first,
// causing ENETUNREACH. Force IPv4 globally so all outbound connections stay reachable.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

// ── Production safety guards ──
// A known/default JWT secret in production means anyone can forge a token for any
// user (including the owner, which unlocks the platform provider keys). Refuse to boot.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start.');
  process.exit(1);
}
// Without SETTINGS_ENC_KEY, user-supplied provider keys are stored as plaintext. Tolerated
// in dev, dangerous in a multi-tenant prod DB — warn loudly rather than fail.
if (process.env.NODE_ENV === 'production' && !require('./lib/secrets').isConfigured()) {
  console.warn('WARNING: SETTINGS_ENC_KEY is not set — stored provider credentials are NOT encrypted at rest.');
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { requireAuth, seedTeam } = require('./auth');

const app = express();
// Railway injects PORT; fall back to STU_PORT or 3002 for local dev
const PORT = process.env.PORT || process.env.STU_PORT || 3002;

// Seed team on first run
seedTeam();

// Auto-import founder data on first production deploy
const { seedIfEmpty } = require('./seed-production');
seedIfEmpty();

// ══════════════════════════════════════════════════════════════════════════
// REAP STRANDED RUNS. Nothing can legitimately be 'running' at boot.
//
// runManager (agents/runManager.js:5) is `new Map()` — process memory, nothing
// else. So on every Railway redeploy:
//   1. an in-flight assessment is sitting at status='running'
//   2. the process dies; the Map evaporates with it
//   3. the new container boots and nothing resets the row
//   4. it stays 'running' FOREVER
//
// And it's unrecoverable through the UI: AssessmentDetail polls a spinner that
// will never resolve, routes/assessments.js blocks a re-run while status is
// 'running', and runManager.cancel() returns false because the Map is empty. The
// user is wedged with no recourse but a direct DB write.
//
// The invariant is exact: the Map is empty at boot BY DEFINITION, so any row
// claiming to be running is lying about a process that no longer exists. Marking
// them 'error' is not a guess — it is the only true statement available.
// ══════════════════════════════════════════════════════════════════════════
try {
  const dbi = require('./db');
  const stranded = dbi.prepare(
    `UPDATE opportunity_assessments
       SET status = 'error',
           context_notes = COALESCE(context_notes, '') ||
             CASE WHEN COALESCE(context_notes,'') = '' THEN '' ELSE ' | ' END ||
             'Interrupted: the server restarted mid-run. Re-run it.'
     WHERE status IN ('running', 'synthesizing', 'processing_inputs')`
  ).run();
  if (stranded.changes) {
    console.log(`[Boot] Reaped ${stranded.changes} run(s) stranded by a restart — they were unrecoverable spinners.`);
    try { require('./services/health').recordJobRun('stale_run_reaper', 'ok', `${stranded.changes} stranded run(s) marked error`, 1); } catch { /* health is optional */ }
  }
} catch (e) {
  // Never take the server down over housekeeping.
  console.error('[Boot] Stale-run reaper failed (server continues):', e.message);
}

// One-time Airtable migration (idempotent — uses migration_flags table)
(async () => {
  try {
    const db = require('./db');
    db.exec("CREATE TABLE IF NOT EXISTS migration_flags (key TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    const flag = db.prepare("SELECT * FROM migration_flags WHERE key = 'airtable_import_v5'").get();
    if (!flag) {
      console.log('[Migration] Running Airtable import v4 (fixed stage mapping)...');
      const runMigration = require('./migrate-from-airtable');
      await runMigration();
      db.prepare("INSERT INTO migration_flags (key) VALUES ('airtable_import_v5')").run();
      console.log('[Migration] Airtable import v4 complete, flag set.');
    } else {
      console.log(`[Migration] Airtable import v4 already ran at ${flag.ran_at}, skipping.`);
    }
    // ── Illinois tie repair (idempotent) ──
    // PRODUCTION HAS ITS OWN DATABASE. Shipping lib/ilTie.js only stops NEW bad
    // ties; every row already on prod's board keeps its fabricated one until this
    // runs there. On 2026-07-15 that was 55 of 85 founders on the IL-tied board
    // who were Stanford / Yale / CMU / Wharton alumni with no Illinois connection.
    //
    // Safe to run on every boot: nothing is deleted (a row that loses its tie moves
    // to the national Frontier Watch), and the gate reads the PROFILE rather than
    // its own previous output, so the answer is stable. Flagged anyway so a normal
    // boot doesn't re-scan every row.
    // NB: this SUPERSEDES `sourcing_tie_cleanup_v1` further down, which ran the old
    // broken gate and DELETED anything it judged untied — so it kept the Stanford
    // rows and may well have deleted real Illinois founders. That damage isn't
    // recoverable here. This one never deletes: an untied row moves to the
    // watchlist, where Danny can still see it and I can still be wrong.
    const ilTieFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'il_tie_repartition_v1'").get();
    if (!ilTieFlag) {
      try {
        const { repartition, splitSchoolSettings } = require('./migrations/repartition-il-ties');
        // Config first — it is the CAUSE. Cleaning rows while the setting still
        // merges pedigree into the tie list just re-poisons them on the next run.
        const split = splitSchoolSettings(1);
        const { total, changed } = repartition({ apply: true });
        db.prepare("INSERT INTO migration_flags (key) VALUES ('il_tie_repartition_v1')").run();
        console.log(
          `[Migration] IL tie repair: ${changed}/${total} sourced founders re-partitioned; ` +
            `schools split ${split.was || '?'} -> ${split.tie || '?'} tie / ${split.pedigree || '?'} pedigree.`
        );
      } catch (e) {
        // Never take the server down over a data repair. A board with stale ties is
        // bad; a board that won't load is worse.
        console.error('[Migration] IL tie repair FAILED (server continues):', e.message);
      }
    }

    // Backfill Airtable record IDs (idempotent — only sets NULL IDs)
    const backfillFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'airtable_backfill_ids_v1'").get();
    if (!backfillFlag) {
      console.log('[Migration] Backfilling Airtable record IDs...');
      const backfillIds = require('./backfill-airtable-ids');
      await backfillIds();
      db.prepare("INSERT INTO migration_flags (key) VALUES ('airtable_backfill_ids_v1')").run();
      console.log('[Migration] Airtable ID backfill complete.');
    }

    // ── Give every pipeline card a stage in Airtable's vocabulary ──
    // The merged board has one axis, `stage_status`. The daily sync mirrors it from
    // Airtable for the 161 founders that have a record there; this covers the 26
    // that came from Airtable's separate Investment Pipeline table and would
    // otherwise sit stage-less forever. Only ever fills a NULL, so it cannot stomp
    // a stage Danny has since dragged — but it is flagged anyway, because an
    // unflagged migration is one bad WHERE clause away from being a nightly rewrite.
    const stageFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'stage_status_backfill_v1'").get();
    if (!stageFlag) {
      const backfillStageStatus = require('./backfill-stage-status');
      const r = backfillStageStatus();
      db.prepare("INSERT INTO migration_flags (key) VALUES ('stage_status_backfill_v1')").run();
      console.log(`[Migration] stage_status: ${r.mirrored} mirrored, ${r.derived} derived, ${r.unresolved.length} left without a stage (untriaged sourcing output — correct).`);
    }

    // ── Fold the two co-founder rows Danny named ──
    // "Could we just have Scott and Kyle kept in?" Nobody is deleted — Eric's and
    // Ehren's rows point at their company's card and are listed on it. Flagged, and
    // it only ever folds those two by name, so a re-run can't cascade.
    const cofoundersFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'cofounder_fold_v1'").get();
    if (!cofoundersFlag) {
      const backfillCofounders = require('./backfill-cofounders');
      const r = backfillCofounders();
      db.prepare("INSERT INTO migration_flags (key) VALUES ('cofounder_fold_v1')").run();
      for (const f of r.folded) console.log(`[Migration] cofounder: ${f.company} keeps ${f.kept}, folded ${f.folded}`);
      for (const s of r.skipped) console.log(`[Migration] cofounder: ${s.company} skipped — ${s.reason}`);
    }
    // ── Incremental Airtable → Stu sync ──
    // This used to run on EVERY startup, unflagged, while every migration around
    // it is flag-guarded. It's fired without await so it doesn't delay listen(),
    // but better-sqlite3 is SYNCHRONOUS — so its loop blocks the event loop solid
    // for ~106ms right when Danny's first post-login requests are queuing. That's
    // a measurable slice of "logged in and it's laggy."
    //
    // Worse, it's O(records × founders): all three dedupe queries full-scan the
    // 5,515-row founders table once per Airtable record. It's ~106ms at 163
    // records and grows with the base.
    //
    // It doesn't belong at boot at all. Airtable is the team's CRM — it changes a
    // few times a day, not on Stu restarts. Moved to the 6am cron, with a manual
    // POST /api/pipeline/sync-airtable for when Danny wants it now.
    // See also: idx_founders_airtable_rec, which kills the first full scan.
    if (process.env.AIRTABLE_SYNC_ON_BOOT === 'true') {
      const { syncFromAirtable } = require('./services/airtable-import');
      syncFromAirtable().catch(err => console.error('[AirtableImport] Startup sync error:', err.message));
    }

    // One-time rubric v3 rescore — fixes v2 (which rescored ALL versions instead of latest per group)
    const rescoreV3Flag = db.prepare("SELECT * FROM migration_flags WHERE key = 'rescore_rubric_v3'").get();
    if (!rescoreV3Flag) {
      console.log('[Migration] Triggering rubric v3 rescore (background)...');
      db.prepare("INSERT INTO migration_flags (key) VALUES ('rescore_rubric_v3')").run();
      const rescoreV3 = require('./migrations/rescore-rubric-v3');
      rescoreV3().catch(err => console.error('[Rescore-v3] Migration error:', err.message));
    }

    // One-time sourcing inbox cleanup — drop non-founders, dedupe, re-score caliber.
    // v2 re-runs with the broadened caliber definition (traction / builder evidence,
    // not just credentials) so strong uncredentialed founders are graded up.
    const sourcingCleanupFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'sourcing_cleanup_v2'").get();
    if (!sourcingCleanupFlag) {
      try {
        console.log('[Migration] Cleaning up sourcing inbox (founder gate + dedupe + broadened caliber)...');
        require('./migrations/cleanup-sourcing-v1')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('sourcing_cleanup_v2')").run();
      } catch (err) {
        console.error('[Migration] Sourcing cleanup error:', err.message);
      }
    }

    // One-time talent function cleanup — type candidates + remove function-mismatched
    // matches (e.g. engineers under a CMO role).
    const talentFnFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'talent_function_cleanup_v1'").get();
    if (!talentFnFlag) {
      try {
        console.log('[Migration] Typing candidates by function + clearing mismatched matches...');
        require('./migrations/cleanup-talent-functions')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('talent_function_cleanup_v1')").run();
      } catch (err) {
        console.error('[Migration] Talent function cleanup error:', err.message);
      }
    }

    // One-time talent role cleanup — derive role function from title/JD (e.g. CMO → gtm)
    // and purge matches that don't fit. Fixes roles stuck on the 'engineering' default.
    const talentRolesFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'talent_roles_cleanup_v1'").get();
    if (!talentRolesFlag) {
      try {
        console.log('[Migration] Resolving role functions from titles/JDs + clearing mismatched matches...');
        require('./migrations/cleanup-talent-roles')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('talent_roles_cleanup_v1')").run();
      } catch (err) {
        console.error('[Migration] Talent roles cleanup error:', err.message);
      }
    }

    // One-time sourcing tie cleanup — drop inbox founders with no verified Chicago/IL tie.
    const tieFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'sourcing_tie_cleanup_v1'").get();
    if (!tieFlag) {
      try {
        console.log('[Migration] Removing inbox founders without a Chicago/IL tie...');
        require('./migrations/cleanup-sourcing-tie')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('sourcing_tie_cleanup_v1')").run();
      } catch (err) {
        console.error('[Migration] Sourcing tie cleanup error:', err.message);
      }
    }

    // One-time sourcing accuracy cleanup — drop unsupported pedigree tags from the inbox.
    const accFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'sourcing_accuracy_v1'").get();
    if (!accFlag) {
      try {
        console.log('[Migration] Scrubbing inaccurate pedigree tags from inbox...');
        require('./migrations/cleanup-sourcing-accuracy')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('sourcing_accuracy_v1')").run();
      } catch (err) {
        console.error('[Migration] Sourcing accuracy cleanup error:', err.message);
      }
    }

    // One-time: flag historical assessments whose decks were corrupted/un-ingested.
    const deckFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'flag_suspect_decks_v1'").get();
    if (!deckFlag) {
      try {
        console.log('[Migration] Flagging assessments with corrupted/un-ingested decks...');
        require('./migrations/flag-suspect-decks')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('flag_suspect_decks_v1')").run();
      } catch (err) {
        console.error('[Migration] Suspect-deck flagging error:', err.message);
      }
    }

    // One-time: purge founders admitted without AI verification (credit-outage fallback).
    const unverFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'cleanup_unverified_sourced_v1'").get();
    if (!unverFlag) {
      try {
        require('./migrations/cleanup-unverified-sourced')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('cleanup_unverified_sourced_v1')").run();
      } catch (err) { console.error('[Migration] unverified-sourced cleanup error:', err.message); }
    }

    // One-time: replace the Elad whole-book brief row with individual chapters.
    const eladFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'fix_elad_chapters_v1'").get();
    if (!eladFlag) {
      db.prepare("INSERT INTO migration_flags (key) VALUES ('fix_elad_chapters_v1')").run();
      require('./migrations/fix-elad-chapters')().catch(err => console.error('[fix-elad-chapters] error:', err.message));
    }

    // One-time: sweep inbox to bar — dismiss investors/VCs + founders without a verified tie.
    const pqFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'cleanup_pipeline_quality_v1'").get();
    if (!pqFlag) {
      try {
        require('./migrations/cleanup-pipeline-quality')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('cleanup_pipeline_quality_v1')").run();
      } catch (err) { console.error('[Migration] pipeline-quality cleanup error:', err.message); }
    }

    // One-time: strip hallucinated school/pedigree labels + dismiss fake school-ties.
    const hlFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'cleanup_hallucinated_labels_v1'").get();
    if (!hlFlag) {
      try {
        require('./migrations/cleanup-hallucinated-labels')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('cleanup_hallucinated_labels_v1')").run();
      } catch (err) { console.error('[Migration] hallucinated-labels cleanup error:', err.message); }
    }

    // One-time: clean-slate Talent — clear candidates/matches sourced under the old engine.
    const tResetFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'reset_talent_candidates_v1'").get();
    if (!tResetFlag) {
      try {
        require('./migrations/reset-talent-candidates')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('reset_talent_candidates_v1')").run();
      } catch (err) { console.error('[Migration] talent reset error:', err.message); }
    }

    // One-time: backfill sourcing evidence onto already-promoted founders.
    const promoMetaFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'promote_metadata_backfill_v1'").get();
    if (!promoMetaFlag) {
      try {
        console.log('[Migration] Backfilling sourcing evidence onto promoted founders...');
        require('./migrations/backfill-promote-metadata')();
        db.prepare("INSERT INTO migration_flags (key) VALUES ('promote_metadata_backfill_v1')").run();
      } catch (err) {
        console.error('[Migration] Promote-metadata backfill error:', err.message);
      }
    }
  } catch (err) {
    console.error('[Migration] Airtable import error:', err.message);
  }
})();

// Security
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://localhost:5175', 'http://localhost:5176', 'http://localhost:3001'];

// In production, the client is served from the same origin — CORS is permissive for same-origin
// For explicit cross-origin requests, check against allowed list
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests (no origin header) or production domain
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Allow the production app over HTTPS only (no plaintext, no arbitrary subdomains).
    if (/^https:\/\/(www\.|app\.)?stu\.vc$/.test(origin)) return cb(null, true);
    // Allow any localhost port in development
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Stripe webhook needs raw body for signature verification — must be before express.json()
const payments = require('./routes/payments');
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), payments.webhook);

// Body parsing. Only the deck/import upload routes need large bodies — mount the 50MB
// parser on those paths FIRST (it parses + sets req.body, so the small global parser
// below no-ops for them). Everything else (incl. /mcp, /api/ai/chat) is capped at 2MB,
// closing a 50MB memory/cost-amplification DoS surface on the LLM endpoints.
app.use(['/api/assessments', '/api/import'], express.json({ limit: '50mb' }));
// ══════════════════════════════════════════════════════════════════════════
// Danny, 2026-07-15: "Logged into Stu and it's very laggy. Takes time to load
// info in." He was right, and it was never the database.
//
// Measured on the real DB: /api/pipeline is 9.5ms, /api/pipeline/inbox is
// 0.18ms, the whole attention engine is 0.23ms. The entire data layer for a page
// load is ~10ms. Meanwhile every byte was shipping UNCOMPRESSED:
//
//   bundle JS   593KB -> 160KB   (3.7x)
//   CSS          57KB ->   9KB   (6.3x)
//   /api/pipeline 136KB -> ~20KB (6x, on every single Pipeline visit)
//
// ~790KB of first load that should be ~190KB. Over Railway's latency that IS the
// lag — one middleware, mounted before the JSON parser and the static handler so
// it covers both API responses and the bundle.
//
// The lesson worth keeping: an engineer's instinct here is to optimize the SQL,
// and PIPELINE_SQL's 9 correlated subqueries look exactly like the culprit. They
// cost 9.5ms. Measure before you tune, or you spend a day making 9.5ms into 1ms
// while 600KB goes over the wire uncompressed.
// ══════════════════════════════════════════════════════════════════════════
app.use(require('compression')());

app.use(express.json({ limit: '2mb' }));

// Rate limiting
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
// LLM chat surfaces (ai.js + stu.js tool-loop) — frequency-cap separately from the global bucket.
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use('/api/ai', aiLimiter);
app.use('/api/stu', aiLimiter);
app.use('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));
// The fan-out / discovery / LLM-spend endpoints are the most expensive (web-search fan-out
// + many LLM calls, all billed to the user's key). Throttle hard, on top of the spend cap.
const expensiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/talent/sourcing/run', expensiveLimiter);
app.use('/api/talent/sourcing/match', expensiveLimiter);
app.use('/api/sourcing/run', expensiveLimiter);
app.use('/api/discover', expensiveLimiter);
app.use('/api/hiring/matches/run', expensiveLimiter);
app.use('/api/hiring/roles/ingest', expensiveLimiter);
app.use('/api/hiring/warm/import', expensiveLimiter);
app.use('/api/hiring/discovery/run', expensiveLimiter);
app.use(['/api/hiring/roles/:id/source'], expensiveLimiter);
app.use('/api/outreach', expensiveLimiter);
// monitor run + per-id run also trigger discovery — throttled inside routes/monitors.js
// (both /run and /:id/run) since a prefix limiter can't match the :id form.

// Public routes
app.get('/api/health', (req, res) => res.json({
  status: 'ok', app: 'Stu', version: '4.9.2',
  pipeline: {
    // Armed = the daily sourcing/talent/filings crons will actually run tonight.
    sourcing_armed: process.env.PIPELINE_ENABLED === 'true'
      || (!!process.env.EXA_API_KEY && !!process.env.ANTHROPIC_API_KEY),
    newsletter_armed: true, // ungated — runs for any user with sources/Gmail
    has_exa: !!process.env.EXA_API_KEY,
    has_anthropic: !!process.env.ANTHROPIC_API_KEY,
  },
}));
// Full healthcheck board (authed) — green/red status across datastores, keys, jobs, integrity.
app.get('/api/health/full', requireAuth, (req, res) => {
  try { res.json(require('./services/health').buildHealthReport(req.user.id)); }
  catch (e) { res.status(500).json({ overall: 'red', checks: [{ name: 'Healthcheck', status: 'red', detail: e.message }] }); }
});
// Notion mirror drift check (authed, async). ?repair=1 re-pushes missing founders from canonical SQLite.
app.get('/api/health/drift', requireAuth, async (req, res) => {
  try { res.json(await require('./services/notion-sync').checkNotionDrift(req.user.id, { repair: req.query.repair === '1' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/payments', payments.router);
// Deliberately NOT requireAuth (no browser session) — self-gated by VAULT_SYNC_SECRET.
// See routes/vaultSync.js for why this is a separate channel from the shared MCP surface.
app.use('/api/vault-sync', require('./routes/vaultSync'));

// Protected routes
// Today is the surface — the screen Danny opens at 9am and works from all day.
// It also serves /api/today/decisions and /api/today/commitments.
app.use('/api/today', requireAuth, require('./routes/today'));
// The front door. One connected read over the founders spine — sourcing joins in,
// assessments and decisions hang off. See routes/pipeline.js for why there is no
// companies table.
app.use('/api/pipeline', requireAuth, require('./routes/pipeline'));
// The card's source log: decks, URLs, notes, Granola. Mounted separately from
// /api/sources, which is the sourcing CONNECTORS route — same word, different layer.
app.use('/api/companies', requireAuth, require('./routes/companySources'));
app.use('/api/founders', requireAuth, require('./routes/founders'));
app.use('/api/notes', requireAuth, require('./routes/notes'));
app.use('/api/sourcing', requireAuth, require('./routes/sourcing'));
app.use('/api/assessments', requireAuth, require('./routes/assessments'));
app.use('/api/deal-room', requireAuth, require('./routes/dealRoom'));
app.use('/api/calls', requireAuth, require('./routes/calls'));
app.use('/api/ai', requireAuth, require('./routes/ai'));
app.use('/api/stu', requireAuth, require('./routes/stu'));
app.use('/api/memos', requireAuth, require('./routes/memos'));
app.use('/api/files', requireAuth, require('./routes/files'));
app.use('/api/search', requireAuth, require('./routes/search'));
app.use('/api/settings', requireAuth, require('./routes/settings'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.use('/api/import', requireAuth, require('./routes/import'));
app.use('/api/talent', requireAuth, require('./routes/talent'));
app.use('/api/hiring', requireAuth, require('./routes/hiring'));
app.use('/api/newsletter', requireAuth, require('./routes/newsletter'));
app.use('/api/mcp', requireAuth, require('./routes/mcp'));
app.use('/api/monitors', requireAuth, require('./routes/monitors'));
app.use('/api/sources', requireAuth, require('./routes/sources'));
app.use('/api/discover', requireAuth, require('./routes/discover'));
app.use('/api/outreach', requireAuth, require('./routes/outreach'));

// MCP protocol endpoint (token-authed, NOT the web JWT) — mounted before the SPA
// catch-all so it isn't swallowed by the static handler. Rate-limited on its own.
require('./mcp/http').mountMcp(
  app,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
);

// Serve static in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Stu running on http://localhost:${PORT}`);

  // Daily newsletter brief — scheduled independently of PIPELINE_ENABLED so the
  // brief is ready each morning for anyone who has connected their Gmail label.
  {
    const cron = require('node-cron');
    // ══════════════════════════════════════════════════════════════════
    // BACKUP — 3:00am CT, before every other job touches the database.
    //
    // There were none. The recovery story was a March seed file containing
    // founders and nothing else — so every assessment, decision, commitment,
    // signal and note was one bad redeploy from gone, and seedIfEmpty() would
    // have refilled the founder count so the loss looked healthy.
    //
    // First, before anything else, so the snapshot is of yesterday's finished
    // state rather than a database mid-sourcing-run.
    //
    // Verified end-to-end 2026-07-16, not assumed: 1.8MB gz, restored into a
    // scratch dir, 5,515 founders + 20 assessments + 2 decisions + the 4.8
    // conviction score all intact. An unrestored backup is a rumour.
    // ══════════════════════════════════════════════════════════════════
    cron.schedule('0 3 * * *', async () => {
      const { recordJobRun } = require('./services/health');
      try {
        const { runBackup } = require('./services/backup');
        const r = await runBackup();
        if (r.ok) {
          recordJobRun('backup', 'ok', `${r.file} — ${Math.round(r.bytes / 1024)}KB, ${r.verified_assessments} assessments verified inside it, ${r.pruned} pruned`, 1);
          console.log('[Cron][Backup]', r.file, `${Math.round(r.bytes / 1024)}KB`);
        } else {
          // A failed backup is an EMERGENCY, not a warning. It's the only job here
          // whose failure is silent and permanent.
          recordJobRun('backup', 'error', r.error, 1);
          console.error('[Cron][Backup] FAILED:', r.error);
        }
      } catch (e) {
        recordJobRun('backup', 'error', e.message, 1);
        console.error('[Cron][Backup] FAILED:', e.message);
      }
    }, { timezone: 'America/Chicago' });
    console.log('Nightly backup scheduled (3:00 AM CT — verified + pruned to 14)');

    // Airtable → Stu, once a day at 5:45am CT — before Danny opens the app, and
    // off the boot path where it was blocking his first requests for ~106ms.
    // Airtable is the team's CRM and the closest thing to source-of-truth on the
    // deal pipeline; it changes a few times a day, not on every Stu restart.
    cron.schedule('45 5 * * *', async () => {
      const { recordJobRun } = require('./services/health');
      try {
        const { syncFromAirtable } = require('./services/airtable-import');
        const r = await syncFromAirtable();
        recordJobRun('airtable_sync', 'ok', JSON.stringify(r || {}).slice(0, 200), 1);
      } catch (e) {
        console.error('[Cron][AirtableSync]', e.message);
        recordJobRun('airtable_sync', 'error', e.message, 1);
      }
    }, { timezone: 'America/Chicago' });
    console.log('Daily Airtable sync scheduled (5:45 AM CT)');

    cron.schedule('0 6 * * *', async () => {
      console.log('[Cron] Starting daily newsletter brief...');
      const { recordJobRun } = require('./services/health');
      try {
        const dbi = require('./db');
        const { fetchAndProcess, fetchAllSources } = require('./services/newsletter');
        // Users with either a managed source (RSS/email) or a legacy Gmail label setup.
        const users = dbi.prepare(`
          SELECT DISTINCT user_id FROM (
            SELECT user_id FROM newsletter_sources WHERE enabled = 1 AND is_deleted = 0
            UNION
            SELECT user_id FROM user_settings WHERE setting_key = 'newsletter_gmail_app_password'
              AND setting_value IS NOT NULL AND setting_value != '' AND setting_value != '""'
          )
        `).all();
        const { backfillAll } = require('./services/brief-archive');
        const { sendDigest } = require('./services/email-digest');
        for (const { user_id } of users) {
          try {
            // 1. Pull the latest newsletter issues.
            const hasSources = dbi.prepare("SELECT COUNT(*) c FROM newsletter_sources WHERE user_id = ? AND enabled = 1 AND is_deleted = 0 AND kind != 'archive'").get(user_id).c > 0;
            const r = hasSources ? await fetchAllSources(user_id) : await fetchAndProcess(user_id, { limit: 40 });
            console.log(`[Cron][Newsletter] user ${user_id}:`, r.ok ? `${r.added} added` : r.error);
            // 2. Keep archive catalogues fresh (idempotent; cheap).
            const hasArchives = dbi.prepare("SELECT COUNT(*) c FROM newsletter_sources WHERE user_id=? AND kind='archive' AND enabled=1 AND is_deleted=0").get(user_id).c > 0;
            if (hasArchives) { try { await backfillAll(user_id); } catch (e) { console.error(`[Cron][Brief] backfill ${user_id}:`, e.message); } }
            // 3. Build + email the digest.
            const sent = await sendDigest(user_id);
            console.log(`[Cron][Brief] user ${user_id}:`, sent.ok ? (sent.skipped ? `skipped (${sent.reason})` : `sent → ${sent.recipient} (${sent.archive} classics, ${sent.newsletters} newsletters)`) : sent.error);
          } catch (e) { console.error(`[Cron][Newsletter] user ${user_id} failed:`, e.message); }
        }
      } catch (e) { console.error('[Cron][Newsletter] run failed:', e.message); }
    }, { timezone: 'America/Chicago' });
    console.log('Daily newsletter brief scheduled (6:00 AM CT)');
  }

  // Daily signal monitors — runs for any user with an enabled monitor. Local detection is
  // deterministic (no key), so this is ungated like the newsletter brief; an ACTIVE monitor
  // (config.active) additionally discovers from the web on the user's Exa key + spend cap
  // (degrades gracefully if absent). Records new "X just happened" hits into monitor_hits.
  {
    const cron = require('node-cron');
    cron.schedule('0 7 * * *', async () => {
      console.log('[Cron] Running daily signal monitors...');
      const { recordJobRun } = require('./services/health');
      try {
        const { runAllMonitors } = require('./pipeline/monitor-engine');
        const r = await runAllMonitors();
        console.log(`[Cron][Monitors] ${r.users} user(s), ${r.totalNew} new hit(s)`);
      } catch (e) { console.error('[Cron][Monitors] run failed:', e.message); }
    }, { timezone: 'America/Chicago' });
    console.log('Daily signal monitors scheduled (7:00 AM CT)');
  }

  // ── Weekly founder-slope refresh + snapshot (Sun 6:00 AM CT) ──
  // Danny: "At pre-seed we really care about founder slope." GitHub trajectory is
  // recomputed for pool founders, then every founder's signal state is snapshotted so
  // slope on non-timestamped signals becomes a week-over-week delta. Weekly because
  // slope is a slow-moving signal and the clock only needs to tick steadily — the
  // point is that history accumulates, not that it's real-time.
  {
    const cron = require('node-cron');
    cron.schedule('0 6 * * 0', async () => {
      try {
        const { runBuilderRadar } = require('./services/builder-radar');
        const r = await runBuilderRadar({ userId: 1 });
        console.log(`[Cron][Slope] ${r.summary}`);
      } catch (e) {
        console.error('[Cron][Slope] failed:', e.message);
      }
    }, { timezone: 'America/Chicago' });
    console.log('Weekly founder-slope refresh scheduled (Sun 6:00 AM CT)');
  }

  // Daily early-signal sources — pulls USPTO trademarks (and future connectors) for the
  // owner, geo-filtered to their Chicago/IL criteria, into the sourced queue. Connectors
  // without a configured key (e.g. USPTO until USPTO_API_KEY is set) no-op harmlessly.
  {
    const cron = require('node-cron');
    // ══════════════════════════════════════════════════════════════════
    // The nightly scout. This is the ONLY thing that makes sourcing feel alive —
    // Harmonic's lesson is that the alert is the product and the search bar is
    // its config UI. The inbox should fill overnight and be waiting.
    //
    // It used to log to console and record NOTHING, which is why job_runs is
    // empty and why Danny said "it didn't seem to be sourcing new founders for me
    // on any time interval." On Railway a console line scrolls away in minutes;
    // if it isn't in the database, it didn't happen as far as he can tell. An
    // automation with no durable record is indistinguishable from one that never
    // runs — and he correctly concluded it never ran.
    // ══════════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════════
    // MONTHLY, not nightly. 1st of the month, 11:30am CT.
    //
    // Every connector here reads a COHORT LIST, and cohort lists change a few
    // times a year: YC ships two batches, a16z Speedrun runs SR00x cohorts, Thiel
    // / Z Fellows / Neo / Residency / Emergent announce in waves. Polling them
    // nightly asked a question whose answer changes twice a year, 365 times a
    // year — and then paid an LLM to re-read the same 144 YC founders each time.
    //
    // The dedup fix (sources/index.js) already made those re-reads free. This
    // makes them rare, which also cuts the Exa line (~$11.40/mo) by ~30x. The two
    // together take this cron from ~$36/mo to roughly $1.
    //
    // Nothing is lost: a founder who appears in the YC directory on the 3rd is
    // still there on the 1st of next month. These sources are a floor, not an
    // edge — the whole point of Danny's Frontier Watch framing. If something ever
    // needs to be caught the day it lands, it does not belong on this cron.
    // ══════════════════════════════════════════════════════════════════
    cron.schedule('30 11 1 * *', async () => {
      console.log('[Cron] Running early-signal sources (monthly)...');
      const { recordJobRun } = require('./services/health');
      try {
        const { ingestAll } = require('./pipeline/sources');
        const r = await ingestAll({ userId: 1 });
        console.log('[Cron][Sources]', JSON.stringify(r.map(x => ({ s: x.source, kept: x.geoKept, saved: x.persisted, skipped: x.skippedAsDupe, err: x.error }))));

        const saved = r.reduce((n, x) => n + (x?.persisted || 0), 0);
        const fetched = r.reduce((n, x) => n + (x?.fetched || 0), 0);
        const errs = r.filter((x) => x?.error);
        // Per-connector, so a source producing zero is visible AS zero rather than
        // vanishing into a total. That the cohort rosters fetch ~99 people and
        // yield 0 Illinois ties is a finding about the source, not a failure —
        // and it should be readable here instead of rediscovered every few months.
        const breakdown = r.map((x) => `${x.source}: ${x.fetched}→${x.geoKept} IL`).join(' · ');
        // skippedAsDupe is in the line because a HEALTHY saturated run now looks
        // like "fetched 144, skipped 144, saved 0, $0" — and without that number
        // it is indistinguishable from a broken connector. That ambiguity is the
        // exact reason Danny concluded sourcing didn't work when it did.
        const skipped = r.reduce((n, x) => n + (x?.skippedAsDupe || 0), 0);
        recordJobRun(
          'early_signal_sources',
          errs.length ? 'partial' : 'ok',
          `+${saved} saved of ${fetched} fetched, ${skipped} already known (not re-enriched) — ${breakdown}` +
            `${errs.length ? ` — ${errs.length} errors` : ''}`,
          1
        );

      } catch (e) {
        console.error('[Cron][Sources] failed:', e.message);
        // A failure has to be as visible as a success, or silence stays ambiguous.
        recordJobRun('early_signal_sources', 'error', e.message, 1);
      }
    }, { timezone: 'America/Chicago' });
    console.log('Early-signal sources scheduled (MONTHLY — 1st, 11:30 AM CT)');

    // ══════════════════════════════════════════════════════════════════
    // LinkedIn enrichment stays DAILY, and deliberately did not go monthly with
    // the sources it used to ride along with.
    //
    // It isn't polling anything — it's draining a finite backlog: 612 sourced
    // founders with a LinkedIn URL and no profile read, at limit 40/run. Monthly
    // would take FIFTEEN MONTHS. Daily drains it in ~15 days for ~$6 total, and
    // then costs ~$0/day forever, because `linkedin_enriched_at IS NULL` means a
    // drained queue does no work.
    //
    // It's also the highest-value spend in the product. Every scorer here is
    // currently regexing 195-character bios, which is why 268 of 624 rows carry
    // the identical breakout score. Real employment history is the input that
    // makes the ranking mean anything — Danny said "I'll pay for enrichment" and
    // this is the thing he was paying for.
    // ══════════════════════════════════════════════════════════════════
    cron.schedule('0 12 * * *', async () => {
      const { recordJobRun } = require('./services/health');
      try {
        const { runLinkedInEnrichment } = require('./pipeline/linkedin-enrich');
        const e = await runLinkedInEnrichment({ userId: 1, limit: 40 });
        console.log('[Cron][LinkedIn]', JSON.stringify(e));
        recordJobRun(
          'linkedin_enrich',
          'ok',
          e.skipped
            ? String(e.skipped)
            : `${e.enriched} enriched, ${e.promoted} promoted to the IL board, ${e.flagged} flagged as noise`,
          1
        );
      } catch (e) {
        console.error('[Cron][LinkedIn] failed:', e.message);
        recordJobRun('linkedin_enrich', 'error', e.message, 1);
      }
    }, { timezone: 'America/Chicago' });
    console.log('LinkedIn enrichment scheduled (daily 12:00 PM CT — drains the backlog, then idles)');
  }

  // Weekly founder digest — Friday 7:00 AM CT. Emails the week's top under-the-radar
  // (pre-program / high-breakout) IL founders. Reuses the Daily Brief Gmail config.
  {
    const cron = require('node-cron');
    cron.schedule('0 7 * * 5', async () => {
      console.log('[Cron] Sending weekly founder digest...');
      const { recordJobRun } = require('./services/health');
      try {
        const { sendFounderDigest } = require('./services/founder-digest');
        const r = await sendFounderDigest(1, {});
        console.log('[Cron][FounderDigest]', JSON.stringify(r));
      } catch (e) { console.error('[Cron][FounderDigest] failed:', e.message); }
    }, { timezone: 'America/Chicago' });
    console.log('Weekly founder digest scheduled (Fri 7:00 AM CT)');
  }

  // Daily sourcing cron — runs at 6:00 AM CT (12:00 UTC in CDT / 12:00 UTC in CST).
  // Self-activating: we schedule whenever the pipeline can actually do work — i.e. the
  // keys that power it (Exa for discovery + Anthropic for scoring) are present in the
  // environment — OR when PIPELINE_ENABLED is explicitly set. This removes the silent
  // failure mode where the engine was built and keyed but never ran because a separate
  // flag wasn't flipped in prod.
  const pipelineReady = process.env.PIPELINE_ENABLED === 'true'
    || (!!process.env.EXA_API_KEY && !!process.env.ANTHROPIC_API_KEY);
  if (pipelineReady) {
    console.log(`[Cron] Pipeline active (${process.env.PIPELINE_ENABLED === 'true' ? 'PIPELINE_ENABLED' : 'keys present'})`);
    const cron = require('node-cron');
    const { runSourcingEngine } = require('./pipeline/sourcing-engine');

    // ══════════════════════════════════════════════════════════════════
    // The daily sourcing run — the single biggest recurring line on Danny's bill
    // (~$29.80/mo: 27 Exa queries + ~37 LLM calls), and until now it recorded
    // NOTHING. It logged to console, which on Railway scrolls away in minutes.
    //
    // That is exactly why he said "I would click Find Founders and it wouldn't
    // really work": the only durable record was sourcing_runs, written by this
    // engine alone, while the connectors that actually produced rows wrote
    // nowhere. Thirty dollars a month with no evidence it ran.
    //
    // Timezone added. It was bare `0 12 * * *` — 12:00 UTC — while the boot log
    // announced "6:00 AM CT". Off by an hour in summer, and a log that lies about
    // when a job runs is the same defect as one that lies about whether it did.
    // ══════════════════════════════════════════════════════════════════
    cron.schedule('0 8 * * *', async () => {
      console.log('[Cron] Starting daily sourcing run...');
      const { recordJobRun } = require('./services/health');
      try {
        const result = await runSourcingEngine({ userId: 1 });
        const errs = result.errors?.length || 0;
        recordJobRun(
          'sourcing_run',
          errs ? 'partial' : 'ok',
          `+${result.totalAdded || 0} added, ${result.totalFiltered || 0} filtered by the gates` +
            `${errs ? `, ${errs} errors — ${String(result.errors[0]).slice(0, 80)}` : ''}`,
          1
        );
        console.log(`[Cron] Sourcing complete: ${result.totalAdded} new founders`);
      } catch (err) {
        console.error('[Cron] Sourcing failed:', err.message);
        recordJobRun('sourcing_run', 'error', err.message, 1);
      }
    }, { timezone: 'America/Chicago' });

    console.log('Daily sourcing engine scheduled (8:00 AM CT)');

    // Daily talent sourcing — source EACH open role against its own function + JD, so
    // marketing/product/CS roles get fresh candidates automatically (not just engineering).
    const { runTalentEngine } = require('./pipeline/talent-engine');
    cron.schedule('30 12 * * *', async () => {
      const dbi = require('./db');
      const roles = dbi.prepare("SELECT id, user_id, title FROM talent_roles WHERE is_deleted = 0 AND status = 'open' ORDER BY user_id, updated_at DESC LIMIT 25").all();
      console.log(`[Cron] Daily talent sourcing across ${roles.length} open role(s)`);
      const { recordJobRun } = require('./services/health');
      if (!roles.length) {
        // `nothing` is a first-class outcome. A ledger that only fills on success
        // is the bug it was built to fix — silence must mean "I looked".
        recordJobRun('talent_sourcing', 'nothing', 'no open roles', 1);
        return;
      }
      let added = 0, failed = 0;
      for (const role of roles) {
        try {
          const r = await runTalentEngine({ userId: role.user_id, roleId: role.id });
          added += r.candidatesAdded || 0;
          console.log(`[Cron][Talent] role ${role.id} "${role.title}": found ${r.candidatesFound}, added ${r.candidatesAdded}, ${r.matchesCreated} matches`);
        } catch (err) {
          failed++;
          console.error(`[Cron][Talent] role ${role.id} failed:`, err.message);
        }
      }
      // This fans out one full engine run PER ROLE, up to 25. One open role today,
      // so it's ~free — but the cost is linear in roles and nothing recorded it,
      // so a day with 12 open reqs would have been a surprise on the invoice.
      recordJobRun(
        'talent_sourcing', failed ? 'partial' : 'ok',
        `${roles.length} role(s), +${added} candidates${failed ? `, ${failed} failed` : ''}`, 1
      );
    });
    console.log('Daily talent sourcing engine scheduled (6:30 AM CT, per open role)');

    // R2: Daily SEC Form D IL filings pull — 11 AM UTC (pre-sourcing run so any
    // new filings are available for matching when sourcing runs at 12 UTC).
    const { runFilingsSource } = require('./pipeline/filings-source');
    cron.schedule('0 11 * * *', async () => {
      console.log('[Cron] Starting SEC Form D filings pull...');
      try {
        const result = await runFilingsSource({ userId: 1, days: 30 });
        console.log('[Cron] Filings pull complete:', result);
        recordJobRun('sec_filings', 'ok', JSON.stringify(result).slice(0, 200), 1);
      } catch (err) {
        console.error('[Cron] Filings pull failed:', err.message);
      }
    });
    console.log('Daily SEC filings pull scheduled (5:00 AM CT)');
  }
});
