/**
 * Daily Brief — assemble and EMAIL the digest.
 * ===========================================
 * Builds one morning email: a "learn from the greats" section (rotating archive classics
 * from PG/Gurley/Chen/Elad, with takeaways) + a breakdown of the latest issues from the
 * newsletters Danny subscribes to. Sends via his Gmail app password (SMTP). The in-platform
 * tab remains the searchable archive; this email is the primary daily surface.
 */
const db = require('../db');
const { loadNewsletterConfig } = require('./newsletter');
const { pickDailyClassic } = require('./brief-archive');

function getAnthropic(userId) {
  return require('../lib/providerKeys').anthropicFor(userId, 'email-digest');
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Gather the latest newsletter issues (one per source, most recent first) ──
function latestNewsletters(userId, days = 2) {
  const rows = db.prepare(`
    SELECT source_name, subject, summary, key_points, url, sender, relevance_score, received_at, brief_date
    FROM newsletter_items
    WHERE user_id = ? AND is_deleted = 0
      AND (brief_date >= date('now','localtime','-${days} days') OR brief_date IS NULL)
    ORDER BY relevance_score DESC, received_at DESC
  `).all(userId);
  // De-dupe to the best item per source so the email isn't 5 issues of one newsletter.
  const bySource = new Map();
  for (const r of rows) {
    const key = (r.source_name || r.sender || r.subject || '').toLowerCase();
    if (!bySource.has(key)) bySource.set(key, r);
  }
  return [...bySource.values()].map(r => ({
    source: r.source_name || r.sender || 'Newsletter',
    subject: r.subject || '',
    summary: r.summary || '',
    key_points: (() => { try { return JSON.parse(r.key_points || '[]'); } catch { return []; } })(),
    url: r.url || '',
  }));
}

// ── Build the full digest object (MUTATES: advances archive rotation) ──
async function buildDigest(userId) {
  const anthropic = getAnthropic(userId);
  const archiveSources = db.prepare(
    "SELECT archive_key FROM newsletter_sources WHERE user_id = ? AND kind = 'archive' AND enabled = 1 AND is_deleted = 0"
  ).all(userId);

  const classics = [];
  for (const s of archiveSources) {
    try {
      const c = await pickDailyClassic(userId, s.archive_key, anthropic);
      if (c) classics.push(c);
    } catch (e) { console.error(`[Digest] archive ${s.archive_key} failed:`, e.message); }
  }
  const newsletters = latestNewsletters(userId);
  return { date: todayStr(), classics, newsletters };
}

// ── The single source of truth ──
// The "classics" selection MUTATES (advances the archive rotation, marks posts shown), so
// it must be built exactly once per day and frozen — both the tab and the email read that
// same frozen set. The "newsletters" section is a pure read of today's ingested items, so
// it's assembled LIVE each time (always fresh, never drifts, no mutation). Result: the two
// surfaces show identical classics, and identical newsletters as of the moment viewed.
const _buildLocks = new Map();
async function getFrozenClassics(userId, { rebuild = false } = {}) {
  const date = todayStr();
  const readRow = () => db.prepare('SELECT payload FROM daily_brief WHERE user_id=? AND brief_date=?').get(userId, date);
  const parse = (row) => { try { return JSON.parse(row.payload).classics || []; } catch { return null; } };

  if (!rebuild) { const r = readRow(); if (r?.payload) { const c = parse(r); if (c) return c; } }

  const lockKey = `${userId}:${date}`;
  if (_buildLocks.has(lockKey)) return _buildLocks.get(lockKey);

  const promise = (async () => {
    if (!rebuild) { const again = readRow(); if (again?.payload) { const c = parse(again); if (c) return c; } }
    const anthropic = getAnthropic(userId);
    const sources = db.prepare(
      "SELECT archive_key FROM newsletter_sources WHERE user_id=? AND kind='archive' AND enabled=1 AND is_deleted=0"
    ).all(userId);
    const classics = [];
    for (const s of sources) {
      try { const c = await pickDailyClassic(userId, s.archive_key, anthropic); if (c) classics.push(c); }
      catch (e) { console.error(`[Digest] archive ${s.archive_key} failed:`, e.message); }
    }
    db.prepare('INSERT OR REPLACE INTO daily_brief (user_id, brief_date, payload, built_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
      .run(userId, date, JSON.stringify({ classics }));
    return classics;
  })();

  _buildLocks.set(lockKey, promise);
  try { return await promise; } finally { _buildLocks.delete(lockKey); }
}

// Assemble the digest both surfaces render: frozen classics + live newsletters.
async function getOrBuildDigest(userId, { rebuild = false } = {}) {
  const classics = await getFrozenClassics(userId, { rebuild });
  const newsletters = latestNewsletters(userId);
  return { date: todayStr(), classics, newsletters };
}

// ── Render to HTML ──
function renderHtml(digest) {
  const dateLabel = new Date(digest.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const card = (inner) => `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin:0 0 14px;background:#fff;">${inner}</div>`;
  const takeaway = (t) => `<li style="margin:0 0 6px;color:#374151;font-size:14px;line-height:1.5;">${esc(t)}</li>`;

  const classicsHtml = digest.classics.length ? digest.classics.map(c => card(`
    <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#9ca3af;margin-bottom:4px;">${esc(c.author)}</div>
    <a href="${esc(c.url)}" style="font-size:17px;font-weight:600;color:#111827;text-decoration:none;">${esc(c.title)}</a>
    ${c.one_liner ? `<div style="color:#6b7280;font-size:13px;margin:4px 0 10px;">${esc(c.one_liner)}</div>` : '<div style="height:8px"></div>'}
    <ul style="margin:0 0 10px;padding-left:18px;">${c.takeaways.map(takeaway).join('')}</ul>
    <a href="${esc(c.url)}" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:500;">Read the full piece →</a>
  `)).join('') : `<p style="color:#9ca3af;font-size:14px;">No archive piece today.</p>`;

  const newsHtml = digest.newsletters.length ? digest.newsletters.map(n => card(`
    <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#9ca3af;margin-bottom:4px;">${esc(n.source)}</div>
    ${n.url ? `<a href="${esc(n.url)}" style="font-size:16px;font-weight:600;color:#111827;text-decoration:none;">${esc(n.subject)}</a>` : `<div style="font-size:16px;font-weight:600;color:#111827;">${esc(n.subject)}</div>`}
    ${n.summary ? `<div style="color:#374151;font-size:14px;line-height:1.5;margin:6px 0 ${n.key_points.length ? '10px' : '0'};">${esc(n.summary)}</div>` : ''}
    ${n.key_points.length ? `<ul style="margin:0 0 10px;padding-left:18px;">${n.key_points.slice(0, 5).map(takeaway).join('')}</ul>` : ''}
    ${n.url ? `<a href="${esc(n.url)}" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:500;">Open →</a>` : ''}
  `)).join('') : `<p style="color:#9ca3af;font-size:14px;">No new newsletter issues in the last couple of days.</p>`;

  const section = (title, body) => `<h2 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin:24px 0 12px;">${title}</h2>${body}`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="margin-bottom:4px;font-size:22px;font-weight:700;color:#111827;">Your Daily Brief</div>
    <div style="color:#9ca3af;font-size:14px;margin-bottom:8px;">${dateLabel}</div>
    ${section('Learn from the greats', classicsHtml)}
    ${section('Newsletters', newsHtml)}
    <div style="margin-top:28px;color:#cbd5e1;font-size:12px;text-align:center;">Stu · stu.vc</div>
  </div></body></html>`;
}

// ── Send ──
async function sendDigest(userId, { force = false } = {}) {
  const cfg = loadNewsletterConfig(userId);
  const recipient = db.prepare("SELECT setting_value FROM user_settings WHERE user_id=? AND setting_key='brief_recipient'").get(userId)?.setting_value
    || cfg.address;
  const log = (status, error, d = {}) => db.prepare(
    'INSERT INTO daily_brief_log (user_id, brief_date, recipient, archive_count, newsletter_count, status, error) VALUES (?,?,?,?,?,?,?)'
  ).run(userId, todayStr(), recipient || null, d.archive || 0, d.news || 0, status, error || null);

  if (!cfg.address || !cfg.appPassword) {
    log('error', 'No Gmail address / app password configured');
    return { ok: false, error: 'Connect your Gmail (address + app password) in Settings first.' };
  }
  if (!recipient) { log('error', 'No recipient'); return { ok: false, error: 'No recipient configured.' }; }

  // Idempotency — one digest per day unless forced.
  if (!force) {
    const already = db.prepare("SELECT id FROM daily_brief_log WHERE user_id=? AND brief_date=? AND status='sent'").get(userId, todayStr());
    if (already) return { ok: true, skipped: true, reason: 'already sent today' };
  }

  // Read (or build) THE one digest for today — the same object the tab shows.
  const digest = await getOrBuildDigest(userId);
  if (!digest.classics.length && !digest.newsletters.length) {
    log('skipped', 'nothing to send');
    return { ok: true, skipped: true, reason: 'no content today' };
  }

  try {
    // Pinned to IPv4. Railway has no IPv6 route, and nodemailer's own resolver drops
    // the A records before it ever queries them — the `family: 4` that used to sit
    // here was a no-op. See server/services/smtp.js.
    const { createTransport } = require('./smtp');
    const transport = await createTransport(cfg);
    await transport.sendMail({
      from: `"Stu Daily Brief" <${cfg.address}>`,
      to: recipient,
      subject: `Your Daily Brief — ${new Date(digest.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      html: renderHtml(digest),
    });
    log('sent', null, { archive: digest.classics.length, news: digest.newsletters.length });
    return { ok: true, archive: digest.classics.length, newsletters: digest.newsletters.length, recipient };
  } catch (e) {
    log('error', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { buildDigest, getOrBuildDigest, renderHtml, sendDigest, latestNewsletters };
