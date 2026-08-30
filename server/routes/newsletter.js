const express = require('express');
const router = express.Router();
const db = require('../db');
const { fetchAndProcess, fetchAllSources, discoverFeedUrl, loadNewsletterConfig } = require('../services/newsletter');

// In-memory per-user sync state (running flag + last result).
const syncState = new Map();

function parseItem(row) {
  let key_points = [], matched = [];
  try { key_points = JSON.parse(row.key_points || '[]'); } catch {}
  try { matched = JSON.parse(row.matched_entities || '[]'); } catch {}
  return { ...row, key_points, matched_entities: matched };
}

// GET /api/newsletter/brief?days=4 — rolling multi-day newsfeed
router.get('/brief', (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 4));
  const rows = db.prepare(`
    SELECT * FROM newsletter_items
    WHERE user_id = ? AND is_deleted = 0
      AND (brief_date >= date('now','localtime', ?) OR brief_date IS NULL)
    ORDER BY relevance_score DESC, received_at DESC
  `).all(req.user.id, `-${days} days`);

  const items = rows.map(parseItem);
  const groups = { book: [], thesis: [], general: [] };
  for (const it of items) (groups[it.category] || groups.general).push(it);

  res.json({ days, total: items.length, groups, date: db.prepare("SELECT date('now','localtime') AS d").get().d });
});

// GET /api/newsletter/status — configured? running? last sync result?
router.get('/status', (req, res) => {
  const cfg = loadNewsletterConfig(req.user.id);
  const sourceCount = db.prepare('SELECT COUNT(*) c FROM newsletter_sources WHERE user_id = ? AND enabled = 1 AND is_deleted = 0').get(req.user.id).c;
  res.json({
    configured: sourceCount > 0 || !!(cfg.address && cfg.appPassword),
    sourceCount,
    gmailConnected: !!(cfg.address && cfg.appPassword),
    label: cfg.label,
    address: cfg.address || null,
    ...(syncState.get(req.user.id) || { running: false, last: null }),
  });
});

// ── Sources management ──
router.get('/sources', (req, res) => {
  const rows = db.prepare('SELECT * FROM newsletter_sources WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC').all(req.user.id);
  res.json(rows);
});

// POST /api/newsletter/sources — add an RSS feed (by URL, auto-discovered) or email sender
router.post('/sources', async (req, res) => {
  const { name, type, url, sender } = req.body || {};
  const t = type === 'email' ? 'email' : 'rss';
  try {
    if (t === 'email') {
      if (!sender) return res.status(400).json({ error: 'Sender email required for an email source.' });
      // Single quotes, not double. SQL spells a string literal '...'; "..." is an
      // IDENTIFIER, and better-sqlite3 ships with the double-quoted-string-literal
      // fallback turned off, so this threw `no such column: "email"` on every call.
      // BOTH branches of this handler had it, which means adding a newsletter source
      // has never once succeeded — that, not disinterest, is why newsletter_sources
      // and newsletter_items are empty tables.
      const r = db.prepare("INSERT INTO newsletter_sources (user_id, name, type, sender_match, enabled) VALUES (?, ?, 'email', ?, 1)")
        .run(req.user.id, name || sender, sender.trim());
      return res.json(db.prepare('SELECT * FROM newsletter_sources WHERE id = ?').get(r.lastInsertRowid));
    }
    if (!url) return res.status(400).json({ error: 'A newsletter URL or RSS feed is required.' });
    const found = await discoverFeedUrl(url);
    if (!found) return res.status(422).json({ error: `Couldn't find an RSS feed at "${url}". Try the newsletter's Substack/site URL, or add it as an email source instead.` });
    const r = db.prepare("INSERT INTO newsletter_sources (user_id, name, type, feed_url, enabled) VALUES (?, ?, 'rss', ?, 1)")
      .run(req.user.id, name || found.title || url, found.feedUrl);
    res.json(db.prepare('SELECT * FROM newsletter_sources WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/newsletter/sources/:id — toggle enabled / rename
router.patch('/sources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM newsletter_sources WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updates = [], params = [];
  if ('enabled' in req.body) { updates.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }
  if ('name' in req.body) { updates.push('name = ?'); params.push(req.body.name); }
  if (!updates.length) return res.json(existing);
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE newsletter_sources SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM newsletter_sources WHERE id = ?').get(req.params.id));
});

router.delete('/sources/:id', (req, res) => {
  db.prepare('UPDATE newsletter_sources SET is_deleted = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// POST /api/newsletter/sync — pull the Gmail label, extract, rank (background)
router.post('/sync', (req, res) => {
  const userId = req.user.id;
  const state = syncState.get(userId);
  if (state && state.running) return res.json({ started: false, running: true });

  const cfg = loadNewsletterConfig(userId);
  const sourceCount = db.prepare('SELECT COUNT(*) c FROM newsletter_sources WHERE user_id = ? AND enabled = 1 AND is_deleted = 0').get(userId).c;
  if (sourceCount === 0 && (!cfg.address || !cfg.appPassword)) {
    return res.status(400).json({ error: 'Add a newsletter source (RSS feed) in Settings, or connect Gmail for email sources.' });
  }

  syncState.set(userId, { running: true, last: state?.last || null });
  res.json({ started: true });

  // Prefer the managed sources list (RSS + email senders). Fall back to the Gmail
  // label path only if no sources are configured yet (legacy setup).
  const runner = sourceCount > 0 ? fetchAllSources(userId) : fetchAndProcess(userId, { limit: 40 });

  // Fire-and-forget; record result in memory for /status.
  const { recordJobRun } = require('../services/health');
  runner
    .then(r => {
      syncState.set(userId, {
        running: false,
        last: { at: new Date().toISOString(), ...r },
      });
      const status = r.ok ? 'ok' : (r.added > 0 ? 'partial' : 'error');
      recordJobRun('newsletter_sync', status, r.ok ? `+${r.added} added` : (r.error || 'failed'), userId);
      console.log(`[Newsletter] sync user ${userId}:`, r.ok ? `${r.added} added` : r.error);
    })
    .catch(err => {
      syncState.set(userId, { running: false, last: { at: new Date().toISOString(), ok: false, error: err.message } });
      recordJobRun('newsletter_sync', 'error', err.message, userId);
      console.error(`[Newsletter] sync user ${userId} failed:`, err.message);
    });
});

// POST /api/newsletter/:id/read — mark read/unread
router.post('/:id/read', (req, res) => {
  const read = req.body?.read === false ? 0 : 1;
  db.prepare('UPDATE newsletter_items SET is_read = ? WHERE id = ? AND user_id = ?').run(read, req.params.id, req.user.id);
  res.json({ success: true });
});

// DELETE /api/newsletter/:id — dismiss from the brief
router.delete('/:id', (req, res) => {
  db.prepare('UPDATE newsletter_items SET is_deleted = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ── Daily Brief v2: archive blogs + email delivery ──

const DEFAULT_ARCHIVES = [
  { archive_key: 'pg', name: 'Paul Graham Essays' },
  { archive_key: 'gurley', name: 'Above the Crowd (Bill Gurley)' },
  { archive_key: 'chen', name: 'Andrew Chen Essays' },
  { archive_key: 'elad', name: 'High Growth Handbook (Elad Gil)' },
];
const DEFAULT_NEWSLETTERS = [
  { name: 'Upstarts (Alex Konrad)', url: 'https://www.upstartsmedia.com/' },
  { name: 'Prof G Media', url: 'https://www.profgmedia.com/' },
  { name: '1440', url: 'https://join1440.com/' },
  { name: 'MTS', url: 'https://mtslive.substack.com/' },
  { name: 'Risk Gaming (Lux Capital)', url: 'https://www.riskgaming.com/' },
  { name: 'The AI Report', url: 'https://www.theaireport.ai/' },
];

// POST /api/newsletter/seed-defaults — install Danny's curated archive + newsletter set,
// then backfill the archive catalogues. Idempotent (skips sources already present).
router.post('/seed-defaults', async (req, res) => {
  const userId = req.user.id;
  const { discoverFeedUrl } = require('../services/newsletter');
  const { backfillAll } = require('../services/brief-archive');
  const added = { archives: 0, newsletters: 0, skipped: 0 };

  for (const a of DEFAULT_ARCHIVES) {
    const exists = db.prepare("SELECT id FROM newsletter_sources WHERE user_id=? AND kind='archive' AND archive_key=? AND is_deleted=0").get(userId, a.archive_key);
    if (exists) { added.skipped++; continue; }
    db.prepare("INSERT INTO newsletter_sources (user_id, name, type, kind, archive_key, enabled) VALUES (?,?,'archive','archive',?,1)").run(userId, a.name, a.archive_key);
    added.archives++;
  }

  for (const n of DEFAULT_NEWSLETTERS) {
    const exists = db.prepare("SELECT id FROM newsletter_sources WHERE user_id=? AND name=? AND is_deleted=0").get(userId, n.name);
    if (exists) { added.skipped++; continue; }
    let feedUrl = null;
    try { const f = await discoverFeedUrl(n.url); feedUrl = f?.feedUrl || null; } catch {}
    if (feedUrl) {
      db.prepare("INSERT INTO newsletter_sources (user_id, name, type, kind, feed_url, enabled) VALUES (?,?,'rss','newsletter',?,1)").run(userId, n.name, feedUrl);
    } else {
      // No public RSS — store disabled with a note so Danny can attach an email sender.
      db.prepare("INSERT INTO newsletter_sources (user_id, name, type, kind, feed_url, enabled, last_status) VALUES (?,?,'rss','newsletter',?,0,?)").run(userId, n.name, n.url, 'no RSS found — add as email sender');
    }
    added.newsletters++;
  }

  let backfill = {};
  try { backfill = await backfillAll(userId); } catch (e) { backfill = { error: e.message }; }
  res.json({ ok: true, added, backfill });
});

// POST /api/newsletter/send-now — build + email today's digest immediately (force).
router.post('/send-now', async (req, res) => {
  try {
    const { sendDigest } = require('../services/email-digest');
    const r = await sendDigest(req.user.id, { force: true });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/newsletter/today — THE single digest the tab renders. Same object that gets
// emailed (frozen classics + live newsletters). Returns INSTANTLY: if today's classics
// aren't built yet, it kicks the build in the background and returns building:true so the
// page never hangs on the multi-second build (the client polls until it's ready).
router.get('/today', async (req, res) => {
  try {
    const userId = req.user.id;
    const { getOrBuildDigest, latestNewsletters } = require('../services/email-digest');
    const date = new Date().toISOString().slice(0, 10);
    const newsletters = latestNewsletters(userId);
    const emailed = db.prepare("SELECT sent_at, recipient FROM daily_brief_log WHERE user_id=? AND brief_date=? AND status='sent' ORDER BY sent_at DESC LIMIT 1").get(userId, date) || null;
    // Most recent send ATTEMPT (any status) so the page can persistently show a failure.
    const lastSend = db.prepare("SELECT status, error, recipient, sent_at FROM daily_brief_log WHERE user_id=? ORDER BY sent_at DESC LIMIT 1").get(userId) || null;

    const row = db.prepare('SELECT payload FROM daily_brief WHERE user_id=? AND brief_date=?').get(userId, date);
    if (row?.payload) {
      let classics = [];
      try { classics = JSON.parse(row.payload).classics || []; } catch {}
      return res.json({ date, classics, newsletters, emailed, lastSend, building: false });
    }
    // Not built yet — start it in the background (the in-build lock dedupes) and return now.
    getOrBuildDigest(userId).catch(e => console.error('[Brief] background build:', e.message));
    res.json({ date, classics: [], newsletters, emailed, lastSend, building: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/newsletter/rebuild — re-pick today's classics (e.g. after adding a source).
router.post('/rebuild', async (req, res) => {
  try {
    const { getOrBuildDigest } = require('../services/email-digest');
    const d = await getOrBuildDigest(req.user.id, { rebuild: true });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/newsletter/digest-preview — the rendered HTML of today's digest (for QA).
router.get('/digest-preview', async (req, res) => {
  try {
    const { getOrBuildDigest, renderHtml } = require('../services/email-digest');
    const d = await getOrBuildDigest(req.user.id);
    res.json({ ok: true, date: d.date, classics: d.classics, newsletters: d.newsletters, html: renderHtml(d) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/newsletter/archive — featured archive classics (the in-platform archive view).
router.get('/archive', (req, res) => {
  const rows = db.prepare(
    "SELECT archive_key, author, title, url, summary, shown_at FROM brief_archive_posts WHERE user_id=? AND shown_at IS NOT NULL ORDER BY shown_at DESC LIMIT 100"
  ).all(req.user.id);
  res.json(rows.map(r => ({ ...r, summary: (() => { try { return JSON.parse(r.summary || 'null'); } catch { return null; } })() })));
});

module.exports = router;
