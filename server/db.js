const Database = require('better-sqlite3');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════
// In production, DATABASE_PATH is MANDATORY. It used to silently fall back.
//
// This line was `process.env.DATABASE_PATH || path.join(__dirname, ...)` — a
// quiet fallback to a container-local file. On Railway that path is ephemeral, so
// if the variable were ever unset or renamed, every redeploy would start from an
// empty database.
//
// And the fallback is CAMOUFLAGED, which is what makes it the scariest thing in
// this repo rather than merely bad:
//
//   1. db.js falls back with no warning, no log line, no error
//   2. seedIfEmpty() (index.js:38) sees COUNT(*)=0 and restores 5,084 founders
//      from seed-data.json.gz
//   3. migration_flags is empty too, so every "one-time" migration re-runs and
//      reports success
//   4. You log in. The founder count looks HEALTHY. Nothing errors.
//   5. Every assessment, note, call log, signal and sourced founder is gone —
//      because assessments are never re-seeded. They're the canary.
//
// The one number you'd check is the one number that lies. You would keep
// deploying, and each deploy would look fine, and the product would be quietly
// zeroed each time.
//
// Verified 2026-07-16: prod's oldest assessment is 2026-04-05 and it survived
// dozens of deploys, so DATABASE_PATH IS currently set in Railway's dashboard.
// But that's dashboard state the repo can't see, can't test, and can't defend. A
// crash-loop is survivable and loud. Silent ephemeral storage is neither.
// ══════════════════════════════════════════════════════════════════════════
const envPath = process.env.DATABASE_PATH;
if (process.env.NODE_ENV === 'production' && !envPath) {
  console.error(
    'FATAL: DATABASE_PATH is not set in production.\n' +
    '  Refusing to start rather than write to ephemeral container disk.\n' +
    '  Set it to the mounted volume, e.g. DATABASE_PATH=/data/superior-os.db\n' +
    '  (If you see this after a deploy, DO NOT redeploy repeatedly — the data is\n' +
    '   likely intact on the volume; the variable is what is missing.)'
  );
  process.exit(1);
}
const dbPath = envPath || path.join(__dirname, 'superior-os.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Team members ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
`);

// ── Ensure the owner/admin (user_id=1) exists BEFORE any user_id=1 seed runs ──
// Several one-time seeds below insert user_settings/talent_criteria rows that FK to
// users(id)=1. auth.seedTeam() also creates this user, but it runs AFTER db.js is
// required — so on a brand-new database those seeds would FK-crash on first boot.
// Seeding the owner here (idempotent: only when the table is empty) makes a fresh DB
// boot cleanly in one pass. Default password is overridable via SEED_ADMIN_PASSWORD.
try {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    // The owner unlocks the platform provider keys, so never ship a known default
    // password in production — randomize when SEED_ADMIN_PASSWORD isn't set (reset via
    // password flow). Dev keeps the convenient default.
    const pw = process.env.SEED_ADMIN_PASSWORD
      || (process.env.NODE_ENV === 'production' ? require('crypto').randomBytes(18).toString('hex') : 'Murphy1!');
    db.prepare("INSERT INTO users (id, email, name, role, password_hash) VALUES (1, ?, ?, 'admin', ?)")
      .run('danny.eric.goodman@gmail.com', 'Danny Goodman', bcrypt.hashSync(pw, 10));
    console.log('[DB] Seeded owner/admin (user_id=1)');
  }
} catch (e) {
  console.error('[DB] owner seed skipped:', e.message);
}

// ── Founders (core pipeline) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS founders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    role TEXT,
    email TEXT,
    linkedin_url TEXT,
    twitter TEXT,
    github_url TEXT,
    website_url TEXT,
    location_city TEXT,
    location_state TEXT,
    stage TEXT DEFAULT 'Pre-seed',
    domain TEXT,
    tags TEXT,
    status TEXT DEFAULT 'Identified',
    source TEXT,
    fit_score INTEGER,
    fit_score_rationale TEXT,
    ai_summary TEXT,
    chicago_connection TEXT,
    bio TEXT,
    previous_companies TEXT,
    notable_background TEXT,
    is_deleted INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Founder notes ──
db.exec(`
  CREATE TABLE IF NOT EXISTS founder_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    content TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Auto-sourced founders queue ──
db.exec(`
  CREATE TABLE IF NOT EXISTS sourced_founders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    role TEXT,
    linkedin_url TEXT,
    email TEXT,
    source TEXT NOT NULL,
    confidence_score INTEGER,
    confidence_rationale TEXT,
    raw_data TEXT,
    status TEXT DEFAULT 'pending',
    promoted_to_founder_id INTEGER REFERENCES founders(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Opportunity assessments ──
db.exec(`
  CREATE TABLE IF NOT EXISTS opportunity_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER REFERENCES founders(id),
    inputs TEXT,
    founder_agent_output TEXT,
    market_agent_output TEXT,
    economics_agent_output TEXT,
    pattern_agent_output TEXT,
    bear_agent_output TEXT,
    synthesis_output TEXT,
    overall_signal TEXT,
    status TEXT DEFAULT 'pending',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Deal room ──
db.exec(`
  CREATE TABLE IF NOT EXISTS deal_room (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER REFERENCES founders(id),
    assessment_id INTEGER REFERENCES opportunity_assessments(id),
    ic_memo TEXT,
    round_terms TEXT,
    returns_model TEXT,
    decision TEXT DEFAULT 'pending',
    decision_rationale TEXT,
    decision_date DATETIME,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Danny AI conversations ──
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_type TEXT,
    context_id INTEGER,
    messages TEXT,
    pinned_insights TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Sourcing run log ──
db.exec(`
  CREATE TABLE IF NOT EXISTS sourcing_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sources_hit TEXT,
    founders_found INTEGER DEFAULT 0,
    founders_added INTEGER DEFAULT 0,
    founders_deduplicated INTEGER DEFAULT 0,
    errors TEXT
  );
`);

// ── Call logs (Granola transcripts) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER REFERENCES founders(id),
    raw_transcript TEXT,
    structured_summary TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Pipeline tracks & deal fields (added for unified pipeline model) ──
// ══════════════════════════════════════════════════════════════════════════
// 102 migrations, and a bare `catch {}` used to swallow every one of them.
//
// The catch could not tell these apart:
//   "duplicate column name"  — expected; the idempotent path, fires 102x per boot
//   "no such table"          — the schema is wrong and a column was just skipped
//   SQLITE_BUSY / disk I/O   — the migration FAILED and the app booted anyway
//   a typo in the type       — skipped silently, forever
//
// So the app boots green with a column missing, and you find out at runtime when
// a query returns undefined and writes null into a business field. It isn't a
// crash — it's silent data corruption, reported as success. That's the same
// disease as every other bug found today: a status decoupled from the thing it
// describes.
//
// Now: "duplicate column name" is the ONLY tolerated error. Everything else is
// re-thrown, which converts 102 silent failure modes into one loud one.
// ══════════════════════════════════════════════════════════════════════════
function addColumn(table, col, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (e) {
    // The expected, idempotent case: the column is already there.
    if (/duplicate column name/i.test(e.message)) return;
    // Anything else means the schema is not what this file thinks it is. Failing
    // to boot is recoverable; booting with a missing column is not.
    throw new Error(`Migration failed — ${table}.${col} (${type}): ${e.message}`);
  }
}

// Track flags
addColumn('founders', 'pipeline_tracks', "TEXT DEFAULT ''");

// Resident track (legacy)
addColumn('founders', 'resident_status', 'TEXT');
addColumn('founders', 'desks_needed', 'INTEGER');
addColumn('founders', 'admitted_at', 'DATETIME');

// Admissions pipeline (new unified track)
addColumn('founders', 'admissions_status', 'TEXT');

// Investment/deal track
addColumn('founders', 'deal_status', 'TEXT');
addColumn('founders', 'deal_lead', 'TEXT');
addColumn('founders', 'valuation', 'REAL');
addColumn('founders', 'round_size', 'REAL');
addColumn('founders', 'investment_amount', 'REAL');
addColumn('founders', 'arr', 'REAL');
addColumn('founders', 'monthly_burn', 'REAL');
addColumn('founders', 'runway_months', 'INTEGER');
addColumn('founders', 'security_type', 'TEXT');
addColumn('founders', 'memo_status', 'TEXT');
addColumn('founders', 'diligence_status', 'TEXT');
addColumn('founders', 'pass_reason', 'TEXT');
addColumn('founders', 'deal_entered_at', 'DATETIME');

// Extra useful fields
addColumn('founders', 'company_one_liner', 'TEXT');
addColumn('founders', 'next_action', 'TEXT');

// Sourced founders enhancements
addColumn('sourced_founders', 'headline', 'TEXT');
addColumn('sourced_founders', 'location_city', 'TEXT');
addColumn('sourced_founders', 'location_type', 'TEXT');
addColumn('sourced_founders', 'chicago_connection', 'TEXT');
addColumn('sourced_founders', 'tags', 'TEXT');
addColumn('sourced_founders', 'enriched_data', 'TEXT');
addColumn('sourced_founders', 'search_query', 'TEXT');
addColumn('sourced_founders', 'company_one_liner', 'TEXT');
addColumn('sourced_founders', 'pedigree_signals', 'TEXT');
addColumn('sourced_founders', 'builder_signals', 'TEXT');
addColumn('sourced_founders', 'github_url', 'TEXT');
addColumn('sourced_founders', 'website_url', 'TEXT');

// Caliber tier carried forward from sourcing into the pipeline
addColumn('founders', 'caliber_tier', 'TEXT');
// Full sourcing evidence carried on promotion — losing this on promote is unacceptable
// for a sourcing tool (you must be able to see WHY a founder was surfaced).
addColumn('founders', 'caliber_score', 'INTEGER');
addColumn('founders', 'caliber_signals', 'TEXT');     // JSON
addColumn('founders', 'evidence_map', 'TEXT');        // JSON — verbatim tie/caliber/stage evidence
addColumn('founders', 'red_flags', 'TEXT');           // JSON
addColumn('founders', 'sourced_from_id', 'INTEGER');  // back-ref to sourced_founders.id

// Airtable record IDs (for one-way Stu → Airtable sync)
addColumn('founders', 'airtable_founder_record_id', 'TEXT');
addColumn('founders', 'airtable_deal_record_id', 'TEXT');

// ── Airtable's TWO axes, stored verbatim ──
// Airtable tracks a founder on two orthogonal fields Danny maintains by hand:
//   "Admission Status"      — the SSFI funnel  (Stage 1: Identified … Stage 5: Not Admitted)
//   "Next Step Description" — the working state (Scheduling 1st Mtg, Active Evaluation, HOLD…)
// mapAdmissionStatus() mashes both into Stu's single `admissions_status`, which
// cannot represent them: "Stage 5: Not Admitted / 1st Mtg Scheduled" is a real and
// common combination (Danny declined them, the courtesy meeting is still booked)
// and it collapsed to the single word "Not Admitted" — or, before this sync
// updated existing rows at all, to "First Call Scheduled", which read as live.
//
// These two columns hold Airtable's strings UNTRANSLATED. Nothing derives from
// them yet; they exist so the mapping is auditable and so the board can render
// Danny's own vocabulary instead of a lossy translation of it.
addColumn('founders', 'airtable_admission_status', 'TEXT');
addColumn('founders', 'airtable_next_step', 'TEXT');
addColumn('founders', 'airtable_synced_at', 'DATETIME');

// ── THE MERGED BOARD'S ONE STAGE COLUMN ──
// Danny: "Let's merge Investment and Admissions pipelines, consolidating.
// Investment and/or Admissions Pipeline should be a badge I can edit on each
// card... Use Airtable right now as the source of truth for the correct stage."
//
// So the board has ONE stage axis, spelled in Airtable's words (lib/airtableVocab
// STAGES), and the Resident/Investment track becomes a badge — which is exactly
// how Airtable itself models it: one Admission Status, one Pipeline multi-select.
//
// Why this is not just `airtable_admission_status`: that column means "what
// Airtable literally says", and 26 cards have no Founder Ecosystem record at all
// (they came from Airtable's SEPARATE Investment Pipeline table). Writing a stage
// into the mirror column for a row Airtable has never heard of would be a lie in
// the one place built to be auditable. `stage_status` is the board's answer for
// EVERY card: mirrored from Airtable where a record exists, derived from the old
// deal_status where one doesn't.
addColumn('founders', 'stage_status', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_founders_stage_status ON founders(stage_status);`);

// ── ONCE DANNY TOUCHES A BADGE, STU OWNS IT ──
// Danny: "I'm comfortable with you publishing stage updates to Airtable. But
// that's it. I'm going to primarily work in Stu, and then choose to enter my own
// context to the team view in Airtable depending on what I want them to see."
//
// So the Resident/Investment badge never publishes. But the nightly sync UNIONS
// tracks from Airtable (it may add a track, never remove one — removing a company
// from a board is a decision, not a sync). Without this column those two rules
// collide: Danny switches Investment OFF in Stu, and at 5:45am an Airtable record
// that still says Investment switches it back ON. His edit, silently undone
// overnight — the same failure that let this board lie for four months.
//
// Set the moment he edits a badge. The sync reads it and leaves that founder's
// tracks alone from then on: his edit is the more recent decision.
addColumn('founders', 'tracks_set_by_user_at', 'DATETIME');

// ── ONE CARD PER COMPANY ──
// Danny: "There are a few companies where there are multiple entries, it tends to
// be for companies we've invested in (Eric Mills and Scott Nelson are both showing
// for Permute, and Kyle DeSana and Ehren are showing for Siftree, for example).
// Could we just have Scott and Kyle kept in?"
//
// These are not duplicate records — they're CO-FOUNDERS. Airtable's Founder
// Ecosystem table is one row per person (residency is per-person: people get
// desks), so two founders of one company are two legitimate rows up there. But this
// board is a board of COMPANIES, and two cards for Permute is one company printed
// twice.
//
// It was also quietly corrupting the money: investment_amount is stored on BOTH
// rows, so Permute's $50K and Siftree's $300K each counted twice in any total.
//
// So: nobody is deleted. The co-founder's row points at the card that represents
// their company. The board shows rows where this is NULL; the card lists the rest
// as co-founders. Reversible, and Danny can repoint it from the card — which is why
// this is a column and not a DELETE.
//
// DELIBERATELY NOT AUTOMATIC ACROSS THE BOARD: company names like "Stealth" and
// "Not Yet" are form placeholders, not companies. Three unrelated founders share
// "Not Yet". Grouping by name alone would merge strangers.
addColumn('founders', 'represented_by_founder_id', 'INTEGER REFERENCES founders(id)');
db.exec(`CREATE INDEX IF NOT EXISTS idx_founders_represented_by ON founders(represented_by_founder_id);`);

// ── "HAS THIS SOURCE BEEN READ?" IS NOT "DID IT PRODUCE SIGNALS?" ──
// The extraction queue is "sources nothing has read yet". Defining that as "sources
// with no rows in company_signals" is wrong in a way that costs money: a source that
// legitimately yields NOTHING — a thin landing page, a note with no claims in it —
// never gains a signal, so it never leaves the queue, so every run reads it again
// forever.
//
// This column is the answer to the question actually being asked. Set once the
// extractor has looked at a source, whatever came back. NULL means unread; a
// timestamp means read, including "read, and there was nothing in it". Clearing it
// is how a deliberate re-read is requested.
addColumn('company_sources', 'signals_extracted_at', 'DATETIME');
db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_extracted ON company_sources(signals_extracted_at);`);

// ── FOUNDER SLOPE — the pre-seed signal Danny cares most about ──
// GitHub trajectory (star velocity, inflection, commit acceleration) — the
// derivative, not the 30-day snapshot github_activity_score already stores. Kept
// separate because they answer different questions: activity is "are they working
// now", slope is "is their output/audience bending upward". See pipeline/github-activity.
addColumn('sourced_founders', 'github_slope_score', 'INTEGER');
addColumn('sourced_founders', 'github_slope_data', 'TEXT');
// When slope was last computed. Slope is a TIME-VARYING signal — a score from three
// weeks ago is stale — so the scorer re-does rows older than a week rather than
// scoring once and freezing. This is also what gives the movers view a real
// week-over-week delta, and how bug fixes (e.g. excluding content repos) reach
// already-scored founders. NULL → never scored → scored first.
addColumn('sourced_founders', 'github_slope_scored_at', 'DATETIME');
// How a resolved GitHub handle was matched (or 'none' if we searched and found no
// corroborated match). Makes every LinkedIn→GitHub resolution auditable and stops the
// resolver re-searching the same founder every run. See pipeline/github-resolve.
addColumn('sourced_founders', 'github_resolve_reason', 'TEXT');

// ── THE FALSIFIABLE LEARNING LOOP ──
// The quant red-teamer's core point: "will attract tier-1 tomorrow" is unfalsifiable
// with no deadline, so the engine can never be scored. This is the fix — when a
// founder is flagged Must-meet, pre-commit a DATED, BINARY prediction ("will raise a
// priced seed from a top-quartile lead by <18mo out>"). When the date passes, Danny
// (or a future check) marks it true/false. Over enough resolved predictions, the
// engine's precision becomes a real number instead of a flattering story. One row per
// founder-flag, so it's a ledger, not vault spam. resolve_by is stored as text
// (YYYY-MM-DD) because the codebase's cron-safe contexts can't call new Date().
db.exec(`
  CREATE TABLE IF NOT EXISTS founder_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourced_founder_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    predicted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolve_by TEXT,                 -- YYYY-MM-DD, ~18 months out
    tier_at_prediction TEXT,
    claim TEXT,                      -- the falsifiable statement
    outcome TEXT,                    -- NULL = open, 'raised' | 'not' | 'skip'
    resolved_at DATETIME,
    UNIQUE(sourced_founder_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_predictions_open ON founder_predictions(user_id, outcome, resolve_by);
`);

// ── SLOPE NEEDS MEMORY — the snapshot table ──
// Some signals carry their own history (GitHub commits are dated). Most don't: a
// follower count, a stealth bio, a stage — a single number with no past. Slope on
// THOSE only exists if Stu remembers last week's value. This table captures each
// pool founder's state on a cadence so deltas are computable run-over-run — and it's
// also the answer to "the engine can never learn": it accumulates its own time
// series. Clock is ticking; history not captured is unrecoverable.
db.exec(`
  CREATE TABLE IF NOT EXISTS founder_signal_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourced_founder_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    github_slope_score INTEGER,
    github_total_stars INTEGER,
    github_last30 INTEGER,
    caliber_tier TEXT,
    fit_tier TEXT,
    stage TEXT,
    marker_keys TEXT   -- JSON array, so we can see which signals appeared/vanished
  );
  CREATE INDEX IF NOT EXISTS idx_fss_founder ON founder_signal_snapshots(sourced_founder_id, captured_at DESC);
`);

// A source that already has signals was, self-evidently, read. Marking those closes
// the gap for the 60 sources extracted before this column existed — without it the
// first run after deploy would pay to read every one of them a second time.
// Sources with no signals stay NULL and get read once, properly.
db.exec(`
  UPDATE company_sources SET signals_extracted_at = CURRENT_TIMESTAMP
  WHERE signals_extracted_at IS NULL
    AND EXISTS (SELECT 1 FROM company_signals g WHERE g.source_id = company_sources.id);
`);

// ── The company card's automated half (pipeline/company-enrich.js) ──
// Danny: "company pages on LinkedIn show how many people work there and have been
// hired at these companies over time... I'll pay for enrichment."
// The whole EnrichLayer company blob lands here: profile, funding, and the
// headcount series. One JSON column rather than 15 scalars because the shape is
// the provider's, not ours — and a provider that adds a field shouldn't need a
// migration. Anything Danny EDITS gets a real column; anything a machine fetches
// lives in here, so his edits can never be clobbered by a re-fetch.
addColumn('founders', 'company_enrichment', 'TEXT');
addColumn('founders', 'company_enriched_at', 'DATETIME');
addColumn('founders', 'company_linkedin_url', 'TEXT');

// ══════════════════════════════════════════════════════════════════════════
// company_snapshots — the one asset that cannot be bought or backfilled.
//
// Danny, day one: "get a real sense for... how it's doing."
//
// "How it's doing" is a DERIVATIVE. It needs two readings. Until this table,
// there was exactly one: `company_enrichment` is a single blob and every refetch
// OVERWROTE it. 44 companies were enriched on 2026-07-16 — 276 people, headcounts,
// arrival curves — and the next run would have destroyed all of it. Not archived.
// Gone. Stu could never have answered "they were 6 people when you met them and
// they're 9 now", which is the question that was asked first.
//
// Three independent research lines landed on this the same day:
//   · Harmonic's `snapshots` is their one un-buyable asset — "you cannot backfill
//     this. If you start today you have zero history today and three years of
//     history in three years."
//   · The pre-seed coverage research: "instrument forward — you can manufacture a
//     time series you can't retrieve."
//   · The traffic research: "the delta signal is the alpha, not the snapshot.
//     Nobody has the eight-week diff showing a waitlist form become an auth flow,
//     because that lives beneath the floor of every commercial tool."
//
// It is also the insurance policy on EnrichLayer. That vendor performs the exact
// primitive LinkedIn sued Proxycurl out of existence for, and discloses no owner,
// no location, and no entity. If it vanishes mid-quarter, everything already
// captured survives — but only if we stopped overwriting it first.
//
// ── APPEND-ONLY, AND DEDUPED AGAINST THE PREVIOUS READING ONLY ──
// A new row only when the reading CHANGED. Deduping against the latest row rather
// than against all history is deliberate: headcount 6 -> 7 -> 6 is a real
// sequence, and a UNIQUE(content_hash) would silently reject that third reading
// and erase the fact that they shrank back.
db.exec(`
  CREATE TABLE IF NOT EXISTS company_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    taken_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 'enrichlayer' (LinkedIn team) | 'public_record' (Form D + open roles).
    -- Separate series per source: they fail independently and cost differently.
    source TEXT NOT NULL,
    -- Denormalised out of the blob so a time series is a cheap query, not a JSON
    -- parse across hundreds of rows. Null where the source doesn't carry it.
    headcount INTEGER,
    role_count INTEGER,
    amount_sold INTEGER,
    blob TEXT NOT NULL,
    content_hash TEXT NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_company_snapshots_founder
         ON company_snapshots (founder_id, source, taken_at DESC)`);

// ── The free half: what the public record says (lib/edgar.js, lib/hiring.js) ──
// Danny: "How many people/are they hiring and growing, what you could learn from
// the company site and crunchbase, etc..."
//
// Same one-blob-per-provider rule as company_enrichment above, and same reason:
// the shape belongs to the SEC and to three job boards, not to us.
//
// Split from company_enrichment rather than merged into it because they cost
// different things and fail independently. EnrichLayer costs real credits per
// employee and needs a resolved LinkedIn URL; this costs nothing and needs a
// website. Merging them would mean a card can't have the free half without paying
// for the expensive one — which is backwards, since the free half is the one that
// can run on all 188 rows on a schedule.
addColumn('founders', 'company_public', 'TEXT');
addColumn('founders', 'company_public_at', 'DATETIME');

// ── The card's manual half — the fields Danny fills in himself ──
// "These should all be fields I can enter and edit too."
addColumn('founders', 'deck_url', 'TEXT');
addColumn('founders', 'data_room_url', 'TEXT');

// Where a note came from: 'manual' (Danny typed it), 'granola' (a call), 'agent'.
// Granola's rule, applied to the card: HIS words render dark, the machine's grey.
// Without this column every note looks equally authored, which is precisely how a
// transcript summary ends up being read as his own judgment six months later.
addColumn('founder_notes', 'source', "TEXT DEFAULT 'manual'");

// Was Stu's score already on screen when Danny recorded his verdict?
// He explicitly rejected being FORCED to go first ("let's not make this so
// complicated") — so this is a fact we record, never a gate. "When Stu and I
// disagreed, who was right?" only means something across rows where his view was
// independent; without this column, anchored and unanchored decisions average
// together silently and the result gets called calibration.
// Both of the first two decisions were recorded AFTER the score existed — one of
// them two minutes after. That's knowable now instead of invisible.
addColumn('decisions', 'saw_score_first', 'INTEGER DEFAULT 0');

// ══════════════════════════════════════════════════════════════════════════
// THE SOURCE LOG + THE SIGNAL GATE
//
// Danny, 2026-07-16: "These cards should be a living, dynamic log of data I feed
// it from uploaded decks, URL links, LinkedIn links, notes, Granola notes. I want
// to get incredibly insightful, accurate signals about founder and company
// performance to the best of your ability, no hallucinations and 100% honest."
//
// "No hallucinations" is not a prompt instruction — you cannot ask a model to be
// honest and then trust it. It's a SCHEMA constraint. The design here makes a
// fabricated signal impossible to REPRESENT, let alone display:
//
//   · A signal has source_id NOT NULL. There is no such row as a claim from
//     nowhere.
//   · A signal has quote NOT NULL. The verbatim line that proves it is required,
//     exactly as commitments require the line that proves a promise — because a
//     paraphrase of a fact is precisely the thing that can be invented.
//   · Every quote is checked against its source's content_text by
//     agents/verify.js (deterministic, bigram-adjacency, no second LLM call).
//     `unverified` is DROPPED, not badged. verify.js annotates for assessments,
//     where a human reads the evidence; a card signal is glanced at, so the gate
//     has to be mechanical.
//
// This is the conviction engine's evidence rung, one layer out: below the rung
// there is no score, there is a question list.
// ══════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS company_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    -- deck | url | linkedin | granola | note | filing
    kind TEXT NOT NULL,
    title TEXT,
    uri TEXT,                      -- the URL, or the stored filename for a deck
    -- The extracted text. THIS is what every quote is checked against, so a
    -- source with no content_text can never father a signal.
    content_text TEXT,
    content_hash TEXT,             -- dedupe: the same deck uploaded twice is one source
    meta TEXT,                     -- JSON: page count, granola id, fetch status
    occurred_at TEXT,              -- when the CALL happened / the deck is dated —
                                   -- not when we ingested it. A six-month-old deck
                                   -- and today's call must not read as equally current.
    added_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sources_founder ON company_sources(founder_id, kind, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash ON company_sources(founder_id, content_hash);

  CREATE TABLE IF NOT EXISTS company_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    -- NOT NULL, and ON DELETE CASCADE below in code: delete the deck, the signals
    -- it produced die with it. A claim must never outlive its evidence.
    source_id INTEGER NOT NULL REFERENCES company_sources(id),
    -- traction | team | product | market | risk | raise | customer
    kind TEXT NOT NULL,
    claim TEXT NOT NULL,
    -- The line that proves it. Required. Verified. Not decorative.
    quote TEXT NOT NULL,
    -- verbatim | paraphrased. NEVER 'unverified' — those are dropped at write
    -- time and never reach this table. A CHECK enforces it at the storage layer
    -- so no future code path can quietly insert one.
    verification TEXT NOT NULL CHECK (verification IN ('verbatim','paraphrased')),
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    model TEXT,
    created_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_signals_founder ON company_signals(founder_id, kind);
  CREATE INDEX IF NOT EXISTS idx_signals_source ON company_signals(source_id);
`);

// Airtable sync audit log
db.exec(`
  CREATE TABLE IF NOT EXISTS airtable_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER,
    table_name TEXT,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT,
    airtable_record_id TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Assessment inputs (multi-file, multi-link, multi-transcript) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS assessment_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER NOT NULL REFERENCES opportunity_assessments(id),
    input_type TEXT NOT NULL,
    label TEXT,
    content TEXT,
    source_url TEXT,
    file_name TEXT,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Assessment version tracking ──
db.exec(`
  CREATE TABLE IF NOT EXISTS assessment_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    assessment_id INTEGER NOT NULL REFERENCES opportunity_assessments(id),
    version_number INTEGER NOT NULL,
    change_summary TEXT,
    previous_assessment_id INTEGER REFERENCES opportunity_assessments(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── IC Memos ──
db.exec(`
  CREATE TABLE IF NOT EXISTS founder_memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    memo_type TEXT DEFAULT 'ic_memo',
    content TEXT NOT NULL DEFAULT '',
    version INTEGER DEFAULT 1,
    data_snapshot TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Founder files/documents ──
db.exec(`
  CREATE TABLE IF NOT EXISTS founder_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL REFERENCES founders(id),
    file_name TEXT NOT NULL,
    file_type TEXT,
    content_text TEXT,
    url TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Assessment columns for versioning, cancellation, soft delete
addColumn('opportunity_assessments', 'group_id', 'TEXT');
addColumn('opportunity_assessments', 'version_number', 'INTEGER DEFAULT 1');
addColumn('opportunity_assessments', 'cancelled_at', 'DATETIME');
addColumn('opportunity_assessments', 'is_deleted', 'INTEGER DEFAULT 0');

// ── Steward-Operator rubric evaluations (post-synthesis diagnostic) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS steward_operator_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER NOT NULL REFERENCES opportunity_assessments(id),
    output TEXT,
    overall_score REAL,
    threshold TEXT,
    flagged INTEGER DEFAULT 0,
    status TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_steward_op_assessment ON steward_operator_evaluations(assessment_id);`);

// ── Migrate old "resident" track → "admissions" track ──
// Move resident_status → admissions_status where not already set
const residentMigration = db.prepare("SELECT COUNT(*) as c FROM founders WHERE pipeline_tracks LIKE '%resident%' AND (admissions_status IS NULL OR admissions_status = '')").get();
if (residentMigration.c > 0) {
  // Map resident_status values to admissions_status
  db.prepare("UPDATE founders SET admissions_status = 'Active Resident' WHERE pipeline_tracks LIKE '%resident%' AND resident_status = 'Active' AND (admissions_status IS NULL OR admissions_status = '')").run();
  db.prepare("UPDATE founders SET admissions_status = 'Admitted' WHERE pipeline_tracks LIKE '%resident%' AND resident_status = 'Admitted' AND (admissions_status IS NULL OR admissions_status = '')").run();
  db.prepare("UPDATE founders SET admissions_status = 'Alumni' WHERE pipeline_tracks LIKE '%resident%' AND resident_status = 'Alumni' AND (admissions_status IS NULL OR admissions_status = '')").run();
  db.prepare("UPDATE founders SET admissions_status = 'Sourced' WHERE pipeline_tracks LIKE '%resident%' AND resident_status = 'Prospect' AND (admissions_status IS NULL OR admissions_status = '')").run();
  db.prepare("UPDATE founders SET admissions_status = 'First Call Scheduled' WHERE pipeline_tracks LIKE '%resident%' AND resident_status = 'Tour Scheduled' AND (admissions_status IS NULL OR admissions_status = '')").run();
  // Update pipeline_tracks: resident → admissions
  db.prepare("UPDATE founders SET pipeline_tracks = REPLACE(pipeline_tracks, 'resident', 'admissions') WHERE pipeline_tracks LIKE '%resident%'").run();
  console.log(`[DB] Migrated ${residentMigration.c} founders from resident → admissions track`);
}

// ── Migrate old statuses into the new track model ──
const migrationNeeded = db.prepare("SELECT COUNT(*) as c FROM founders WHERE status IN ('Active Diligence', 'IC Ready', 'Invested') AND (deal_status IS NULL OR deal_status = '')").get();
if (migrationNeeded.c > 0) {
  db.prepare("UPDATE founders SET deal_status = 'Active Diligence', pipeline_tracks = 'investment', status = 'Met' WHERE status = 'Active Diligence' AND (deal_status IS NULL OR deal_status = '')").run();
  db.prepare("UPDATE founders SET deal_status = 'IC Review', pipeline_tracks = 'investment', status = 'Met' WHERE status = 'IC Ready' AND (deal_status IS NULL OR deal_status = '')").run();
  db.prepare("UPDATE founders SET deal_status = 'Committed', pipeline_tracks = 'investment', status = 'Met' WHERE status = 'Invested' AND (deal_status IS NULL OR deal_status = '')").run();
  console.log(`[DB] Migrated ${migrationNeeded.c} founders to new track model`);
}

// ── User settings (key-value per user) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, setting_key)
  );
`);

// ── Multi-tenancy: add user_id columns and backfill ──
addColumn('sourced_founders', 'user_id', 'INTEGER REFERENCES users(id)');
addColumn('sourcing_runs', 'user_id', 'INTEGER REFERENCES users(id)');

// ── Sourcing audit v2 (R3/R5/R7/R8/R10) ──
// R3: recency-of-departure signal extracted by Claude
addColumn('sourced_founders', 'departure_recency_months', 'INTEGER');  // e.g., 3 = left 3mo ago; null = N/A
addColumn('sourced_founders', 'signal_captured_at', 'DATETIME');        // when we first picked up the signal
// R7: permanent do-not-resurface flag (separate from per-run dismissal)
addColumn('sourced_founders', 'do_not_resurface', 'INTEGER DEFAULT 0');
// R10: tiered school pedigree (JSON arrays)
addColumn('sourced_founders', 'anchor_schools_il', 'TEXT');             // JSON
addColumn('sourced_founders', 'elite_schools_national', 'TEXT');        // JSON
// R5: co-founder pair detection
addColumn('sourced_founders', 'previous_company_norm', 'TEXT');         // normalized prev-co for pairing
addColumn('sourced_founders', 'pair_candidate_ids', 'TEXT');            // JSON — ids of suspected co-founder peers
// R8: GitHub activity depth
addColumn('sourced_founders', 'github_activity_score', 'INTEGER');      // 0-10
addColumn('sourced_founders', 'github_activity_data', 'TEXT');          // JSON — commit/org/repo details
// R4: extract-then-score evidence map
addColumn('sourced_founders', 'evidence_map', 'TEXT');                  // JSON from new Claude extraction prompt
addColumn('sourced_founders', 'red_flags', 'TEXT');                     // JSON

// CALIBER v1: the unicorn-grade axis, scored SEPARATELY from confidence/relevance.
//   confidence_score answers "is this a real, fresh, Chicago-tied founder?"
//   caliber_* answers "is this a best-of-best, fund-returning builder?"
// A founder can be highly relevant (9 confidence) but B-caliber, or A-caliber but
// stale (low confidence). Keeping them separate stops the two questions from
// canceling each other out in a single muddy number.
addColumn('sourced_founders', 'caliber_tier', 'TEXT');                  // 'S' | 'A' | 'B' | 'C'
addColumn('sourced_founders', 'caliber_score', 'INTEGER');             // 1-10, deterministic after reconciliation
addColumn('sourced_founders', 'caliber_rationale', 'TEXT');            // why this tier
addColumn('sourced_founders', 'caliber_signals', 'TEXT');             // JSON — hard caliber signals detected

// LEARNING LOOP: affinity to Danny's revealed taste (from approve/star/dismiss history).
// A re-ranking nudge, never an override of caliber/tie/red-flag rules.
addColumn('sourced_founders', 'affinity_score', 'INTEGER DEFAULT 0'); // -5..+5
addColumn('sourced_founders', 'affinity_reason', 'TEXT');

// Deck-integrity flag: marks assessments whose deck input was corrupted (PDF read as
// text by the old client bug) or was an un-ingested link — so suspect scores are visible.
addColumn('opportunity_assessments', 'deck_status', 'TEXT');        // 'ok' | 'suspect'
addColumn('opportunity_assessments', 'deck_status_reason', 'TEXT');

// ── Conviction engine (see server/lib/conviction.js) ──
// Assess used to emit a 0-10 score and one of three words (Invest/Monitor/Pass) at
// identical confidence whether it had read a marketing page or a deck plus two
// transcripts. These columns make evidence strength a first-class, queryable fact
// rather than something the reader has to infer.
addColumn('opportunity_assessments', 'conviction_score', 'REAL');       // 1-10, NULL when indeterminate
addColumn('opportunity_assessments', 'conviction_band', 'TEXT');        // anchor | memo | monitor | pass | indeterminate
addColumn('opportunity_assessments', 'conviction_output', 'TEXT');      // full JSON from computeConviction
addColumn('opportunity_assessments', 'evidence_rung', 'INTEGER');       // 0-4, computed from inputs, never from the LLM
addColumn('opportunity_assessments', 'evidence_output', 'TEXT');        // full JSON from computeEvidenceRung (incl. dropped inputs)
addColumn('opportunity_assessments', 'rubric_output', 'TEXT');          // Founder Rubric agent: the 4 movements
// What the context assembler truncated or dropped. Was console.warn-only, so Danny
// never learned his transcript had been cut. This is the "what we didn't look at" source.
addColumn('opportunity_assessments', 'context_notes', 'TEXT');

// ── Commitments (see server/lib/commitments.js) ──
// "The delta between what they said and what they did is my single best signal —
//  it's the one thing they can't perform." — Danny's first-call script, Q10.
//
// It has never been recorded once. This table is why Stu is a surface and not just
// a viewer over the vault: the nightly workup task writes an excellent DOCUMENT, but
// a commitment is STATE. It has a clock. It comes due. A markdown file can say a
// promise was made; only this can tell you it's three days late.
db.exec(`
  CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER REFERENCES founders(id),
    assessment_id INTEGER REFERENCES opportunity_assessments(id),
    owed_by TEXT NOT NULL,              -- 'them' | 'me'
    commitment TEXT NOT NULL,           -- the promise, in one line
    quote TEXT NOT NULL,                -- the VERBATIM line that proves it. required.
    stated_at TEXT NOT NULL,            -- the date they said it (not the date logged)
    due_at TEXT,                        -- when it comes due, if they named a window
    closed_at TEXT,                     -- when it actually happened
    status TEXT NOT NULL DEFAULT 'open',-- open | kept | broken | released
    source_ref TEXT,                    -- granola meeting id / transcript pointer
    dedupe_key TEXT UNIQUE,             -- the nightly task re-reads the week; this stops 7x dupes
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_commitments_founder ON commitments(founder_id);
  CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(status, due_at);
`);

// ── Today (see server/routes/today.js) ──
// Danny's own to-do list, which agents may contribute to but never own.
//
// The classic bug in this pattern: an agent re-run resurrects the row you deleted.
// So agent rows are NEVER deleted — they tombstone. `dedupe_key` makes the upsert
// idempotent, and a row with `dismissed_at` set must never come back. Danny's own
// rows are his: he can delete those outright.
db.exec(`
  CREATE TABLE IF NOT EXISTS today_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'agent'
    lane TEXT NOT NULL,                   -- undecided | i_owe | they_owe | mine
    title TEXT NOT NULL,
    detail TEXT,
    quote TEXT,                           -- the line that produced it, when an agent made it
    founder_id INTEGER REFERENCES founders(id),
    commitment_id INTEGER REFERENCES commitments(id),
    due_at TEXT,
    dedupe_key TEXT UNIQUE,               -- agent rows only; NULL for user rows
    completed_at DATETIME,
    dismissed_at DATETIME,                -- tombstone. an agent must not resurrect this.
    snoozed_until TEXT,
    sort_order REAL,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_today_open ON today_items(created_by, completed_at, dismissed_at);
`);

// ── Decisions (see server/routes/today.js) ──
// The headline number is DECIDED, never pipeline count — Danny: "I want to inflate my
// pipeline numbers." A metric he's told me he games is a metric I won't build.
//
// And the increment is not the decision. It's the decision PLUS a dated falsifiable
// prediction. His most common kill is "cool but indefensible" — a ten-second reflex —
// so a bare pass=+1 would pay him to fire it faster, and Portfolio Pattern Analysis
// says his undocumented passes on STRONG founders are his most fixable blind spot.
// A pass without a prediction is not a decision; it stays undecided and visible.
db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER REFERENCES founders(id),
    assessment_id INTEGER REFERENCES opportunity_assessments(id),
    band TEXT NOT NULL,                   -- anchor | memo | monitor | pass  (Danny's call, not Stu's)
    rationale TEXT,                       -- one line. why.
    prediction TEXT NOT NULL,             -- dated, checkable, falsifiable. required.
    resolve_by TEXT NOT NULL,             -- when we find out
    resolved_at TEXT,
    outcome TEXT,                         -- right | wrong | unresolved
    stu_band TEXT,                        -- what the engine said, for the calibration set
    stu_score REAL,
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_resolve ON decisions(resolved_at, resolve_by);
`);

// Job run log — every scheduled/triggered job records its outcome here so failures are
// durable and surfaced (not swallowed in console). Powers the healthcheck board.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    job TEXT NOT NULL,
    status TEXT NOT NULL,   -- 'ok' | 'partial' | 'error'
    detail TEXT,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs ON job_runs(job, ran_at DESC);`);

// R2: entity filings source (new)
db.exec(`
  CREATE TABLE IF NOT EXISTS entity_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- 'sec_form_d' | 'il_sos'
    filing_type TEXT,                   -- 'Form D' | 'LLC' | 'C-Corp'
    filing_id TEXT,                     -- SEC CIK / accession or IL file number
    entity_name TEXT,
    officer_names TEXT,                 -- JSON array
    state TEXT,
    city TEXT,
    filed_at DATETIME,
    raw_data TEXT,                      -- JSON blob
    matched_to_candidate_id INTEGER,    -- sourced_founders.id if matched
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, filing_id)
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_filings_filed_at ON entity_filings(filed_at DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_filings_state ON entity_filings(state);`);
addColumn('users', 'onboarding_complete', 'INTEGER DEFAULT 0');
addColumn('users', 'has_paid', 'INTEGER DEFAULT 0');
addColumn('users', 'stripe_customer_id', 'TEXT');
addColumn('users', 'payment_date', 'DATETIME');

// Migration ledger — must exist before any migration flag is read (fresh DBs would
// otherwise crash on the first SELECT below).
db.exec("CREATE TABLE IF NOT EXISTS migration_flags (key TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

// User 1 (Danny) is created by auth.seedTeam() AFTER this module loads, so on a brand-new
// DB it does not exist while these seeds run. The Danny-specific seeds below INSERT rows
// that FK-reference users(id)=1 — with foreign_keys ON, running them before user 1 exists
// crashes a fresh boot. Guard each on this check: when user 1 is absent the seed no-ops
// WITHOUT recording its flag, so it runs cleanly on a later boot once seedTeam has run.
const user1Exists = () => !!db.prepare('SELECT 1 FROM users WHERE id = 1').get();

// One-time migration: assign all existing data to user_id=1 (Danny)
const mtFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'multi_tenant_v1'").get();
if (!mtFlag) {
  db.prepare("UPDATE founders SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE sourced_founders SET user_id = 1 WHERE user_id IS NULL").run();
  db.prepare("UPDATE sourcing_runs SET user_id = 1 WHERE user_id IS NULL").run();
  db.prepare("UPDATE founder_notes SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE call_logs SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE opportunity_assessments SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE deal_room SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE founder_memos SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE founder_files SET created_by = 1 WHERE created_by IS NULL").run();
  db.prepare("UPDATE users SET onboarding_complete = 1, has_paid = 1 WHERE id = 1").run();

  db.prepare("INSERT INTO migration_flags (key) VALUES ('multi_tenant_v1')").run();
  console.log('[DB] Multi-tenant migration complete — all existing data assigned to user_id=1');
}

// ── Payment columns + admin bypass ──
const payFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'payment_v1'").get();
if (!payFlag) {
  // Ensure Danny (user_id=1) bypasses payment gate
  db.prepare("UPDATE users SET has_paid = 1 WHERE id = 1").run();
  // Grant all existing users free access (pre-payment era)
  db.prepare("UPDATE users SET has_paid = 1 WHERE has_paid = 0 OR has_paid IS NULL").run();
  db.prepare("INSERT INTO migration_flags (key) VALUES ('payment_v1')").run();
  console.log('[DB] Payment migration complete — existing users granted free access');
}

// ── One-time: restore Danny's sourcing criteria (user_id=1 only) ──
const criteriaFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'danny_criteria_v1'").get();
if (!criteriaFlag && user1Exists()) {
  const upsert = db.prepare(`
    INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
    VALUES (1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, setting_key)
    DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `);

  const criteria = {
    sourcing_locations: JSON.stringify([
      'chicago','evanston','naperville','oak park','skokie','schaumburg',
      'urbana','champaign','bloomington','rockford','aurora','joliet',
      'palatine','deerfield','highland park','lake forest','winnetka',
      'wilmette','hinsdale','river north','wicker park','lincoln park',
      'west loop','loop','hyde park','pilsen'
    ]),
    sourcing_schools: JSON.stringify([
      'northwestern university','university of chicago','university of illinois',
      'illinois institute of technology','loyola university chicago','depaul university',
      'university of illinois chicago','northwestern kellogg','booth school of business',
      'illinois urbana-champaign','uiuc','northwestern mccormick'
    ]),
    sourcing_companies: JSON.stringify([
      'google','meta','apple','amazon','microsoft','stripe','openai','anthropic',
      'palantir','spacex','coinbase','datadog','snowflake','databricks','figma',
      'notion','linear','vercel','scale ai','anduril','shield ai',
      'brex','ramp','plaid','robinhood','square','block',
      'tesla','nvidia','uber','lyft','airbnb','doordash','instacart',
      'grubhub','groupon','avant','sprout social','tempus','relativity',
      'enova','reverb','braintree','uptake','sertifi',
      'mckinsey','bain','bcg','a16z','sequoia','benchmark'
    ]),
    sourcing_builder_signals: JSON.stringify([
      'YC Alum','Y Combinator','South Park Commons','SPC','Founders Inc',
      'Z Fellows','Thiel Fellow','On Deck','Entrepreneur First','TechStars',
      'Previous Exit','Serial Founder','Second-time Founder','Exited Founder',
      'PhD','Stanford PhD','MIT PhD',
      'Former CTO','Former VP Engineering','Former VP Product',
      'Staff Engineer','Principal Engineer','Founding Engineer',
      'Head of Product','Head of Growth','Head of Engineering',
      'Stealth Mode','Building something new','Just left',
      'Open Source','Patent Holder','Forbes 30 Under 30'
    ]),
    sourcing_domains: JSON.stringify([
      'AI/ML','Vertical AI','AI Infrastructure','Applied AI',
      'Fintech','Defense Tech','Climate Tech','Health Tech',
      'Developer Tools','DevOps','Cybersecurity',
      'Vertical SaaS','Enterprise SaaS','B2B SaaS',
      'Biotech','Proptech','Edtech','Legaltech',
      'Robotics','Hardware','Deep Tech'
    ]),
    sourcing_stage_filter: 'Pre-seed',
    sourcing_custom_queries: JSON.stringify([]),
  };

  db.transaction(() => {
    for (const [key, value] of Object.entries(criteria)) {
      upsert.run(key, value);
    }
  })();

  db.prepare("INSERT INTO migration_flags (key) VALUES ('danny_criteria_v1')").run();
  console.log('[DB] Danny sourcing criteria restored (user_id=1 only)');
}

// ── Update Danny's schools to include elite builder institutions ──
const schoolsFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'danny_schools_v2'").get();
if (!schoolsFlag && user1Exists()) {
  const schools = JSON.stringify([
    'northwestern university','university of chicago','university of illinois',
    'illinois institute of technology','loyola university chicago','depaul university',
    'university of illinois chicago','northwestern kellogg','booth school of business',
    'illinois urbana-champaign','uiuc','northwestern mccormick',
    'stanford university','stanford','mit','massachusetts institute of technology',
    'harvard university','harvard','harvard business school',
    'uc berkeley','berkeley','carnegie mellon','cmu',
    'caltech','georgia tech','princeton university','princeton',
    'yale university','yale','columbia university','columbia',
    'cornell university','cornell','upenn','wharton',
    'duke university','duke','brown university',
    'university of michigan','umich','university of texas','ut austin',
    'university of waterloo','waterloo',
    'nyu','new york university','usc','ucla'
  ]);
  db.prepare(`
    INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
    VALUES (1, 'sourcing_schools', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, setting_key)
    DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `).run(schools);
  db.prepare("INSERT INTO migration_flags (key) VALUES ('danny_schools_v2')").run();
  console.log('[DB] Danny schools updated with elite institutions (user_id=1 only)');
}

// ── One-time: clean Danny's sourcing inbox — dismiss founders with no Chicago/IL connection ──
const inboxCleanFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'danny_inbox_clean_v1'").get();
if (!inboxCleanFlag) {
  // Danny's criteria locations + schools
  const locations = [
    'chicago','evanston','naperville','oak park','skokie','schaumburg',
    'urbana','champaign','bloomington','rockford','aurora','joliet',
    'palatine','deerfield','highland park','lake forest','winnetka',
    'wilmette','hinsdale','river north','wicker park','lincoln park',
    'west loop','loop','hyde park','pilsen','illinois'
  ];
  const ilSchools = [
    'northwestern','university of chicago','uchicago','booth','kellogg',
    'university of illinois','uiuc','illinois institute','iit',
    'loyola','depaul','mccormick'
  ];

  const pending = db.prepare(
    "SELECT id, name, headline, raw_data, location_city, chicago_connection, pedigree_signals FROM sourced_founders WHERE user_id = 1 AND status IN ('pending','starred')"
  ).all();

  let dismissed = 0;
  const dismiss = db.prepare("UPDATE sourced_founders SET status = 'dismissed' WHERE id = ?");

  db.transaction(() => {
    for (const f of pending) {
      const text = ((f.headline || '') + ' ' + (f.raw_data || '') + ' ' + (f.location_city || '') + ' ' + (f.chicago_connection || '') + ' ' + (f.pedigree_signals || '')).toLowerCase();

      // Check for any Chicago/IL geo connection
      const hasGeo = locations.some(loc => text.includes(loc));
      // Check for IL school connection
      const hasILSchool = ilSchools.some(s => text.includes(s));

      if (!hasGeo && !hasILSchool) {
        dismiss.run(f.id);
        dismissed++;
      }
    }
  })();

  db.prepare("INSERT INTO migration_flags (key) VALUES ('danny_inbox_clean_v1')").run();
  console.log(`[DB] Inbox cleanup: ${dismissed} of ${pending.length} dismissed (no Chicago/IL connection). ${pending.length - dismissed} kept.`);
}

// ── Strict inbox cleanup: must have actual Chicago/IL tie (geo or IL school) ──
const strictCleanFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'danny_inbox_strict_v1'").get();
if (!strictCleanFlag) {
  // Geographic signals — cities, neighborhoods, state
  const geoTerms = [
    'chicago','evanston','naperville','oak park','skokie','schaumburg',
    'urbana','champaign','bloomington','rockford','aurora','joliet',
    'palatine','deerfield','highland park','lake forest','winnetka',
    'wilmette','hinsdale','river north','wicker park','lincoln park',
    'west loop','hyde park','pilsen','lakeview','logan square',
    'bucktown','old town','gold coast','streeterville','south loop',
    'wrigleyville','andersonville','ravenswood','edgewater',
    'illinois','chicagoland'
  ];
  // Only Illinois schools count (not Stanford/MIT/etc.)
  const ilSchoolTerms = [
    'northwestern','university of chicago','uchicago','booth school',
    'kellogg school','kellogg mba',
    'university of illinois','uiuc','u of i','illini',
    'illinois institute','iit',
    'loyola chicago','depaul university','mccormick school',
    'lake forest college','wheaton college illinois',
    'illinois state','southern illinois'
  ];

  const pending = db.prepare(
    "SELECT id, name, headline, raw_data, location_city, location_type, chicago_connection, pedigree_signals, builder_signals FROM sourced_founders WHERE user_id = 1 AND status IN ('pending','starred')"
  ).all();

  let dismissed = 0;
  const dismiss = db.prepare("UPDATE sourced_founders SET status = 'dismissed' WHERE id = ?");

  db.transaction(() => {
    for (const f of pending) {
      const text = [
        f.headline, f.raw_data, f.location_city, f.chicago_connection,
        f.pedigree_signals, f.builder_signals
      ].filter(Boolean).join(' ').toLowerCase();

      // Must have a real Chicago/IL geographic mention OR attended an IL school
      const hasChicagoGeo = geoTerms.some(t => text.includes(t));
      const hasILSchool = ilSchoolTerms.some(t => text.includes(t));

      if (!hasChicagoGeo && !hasILSchool) {
        dismiss.run(f.id);
        dismissed++;
      }
    }
  })();

  db.prepare("INSERT INTO migration_flags (key) VALUES ('danny_inbox_strict_v1')").run();
  console.log(`[DB] Strict inbox cleanup: ${dismissed} of ${pending.length} dismissed. ${pending.length - dismissed} kept (verified Chicago/IL tie).`);
}

// ════════════════════════════════════════════════════════════════════════════
// TALENT MODULE — portfolio hiring engine (cofounder / early-hire matching)
// ════════════════════════════════════════════════════════════════════════════

// Portfolio companies (the startups Danny is hiring for)
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_portfolio_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    website_url TEXT,
    sector TEXT,
    stage TEXT,
    one_liner TEXT,
    founder_name TEXT,
    founder_email TEXT,
    logo_url TEXT,
    hq_location TEXT,
    remote_policy TEXT,
    notes TEXT,
    status TEXT DEFAULT 'active',
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tpc_user ON talent_portfolio_companies(user_id, is_deleted);`);

// Open roles (per portfolio company)
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    portfolio_company_id INTEGER NOT NULL REFERENCES talent_portfolio_companies(id),
    title TEXT NOT NULL,
    band TEXT,
    stack_requirements TEXT,
    domain_requirements TEXT,
    must_haves TEXT,
    nice_to_haves TEXT,
    min_years_experience INTEGER,
    max_years_experience INTEGER,
    comp_low INTEGER,
    comp_high INTEGER,
    equity_low REAL,
    equity_high REAL,
    remote_ok INTEGER DEFAULT 1,
    location_pref TEXT,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'open',
    filled_by_candidate_id INTEGER,
    filled_at DATETIME,
    jd_content TEXT,
    notes TEXT,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tr_user ON talent_roles(user_id, is_deleted);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tr_company ON talent_roles(portfolio_company_id, is_deleted);`);

// Sourced candidates (engineers / operators — NOT founders)
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    headline TEXT,
    linkedin_url TEXT,
    github_url TEXT,
    twitter_url TEXT,
    website_url TEXT,
    email TEXT,
    current_company TEXT,
    current_role TEXT,
    tenure_months INTEGER,
    years_experience INTEGER,
    location_city TEXT,
    location_state TEXT,
    remote_ok INTEGER,
    tech_stack TEXT,
    pedigree_signals TEXT,
    builder_signals TEXT,
    leap_signals TEXT,
    band_fit TEXT,
    score_build_caliber INTEGER,
    score_leap_readiness INTEGER,
    score_domain_fit INTEGER,
    score_geography INTEGER,
    overall_score INTEGER,
    score_rationale TEXT,
    one_liner TEXT,
    source TEXT,
    search_query TEXT,
    raw_data TEXT,
    enriched_data TEXT,
    status TEXT DEFAULT 'new',
    starred INTEGER DEFAULT 0,
    notes TEXT,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tcand_user ON talent_candidates(user_id, is_deleted, status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tcand_score ON talent_candidates(user_id, overall_score DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tcand_linkedin ON talent_candidates(linkedin_url);`);

// Candidate ↔ Role matches
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    candidate_id INTEGER NOT NULL REFERENCES talent_candidates(id),
    role_id INTEGER NOT NULL REFERENCES talent_roles(id),
    match_score INTEGER,
    match_rationale TEXT,
    strengths TEXT,
    gaps TEXT,
    status TEXT DEFAULT 'suggested',
    surfaced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_action_at DATETIME,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(candidate_id, role_id)
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_user ON talent_matches(user_id, is_deleted, status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_role ON talent_matches(role_id, match_score DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_candidate ON talent_matches(candidate_id);`);

// Role function/archetype — drives which caliber rubric and sourcing queries apply.
// Defaults to 'engineering' so existing roles keep their current (eng-centric) behavior.
addColumn('talent_roles', 'role_function', "TEXT DEFAULT 'engineering'");
// Candidate function/archetype — so the matcher never pairs an engineer with a GTM role.
addColumn('talent_candidates', 'role_function', 'TEXT');
// Recency-of-departure for talent (parallels sourced_founders) — powers the
// "just_departed" builder signal on the Talent side (e.g. "just left a top company").
addColumn('talent_candidates', 'departure_recency_months', 'INTEGER');
addColumn('talent_candidates', 'signal_captured_at', 'DATETIME');

// Discovery enrichment (LLM analyst pass): a 0-100 unicorn-builder score + a JSON blob
// {summary, why, contactability}. Distinct from the talent engine's role-fit overall_score
// and the sourcing caliber (1-10), so neither is overwritten.
addColumn('talent_candidates', 'unicorn_score', 'INTEGER');
addColumn('talent_candidates', 'enrichment', 'TEXT');
addColumn('sourced_founders', 'unicorn_score', 'INTEGER');
addColumn('sourced_founders', 'enrichment', 'TEXT');

// Deal-queue vs. national frontier watch. IL-tied finds land in the deal 'pipeline';
// non-IL finds from cohort/frontier sources (YC, fellowships, national labs) that we still
// want visibility on land on the 'watchlist' instead of being dropped. Default 'pipeline'
// so every existing row keeps today's behavior.
addColumn('sourced_founders', 'list_scope', "TEXT DEFAULT 'pipeline'");

// Indices on the two largest / hottest tables (founders ~5k+ rows, sourced_founders grows
// with every sweep). Without these, dedup + inbox + scoping queries are full scans.
db.exec(`CREATE INDEX IF NOT EXISTS idx_founders_user ON founders(created_by, is_deleted);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_founders_linkedin ON founders(linkedin_url);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_user_status ON sourced_founders(user_id, status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_linkedin ON sourced_founders(linkedin_url);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_user_scope ON sourced_founders(user_id, list_scope, status);`);

// YC founder-resolution cache: which company pages we've already crawled for founders, so the
// daily source cron never re-fetches a page it has already parsed.
db.exec(`CREATE TABLE IF NOT EXISTS yc_resolved (slug TEXT PRIMARY KEY, resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

// LinkedIn enrichment (EnrichLayer): when we last read a sourced founder's real LinkedIn (cache,
// so we never re-pay for the same profile) and the raw profile JSON we pulled.
addColumn('sourced_founders', 'linkedin_enriched_at', 'DATETIME');
addColumn('sourced_founders', 'linkedin_data', 'TEXT');

// Breakout pedigree score (0-100) + the evidence signals behind it. Computed for every sourced
// founder so any view can sort by "who looks most like a breakout / future top-program admit".
addColumn('sourced_founders', 'breakout_score', 'INTEGER');
addColumn('sourced_founders', 'breakout_signals', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_breakout ON sourced_founders(user_id, breakout_score);`);

// ── Indexes added 2026-07-15 after measuring, not guessing ──
// EXPLAIN QUERY PLAN showed 7 of PIPELINE_SQL's 9 correlated subqueries doing a
// SCAN. Most are free (opportunity_assessments is 18 rows, decisions is 0) — the
// one that costs is sourced_founders: 187 founders × 2 subqueries × 647 rows =
// ~242K row reads, which IS the 9.5ms. This takes it to ~1ms.
//
// Honest note: 8ms is imperceptible and was never the lag Danny felt (that was
// 600KB of uncompressed transport). This is here because it's free and because
// the cost grows with the inbox, not because it fixes anything today.
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_promoted ON sourced_founders(promoted_to_founder_id, created_at);`);

// This one is a real fix. services/airtable-import.js looks up every incoming
// record by airtable_founder_record_id, and without an index that's a full scan
// of all 5,515 founders PER RECORD — the loop is O(records × founders) and blocks
// the event loop because better-sqlite3 is synchronous.
db.exec(`CREATE INDEX IF NOT EXISTS idx_founders_airtable_rec ON founders(airtable_founder_record_id);`);

// Insurance against growth: both are free today (assessments 18 rows, decisions 0)
// but every attention check and every pipeline row joins through them.
db.exec(`CREATE INDEX IF NOT EXISTS idx_oa_founder ON opportunity_assessments(founder_id, is_deleted, assessment_type, status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_founder ON decisions(founder_id, decided_at DESC);`);

// Meeting Prep reuses opportunity_assessments (same intake/ingestion: decks, transcripts,
// URLs, notes, founder CRM context) with a type discriminator, rather than a parallel
// table+pipeline. 'assessment' (default, existing behavior) | 'meeting_prep' (a single
// briefing-generation pass instead of the 4-agent eval; result stored in synthesis_output,
// same as always — the column's meaning is just contextual on assessment_type).
addColumn('opportunity_assessments', 'assessment_type', "TEXT DEFAULT 'assessment'");

// ── The expert panel (see server/agents/prompts.js LENSES + server/routes/assessments.js) ──
// The old depth layer was three generic agents (Team/Product/Market prose) stored in the
// mis-named founder_/market_/economics_agent_output columns. The rescope replaces that prose
// with a room of NINE named-lens opinions (Monopoly/Thiel, Unit-Economics/Gurley,
// Founder-Edge/Rabois, Hard-Problems/Lonsdale, Long-Game/Housel, Deep-Tech/Wolfe,
// Networks/Hoffman, Inflection/Maples, and The Bear) — each grounded in the actual inputs,
// disagreeing where they should, and abstaining honestly where a lens has nothing to add.
// panel_output holds the array of lens cards; agenda_output holds the deduped, owner-bucketed
// diligence agenda synthesised across all of them. New columns rather than reusing the
// mis-named ones so the panel never inherits the Team/Product/Market column lie.
addColumn('opportunity_assessments', 'panel_output', 'TEXT');   // JSON array of nine named-lens cards
addColumn('opportunity_assessments', 'agenda_output', 'TEXT');  // JSON: diligence agenda bucketed by owner

// Thesis Update (Ask Stu, ?topic=thesis): a place to save a thesis reflection/conclusion
// worked through in chat. Saved IN STU today, not vault-synced — that's a deliberately
// separate, not-yet-built path (see vault-sync's assessment_type filter + its comment on
// why Meeting Prep isn't synced either; extending the bridge to a second content type is
// real, scoped work for later, not squeezed in here).
db.exec(`
  CREATE TABLE IF NOT EXISTS thesis_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_thesis_notes_user ON thesis_notes(created_by, created_at);`);

// ── Newsletter / Daily Brief ──
// One row per extracted newsletter issue. Stu reads a Gmail label over IMAP, extracts
// the key points with Claude, and ranks each issue by relevance to the user's pipeline.
db.exec(`
  CREATE TABLE IF NOT EXISTS newsletter_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message_id TEXT,
    source_name TEXT,
    sender TEXT,
    subject TEXT,
    received_at DATETIME,
    brief_date TEXT,
    url TEXT,
    summary TEXT,
    key_points TEXT,
    relevance_score INTEGER DEFAULT 0,
    relevance_reason TEXT,
    matched_entities TEXT,
    category TEXT DEFAULT 'general',
    is_read INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_news_msg ON newsletter_items(user_id, message_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_news_brief ON newsletter_items(user_id, brief_date, relevance_score DESC);`);

// Newsletter sources — a managed list so the user adds a newsletter once (RSS feed
// or email sender) and it flows in forever, no manual Gmail labeling required.
db.exec(`
  CREATE TABLE IF NOT EXISTS newsletter_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT,
    type TEXT DEFAULT 'rss',        -- 'rss' | 'email'
    feed_url TEXT,                   -- for rss
    sender_match TEXT,               -- for email (substring of From)
    enabled INTEGER DEFAULT 1,
    last_fetched DATETIME,
    last_status TEXT,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_news_sources ON newsletter_sources(user_id, enabled, is_deleted);`);
// Track which source an item came from
addColumn('newsletter_items', 'source_id', 'INTEGER');

// Daily Brief v2 — archive blogs + email delivery.
// A source can be a 'newsletter' (latest issue, via RSS/email) or an 'archive' (a treasure
// trove of evergreen posts we resurface one-at-a-time daily, e.g. Paul Graham essays).
addColumn('newsletter_sources', 'kind', "TEXT DEFAULT 'newsletter'");  // 'newsletter' | 'archive'
addColumn('newsletter_sources', 'archive_key', 'TEXT');                // 'pg' | 'gurley' | 'chen' | 'elad'

// Every post discovered in an archive. We rotate through them (shown_at IS NULL first),
// so Danny works through the full back-catalogue without repeats.
db.exec(`
  CREATE TABLE IF NOT EXISTS brief_archive_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    archive_key TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    author TEXT,
    content TEXT,                  -- cached full text (filled lazily on first feature)
    summary TEXT,                  -- Claude takeaways (filled on first feature)
    shown_at DATETIME,             -- NULL = never featured yet
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_url ON brief_archive_posts(user_id, url);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_rotation ON brief_archive_posts(user_id, archive_key, shown_at);`);

// The single source of truth for a day's digest. Built ONCE (the build advances the
// archive rotation + marks classics shown), then both the in-platform Daily Brief tab and
// the emailed copy read this exact row — so the two are always identical.
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_brief (
    user_id INTEGER NOT NULL,
    brief_date TEXT NOT NULL,
    payload TEXT,                  -- JSON: { date, classics:[...], newsletters:[...] }
    built_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, brief_date)
  );
`);

// Log of digest emails sent — so we never double-send and can show send history.
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_brief_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    brief_date TEXT,
    recipient TEXT,
    archive_count INTEGER DEFAULT 0,
    newsletter_count INTEGER DEFAULT 0,
    status TEXT,                   -- 'sent' | 'error' | 'skipped'
    error TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_brief_log ON daily_brief_log(user_id, brief_date);`);

// Talent criteria (sourcing config — global or per-portfolio-co)
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_criteria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    scope TEXT DEFAULT 'global',
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, scope, setting_key)
  );
`);

// Talent sourcing run log
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_sourcing_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sources_hit TEXT,
    candidates_found INTEGER DEFAULT 0,
    candidates_added INTEGER DEFAULT 0,
    candidates_deduplicated INTEGER DEFAULT 0,
    matches_generated INTEGER DEFAULT 0,
    errors TEXT
  );
`);
// Talent run diagnostics — added AFTER the CREATE above so a fresh DB gets these columns
// (addColumn no-ops if the table doesn't exist yet). role_id + a drop-reason summary.
addColumn('talent_sourcing_runs', 'role_id', 'INTEGER');
addColumn('talent_sourcing_runs', 'summary', 'TEXT');

// Seed Danny's default talent criteria on first run
const talentCriteriaFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'talent_criteria_v1'").get();
if (!talentCriteriaFlag && user1Exists()) {
  const upsert = db.prepare(`
    INSERT INTO talent_criteria (user_id, scope, setting_key, setting_value, updated_at)
    VALUES (1, 'global', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, scope, setting_key)
    DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `);

  const defaults = {
    talent_bands: JSON.stringify(['A', 'B', 'C']),
    talent_locations: JSON.stringify([
      'chicago','evanston','naperville','oak park','river north','wicker park',
      'lincoln park','west loop','illinois','remote','san francisco','new york',
      'boston','austin','seattle','los angeles'
    ]),
    talent_schools: JSON.stringify([
      'northwestern','university of chicago','uchicago','university of illinois',
      'uiuc','illinois institute of technology','stanford','mit','harvard',
      'uc berkeley','carnegie mellon','cmu','princeton','caltech','georgia tech',
      'university of michigan','university of waterloo','waterloo'
    ]),
    talent_companies: JSON.stringify([
      'google','meta','apple','amazon','microsoft','stripe','openai','anthropic',
      'palantir','spacex','anduril','coinbase','datadog','snowflake','databricks',
      'figma','notion','linear','vercel','scale ai','shield ai','brex','ramp',
      'plaid','robinhood','square','block','tesla','nvidia','netflix','uber',
      'citadel','jump trading','drw','two sigma','jane street','hudson river',
      'tempus','relativity','braintree','grubhub','groupon','sprout social'
    ]),
    talent_stacks: JSON.stringify([
      'Python','TypeScript','Go','Rust','React','Next.js','Node.js',
      'PyTorch','TensorFlow','LLM','RAG','CUDA','Kubernetes','Postgres',
      'Distributed Systems','ML Infra','Compilers','Systems Programming',
      'iOS','Android','Swift','Kotlin','Elixir','Ruby','Java','C++'
    ]),
    talent_domains: JSON.stringify([
      'AI/ML','Vertical AI','AI Infra','Applied AI','Fintech','Healthtech',
      'DevTools','B2B SaaS','Vertical SaaS','Defense','Climate','Biotech',
      'Robotics','Hardware','Cybersecurity','Legaltech','Proptech','Edtech'
    ]),
    talent_leap_signals: JSON.stringify([
      '2-4 year tenure','open source maintainer','side project velocity',
      'build-in-public','PhD commercialization','post-IPO team member',
      'post-acquisition','first-20 at growth-stage','tech lead looking for scope',
      'advisor to startups','angel investor','cofounder match profiles'
    ]),
    talent_custom_queries: JSON.stringify([]),
  };

  db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) {
      upsert.run(key, value);
    }
  })();

  db.prepare("INSERT INTO migration_flags (key) VALUES ('talent_criteria_v1')").run();
  console.log('[DB] Talent default criteria seeded for user_id=1');
}

// ════════════════════════════════════════════════════════════════════════════
// HIRING MODULE — "know anyone good for this role?" (greenfield, 2026-08)
//
// A ground-up rebuild of Talent on the new sourcing infra. The old talent_* tables
// (above) are left dead-but-intact; nothing here reads or writes them. Deliberately
// greenfield (Danny's call): no legacy scoring columns to carry, and the model is
// built for the actual workflow — a JD arrives, it's linked to a real portfolio
// company (the founders table, invested set), and Stu returns a warm-first, IL-tied,
// grounded shortlist that's tracked per candidate and handed to the founder.
//
// Design rules that show up as columns:
//   · Roles link to founders(id), NOT a separate portco table — founders is the one
//     source of truth for Danny's universe (invested = investment_amount > 0).
//   · Every candidate carries its TIER + PROVENANCE. A warm row names the real
//     relationship (warm_source); a cold row carries the GitHub slope that earned it.
//     Warmth is never invented — the old engine's Airtable write-back is not warm and
//     is not imported at all (see routes/hiring — warm import skips it).
//   · Every IL tie carries its own receipt (il_tie_type/place/evidence) straight from
//     verifyIlTie, so a claimed Illinois tie is a fact Danny can read and overrule.
//   · jd_content is stored so the match rationale can be honesty-gated against the
//     role's own stated requirements, never against invented ones.
// ════════════════════════════════════════════════════════════════════════════

// Open roles — one per JD, linked to the portfolio company (founders row) it's for.
db.exec(`
  CREATE TABLE IF NOT EXISTS hiring_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    founder_id INTEGER REFERENCES founders(id),   -- the portco this role is for
    company_name TEXT,                            -- snapshot label (survives a founder rename/unlink)
    title TEXT NOT NULL,
    role_function TEXT,                           -- engineering|gtm|product|design|ops|data|finance|marketing|other
    seniority TEXT,                              -- as stated in the JD (junior..founding..exec); blank if unstated
    must_have_stack TEXT,                        -- JSON array; only what the JD actually requires
    nice_to_have_stack TEXT,                     -- JSON array
    domain TEXT,                                 -- e.g. healthcare, fintech (blank if unstated)
    must_haves TEXT,                             -- JSON array of hard requirements the JD states
    location_pref TEXT,                          -- free text, as stated
    remote_ok INTEGER DEFAULT 1,
    il_only INTEGER DEFAULT 0,                    -- hard-filter the shortlist to verified IL ties
    comp_note TEXT,                              -- comp/equity exactly as stated; never a guessed band
    jd_content TEXT,                             -- raw JD text — the grounding source for rationale
    jd_source TEXT,                              -- 'pdf' | 'url' | 'sentence'
    jd_ref TEXT,                                 -- filename or url the JD came from
    parse_json TEXT,                             -- the raw structured parse (audit trail)
    status TEXT DEFAULT 'open',                  -- open|paused|filled|closed
    priority TEXT DEFAULT 'normal',
    notes TEXT,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_user ON hiring_roles(user_id, is_deleted, status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_founder ON hiring_roles(founder_id, is_deleted);`);

// The candidate pool — warm and cold in one table, tier + provenance on every row.
db.exec(`
  CREATE TABLE IF NOT EXISTS hiring_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    headline TEXT,                              -- one-line bio
    linkedin_url TEXT,
    github_url TEXT,
    website_url TEXT,
    email TEXT,
    current_company TEXT,
    current_role TEXT,
    location_city TEXT,
    location_state TEXT,
    role_function TEXT,                         -- normalized function(s) (JSON array or csv)
    tech_stack TEXT,                            -- JSON array
    years_experience INTEGER,
    -- tiering + provenance (warmth is never invented)
    tier TEXT DEFAULT 'cold',                   -- 'warm' | 'cold'
    source TEXT,                                -- airtable_talent_db|airtable_master_contacts|portfolio_alumni|github_builders
    warm_source TEXT,                           -- the real relationship, e.g. "Permute Hackathon"
    superior_connection TEXT,                   -- warm connection note carried from Airtable
    external_id TEXT,                           -- source record id (dedup on re-import)
    -- IL tie, with its receipt
    il_tie_type TEXT,                           -- current|worked|school|hometown|cofounder
    il_tie_place TEXT,
    il_tie_evidence TEXT,
    -- builder quality (cold / GitHub)
    github_slope_score INTEGER,
    github_slope_data TEXT,
    builder_signals TEXT,                       -- JSON array from builderSignals
    raw_data TEXT,                              -- JSON blob of the source record
    notes TEXT,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hc_user ON hiring_candidates(user_id, is_deleted, tier);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hc_linkedin ON hiring_candidates(user_id, linkedin_url);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hc_github ON hiring_candidates(user_id, github_url);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hc_external ON hiring_candidates(user_id, external_id);`);

// The shortlist: candidate ↔ role, with the grounded rationale and the handoff status.
db.exec(`
  CREATE TABLE IF NOT EXISTS hiring_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role_id INTEGER NOT NULL REFERENCES hiring_roles(id),
    candidate_id INTEGER NOT NULL REFERENCES hiring_candidates(id),
    tier TEXT,                                  -- denormalized warm|cold (warm-first sort)
    fit_score INTEGER,                          -- role-fit 0-100 from cheap signals
    rank_score REAL,                            -- final combined rank (warmth-weighted)
    rationale TEXT,                             -- grounded "why this match" (honesty-gated)
    strengths TEXT,                             -- JSON array
    gaps TEXT,                                  -- JSON array (stated, not guessed)
    breakdown TEXT,                             -- JSON of the score components
    status TEXT DEFAULT 'sourced',              -- sourced|shortlisted|shared|intro_made|hired|passed
    status_changed_at DATETIME,
    surfaced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, candidate_id)
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hm_role ON hiring_matches(role_id, is_deleted, rank_score DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hm_candidate ON hiring_matches(candidate_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hm_user ON hiring_matches(user_id, is_deleted, status);`);

// Run log — one row per match/discovery run, role-scoped. Counts are reported, never
// silent: "12 warm + 40 cold considered → 6 shortlisted" is how Danny trusts a run.
db.exec(`
  CREATE TABLE IF NOT EXISTS hiring_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role_id INTEGER REFERENCES hiring_roles(id),
    kind TEXT,                                  -- 'match' | 'discovery' | 'warm_import'
    warm_considered INTEGER DEFAULT 0,
    cold_considered INTEGER DEFAULT 0,
    shortlisted INTEGER DEFAULT 0,
    summary TEXT,
    error TEXT,
    run_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hrun_role ON hiring_runs(role_id, run_at DESC);`);

// ════════════════════════════════════════════════════════════════════════════
// COST ATTRIBUTION, MCP ACCESS & SIGNAL MONITORS
// (BYOK foundation — see docs/talent-mcp-and-monitors-plan.md)
// ════════════════════════════════════════════════════════════════════════════

// Per-call metered usage. Powers soft daily spend caps and usage transparency.
// est_cost_usd is an approximation for capping, not an invoice.
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    feature TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    est_cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_events(user_id, created_at);`);

// MCP access tokens — long-lived but revocable, separate from the 7-day web JWT.
// We store only the hash; the plaintext token is shown once at creation.
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    scopes TEXT DEFAULT 'talent:read',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    revoked_at DATETIME
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id, revoked_at);`);

// Signal monitors (universe → snapshot → diff → classify → alert). Each row is one
// monitor a user has configured (e.g. "YC founders who just left"). Runs on the
// owning user's keys, so the watch is billed to the watch owner.
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,                 -- 'yc_departure' | 'factory_departure' | 'stealth' | 'repeat_founder' | 'formation' | 'breakout_builder'
    label TEXT,
    config_json TEXT,                   -- watch set + filters
    schedule TEXT DEFAULT 'daily',
    enabled INTEGER DEFAULT 1,
    last_run_at DATETIME,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id, enabled, is_deleted);`);

// One detected transition (a hit) for a monitor.
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    entity_name TEXT,
    entity_url TEXT,
    signal_type TEXT,                   -- builder-signal key, e.g. 'just_departed' | 'stealth_building'
    payload_json TEXT,                  -- who/last-co/when/source
    intent TEXT,                        -- 'starting_new' | 'open_to_join' | 'taking_break' | null
    confidence INTEGER,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified_at DATETIME,
    dismissed INTEGER DEFAULT 0
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_hits ON monitor_hits(monitor_id, detected_at DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_hits_user ON monitor_hits(user_id, dismissed, detected_at DESC);`);

// ── One-time: encrypt any plaintext provider keys already in user_settings ──
// Only runs once a SETTINGS_ENC_KEY is configured. Idempotent: encrypt() skips
// values that are already ciphertext, and the flag guards re-runs.
const secrets = require('./lib/secrets');
const encFlag = db.prepare("SELECT * FROM migration_flags WHERE key = 'encrypt_secrets_v1'").get();
if (secrets.isConfigured() && !encFlag) {
  // Keep this LIKE set in sync with settings.js isSensitiveSettingKey().
  const sensitive = db.prepare(
    "SELECT id, setting_value FROM user_settings WHERE setting_key LIKE 'api_key_%' OR setting_key LIKE '%_token' OR setting_key LIKE '%_app_password' OR setting_key LIKE '%_secret'"
  ).all();
  const upd = db.prepare('UPDATE user_settings SET setting_value = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const row of sensitive) {
      if (secrets.isEncrypted(row.setting_value)) continue;
      upd.run(secrets.encrypt(row.setting_value), row.id);
      n++;
    }
  })();
  db.prepare("INSERT INTO migration_flags (key) VALUES ('encrypt_secrets_v1')").run();
  console.log(`[DB] Encrypted ${n} stored credential(s) at rest`);
}

module.exports = db;
