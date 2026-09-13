'use strict';
// ══════════════════════════════════════════════════════════════════════════
// network-ingest.js — build the people graph from Danny's own exports.
//
// Two sources, deliberately different in kind:
//   · A LinkedIn data export (.zip) — Connections.csv, messages.csv,
//     Invitations.csv. This is the BOOK: who he knows and how well.
//   · Airtable's Advisor Network and Investor Network — READ-ONLY. Small, but
//     hand-curated, so an "Expertise" written by Danny outranks anything parsed
//     from a job title.
//
// ── WHY A FILE UPLOAD AND NOT AN API ──
// LinkedIn has no connections API, and scraping the connections page would be
// brittle, slow, and against their terms. The official data export is the
// supported path, it is richer than anything scraping could reach (message
// history with direction and timestamps), and it costs Danny one click. The
// tradeoff is that the book is a DATED SNAPSHOT, so every import records the
// export's own date and the UI shows it — a six-month-old export silently
// ranking people by jobs they have left is the live failure mode here.
//
// ── THE MESSAGE JOIN IS THE WHOLE POINT ──
// Connections.csv alone gives 2,691 names with no way to tell a co-founder from
// a conference badge scan. messages.csv resolves that, and it also carries 482
// people Danny has real correspondence with who were never connections at all.
// Those are included: a relationship is what the messages say, not what the
// connection list says.
// ══════════════════════════════════════════════════════════════════════════

const Papa = require('papaparse');
const JSZip = require('jszip');
const https = require('https');
const db = require('../db');
const np = require('../lib/networkProfile');
const rs = require('../lib/relationshipStrength');
const { TABLE, recordsUrl, authHeaders, isConfigured } = require('../lib/airtableBase');

// Danny's own profile slug — every message has him on one side, so he is the
// axis of the graph, never a node in it.
const SELF_SLUG_HINT = /danielericgoodman/i;

// ── Parsing helpers ───────────────────────────────────────────────────────

/**
 * LinkedIn prefixes several CSVs with a free-text "Notes:" preamble before the
 * real header row. Find the header by looking for a known column, then parse
 * from there. Papa's own header:true would otherwise adopt "Notes:" as a schema.
 */
function parseLinkedInCsv(text, headerCol) {
  if (!text) return [];
  const rows = Papa.parse(text, { skipEmptyLines: true }).data;
  const idx = rows.findIndex((r) => r[0] === headerCol);
  if (idx === -1) return [];
  const header = rows[idx];
  return rows.slice(idx + 1)
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** The stable identity in every LinkedIn URL: /in/<slug>. */
function slugOf(url) {
  const m = /\/in\/([^/?#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, '') : null;
}

/** LinkedIn writes dates as "15 Jul 2026". Normalize to ISO for sorting. */
function isoFromLinkedInDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The key a person merges on. A LinkedIn slug when we have one; otherwise a
 * normalized name+company, which is what lets an Airtable advisor with no
 * LinkedIn URL merge into an existing row rather than duplicate it.
 */
function dedupeKeyFor({ slug, name, company }) {
  if (slug) return `li:${slug}`;
  const n = np.normalize(name);
  const c = np.normalize(company || '');
  return `nc:${n}|${c}`;
}

// ── Reading the export ────────────────────────────────────────────────────

/**
 * Pull the three files we need out of a LinkedIn export zip.
 * Tolerant of the folder nesting LinkedIn sometimes adds.
 * @returns {{connections:string, messages:string, invitations:string, dated:string|null}}
 */
async function readExportZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const find = (needle) => {
    const hit = Object.keys(zip.files).find(
      (n) => !zip.files[n].dir && n.split('/').pop().toLowerCase() === needle
    );
    return hit ? zip.files[hit] : null;
  };
  const read = async (f) => (f ? f.async('string') : '');

  const connFile = find('connections.csv');
  if (!connFile) {
    throw new Error(
      'No Connections.csv in that zip. Use the FULL LinkedIn export ' +
      '(Settings → Data privacy → Get a copy of your data), not the profile-only download.'
    );
  }

  // The export's own cut date — read off the zip entry, not "today". An import
  // is only as current as the export, and the UI has to be able to say so.
  const dated = connFile.date ? new Date(connFile.date).toISOString().slice(0, 10) : null;

  return {
    connections: await read(connFile),
    messages: await read(find('messages.csv')),
    invitations: await read(find('invitations.csv')),
    dated,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// NOT EVERY EXPORT ARRIVES AS A ZIP.
//
// macOS unpacks a downloaded archive automatically, leaving a FOLDER named
// "Basic_LinkedInDataExport_09-13-2026.zip" next to the real archive — and a
// browser file picker cannot select a folder. On 2026-09-13 Danny could not
// import at all: the picker only accepted .zip, the thing that looked like the
// zip was a directory, and the Connections.csv he could see was greyed out. He
// ended up printing it to PDF.
//
// So an import is a set of FILES: a zip, or the CSVs from inside one. Each CSV is
// identified by its header row, not its filename, because a renamed or re-saved
// file keeps its columns. A PDF is refused with the file to use instead — its
// text layer mangles URLs (ligatures turn "jonnyfisher" into "jonny sher"), and a
// slug is the identity every relationship hangs on.
// ══════════════════════════════════════════════════════════════════════════
const CSV_KINDS = [
  ['connections', /(^|\n)\s*first name\s*,\s*last name\s*,\s*url/i],
  ['messages', /(^|\n)\s*"?conversation id"?\s*,/i],
  ['invitations', /(^|\n)\s*from\s*,\s*to\s*,\s*sent at/i],
];

function csvKind(text) {
  const head = String(text || '').slice(0, 3000);
  const hit = CSV_KINDS.find(([, re]) => re.test(head));
  return hit ? hit[0] : null;
}

/** An export's cut date when there is no zip entry date: its newest connection. */
function newestConnectionDate(csv) {
  let max = null;
  for (const r of parseLinkedInCsv(csv, 'First Name')) {
    const d = isoFromLinkedInDate(r['Connected On']);
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

/**
 * Read whatever the user uploaded into one export.
 * @param files [{ buffer, name }] — zips and/or CSVs, in any combination.
 */
async function readExportFiles(files) {
  const out = { connections: '', messages: '', invitations: '', dated: null };
  const unknown = [];
  for (const f of files || []) {
    const name = String(f.name || '');
    const buf = f.buffer;
    if (!buf || !buf.length) continue;
    const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;       // "PK"
    const isPdf = buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-';
    if (isPdf) {
      throw new Error(
        `${name || 'That file'} is a PDF. Stu needs LinkedIn's original export: upload the .zip, or ` +
        'Connections.csv (and messages.csv, for relationship strength) from inside the export folder.'
      );
    }
    if (isZip) {
      const z = await readExportZip(buf);
      for (const k of ['connections', 'messages', 'invitations']) if (z[k]) out[k] = z[k];
      if (z.dated) out.dated = z.dated;
      continue;
    }
    const text = buf.toString('utf8');
    const kind = csvKind(text);
    if (!kind) { unknown.push(name || 'a file'); continue; }
    out[kind] = text;
  }
  if (!out.connections) {
    throw new Error(
      (unknown.length ? `Not a LinkedIn connections file: ${unknown.join(', ')}. ` : '') +
      'Upload the LinkedIn export .zip, or Connections.csv from inside the export folder ' +
      '(add messages.csv too — it is what measures how well you know each person).'
    );
  }
  if (!out.dated) out.dated = newestConnectionDate(out.connections);
  out.has_messages = !!out.messages;
  return out;
}

/**
 * Fold messages.csv into per-person counts.
 *
 * Only 1:1 conversations count. A group thread's traffic says nothing about any
 * single participant, so a message with more than one non-Danny recipient is
 * skipped rather than credited to everyone in it — which would manufacture warm
 * relationships out of a mailing list.
 */
function aggregateMessages(csv, selfSlug) {
  const rows = parseLinkedInCsv(csv, 'CONVERSATION ID');
  const byPerson = new Map();

  for (const m of rows) {
    const from = slugOf(m['SENDER PROFILE URL']);
    const to = String(m['RECIPIENT PROFILE URLS'] || '').split(',').map(slugOf).filter(Boolean);

    let other = null;
    if (from && from !== selfSlug) {
      // Inbound: credited only when Danny is the sole recipient.
      const others = to.filter((s) => s !== selfSlug);
      if (others.length === 0) other = from;
    } else {
      const others = to.filter((s) => s !== selfSlug);
      if (others.length === 1) other = others[0];
    }
    if (!other) continue;

    let e = byPerson.get(other);
    if (!e) { e = { sent: 0, received: 0, threads: new Set(), first_at: null, last_at: null }; byPerson.set(other, e); }
    if (from === selfSlug) e.sent++; else e.received++;
    if (m['CONVERSATION ID']) e.threads.add(m['CONVERSATION ID']);

    const d = String(m['DATE'] || '').slice(0, 10);
    if (d) {
      if (!e.last_at || d > e.last_at) e.last_at = d;
      if (!e.first_at || d < e.first_at) e.first_at = d;
    }
  }
  return byPerson;
}

/** Outbound invitations carry Danny's own note on why the person mattered. */
function aggregateInvitations(csv, selfSlug) {
  const rows = parseLinkedInCsv(csv, 'From');
  const out = new Map();
  for (const r of rows) {
    if (String(r['Direction'] || '').toUpperCase() !== 'OUTGOING') continue;
    const slug = slugOf(r['inviteeProfileUrl']);
    if (!slug || slug === selfSlug) continue;
    out.set(slug, { danny_invited: 1, invite_note: (r['Message'] || '').trim() || null });
  }
  return out;
}

// ── Airtable (read-only) ──────────────────────────────────────────────────

function fetchAirtableTable(tableId) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const page = (offset) => {
      https.get(recordsUrl(tableId, { pageSize: 100, offset: offset || undefined }),
        { headers: authHeaders() }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`Airtable ${tableId} HTTP ${res.statusCode}: ${b.slice(0, 160)}`));
            let data; try { data = JSON.parse(b); } catch { return reject(new Error('Airtable returned non-JSON')); }
            rows.push(...(data.records || []));
            if (data.offset) page(data.offset); else resolve(rows);
          });
        }).on('error', reject);
    };
    page(null);
  });
}

// ── The row builder ───────────────────────────────────────────────────────

/**
 * Assemble one network_people row from whatever we know. Pure — takes facts,
 * returns a row — so the whole classification path is testable without a DB.
 */
function buildRow({ name, title, company, linkedin_url, email, expertise, extra,
  msg = {}, invite = {}, is_connection = false, connected_on = null,
  sources = [], airtable_record_id = null, airtable_table = null, notes = null,
  curated = false, curated_source = null, now }) {

  const slug = slugOf(linkedin_url);
  const profile = np.classify({ title, company, expertise, extra });

  const rel = rs.score({
    sent: msg.sent || 0,
    received: msg.received || 0,
    threads: msg.threads ? (msg.threads.size ?? msg.threads) : 0,
    first_at: msg.first_at || null,
    last_at: msg.last_at || null,
    is_connection,
    connected_on,
    danny_invited: !!invite.danny_invited,
    invite_note: invite.invite_note || null,
    curated, curated_source,
    now,
  });

  return {
    name: String(name || '').trim(),
    dedupe_key: dedupeKeyFor({ slug, name, company }),
    linkedin_slug: slug,
    linkedin_url: linkedin_url || (slug ? `https://www.linkedin.com/in/${slug}` : null),
    email: email || null,
    title: (title || '').trim() || null,
    company: profile.company,
    functions: JSON.stringify(profile.functions),
    personas: JSON.stringify(profile.personas),
    sectors: JSON.stringify(profile.sectors),
    seniority: profile.seniority,
    is_commercial: profile.is_commercial ? 1 : 0,
    profile_signal: profile.signal,
    profile_evidence: JSON.stringify(profile.evidence),
    msgs_sent: msg.sent || 0,
    msgs_received: msg.received || 0,
    msg_threads: msg.threads ? (msg.threads.size ?? msg.threads) : 0,
    first_contact_at: msg.first_at || null,
    last_contact_at: msg.last_at || null,
    is_connection: is_connection ? 1 : 0,
    connected_on,
    danny_invited: invite.danny_invited ? 1 : 0,
    invite_note: invite.invite_note || null,
    warmth: rel.warmth,
    warmth_tier: rel.tier,
    months_since: rel.months_since,
    relationship_receipt: rel.receipt,
    sources: JSON.stringify(sources),
    airtable_record_id,
    airtable_table,
    expertise: expertise || null,
    notes,
  };
}

const COLS = [
  'name', 'dedupe_key', 'linkedin_slug', 'linkedin_url', 'email', 'title', 'company',
  'functions', 'personas', 'sectors', 'seniority', 'is_commercial', 'profile_signal', 'profile_evidence',
  'msgs_sent', 'msgs_received', 'msg_threads', 'first_contact_at', 'last_contact_at',
  'is_connection', 'connected_on', 'danny_invited', 'invite_note',
  'warmth', 'warmth_tier', 'months_since', 'relationship_receipt',
  'sources', 'airtable_record_id', 'airtable_table', 'expertise', 'notes',
];

/**
 * Upsert on (user_id, dedupe_key).
 *
 * Merges rather than replaces: a person who arrives from Airtable AFTER the
 * LinkedIn import must not have their message history blanked by a row that
 * knows nothing about it. Only non-empty incoming values overwrite, `sources`
 * unions, and `is_deleted` is never touched — if Danny removed someone, a
 * re-import does not resurrect them.
 */
function upsert(userId, row) {
  const existing = db.prepare('SELECT * FROM network_people WHERE user_id = ? AND dedupe_key = ?')
    .get(userId, row.dedupe_key);

  if (!existing) {
    db.prepare(`INSERT INTO network_people (user_id, ${COLS.join(', ')})
                VALUES (?, ${COLS.map(() => '?').join(', ')})`)
      .run(userId, ...COLS.map((c) => row[c] ?? null));
    return 'inserted';
  }

  const merged = {};
  for (const c of COLS) {
    const incoming = row[c];
    const isEmpty = incoming === null || incoming === undefined || incoming === ''
      || incoming === '[]' || incoming === '{}';
    merged[c] = isEmpty ? existing[c] : incoming;
  }

  // ── The relationship block moves together, and only on real evidence. ──
  // A numeric 0 is not "empty", so the loop above happily overwrote nine sent
  // messages with the zero an Airtable row carries — silently demoting a strong
  // relationship to a thin one the moment the same person appeared in Airtable.
  // The counts, the warmth derived from them and the receipt that quotes them
  // are one fact, so they are kept or replaced as one.
  const incomingMsgs = (row.msgs_sent || 0) + (row.msgs_received || 0);
  const existingMsgs = (existing.msgs_sent || 0) + (existing.msgs_received || 0);
  if (incomingMsgs === 0 && existingMsgs > 0) {
    for (const c of ['msgs_sent', 'msgs_received', 'msg_threads', 'first_contact_at',
      'last_contact_at', 'warmth', 'warmth_tier', 'months_since', 'relationship_receipt']) {
      merged[c] = existing[c];
    }
  }

  // Being connected, and having been invited, are facts that only ever accrue.
  // A source that does not know about the connection must not deny it.
  merged.is_connection = (existing.is_connection || row.is_connection) ? 1 : 0;
  merged.connected_on = existing.connected_on || row.connected_on || null;
  merged.danny_invited = (existing.danny_invited || row.danny_invited) ? 1 : 0;
  merged.invite_note = existing.invite_note || row.invite_note || null;

  // Provenance accumulates; it never gets overwritten by the latest source.
  try {
    const prev = JSON.parse(existing.sources || '[]');
    const next = JSON.parse(row.sources || '[]');
    merged.sources = JSON.stringify([...new Set([...prev, ...next])]);
  } catch { /* a malformed blob must not fail an import */ }

  db.prepare(`UPDATE network_people SET ${COLS.map((c) => `${c} = ?`).join(', ')},
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...COLS.map((c) => merged[c] ?? null), existing.id);
  return 'updated';
}

// ── The two importers ─────────────────────────────────────────────────────

/**
 * Import a LinkedIn export zip.
 * @returns {{inserted, updated, skipped, export_dated, connections, messaged_only, tiers}}
 */
async function importLinkedInExport({ userId = 1, buffer, files, now = new Date() } = {}) {
  const input = files && files.length ? files : [{ buffer, name: 'export.zip' }];
  const { connections, messages, invitations, dated, has_messages: hasMessages } = await readExportFiles(input);

  const conns = parseLinkedInCsv(connections, 'First Name');
  if (!conns.length) throw new Error('Connections.csv had no rows — is this the right export?');

  // Identify Danny by whichever slug appears on both sides of the traffic,
  // rather than hard-coding it: this module should work for a second user.
  const selfSlug = detectSelfSlug(messages) || 'danielericgoodman';

  const msgs = aggregateMessages(messages, selfSlug);
  const invites = aggregateInvitations(invitations, selfSlug);

  const out = { inserted: 0, updated: 0, skipped: 0, connections: conns.length, messaged_only: 0, export_dated: dated, has_messages: hasMessages };
  const seen = new Set();

  const work = db.transaction(() => {
    for (const c of conns) {
      const name = `${(c['First Name'] || '').trim()} ${(c['Last Name'] || '').trim()}`.trim();
      if (!name) { out.skipped++; continue; }
      const slug = slugOf(c['URL']);
      if (slug) seen.add(slug);

      const row = buildRow({
        name,
        title: c['Position'],
        company: c['Company'],
        linkedin_url: c['URL'],
        email: (c['Email Address'] || '').trim() || null,
        msg: slug ? msgs.get(slug) : null,
        invite: slug ? invites.get(slug) : null,
        is_connection: true,
        connected_on: isoFromLinkedInDate(c['Connected On']),
        sources: ['linkedin_connections'],
        now,
      });
      out[upsert(userId, row)]++;
    }

    // People Danny corresponds with who never became connections. Dropping them
    // would lose real relationships — 482 of them in the 2026-07 export.
    for (const [slug, msg] of msgs) {
      if (seen.has(slug) || slug === selfSlug) continue;
      const row = buildRow({
        name: nameFromSlug(slug),
        title: '', company: '',
        linkedin_url: `https://www.linkedin.com/in/${slug}`,
        msg,
        invite: invites.get(slug),
        is_connection: false,
        sources: ['linkedin_messages'],
        notes: 'Correspondent, not a 1st-degree connection. Name inferred from the profile URL.',
        now,
      });
      out[upsert(userId, row)]++;
      out.messaged_only++;
    }
  });
  work();

  out.tiers = db.prepare(`SELECT warmth_tier t, COUNT(*) n FROM network_people
                          WHERE user_id = ? AND is_deleted = 0 GROUP BY warmth_tier`).all(userId)
    .reduce((a, r) => (a[r.t] = r.n, a), {});

  db.prepare(`INSERT INTO network_import_runs (user_id, source, export_dated, inserted, updated, skipped, summary)
              VALUES (?, 'linkedin_export', ?, ?, ?, ?, ?)`)
    .run(userId, dated, out.inserted, out.updated, out.skipped,
      `${out.inserted} new, ${out.updated} refreshed from a ${dated || 'undated'} export ` +
      `(${out.connections} connections, ${out.messaged_only} correspondents who were never connections)` +
      (hasMessages ? '' : ' — no messages.csv, so relationship strength was not updated'));

  return out;
}

/** The slug is all we have for a correspondent; render it as a readable name. */
function nameFromSlug(slug) {
  return String(slug)
    // The trailing LinkedIn disambiguator ("krish-khanna-46abb122a"). It always
    // contains a digit — requiring one is what stops the pattern from eating a
    // real surname of the same length ("haley-sonenthal" → "Haley").
    .replace(/-(?=[a-z0-9]*\d)[a-z0-9]{6,}$/i, '')
    .split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || slug;
}

/** The account owner is the slug that appears on the most messages, both ways. */
function detectSelfSlug(messagesCsv) {
  const rows = parseLinkedInCsv(messagesCsv, 'CONVERSATION ID');
  const tally = new Map();
  for (const m of rows.slice(0, 4000)) {
    for (const s of [slugOf(m['SENDER PROFILE URL']),
      ...String(m['RECIPIENT PROFILE URLS'] || '').split(',').map(slugOf)]) {
      if (s) tally.set(s, (tally.get(s) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [s, n] of tally) if (n > bestN) { best = s; bestN = n; }
  // Only trust it if it dominates; otherwise fall back to the known hint.
  return bestN > rows.length * 0.5 ? best : (SELF_SLUG_HINT.test(best || '') ? best : null);
}

/**
 * Merge Airtable's Advisor Network and Investor Network. Read-only, always —
 * Stu never writes to the base Danny's team maintains by hand.
 */
async function importAirtableNetwork({ userId = 1, now = new Date(), deps = {} } = {}) {
  if (!isConfigured()) return { error: 'No AIRTABLE_API_KEY configured.' };
  const fetch = deps.fetchAirtableTable || fetchAirtableTable;
  const out = { inserted: 0, updated: 0, skipped: 0, advisors: 0, investors: 0 };

  const advisors = await fetch(TABLE.ADVISOR_NETWORK);
  for (const rec of advisors) {
    const f = rec.fields || {};
    const name = String(f['Advisor Name'] || '').trim();
    if (!name) { out.skipped++; continue; }
    out[upsert(userId, buildRow({
      name,
      title: null,
      company: f['Company Affiliation'] || '',
      linkedin_url: f['LinkedIn'] || null,
      email: f['Email'] || null,
      expertise: f['Expertise'] || null,
      extra: f['Notes'] || '',
      sources: ['airtable_advisor_network'],
      curated: true, curated_source: 'Advisor Network',
      airtable_record_id: rec.id,
      airtable_table: 'advisor_network',
      notes: f['Notes'] || null,
      now,
    }))]++;
    out.advisors++;
  }

  const investors = await fetch(TABLE.INVESTOR_NETWORK);
  for (const rec of investors) {
    const f = rec.fields || {};
    const name = String(f['Name'] || '').trim();
    if (!name) { out.skipped++; continue; }
    const stage = [].concat(f['Stage Focus'] || []).map((s) => (s && s.name) || s).filter(Boolean).join(', ');
    out[upsert(userId, buildRow({
      name,
      // Airtable's Investor Network has no title column, but every row IS an
      // investor. Stating that explicitly is what lets the classifier read the
      // persona, rather than leaving the row with no signal at all.
      title: 'Investor',
      company: f['Firm'] || '',
      linkedin_url: f['LinkedIn'] || null,
      email: f['Email'] || null,
      expertise: [f['Industry Focus'], stage].filter(Boolean).join(' • ') || null,
      extra: f['Notes'] || '',
      sources: ['airtable_investor_network'],
      curated: true, curated_source: 'Investor Network',
      airtable_record_id: rec.id,
      airtable_table: 'investor_network',
      notes: [f['Strength of Relationship'] && `Relationship: ${(f['Strength of Relationship'].name || f['Strength of Relationship'])}`,
        f['Notes']].filter(Boolean).join(' — ') || null,
      now,
    }))]++;
    out.investors++;
  }

  db.prepare(`INSERT INTO network_import_runs (user_id, source, inserted, updated, skipped, summary)
              VALUES (?, 'airtable', ?, ?, ?, ?)`)
    .run(userId, out.inserted, out.updated, out.skipped,
      `${out.advisors} advisors, ${out.investors} investors merged read-only from Airtable`);

  return out;
}

module.exports = {
  importLinkedInExport, importAirtableNetwork,
  parseLinkedInCsv, aggregateMessages, aggregateInvitations, readExportZip, readExportFiles, csvKind,
  buildRow, upsert, slugOf, dedupeKeyFor, nameFromSlug, detectSelfSlug, isoFromLinkedInDate,
};
