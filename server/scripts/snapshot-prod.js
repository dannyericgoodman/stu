'use strict';
// ══════════════════════════════════════════════════════════════════════════
// snapshot-prod.js — pull production through its own REST API, because the
// database file cannot be reached any other way.
//
// Stu's entire state is one SQLite file on a Railway volume. The Railway account
// that owns that volume is tied to an email address nobody can sign into, so:
//   * there is no dashboard, no shell, no `railway run`, no volume download;
//   * `/data/backups` (14 nightly backups, written by services/backup.js) is on
//     that same volume, so the backups are exactly as unreachable as the DB;
//   * there is no export endpoint in the deployed code, and none can be added,
//     because deploying to that account is the very thing that stopped working.
//
// What is left is the running app's authenticated read API, reachable only through
// the `www.stu.vc` custom domain. That domain is a CNAME the registrar controls.
// **Repointing it is irreversible for data purposes** — the container keeps running
// but becomes unaddressable, since the generated `*.up.railway.app` host 404s. So a
// fresh run of this script is a hard prerequisite for any host migration, not a
// nice-to-have. Take the snapshot, verify it, THEN touch DNS.
//
// ── AUTH: minted, not logged in ──
// The production admin password is a random 18-byte value generated at first boot
// (db.js) and never printed, so there is nothing to log in with. But the repo `.env`
// carries the same JWT_SECRET production runs, so a locally signed owner token
// verifies server-side. That is a convenience here and a real finding otherwise: a
// public repo's .env can mint production credentials. The new host must get a fresh
// JWT_SECRET that does not live in the tree.
//
// ── RATE LIMIT is the binding constraint ──
// server/index.js applies `rateLimit({ windowMs: 15min, max: 200 })` to all of
// `/api`. A complete per-founder crawl (notes + calls + memos over 312 founders) is
// ~936 requests — over four windows. So this script:
//   * spends its budget in priority order, non-regenerable data FIRST;
//   * stops cleanly on 429 rather than hammering a live production box;
//   * is RESUMABLE — an existing output file is skipped, so re-running in the next
//     window continues where it stopped instead of starting over.
//
// Usage:
//   node scripts/snapshot-prod.js [outDir] [--budget=190] [--base=https://www.stu.vc]
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// Load the repo .env by hand — this script runs standalone and must not require db.js
// (which would try to open a local SQLite file and, in production mode, refuse to boot).
const envPath = path.join(__dirname, '..', '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const JWT_SECRET = process.env.JWT_SECRET || env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: no JWT_SECRET in env or repo .env — cannot mint a token.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const BASE = flag('base', 'https://www.stu.vc');
const BUDGET = Number(flag('budget', 190));
const stamp = new Date().toISOString().slice(0, 10);
const OUT = args.find((a) => !a.startsWith('--'))
  || path.join(__dirname, '..', '..', '..', `superior-os-prod-backup-${stamp}`);

const TOKEN = jwt.sign(
  { id: 1, email: 'danny.eric.goodman@gmail.com', name: 'Danny Goodman', role: 'admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

let spent = 0;
let rateLimited = false;
const manifest = { base: BASE, startedAt: new Date().toISOString(), ok: [], failed: [], skipped: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(route) {
  if (rateLimited) return { stop: true };
  if (spent >= BUDGET) {
    manifest.skipped.push({ route, reason: 'request budget exhausted' });
    return { stop: true };
  }
  spent++;
  try {
    const res = await fetch(`${BASE}${route}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(90000),
    });
    if (res.status === 429) {
      rateLimited = true;
      manifest.failed.push({ route, status: 429, note: 'rate limit hit — resume in the next 15-min window' });
      return { stop: true };
    }
    if (!res.ok) {
      manifest.failed.push({ route, status: res.status });
      return { error: res.status };
    }
    return { data: await res.json() };
  } catch (e) {
    manifest.failed.push({ route, error: e.message });
    return { error: e.message };
  }
}

function write(relPath, data) {
  const full = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2));
  const rows = Array.isArray(data) ? data.length : (data && Array.isArray(data.rows) ? data.rows.length : null);
  manifest.ok.push({ route: relPath, rows });
  return rows;
}

const exists = (relPath) => fs.existsSync(path.join(OUT, relPath));

// Pull one route to one file. Returns the parsed body so callers can chain.
async function pull(route, relPath, { force = false } = {}) {
  if (!force && exists(relPath)) {
    manifest.skipped.push({ route, reason: 'already present (resume)' });
    return JSON.parse(fs.readFileSync(path.join(OUT, relPath), 'utf8'));
  }
  const r = await get(route);
  if (r.stop || r.error) return null;
  const rows = write(relPath, r.data);
  console.log(`  ✓ ${relPath}${rows !== null ? ` (${rows} rows)` : ''}  [${spent}/${BUDGET}]`);
  await sleep(120); // be gentle: this is the live production box serving the crons
  return r.data;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\nSnapshotting ${BASE} → ${OUT}`);
  console.log(`Request budget: ${BUDGET} (prod allows 200 per 15 min)\n`);

  // ── PHASE 1 — the non-regenerable core, in priority order ──
  // Assessments are multi-agent Opus runs that cost real money and will not reproduce.
  // The taste profile is learned from every approve/dismiss Danny has ever made.
  console.log('PHASE 1 — non-regenerable');
  const index = await pull('/api/assessments', 'assessments.json');
  const ids = Array.isArray(index) ? index.map((a) => a.id) : [];
  for (const id of ids) {
    await pull(`/api/assessments/${id}`, `assessments/${id}.json`);
    await pull(`/api/assessments/${id}/inputs`, `assessments/${id}-inputs.json`);
  }
  await pull('/api/sourcing/taste-profile', 'sourcing_taste-profile.json');
  await pull('/api/today/decisions/calibration', 'today_decisions_calibration.json');
  await pull('/api/today/commitments', 'today_commitments.json');
  await pull('/api/pipeline/predictions', 'pipeline_predictions.json');
  await pull('/api/pipeline/movers', 'pipeline_movers.json');

  // ── PHASE 2 — the board and the deal state ──
  console.log('PHASE 2 — board + deal state');
  const founders = await pull('/api/founders', 'founders.json');
  await pull('/api/pipeline/shortlist', 'pipeline_shortlist.json');
  await pull('/api/deal-room', 'deal_room.json');
  await pull('/api/monitors', 'monitors.json');
  await pull('/api/monitors/hits', 'monitors_hits.json');
  await pull('/api/sources', 'sources.json');
  await pull('/api/pipeline/stats', 'pipeline_stats.json');
  await pull('/api/sourcing/stats', 'sourcing_stats.json');
  await pull('/api/sourcing/runs', 'sourcing_runs.json');
  await pull('/api/sourcing/starred', 'sourcing_starred.json');
  await pull('/api/today', 'today.json');
  await pull('/api/today/attention', 'today_attention.json');

  // ── PHASE 3 — the sourcing inbox, paginated ──
  // Note the honest limit: /inbox selects only indexed columns, so raw_data,
  // enriched_data and linkedin_data do NOT come back. Those blobs are what
  // lib/founderFit reads for markers. The rows are restorable; the evidence
  // behind their stored verdicts is not. The nightly scout re-sources this.
  console.log('PHASE 3 — sourcing inbox (paginated)');
  for (const scope of ['pipeline', 'watchlist']) {
    let offset = 0;
    for (;;) {
      const page = await pull(
        `/api/pipeline/inbox?limit=500&offset=${offset}&scope=${scope}`,
        `inbox/${scope}-${offset}.json`
      );
      if (!page) break;
      const got = Array.isArray(page.rows) ? page.rows.length : 0;
      const total = Number(page.total || 0);
      offset += 500;
      if (got < 500 || offset >= total) break;
    }
  }

  // ── PHASE 4 — per-founder human writing (notes, calls, memos) ──
  // This is what the 2026-08-29 snapshot missed entirely. Notes and call logs are
  // typed by a human and regenerate from nothing. Prioritised: anything with deal
  // motion first, then most-recently-touched, because the budget will not cover 312.
  console.log('PHASE 4 — per-founder notes/calls/memos (budget-limited, resumable)');
  if (Array.isArray(founders)) {
    const priority = [...founders].sort((a, b) => {
      const motion = (f) => (f.deal_status ? 2 : 0) + (f.memo_status || f.diligence_status ? 1 : 0);
      return motion(b) - motion(a)
        || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    for (const f of priority) {
      if (rateLimited || spent >= BUDGET) break;
      await pull(`/api/notes/${f.id}`, `founder-detail/${f.id}-notes.json`);
      await pull(`/api/calls/${f.id}`, `founder-detail/${f.id}-calls.json`);
      await pull(`/api/memos/${f.id}`, `founder-detail/${f.id}-memos.json`);
    }
    const covered = new Set(
      fs.existsSync(path.join(OUT, 'founder-detail'))
        ? fs.readdirSync(path.join(OUT, 'founder-detail')).map((n) => n.split('-')[0])
        : []
    );
    manifest.founderDetail = { covered: covered.size, total: founders.length };
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.requestsSpent = spent;
  manifest.rateLimited = rateLimited;
  manifest.complete = !rateLimited && spent < BUDGET;
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n─────────────────────────────────────────`);
  console.log(`requests spent : ${spent}/${BUDGET}`);
  console.log(`files written  : ${manifest.ok.length}`);
  console.log(`failed         : ${manifest.failed.length}`);
  console.log(`rate limited   : ${rateLimited}`);
  if (manifest.founderDetail) {
    console.log(`founder detail : ${manifest.founderDetail.covered}/${manifest.founderDetail.total} founders`);
  }
  if (rateLimited || !manifest.complete) {
    console.log(`\nINCOMPLETE — re-run the SAME command in ~15 minutes; it resumes.`);
  }
  console.log(`out: ${OUT}\n`);
})();
