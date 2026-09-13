'use strict';
// ══════════════════════════════════════════════════════════════════════════
// /api/network — the people graph, the asks it answers, and the match runs.
//
// Three shapes of endpoint:
//   · import  — owner-only, writes the book from Danny's own LinkedIn export
//               and from Airtable (READ-ONLY on the Airtable side, always).
//   · read    — the book, the open Founder Asks, the companies that can be matched.
//   · match   — a need in, a ranked shortlist with receipts out, persisted as a run.
//
// Airtable is read and never written. The base is shared with Danny's team and
// hand-maintained; an agent writing to it puts unreviewed state in front of
// colleagues. Everything this module produces stays in Stu, and where Danny
// wants a match reflected in Airtable he copies it across himself.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const https = require('https');
const router = express.Router();
const db = require('../db');
const { isOwner } = require('../lib/providerKeys');
const { matchNeed, clampCount } = require('../lib/networkMatch');
const { stalenessLabel } = require('../lib/relationshipStrength');
const { importLinkedInExport, importAirtableNetwork } = require('../pipeline/network-ingest');
const { TABLE, recordsUrl, authHeaders, isConfigured } = require('../lib/airtableBase');

// A full LinkedIn export runs ~12 MB; the cap leaves headroom without inviting
// an arbitrary upload. memoryStorage because the zip is parsed and discarded.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── Airtable read helper ──────────────────────────────────────────────────
function fetchAirtable(tableId, params = {}) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const page = (offset) => {
      https.get(recordsUrl(tableId, { pageSize: 100, ...params, offset: offset || undefined }),
        { headers: authHeaders() }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`Airtable HTTP ${res.statusCode}`));
            let data; try { data = JSON.parse(b); } catch { return reject(new Error('Airtable returned non-JSON')); }
            rows.push(...(data.records || []));
            if (data.offset) page(data.offset); else resolve(rows);
          });
        }).on('error', reject);
    };
    page(null);
  });
}

const selName = (v) => (v && typeof v === 'object' ? v.name : v) || null;

// ── The book, shaped for the matcher ──────────────────────────────────────
// One query, whole book. At ~3,000 rows a full scan is single-digit
// milliseconds, and it keeps the matcher a pure function over plain objects
// rather than something that has to know SQL.
const BOOK_SQL = `
  SELECT id, name, title, company, linkedin_url, email, expertise, notes,
         functions, personas, sectors, seniority, is_commercial, profile_signal,
         warmth, warmth_tier, months_since, relationship_receipt, sources
  FROM network_people
  WHERE user_id = ? AND is_deleted = 0
`;

function parseJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

function toMatcherShape(r) {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    company: r.company,
    linkedin_url: r.linkedin_url,
    email: r.email,
    profile: {
      functions: parseJson(r.functions, []),
      personas: parseJson(r.personas, []),
      sectors: parseJson(r.sectors, []),
      seniority: r.seniority,
      company: r.company,
      is_commercial: !!r.is_commercial,
      signal: r.profile_signal || 'none',
    },
    relationship: {
      warmth: r.warmth || 0,
      tier: r.warmth_tier || 'name_only',
      months_since: r.months_since,
      staleness: stalenessLabel(r.months_since),
      receipt: r.relationship_receipt,
    },
  };
}

function loadBook(userId) {
  return db.prepare(BOOK_SQL).all(userId).map(toMatcherShape);
}

// ── GET /api/network/status ───────────────────────────────────────────────
// Book size, warmth distribution, and — the one that matters — how old the
// underlying export is. A stale export ranks people by jobs they have left,
// so the age is surfaced rather than buried.
router.get('/status', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) n FROM network_people WHERE user_id = ? AND is_deleted = 0').get(req.user.id).n;
  const tiers = db.prepare(`SELECT warmth_tier t, COUNT(*) n FROM network_people
                            WHERE user_id = ? AND is_deleted = 0 GROUP BY warmth_tier`).all(req.user.id)
    .reduce((a, r) => (a[r.t || 'unknown'] = r.n, a), {});
  const signal = db.prepare(`SELECT profile_signal s, COUNT(*) n FROM network_people
                             WHERE user_id = ? AND is_deleted = 0 GROUP BY profile_signal`).all(req.user.id)
    .reduce((a, r) => (a[r.s || 'none'] = r.n, a), {});
  const lastLinkedIn = db.prepare(`SELECT export_dated, run_at, summary FROM network_import_runs
                                   WHERE user_id = ? AND source = 'linkedin_export'
                                   ORDER BY run_at DESC LIMIT 1`).get(req.user.id);
  const lastAirtable = db.prepare(`SELECT run_at, summary FROM network_import_runs
                                   WHERE user_id = ? AND source = 'airtable'
                                   ORDER BY run_at DESC LIMIT 1`).get(req.user.id);

  let exportAgeDays = null;
  if (lastLinkedIn && lastLinkedIn.export_dated) {
    exportAgeDays = Math.round((Date.now() - new Date(lastLinkedIn.export_dated).getTime()) / 86400000);
  }

  res.json({
    total, tiers, signal,
    reachable: (tiers.strong || 0) + (tiers.real || 0),
    last_linkedin_import: lastLinkedIn || null,
    last_airtable_import: lastAirtable || null,
    export_dated: lastLinkedIn ? lastLinkedIn.export_dated : null,
    export_age_days: exportAgeDays,
    // The book is only as current as the export it came from.
    export_stale: exportAgeDays !== null && exportAgeDays > 120,
    airtable_configured: isConfigured(),
    is_owner: isOwner(req.user.id),
  });
});

// ── POST /api/network/import/linkedin ─────────────────────────────────────
// Upload a LinkedIn data export (.zip). Owner-only: it rewrites the shared book.
// multer rejects oversized uploads inside the middleware, where the handler's
// try/catch cannot see it — without this wrapper an over-limit zip returns a bare
// 500 and the user is told nothing useful.
function uploadZip(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooBig
        ? 'That export is larger than the 60 MB limit. LinkedIn splits very large archives — upload the part containing Connections.csv.'
        : `Upload failed: ${err.message}`,
    });
  });
}

router.post('/import/linkedin', uploadZip, async (req, res) => {
  if (!isOwner(req.user.id)) return res.status(403).json({ error: 'Owner only — the network book is shared.' });
  if (!req.file) return res.status(400).json({ error: 'No file. Upload the LinkedIn export .zip.' });
  try {
    const out = await importLinkedInExport({ userId: req.user.id, buffer: req.file.buffer });
    res.json(out);
  } catch (e) {
    console.error('[Network] LinkedIn import failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/network/import/airtable ─────────────────────────────────────
// Merge the hand-curated Advisor and Investor networks. Read-only on Airtable.
router.post('/import/airtable', async (req, res) => {
  if (!isOwner(req.user.id)) return res.status(403).json({ error: 'Owner only — the import uses the shared Airtable key.' });
  try {
    const out = await importAirtableNetwork({ userId: req.user.id });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) {
    console.error('[Network] Airtable merge failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/network/people ───────────────────────────────────────────────
// Browse and search the book. `q` matches name, title or company.
router.get('/people', (req, res) => {
  const { q, tier, persona, sector, limit = 50, offset = 0 } = req.query;
  const where = ['user_id = ?', 'is_deleted = 0'];
  const args = [req.user.id];

  if (q) {
    where.push('(name LIKE ? OR title LIKE ? OR company LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (tier) { where.push('warmth_tier = ?'); args.push(tier); }
  // personas/sectors are JSON arrays; a LIKE on the quoted token is exact enough
  // for a browse filter and avoids a join table for a read-mostly column.
  if (persona) { where.push('personas LIKE ?'); args.push(`%"${persona}"%`); }
  if (sector) { where.push('sectors LIKE ?'); args.push(`%"${sector}"%`); }

  // Clamped, never trusted. A negative LIMIT means "no limit" to SQLite, and a
  // negative OFFSET is accepted silently — either turns a paging bug into a
  // full-table dump.
  const lim = clampCount(limit, 50, 200);
  const offN = Math.floor(Number(offset));
  const off = Number.isFinite(offN) && offN > 0 ? offN : 0;

  const rows = db.prepare(`SELECT id, name, title, company, linkedin_url, email, warmth, warmth_tier,
                                  months_since, relationship_receipt, functions, personas, sectors,
                                  seniority, profile_signal, sources, expertise, notes
                           FROM network_people WHERE ${where.join(' AND ')}
                           ORDER BY warmth DESC, name ASC LIMIT ? OFFSET ?`)
    .all(...args, lim, off);
  const total = db.prepare(`SELECT COUNT(*) n FROM network_people WHERE ${where.join(' AND ')}`).get(...args).n;

  res.json({
    total,
    people: rows.map((r) => ({
      ...r,
      functions: parseJson(r.functions, []),
      personas: parseJson(r.personas, []),
      sectors: parseJson(r.sectors, []),
      sources: parseJson(r.sources, []),
      staleness: stalenessLabel(r.months_since),
    })),
  });
});

// ── GET /api/network/needs ────────────────────────────────────────────────
// The open Founder Asks, straight from Airtable, joined to their company. This
// is the demand side and it already exists — Danny's team types real asks into
// that table, typed by kind. Nothing here is invented.
router.get('/needs', async (req, res) => {
  if (!isConfigured()) return res.json({ needs: [], error: 'Airtable is not configured.' });
  try {
    const [asks, portfolio] = await Promise.all([
      fetchAirtable(TABLE.FOUNDER_ASKS),
      fetchAirtable(TABLE.PORTFOLIO),
    ]);
    const coByRec = new Map(portfolio.map((r) => [r.id, r.fields || {}]));

    const needs = asks.map((rec) => {
      const f = rec.fields || {};
      const link = (f['Company'] || [])[0];
      const co = link ? coByRec.get(link.id || link) : null;
      const companyName = (link && link.name) || (co && co['Company']) || null;
      return {
        airtable_ask_id: rec.id,
        ask: f['Ask'] || '',
        type: String(selName(f['Type']) || 'advice').toLowerCase(),
        status: selName(f['Status']) || null,
        owner: selName(f['Owner']) || null,
        company: companyName,
        // Free-text context from the portfolio row gives the matcher the
        // company's own sector without anyone typing it twice.
        company_context: co
          ? [co['Notes'], co['Company Updates']].filter(Boolean).join(' ').slice(0, 4000)
          : null,
        notes: f['Notes'] || null,
      };
    }).filter((n) => n.ask);

    res.json({ needs, open: needs.filter((n) => n.status === 'Open').length });
  } catch (e) {
    console.error('[Network] needs fetch failed:', e.message);
    res.status(502).json({ error: `Could not read Founder Asks: ${e.message}` });
  }
});

// ── GET /api/network/companies ────────────────────────────────────────────
// Everything matchable: the portfolio, plus any pipeline company on demand.
// The pipeline half is what lets Danny hand a live founder a shortlist during
// diligence rather than only after a cheque clears.
router.get('/companies', async (req, res) => {
  if (!isConfigured()) return res.json({ portfolio: [], pipeline: [] });
  try {
    const [portfolio, pipeline] = await Promise.all([
      fetchAirtable(TABLE.PORTFOLIO),
      fetchAirtable(TABLE.PIPELINE),
    ]);
    res.json({
      portfolio: portfolio.map((r) => {
        const f = r.fields || {};
        return {
          id: r.id, name: f['Company'], status: selName(f['Investment Status']),
          context: [f['Notes'], f['Company Updates']].filter(Boolean).join(' ').slice(0, 4000),
          asks_text: f['Founder Asks (text)'] || null,
        };
      }).filter((c) => c.name),
      pipeline: pipeline.map((r) => {
        const f = r.fields || {};
        return {
          id: r.id, name: f['Company / Founder'], founder: f['Founder'] || null,
          sector: f['Sector'] || null, stage: selName(f['Stage']),
          context: [f['One-liner'], f['Sector'], f['Commentary']].filter(Boolean).join(' . ').slice(0, 4000),
        };
      }).filter((c) => c.name),
    });
  } catch (e) {
    res.status(502).json({ error: `Could not read companies: ${e.message}` });
  }
});

// ── POST /api/network/match ───────────────────────────────────────────────
// The endpoint the whole module exists for. A need in, a ranked shortlist out,
// every row carrying why it is there and how Danny knows the person.
router.post('/match', (req, res) => {
  const { type = 'advice', text, company_name = null, company_context = null,
    airtable_ask_id = null, limit = 10, save = true } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Describe the ask — one line is enough.' });
  }

  const book = loadBook(req.user.id);
  if (!book.length) {
    return res.status(400).json({
      error: 'The network book is empty. Import a LinkedIn export first.',
      empty_book: true,
    });
  }

  const result = matchNeed(
    { type, text: String(text).trim(), company_context, company_sectors: [] },
    book,
    { limit }   // matchNeed clamps this; see its `limit` handling
  );

  let runId = null;
  if (save) {
    // Every match stores its full result JSON, so an unbounded table grows without
    // limit on a screen designed to be re-run. Keep a deep-but-finite history.
    try {
      db.prepare(`DELETE FROM network_match_runs WHERE user_id = ? AND id NOT IN (
        SELECT id FROM network_match_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
      )`).run(req.user.id, req.user.id);
    } catch { /* pruning must never fail a match */ }

    runId = db.prepare(`INSERT INTO network_match_runs
      (user_id, need_type, need_text, company_name, airtable_ask_id, considered, qualified, coverage, unmet, results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, result.need.type, result.need.text, company_name, airtable_ask_id,
        result.considered, result.qualified,
        JSON.stringify(result.coverage), JSON.stringify(result.unmet), JSON.stringify(result.results))
      .lastInsertRowid;
  }

  res.json({ ...result, run_id: runId, company_name });
});

// ── GET /api/network/runs ─────────────────────────────────────────────────
router.get('/runs', (req, res) => {
  const runs = db.prepare(`SELECT id, need_type, need_text, company_name, considered, qualified, unmet, created_at
                           FROM network_match_runs WHERE user_id = ?
                           ORDER BY created_at DESC LIMIT 40`).all(req.user.id);
  res.json(runs.map((r) => ({ ...r, unmet: parseJson(r.unmet, []) })));
});

router.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM network_match_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    ...run,
    coverage: parseJson(run.coverage, {}),
    unmet: parseJson(run.unmet, []),
    results: parseJson(run.results, []),
  });
});

module.exports = router;
module.exports.loadBook = loadBook;
