'use strict';
// ══════════════════════════════════════════════════════════════════════════
// push-snapshot.js — send a prod snapshot to a new host over HTTP.
//
// The companion to restore-snapshot.js, for the case where the target's database
// cannot be reached as a file. restore-snapshot.js runs WHERE the db is; this runs
// where the SNAPSHOT is (a laptop) and pushes rows to routes/restore.js instead.
//
// Insert order is load-bearing: founders own the foreign keys that notes, memos and
// call logs point at, and assessments hang off founders too. Push parents first or
// SQLite rejects the children.
//
// Usage:
//   RESTORE_TOKEN=... node scripts/push-snapshot.js <snapshot-dir> --base=https://host
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const BASE = (args.find((a) => a.startsWith('--base=')) || '').split('=')[1];
const TOKEN = process.env.RESTORE_TOKEN;

if (!dir || !fs.existsSync(dir)) { console.error('Usage: node scripts/push-snapshot.js <snapshot-dir> --base=<url>'); process.exit(1); }
if (!BASE) { console.error('FATAL: --base=<url> is required'); process.exit(1); }
if (!TOKEN) { console.error('FATAL: RESTORE_TOKEN env var is required'); process.exit(1); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const listOf = (raw, ...keys) => (Array.isArray(raw) ? raw : (keys.map((k) => raw[k]).find(Array.isArray) || raw.rows || []));

async function post(route, body) {
  const r = await fetch(`${BASE}/api/restore${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${route} → HTTP ${r.status}: ${JSON.stringify(json)}`);
  return json;
}

// Batched so one oversized request cannot fail an entire table.
async function pushRows(table, rows, { skip = [], batch = 50 } = {}) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const res = await post('/rows', { table, rows: rows.slice(i, i + batch), skip });
    written += res.written;
  }
  if (rows.length) console.log(`  ${table}: ${written}/${rows.length} written`);
  return written;
}

(async () => {
  // ── 1. Founders (parents) ──
  const fPath = path.join(dir, 'founders.json');
  if (fs.existsSync(fPath)) {
    // The read API nests derived read-models the table has no columns for.
    const rows = listOf(readJson(fPath), 'founders').map(({ fit, assessment, decision, stu_read, ...flat }) => flat);
    await pushRows('founders', rows, { batch: 40 });
  }

  // ── 2. Assessments + inputs ──
  const aDir = path.join(dir, 'assessments');
  if (fs.existsSync(aDir)) {
    const files = fs.readdirSync(aDir).filter((f) => /^\d+\.json$/.test(f));
    const assessments = [], inputs = [];
    for (const f of files) {
      const a = readJson(path.join(aDir, f));
      // Strip the parsed conveniences the route adds on read — the durable columns
      // (panel_output, conviction_output, …) are already in the payload.
      const { panel, agenda, bear, memo_7m, defensibility, company, decision, inputs: _in, ...row } = a;
      assessments.push(row);
      const ip = path.join(aDir, f.replace('.json', '-inputs.json'));
      if (fs.existsSync(ip)) for (const inp of listOf(readJson(ip), 'inputs')) inputs.push({ ...inp, assessment_id: a.id });
    }
    await pushRows('opportunity_assessments', assessments, { batch: 10 });
    await pushRows('assessment_inputs', inputs, { skip: ['id'], batch: 25 });
  }

  // ── 3. Per-founder detail (children) ──
  const dDir = path.join(dir, 'founder-detail');
  if (fs.existsSync(dDir)) {
    const tableFor = { notes: 'founder_notes', calls: 'call_logs', memos: 'founder_memos' };
    const buckets = { notes: [], calls: [], memos: [] };
    for (const f of fs.readdirSync(dDir)) {
      const m = f.match(/^(\d+)-(notes|calls|memos)\.json$/);
      if (!m) continue;
      const [, founderId, kind] = m;
      for (const r of listOf(readJson(path.join(dDir, f)), kind)) {
        buckets[kind].push({ ...r, founder_id: r.founder_id ?? Number(founderId) });
      }
    }
    for (const [kind, rows] of Object.entries(buckets)) await pushRows(tableFor[kind], rows, { batch: 50 });
  }

  // ── 3b. The sourcing inbox ──
  // Skipped by restore-snapshot.js on purpose (the ranker's blobs did not survive the
  // API crawl), but an empty inbox is a worse outcome than a read-only one: 26 of the
  // 28 captured fields DO land, including caliber tier/score, the signal sets and the
  // Chicago connection, which is everything the Source board reads to render and filter.
  // What is missing is raw_data/enriched_data/linkedin_data, so a RE-SCORE of these rows
  // would mis-rank them until LinkedIn enrichment backfills the blobs.
  //
  // user_id is stamped here because the snapshot has no such field — the read API never
  // exposed it — and the inbox query filters on it. Without this every restored row is
  // invisible to every user, which is indistinguishable from the restore doing nothing.
  const iDir = path.join(dir, 'inbox');
  if (fs.existsSync(iDir)) {
    const ownerId = Number((args.find((a) => a.startsWith('--owner=')) || '--owner=1').split('=')[1]);
    const rows = [];
    for (const f of fs.readdirSync(iDir)) {
      if (!/\.json$/.test(f)) continue;
      const raw = readJson(path.join(iDir, f));
      // Derived read-model fields with no column behind them.
      for (const r of listOf(raw, 'rows', 'inbox', 'candidates')) {
        const { is_new, fit, ...flat } = r;
        rows.push({ ...flat, user_id: r.user_id ?? ownerId });
      }
    }
    // The crawl paginated with overlapping windows; dedupe by id so a row is not
    // counted twice in the reported total.
    const byId = new Map();
    for (const r of rows) byId.set(r.id, r);
    console.log(`  inbox: ${byId.size} unique rows (from ${rows.length} across pages), owner=${ownerId}`);
    await pushRows('sourced_founders', [...byId.values()], { batch: 50 });
  }

  // ── 4. Make the owner account reachable, then report ──
  const admin = await post('/reset-admin', {});
  console.log(`  admin password reset for ${admin.email}`);

  const r = await fetch(`${BASE}/api/restore/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log('FINAL COUNTS:', JSON.stringify((await r.json()).counts));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
