/**
 * founder-digest.js — the daily 8:00 AM CT "Breakout Radar" email.
 *
 * Every morning, email Danny the top UNDER-THE-RADAR founders to reach out to: IL-tied builders
 * with the highest breakout-pedigree score, led by the pre-program names (elite background, no
 * program tag yet) — the people to reach before YC/Speedrun does. Reuses the Daily Brief's Gmail
 * SMTP path (loadNewsletterConfig), so no new email config. Idempotent per CT day.
 *
 * The ranking window stays 7 days while the send cadence is daily: a single day of sourcing is
 * too thin to rank meaningfully, so each morning re-ranks a rolling week and surfaces the current
 * best. A founder Danny hasn't acted on can therefore recur across mornings — that is deliberate
 * (an unactioned high scorer is still today's best call), but per-recipient send suppression is
 * tracked separately in STU-18.
 */
const db = require('../db');
const { loadNewsletterConfig } = require('./newsletter');

const PROGRAM_LABEL = {
  pre_program: 'Breakout Radar', yc_directory: 'Y Combinator', a16z_speedrun: 'a16z Speedrun',
  il_school_discovery: 'IL school', z_fellows: 'Z Fellows', thiel_fellows: 'Thiel Fellows',
  neo_scholars: 'Neo', the_residency: 'The Residency', emergent_ventures: 'Emergent Ventures',
  uspto_trademark: 'Trademark', discovery: 'Web',
};
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function label(src) { return PROGRAM_LABEL[src] || src || 'Sourced'; }

// Gather the rolling 7-day window of breakout founders + a few counts.
function gather(userId, { days = 7, limit = 15, minScore = 25 } = {}) {
  const since = `datetime('now','-${days} days')`;
  const top = db.prepare(`
    SELECT name, company, source, breakout_score, breakout_signals, chicago_connection, linkedin_url, headline, company_one_liner
    FROM sourced_founders
    WHERE user_id = ? AND status IN ('pending','starred') AND list_scope = 'pipeline'
      AND created_at >= ${since} AND COALESCE(breakout_score,0) >= ?
    ORDER BY COALESCE(breakout_score,0) DESC, created_at DESC
    LIMIT ?`).all(userId, minScore, limit);
  const c = (sql, ...p) => db.prepare(sql).get(userId, ...p).c;
  const totalWeek = c(`SELECT COUNT(*) c FROM sourced_founders WHERE user_id=? AND created_at >= ${since}`);
  const preProgram = c(`SELECT COUNT(*) c FROM sourced_founders WHERE user_id=? AND source='pre_program' AND created_at >= ${since}`);
  const ilWeek = c(`SELECT COUNT(*) c FROM sourced_founders WHERE user_id=? AND list_scope='pipeline' AND created_at >= ${since}`);
  return {
    top: top.map(r => ({ ...r, signals: (() => { try { return JSON.parse(r.breakout_signals || '[]'); } catch { return []; } })() })),
    counts: { totalWeek, preProgram, ilWeek },
  };
}

function renderHtml({ top, counts }) {
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const card = (r) => {
    const signals = Array.isArray(r.signals) ? r.signals
      : (() => { try { return JSON.parse(r.breakout_signals || '[]'); } catch { return []; } })();
    return `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 12px;background:#fff;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div style="font-size:16px;font-weight:650;color:#111827;">${esc(r.name)}${r.company ? ` <span style="color:#9ca3af;font-weight:400;">· ${esc(r.company)}</span>` : ''}</div>
        <div style="font-size:13px;font-weight:700;color:#2563eb;white-space:nowrap;">${r.breakout_score ?? '—'}</div>
      </div>
      <div style="font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:#9ca3af;margin:3px 0 6px;">${esc(label(r.source))}${r.chicago_connection ? ` · ${esc(r.chicago_connection)}` : ''}</div>
      ${r.headline ? `<div style="color:#374151;font-size:13px;line-height:1.5;margin-bottom:6px;">${esc(String(r.headline).slice(0, 140))}</div>` : ''}
      ${signals.length ? `<div style="color:#6b7280;font-size:12px;margin-bottom:8px;">▸ ${signals.slice(0, 3).map(esc).join(' · ')}</div>` : ''}
      ${r.linkedin_url ? `<a href="${esc(r.linkedin_url)}" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:500;">Open LinkedIn →</a>` : ''}
    </div>`;
  };
  const list = top.length ? top.map(card).join('') : `<p style="color:#9ca3af;font-size:14px;">No breakout founders crossed the bar in the last 7 days.</p>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="font-size:22px;font-weight:700;color:#111827;">Breakout Radar — who to meet today</div>
    <div style="color:#9ca3af;font-size:14px;margin-bottom:14px;">${dateLabel}</div>
    <div style="background:#eef2ff;border-radius:8px;padding:10px 14px;font-size:13px;color:#4338ca;margin-bottom:20px;">
      ${counts.ilWeek} IL-tied founders sourced in the last 7 days · ${counts.preProgram} under-the-radar (pre-program) · ${counts.totalWeek} total across all sources.
    </div>
    <h2 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin:0 0 12px;">Top to reach out to — ranked by breakout pedigree</h2>
    ${list}
    <div style="margin-top:24px;color:#cbd5e1;font-size:12px;text-align:center;">Stu · Breakout Radar · stu.vc</div>
  </div></body></html>`;
}

// The CT calendar day, as YYYY-MM-DD. The digest is scheduled in America/Chicago, so its
// idempotency key has to be a Chicago day too — a UTC key rolls over at 6/7 PM CT and would
// let a single morning send twice, or block one, depending on the season.
function ctDayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// Send the daily digest. Reuses the Daily Brief Gmail config. Idempotent per CT day.
//
// Was idempotent per *week* (a 6-day cooldown), which paired with the old Friday-only cron.
// On a daily schedule that cooldown is the bug: the 8:00 AM job would send Monday, then
// silently return `skipped` for the next six mornings.
async function sendFounderDigest(userId = 1, { force = false, days = 7 } = {}) {
  const cfg = loadNewsletterConfig(userId);
  const recipient = db.prepare("SELECT setting_value FROM user_settings WHERE user_id=? AND setting_key='brief_recipient'").get(userId)?.setting_value || (cfg && cfg.address);
  if (!cfg || !cfg.address || !cfg.appPassword) return { ok: false, error: 'No Gmail app password configured (Settings).' };
  if (!recipient) return { ok: false, error: 'No recipient configured.' };

  const dayKey = ctDayKey();
  if (!force) {
    const last = db.prepare("SELECT setting_value FROM user_settings WHERE user_id=? AND setting_key='founder_digest_last_sent'").get(userId)?.setting_value;
    if (last === dayKey) return { ok: true, skipped: true, reason: 'already sent today' };
  }

  const data = gather(userId, { days });
  try {
    // Pinned to IPv4 — the `family: 4` that used to sit here never reached DNS. See
    // server/services/smtp.js for why Railway + nodemailer 8 needs a literal address.
    const { createTransport } = require('./smtp');
    const transport = await createTransport(cfg);
    await transport.sendMail({
      from: `"Stu · Breakout Radar" <${cfg.address}>`,
      to: recipient,
      subject: `Breakout Radar — ${data.top.length} founders to meet today`,
      html: renderHtml(data),
    });
    db.prepare(`INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at) VALUES (?, 'founder_digest_last_sent', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`).run(userId, dayKey);
    return { ok: true, recipient, count: data.top.length, preProgram: data.counts.preProgram };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { gather, renderHtml, sendFounderDigest };
