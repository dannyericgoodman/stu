/**
 * routes/vaultSync.js — a narrow, single-purpose read channel for the local Obsidian
 * vault-sync automation. Deliberately NOT part of the shareable MCP token system: Stu's
 * MCP surface has an explicit design boundary ("no code path to founders / assessments /
 * notes / memos — those stay private to Stu's owner") because Stu is shared with portfolio
 * founders and VC friends who mint their own MCP tokens. This endpoint exists so Danny's
 * OWN local automation can read his OWN assessments to write them into his vault, without
 * ever touching that shared surface — gated by a single fixed secret only he holds
 * (VAULT_SYNC_SECRET), never exposed in any UI, never distributable via the token flow.
 *
 * Fails closed: if VAULT_SYNC_SECRET isn't set, every request 503s — no accidental exposure.
 * Owner-only (userId 1), matching the existing convention for other owner-only automation
 * (e.g. the weekly founder digest).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');

const OWNER_ID = 1;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireVaultSyncSecret(req, res, next) {
  const secret = process.env.VAULT_SYNC_SECRET;
  if (!secret) return res.status(503).json({ error: 'Vault sync is not configured (VAULT_SYNC_SECRET unset).' });
  const h = req.headers.authorization || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-vault-sync-secret'] || '');
  if (!provided || !timingSafeEqual(provided, secret)) {
    return res.status(401).json({ error: 'Invalid or missing vault-sync credential.' });
  }
  next();
}

router.use(requireVaultSyncSecret);

function safeParse(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

// Pure, unit-testable: the exact agent-output column mapping the app itself uses (see
// server/routes/assessments.js:957-961). Extracted here so the mapping is covered by a test
// that fails loudly if it ever drifts from the app's own read path — this is a real landmine
// (columns literally named after agents that no longer write to them).
function mapAgentOutputs(row) {
  return {
    team: safeParse(row.founder_agent_output),
    product: safeParse(row.market_agent_output),
    market: safeParse(row.economics_agent_output),
    bear: safeParse(row.bear_agent_output),
  };
}

// Real Founder Assessments only. Meeting Prep (assessment_type='meeting_prep') has a
// completely different data shape (founder_profile/company_snapshot/thesis_fit/... — see
// agents/prompts.js meetingPrep) and would crash or garble the vault template if this
// bridge tried to map it through mapAgentOutputs/synthesis like a real assessment. Meeting
// Prep gets its own vault-sync path later if/when Danny wants briefings synced too.
const ASSESSMENT_TYPE_FILTER = "(a.assessment_type IS NULL OR a.assessment_type = 'assessment')";

// GET /api/vault-sync/assessments — a light list for the local task to dedupe against.
router.get('/assessments', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.founder_id, a.group_id, a.version_number, a.status, a.overall_signal,
           a.conviction_score, a.conviction_band, a.evidence_rung, a.created_at,
           f.name as founder_name, f.company as founder_company
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.is_deleted = 0 AND a.created_by = ? AND ${ASSESSMENT_TYPE_FILTER}
    ORDER BY a.created_at DESC
    LIMIT 200
  `).all(OWNER_ID);
  res.json(rows);
});

// GET /api/vault-sync/assessments/:id — full detail: correctly-mapped agent outputs (the
// DB columns were repurposed from an earlier 6-agent schema and no longer match their own
// names — economics_agent_output actually holds Market, market_agent_output holds Product;
// this mirrors the exact mapping the app itself uses at server/routes/assessments.js:957-961)
// + synthesis + the latest rubric run + the raw inputs (for Call Notes).
router.get('/assessments/:id', (req, res) => {
  const a = db.prepare(`
    SELECT a.*, f.name as founder_name, f.company as founder_company
    FROM opportunity_assessments a
    LEFT JOIN founders f ON a.founder_id = f.id
    WHERE a.id = ? AND a.is_deleted = 0 AND a.created_by = ? AND ${ASSESSMENT_TYPE_FILTER}
  `).get(req.params.id, OWNER_ID);
  if (!a) return res.status(404).json({ error: 'Assessment not found (or is a Meeting Prep — not synced by this endpoint).' });

  const agents = mapAgentOutputs(a);
  const synthesis = safeParse(a.synthesis_output);
  // The Founder Rubric now runs inline on every assessment and IS the conviction score.
  // This used to read `steward_operator_evaluations` — the ARCHIVED 9-trait rubric,
  // retired 2026-06-25 — and export it to the vault under the key `rubric`. Anything
  // reading the vault was getting the retired framework labelled as the current one.
  const rubric = safeParse(a.rubric_output);
  const legacyStewardOperator = db.prepare(
    'SELECT output, overall_score, threshold, flagged, status FROM steward_operator_evaluations WHERE assessment_id = ? ORDER BY id DESC LIMIT 1'
  ).get(a.id);
  const inputs = db.prepare(
    'SELECT input_type, label, content, source_url, file_name, created_at FROM assessment_inputs WHERE assessment_id = ? ORDER BY input_type, created_at'
  ).all(a.id);

  res.json({
    id: a.id, founder_id: a.founder_id, founder_name: a.founder_name, founder_company: a.founder_company,
    status: a.status, overall_signal: a.overall_signal, created_at: a.created_at,
    group_id: a.group_id, version_number: a.version_number,
    // The verdict, and — just as important — how much it is worth trusting. Without the
    // rung and band, "Insufficient evidence" is just a string that reads like a rejection.
    conviction: safeParse(a.conviction_output),
    conviction_score: a.conviction_score,
    conviction_band: a.conviction_band,
    evidence_rung: a.evidence_rung,
    evidence: safeParse(a.evidence_output),
    context_notes: safeParse(a.context_notes),
    // The expert panel + its diligence agenda. This is the new depth surface — nine
    // named-lens cards and the deduped, owner-bucketed agenda synthesised across them.
    // `agents` below is the LEGACY depth (Team/Product/Market), kept so pre-panel
    // assessments still export; it is NULL on new runs, which is correct.
    panel: safeParse(a.panel_output),
    agenda: safeParse(a.agenda_output),
    agents, synthesis,
    rubric, // Founder Rubric — the four movements that decided the score
    legacy_steward_operator: legacyStewardOperator
      ? { ...legacyStewardOperator, output: safeParse(legacyStewardOperator.output), note: 'ARCHIVED 9-trait rubric, retired 2026-06-25. Historical rows only.' }
      : null,
    inputs,
  });
});

// ── POST /api/vault-sync/commitments — the Listener's write path ──
//
// This is the one place data flows INTO Stu from the outside, and it exists for a
// specific reason: the `founder-call-auto-workup` scheduled task already reads
// Granola every night and already writes a workup to the vault. It runs on Danny's
// machine, holds VAULT_SYNC_SECRET, and is the only thing in the stack that sees a
// transcript. Rather than build a second Granola integration inside Stu — which the
// engineering review priced at 4-6 days and which may not even be possible, since
// Granola has no webhook — the task that already works gets a way to push what it
// found.
//
// Scope is deliberately one table. Not a general write API. The vault-sync channel
// is owner-only and secret-gated precisely because Stu's shareable MCP surface has an
// explicit boundary against founders/assessments/notes; this must not become a hole
// in it. Commitments only, owner only, idempotent.
router.post('/commitments', (req, res) => {
  const rows = Array.isArray(req.body?.commitments) ? req.body.commitments : null;
  if (!rows) return res.status(400).json({ error: 'body must be { commitments: [...] }' });
  if (rows.length > 200) return res.status(400).json({ error: 'max 200 per call' });

  const { record } = require('../lib/commitments');
  const out = { created: 0, deduped: 0, skipped: [] };

  for (const r of rows) {
    // Resolve the founder by id, or by name — the task knows "Dan Preiss" from the
    // Granola title, not a database id.
    let founderId = r.founder_id || null;
    if (!founderId && r.founder_name) {
      const f = db.prepare(
        'SELECT id FROM founders WHERE created_by = ? AND is_deleted = 0 AND LOWER(name) = LOWER(?) LIMIT 1'
      ).get(OWNER_ID, String(r.founder_name).trim());
      founderId = f?.id || null;
    }
    if (!founderId) { out.skipped.push({ reason: 'no matching founder', name: r.founder_name }); continue; }

    try {
      const w = record({
        founderId,
        owedBy: r.owed_by,
        commitment: r.commitment,
        quote: r.quote, // required — a commitment without the verbatim line is a paraphrase
        statedAt: r.stated_at,
        dueAt: r.due_at,
        sourceRef: r.source_ref,
        createdBy: OWNER_ID,
      });
      if (w.created) out.created++; else out.deduped++;
    } catch (e) {
      out.skipped.push({ reason: e.message, commitment: String(r.commitment || '').slice(0, 60) });
    }
  }
  res.json(out);
});

// ── POST /api/vault-sync/call-notes — Granola notes onto the card ──
//
// Danny: "Granola notes (which I think also get automatically loaded?)"
// They didn't. Only commitments came down this road; the note itself — the thing
// he actually wants to re-read before a second call — never landed. founder_notes
// has 189 rows and every one is from the March Airtable import.
//
// Same channel, same secret, same reason as commitments above: the nightly
// `founder-call-auto-workup` is the ONLY thing in the stack that can see a Granola
// transcript, so it pushes rather than Stu pulling. Scope stays narrow — this adds
// exactly one more table to an owner-only, secret-gated endpoint.
//
// The note lands as a SOURCE, not a blob of prose. That means the honesty gate
// applies to it like anything else: signals extracted from a call are checked
// against the actual transcript text, and a quote the model invented about a
// conversation is dropped exactly as it would be from a deck.
//
// occurred_at is the CALL date, not tonight. A note pushed at 7pm about a call
// from March must not read as fresh contact — that distinction is precisely what
// lib/attention.js is currently blocked on, since every touch signal in the
// database is the Airtable import date.
// ══════════════════════════════════════════════════════════════════════════
// POST /api/vault-sync/notes — Danny's OWN words onto a card.
//
// Distinct from /call-notes, and the distinction is the point. A Granola note is a
// record of a CONVERSATION (kind='granola' → the OBSERVED evidence rung). This is
// Danny's read (kind='note') — it renders in his ink, not the machine's, and the
// honesty gate checks any claim drawn from it against his own line.
//
// Why this endpoint exists at all: his 35-company pipeline dump — by his own
// account the most valuable text in this database, "the only record of what he
// actually thinks about his own deals" — was written into a LOCAL dev database by a
// script that was never committed. The commit that claimed to put it on the cards
// changed one client file. It never reached production, and there was no path to
// send it there without a browser session. Now there is one, and it is the same
// secret-gated, owner-only channel the vault already uses.
//
// Matches by name/company because ids are per-database and this crosses databases.
// ══════════════════════════════════════════════════════════════════════════
router.post('/notes', (req, res) => {
  const rows = Array.isArray(req.body?.notes) ? req.body.notes : null;
  if (!rows) return res.status(400).json({ error: 'body must be { notes: [...] }' });
  if (rows.length > 100) return res.status(400).json({ error: 'max 100 per call' });

  const { ingestNote } = require('../lib/ingest');
  const out = { created: 0, deduped: 0, skipped: [] };
  const cards = allCards();

  for (const r of rows) {
    const founderId = resolveFounderId(r, cards);
    if (!founderId) { out.skipped.push({ reason: 'no matching card', name: r.founder_name || r.company }); continue; }
    try {
      const w = ingestNote({
        founderId,
        title: r.title || 'Note',
        text: r.text,
        occurredAt: r.occurred_at,
        userId: OWNER_ID,
      });
      if (w.error) out.skipped.push({ reason: w.error, name: r.founder_name });
      else if (w.created) out.created++;
      else out.deduped++; // recordSource is idempotent on content_hash — re-running is free
    } catch (e) {
      out.skipped.push({ reason: e.message, name: r.founder_name });
    }
  }
  res.json(out);
});

// ══════════════════════════════════════════════════════════════════════════
// Which card does this call belong to?
//
// Shared by /notes and /call-notes. IDs are meaningless across databases, so the
// name is the join key — which makes this function the entire safety boundary for
// Danny's most valuable data. Get it wrong and a real transcript lands on a
// stranger's card, then fathers signals, with verbatim quotes, that verify
// perfectly against the wrong company.
//
// ── WHY NORMALISED, AND WHY THAT ISN'T A LOOSENING ──
// Exact match was losing real calls to cosmetic drift, measured against the live
// board and 90 days of Granola titles:
//
//   Granola "Uptake AI"  vs card "Uptake AI"       -> fine
//   Granola "Onnyx"      vs card "ONNYX Systesm"   -> MISSED (typo in the card)
//   Granola "Kelvin"     vs card "Kelvon"          -> MISSED (typo somewhere)
//
// So we normalise. But normalising ALONE is how "Peak" starts matching "Peak Labs",
// which is the exact failure resolve-company-linkedin.js and lib/edgar.js are both
// built to refuse. The safety doesn't come from strictness — it comes from
// REFUSING AMBIGUITY. Every query below returns ALL matches, and more than one
// match is a refusal, not a coin flip.
//
// That's the bug this replaces: the old company fallback ended in `LIMIT 1`, so 18
// cards named "Stealth" resolved to whichever row SQLite happened to return first.
// The placeholder guard hid it for "Stealth" specifically and nothing else.
// ══════════════════════════════════════════════════════════════════════════

// Corporate/product filler that shouldn't decide identity. Same list as
// lib/edgar.js and lib/hiring.js — one company-name vocabulary across the codebase.
const NAME_NOISE = /\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs?|group|holdings|ai|io|hq|the|systems?)\b/g;

function normCompany(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// People are not companies: strip case and punctuation, never words. "Dan" must not
// become the same token as "Daniel", and no part of a person's name is filler.
function normPerson(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A name that identifies no one. "Stealth" is 18 cards; matching it files Danny's
// note about one company onto a stranger's.
const PLACEHOLDER_CO = /^(stealth|not yet|tbd|n\/a|na|unknown|none|new|company)$/i;

// Read once per request and passed down. A sync pushes up to 100 notes, and
// re-querying every card per note is how a 2s job becomes a 40s one. Never cached
// across requests: a card created a moment ago must be matchable now.
function allCards() {
  return db.prepare(
    'SELECT id, name, company FROM founders WHERE created_by = ? AND is_deleted = 0'
  ).all(OWNER_ID);
}

// ── Reading a Granola title ──
//
// Danny's meeting titles carry the join key, but in no fixed order. Measured over
// 90 days of real titles:
//
//   "Dan Preiss (Cadrian AI)"      Person (Company)
//   "Concorda (Sam and Ke)"        Company (People)     <- the reverse
//   "Hedge Insurance (Luke Button)"Company (Person)
//   "Alex Wilson"                  Person, bare
//   "Scaylor"                      Company, bare
//   "Concorda <> GLG Call"         Company + meeting noise
//
// There is no rule that separates these — "Scaylor" and "Alex Wilson" are the same
// shape. So we don't guess: we produce every reading and let resolveFounderId's
// refusal rule sort it out. A reading that matches nothing costs nothing, and a
// reading that matches something ambiguous is refused anyway.
//
// This lives on the SERVER rather than in the scheduled task on purpose. The
// caller used to be responsible for parsing, which meant the join rules lived in a
// prompt, were reimplemented per caller, and were untestable. Now the task can send
// the raw Granola title and this decides — one implementation, under test.
const MEETING_NOISE = /\s*<>.*$|\s+[—–-]\s+.*$|\s+pitch\b.*$|\s*\((?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\w+ \d{1,2},? \d{4})\)\s*$/gi;

function parseMeetingTitle(title) {
  const clean = String(title || '').replace(MEETING_NOISE, '').trim();
  if (!clean) return [];
  const m = /^\s*(.+?)\s*\((.+?)\)\s*$/.exec(clean);
  if (m) {
    const [, outer, inner] = m;
    // Both orders. Whichever is real will match; the other almost never will.
    return [
      { founder_name: outer, company: inner },
      { founder_name: inner, company: outer },
    ];
  }
  // Bare. Could be either — "Scaylor" is a company, "Alex Wilson" is a person, and
  // nothing in the string says which. Try both rather than assuming, which is the
  // bug that lost Alex Wilson and Roy Grossberg on the first pass.
  return [{ company: clean }, { founder_name: clean }];
}

/**
 * @returns {number|null} the card id, or null when nothing matches OR when more
 *   than one thing does. Ambiguity is a refusal — an unfiled note is a nuisance,
 *   a misfiled transcript is a lie with quotes attached.
 */
function resolveFounderId(r, cards) {
  if (r.founder_id) return r.founder_id;
  const rows = cards || allCards();

  // Nothing explicit to go on: read the meeting title instead. Each reading gets the
  // full matcher, including its refusals, and the FIRST unambiguous hit wins.
  if (!r.founder_name && !r.company && r.title) {
    for (const cand of parseMeetingTitle(r.title)) {
      const id = resolveFounderId({ ...cand }, rows);
      if (id) return id;
    }
    return null;
  }

  const wantPerson = normPerson(r.founder_name);
  const wantCo = normCompany(r.company);
  const coIsPlaceholder = !wantCo || PLACEHOLDER_CO.test(String(r.company || '').trim());

  const only = (list) => (list.length === 1 ? list[0].id : null);

  // 1. Both agree. The strongest evidence available, and the only one that can
  //    safely disambiguate a placeholder company: "Alex Wilson (Stealth)" is a real
  //    join when the NAME is what's carrying it.
  if (wantPerson && wantCo) {
    const both = rows.filter((c) => normPerson(c.name) === wantPerson && normCompany(c.company) === wantCo);
    if (both.length) return only(both);
  }

  // 2. The person. Distinctive enough to stand alone — and unlike the company,
  //    a founder's name is not shared by 18 cards.
  if (wantPerson) {
    const byPerson = rows.filter((c) => normPerson(c.name) === wantPerson);
    if (byPerson.length) return only(byPerson);
  }

  // 3. The company, last and never for a placeholder.
  if (!coIsPlaceholder) {
    const byCo = rows.filter((c) => normCompany(c.company) === wantCo);
    if (byCo.length) return only(byCo);
  }

  return null;
}

router.post('/call-notes', (req, res) => {
  const rows = Array.isArray(req.body?.notes) ? req.body.notes : null;
  if (!rows) return res.status(400).json({ error: 'body must be { notes: [...] }' });
  if (rows.length > 100) return res.status(400).json({ error: 'max 100 per call' });

  const { ingestGranolaNote } = require('../lib/ingest');
  const out = { created: 0, deduped: 0, skipped: [] };
  const cards = allCards();

  for (const r of rows) {
    // Shared with /notes. The old inline version here fell back to company name with
    // no placeholder guard: a Granola call titled "Michael Dunn (Stealth)" would
    // match whichever of the 18 founders whose company is literally "Stealth" came
    // back first, and file a real call transcript onto a stranger's card. The
    // transcript would then father signals, with quotes, that verify perfectly —
    // against the wrong company.
    const founderId = resolveFounderId(r, cards);
    if (!founderId) {
      // Name the thing that didn't match, and say which way it failed. "no matching
      // company" on 52 skipped rows is unactionable; this is a to-fix list.
      out.skipped.push({
        reason: 'no card matches, or more than one does',
        title: r.title || null,
        founder_name: r.founder_name || null,
        company: r.company || null,
      });
      continue;
    }

    try {
      const w = ingestGranolaNote({
        founderId,
        title: r.title,
        text: r.text,
        occurredAt: r.occurred_at,
        granolaId: r.granola_id,
        userId: OWNER_ID,
      });
      if (w.error) out.skipped.push({ reason: w.error, title: r.title });
      else if (w.created) {
        out.created++;
        // The transcript is the point of this whole endpoint — a call that lands and
        // says "not analysed" is the 28 conversations sitting outside the product all
        // over again, one layer in. `created` gates it, so the nightly re-push of the
        // same call costs nothing.
        require('../lib/extract-signals').extractSoon(founderId, w.id, OWNER_ID);
      } else out.deduped++; // the same call pushed by seven consecutive nightly runs
    } catch (e) {
      out.skipped.push({ reason: e.message, title: String(r.title || '').slice(0, 60) });
    }
  }
  res.json(out);
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/vault-sync/tasks — the agentic half of the daily list.
//
// Danny: "Agents should comb through my sourcing, pipeline, and the rest of the
// product and offer relevant priority tasks. And I need to be able to
// add/modify/delete them, including any that I create."
//
// The nightly workup is the only agent with real input — it reads every Granola
// call. So it writes tasks here, and Danny owns them the moment they land.
//
// ── THE THREE RULES THAT KEEP THIS FROM BECOMING NOISE ──
//
// 1. EVERY TASK CARRIES ITS QUOTE. `quote` is required. "Send the deck" is a nag
//    that costs nothing to ignore and reappears tomorrow looking identical.
//    "My next step, I guess, is I'll send you some slides" — Dan Preiss, July 14
//    — is a fact he can act on without re-deriving anything. The quote is the
//    difference between a task and a chore, and it's why the agent must have READ
//    something to be allowed to write here.
//
// 2. DEDUPE_KEY IS MANDATORY. The task re-reads the same week every night, so the
//    same suggestion arrives ~7 times. Without idempotency the list fills with
//    duplicates and he stops opening it by Thursday. Same reason the commitment
//    ledger has one.
//
// 3. A DISMISSED TASK STAYS DEAD. today_items.dismissed_at is a tombstone and
//    DELETE tombstones agent rows rather than removing them (routes/today.js:154).
//    So a re-run CANNOT resurrect something he threw away — the single most common
//    way this pattern dies. This endpoint checks the tombstone before inserting.
//
// What this endpoint deliberately does NOT do: send anything, write to Airtable,
// or email a founder. Danny's hard constraint — "Just nudge me to follow up."
// ══════════════════════════════════════════════════════════════════════════
router.post('/tasks', (req, res) => {
  const rows = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
  if (!rows) return res.status(400).json({ error: 'body must be { tasks: [...] }' });
  if (rows.length > 50) return res.status(400).json({ error: 'max 50 per call' });

  const out = { created: 0, deduped: 0, dismissed: 0, skipped: [] };

  const findByName = db.prepare(
    'SELECT id FROM founders WHERE created_by = ? AND is_deleted = 0 AND LOWER(name) = LOWER(?) LIMIT 1'
  );
  const findByCompany = db.prepare(
    'SELECT id FROM founders WHERE created_by = ? AND is_deleted = 0 AND LOWER(company) = LOWER(?) LIMIT 1'
  );
  const existing = db.prepare('SELECT id, dismissed_at FROM today_items WHERE dedupe_key = ?');
  const insert = db.prepare(`
    INSERT INTO today_items (origin, lane, title, detail, quote, founder_id, due_at, dedupe_key, created_by)
    VALUES ('agent', 'mine', ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of rows) {
    const title = String(t.title || '').trim();
    if (!title) { out.skipped.push({ reason: 'no title' }); continue; }

    // The quote is the price of admission. An agent that hasn't read anything
    // doesn't get to add to his day.
    const quote = String(t.quote || '').trim();
    if (!quote) { out.skipped.push({ reason: 'no quote — a task without its line is a nag', title }); continue; }

    let founderId = t.founder_id || null;
    if (!founderId && t.founder_name) founderId = findByName.get(OWNER_ID, String(t.founder_name).trim())?.id || null;
    if (!founderId && t.company) founderId = findByCompany.get(OWNER_ID, String(t.company).trim())?.id || null;

    // Stable across nightly runs: same founder + same task = same key.
    const key = t.dedupe_key || `agent:${founderId || 'none'}:${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;

    const hit = existing.get(key);
    if (hit) {
      // He threw it away. It does not come back.
      if (hit.dismissed_at) out.dismissed++;
      else out.deduped++;
      continue;
    }

    try {
      insert.run(title, t.detail || null, quote, founderId, t.due_at || null, key, OWNER_ID);
      out.created++;
    } catch (e) {
      out.skipped.push({ reason: e.message, title: title.slice(0, 60) });
    }
  }
  res.json(out);
});

module.exports = router;
module.exports.timingSafeEqual = timingSafeEqual;
module.exports.mapAgentOutputs = mapAgentOutputs;
// Exported for test: this function is the entire safety boundary between Danny's
// transcripts and the wrong company's card.
module.exports.resolveFounderId = resolveFounderId;
module.exports.normCompany = normCompany;
module.exports.normPerson = normPerson;
module.exports.parseMeetingTitle = parseMeetingTitle;
