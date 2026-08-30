/**
 * Airtable → Stu sync
 *
 * Airtable's "Superior Founder Ecosystem" is the team's CRM and the source of
 * truth for where a founder stands. Danny maintains it by hand. This pulls it in.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE WAS REWRITTEN (2026-07-16)
 *
 * The header used to say, proudly: "Existing founders are NOT overwritten.
 * Safe to run repeatedly — only inserts new records."
 *
 * It ran every morning at 5:45. It fetched all 162 records, and for every
 * founder already in Stu it hit `skipped++; continue;`. So the ONLY Airtable
 * edit that could ever reach Stu was the creation of a brand new founder.
 * Every stage change Danny made by hand for four months was fetched, compared,
 * and thrown away — daily — while the log printed a reassuring
 * "Done: 0 imported, 162 skipped (already exist)".
 *
 * This is the same bug this codebase keeps producing: a status message decoupled
 * from the thing it describes. "Skipped" was doing the work of "discarded".
 *
 * Measured the morning it was found: 49 of 159 matched founders (31%) disagreed
 * with what a fresh sync of that day's Airtable would say. The failures ran in
 * the worst possible direction:
 *   · 22 founders Danny had already declined (Stage 5: Not Admitted / Pass on
 *     Investment) sat on Stu's board as LIVE prospects — "First Call Scheduled".
 *   · 4 admitted residents (Stage 4) showed as unclosed prospects.
 *   · 8 company names were wrong, incl. Vishnu Indukuri's, which Stu called
 *     "Stealth" while Airtable had said "Brae Systems" for months.
 *
 * A pipeline tool whose board shows dead deals as live meetings is worse than no
 * pipeline tool. So: this now UPDATES.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FIELD OWNERSHIP — the only interesting decision here
 *
 * AUTHORITATIVE (Airtable always wins, every run, and the change is logged):
 *   the funnel facts Danny curates in Airtable and nowhere else — admission
 *   status, next step, company name, one-liner, HQ, current stage, previous
 *   companies. A BLANK Airtable cell is never authoritative: it means "unset",
 *   not "delete what Stu knows".
 *
 * FILL-IF-EMPTY (Airtable may fill a blank, never clobber a value):
 *   email, linkedin_url, website_url, next_action, source. Stu is where Danny
 *   types, and `next_action` in particular carries context from his own pipeline
 *   dumps that has no Airtable equivalent. Overwriting it would delete his work.
 *   `source` is here because Stu's and Airtable's are false friends — Stu's says
 *   WHO ("Danny Goodman"), Airtable's says the CHANNEL ("Outbound").
 *
 * UNIONED: pipeline_tracks. Airtable can add a founder to a board; only Danny
 *   takes one off. See mergeTracks().
 *
 * NEVER TOUCHED: conviction scores, assessments, sources, signals, notes,
 *   deal_status, and `name` (the match key). Those are Stu's. Airtable has no
 *   opinion about them. Enforced by test/mirror-integrity.test.js.
 *
 * This is a ONE-WAY read. It does not write to Airtable — see airtable-sync.js,
 * whose gate requires an explicit publish-to-team action. Airtable is shared with
 * the team; nothing automatic goes back up it.
 */

const db = require('../db');
const https = require('https');
const { normalizeStage } = require('../lib/fundingStage');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appfE9DVrSUOrkkpu';
const FOUNDER_TABLE = 'tblWkJzy5qpw7FP2M';

function fetchAirtable(tableId) {
  return new Promise((resolve, reject) => {
    const records = [];
    function fetchPage(offset) {
      let url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?pageSize=100`;
      if (offset) url += `&offset=${offset}`;
      const req = https.get(url, { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            records.push(...(data.records || []));
            if (data.offset) fetchPage(data.offset);
            else resolve(records);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
    }
    fetchPage(null);
  });
}

function mapNextStepToAdmissions(nextStep) {
  if (!nextStep) return 'Sourced';
  const ns = nextStep.toLowerCase().trim();
  if (ns === 'hold') return 'Hold/Nurture';
  if (ns === 'admitted') return 'Admitted';
  if (ns === 'met') return 'First Call Complete';
  if (ns === 'convert to ssfi applicant') return 'Sourced';
  if (ns === 'support action items') return 'Hold/Nurture';
  if (ns.includes('scheduling 1st') || ns.includes('1st mtg scheduling')) return 'Outreach';
  if (ns.includes('1st mtg scheduled')) return 'First Call Scheduled';
  if (ns.includes('scheduling 2nd') || ns.includes('2nd mtg scheduling')) return 'First Call Complete';
  if (ns.includes('2nd mtg scheduled')) return 'Second Call Scheduled';
  if (ns.includes('scheduling 3rd') || ns.includes('3rd mtg')) return 'Second Call Complete';
  return 'Sourced';
}

function mapAdmissionStatus(airtableStatus, nextStep) {
  if (!airtableStatus) return { admissions_status: 'Sourced', status: 'Sourced' };
  const s = airtableStatus.trim().toLowerCase();

  if (s.includes('stage 0') || s.includes('legacy (density)') || s.includes('legacy density')) {
    return { admissions_status: 'Density Resident', status: 'Active' };
  }
  if (s.includes('stage 1')) {
    const admStatus = mapNextStepToAdmissions(nextStep);
    let overallStatus = 'Sourced';
    if (['Outreach', 'First Call Scheduled'].includes(admStatus)) overallStatus = 'Outreach';
    if (['First Call Complete', 'Second Call Scheduled', 'Second Call Complete'].includes(admStatus)) overallStatus = 'Interviewing';
    if (admStatus === 'Hold/Nurture') overallStatus = 'Hold';
    return { admissions_status: admStatus, status: overallStatus };
  }
  if (s.includes('stage 2')) {
    const admStatus = mapNextStepToAdmissions(nextStep);
    let mapped = admStatus === 'Sourced' ? 'First Call Complete' : admStatus;
    return { admissions_status: mapped, status: 'Interviewing' };
  }
  if (s.includes('stage 3')) {
    const admStatus = mapNextStepToAdmissions(nextStep);
    let mapped = admStatus === 'Sourced' ? 'Second Call Scheduled' : admStatus;
    return { admissions_status: mapped, status: 'Interviewing' };
  }
  if (s.includes('stage 4')) {
    if (s.includes('admitted')) return { admissions_status: 'Active Resident', status: 'Active' };
    const admStatus = mapNextStepToAdmissions(nextStep);
    let mapped = admStatus === 'Sourced' ? 'Second Call Complete' : admStatus;
    return { admissions_status: mapped, status: 'Interviewing' };
  }
  if (s.includes('stage 5')) {
    if (s.includes('legacy density') || s.includes('legacy (density)')) return { admissions_status: 'Density Resident', status: 'Active' };
    if (s.includes('not admitted')) return { admissions_status: 'Not Admitted', status: 'Not Admitted' };
    if (s.includes('admitted') || s.includes('onboarding')) return { admissions_status: 'Active Resident', status: 'Active' };
    if (s.includes('hold') || s.includes('nurture')) return { admissions_status: 'Hold/Nurture', status: 'Hold' };
    return { admissions_status: 'Hold/Nurture', status: 'Hold' };
  }

  if (s.includes('not admitted')) return { admissions_status: 'Not Admitted', status: 'Not Admitted' };
  if (s.includes('admitted')) return { admissions_status: 'Active Resident', status: 'Active' };
  if (s.includes('hold') || s.includes('nurture')) return { admissions_status: 'Hold/Nurture', status: 'Hold' };
  return { admissions_status: 'Sourced', status: 'Sourced' };
}

function parseLocation(hq) {
  if (!Array.isArray(hq) || hq.length === 0) return { city: null, state: null };
  const loc = hq[0];
  const cityStateMap = {
    'Chicago': 'IL', 'Bay Area': 'CA', 'New York': 'NY', 'Boston': 'MA',
    'Seattle': 'WA', 'Los Angeles': 'CA', 'Evanston': 'IL', 'Ann Arbor': 'MI',
    'Milwaukee': 'WI', 'Orlando': 'FL', 'Chattanooga': 'TN', 'Boulder': 'CO', 'Houston': 'TX',
  };
  if (cityStateMap[loc]) return { city: loc, state: cityStateMap[loc] };
  if (loc.includes(',')) {
    const parts = loc.split(',');
    return { city: parts[0].trim(), state: parts[1]?.trim() || null };
  }
  return { city: loc, state: null };
}

// Airtable's shape: a singleSelect arrives as a bare string via the REST API,
// a multipleSelect as an array of strings. Normalize both to a trimmed string.
function sel(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]).trim() : null;
  if (typeof v === 'object') return v.name ? String(v.name).trim() : null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Fields Airtable owns outright. Recomputed from Airtable on every run.
//
// `pipeline_tracks` is NOT here — it's unioned, see mergeTracks().
//
// `source` is NOT here either, and the dry run is why. Stu's `source` and
// Airtable's "Source" are false friends: Stu's holds WHO brought the founder in
// ("Danny Goodman"), Airtable's holds the CHANNEL ("Outbound", "Founder
// Referral"). Treating them as the same column proposed overwriting 93 rows of
// attribution with a channel name. Same word, different question. Airtable may
// fill the 7 blanks; it may not answer Stu's question with its own.
const AUTHORITATIVE = [
  'company', 'company_one_liner', 'location_city', 'location_state',
  'stage', 'previous_companies',
  'admissions_status', 'status',
  'airtable_admission_status', 'airtable_next_step',
  // The merged board's stage axis. For an Airtable-backed founder this is just
  // airtable_admission_status under the name the board reads — Danny: "Use
  // Airtable right now as the source of truth for the correct stage."
  'stage_status',
];

// Fields Airtable may fill but must never clobber. See FIELD OWNERSHIP above.
const FILL_IF_EMPTY = ['email', 'linkedin_url', 'website_url', 'next_action', 'source'];

// Tracks are UNIONED, never replaced.
//
// The dry run wanted to move 17 founders from "admissions,investment" to
// "admissions" — i.e. silently delete 17 companies from Danny's investment board
// because Airtable's Pipeline cell doesn't say "Investment". Airtable is a CRM
// the team keeps; the investment board is Danny's own working state, and he put
// those companies there deliberately (several arrived via his July pipeline dump,
// which has no Airtable equivalent). A nightly job must be able to ADD a founder
// to a track — that's Danny flipping the multi-select and expecting Stu to catch
// up — but taking one off the board is a decision, and decisions happen in Stu.
function mergeTracks(existingCsv, airtableCsv) {
  const have = String(existingCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  const want = String(airtableCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [...new Set([...have, ...want])];
  return out.join(',');
}

function isBlank(v) { return v == null || String(v).trim() === ''; }

// Build the full desired Stu row from one Airtable record.
function desiredFrom(f) {
  const pipelines = Array.isArray(f['Pipeline']) ? f['Pipeline'] : [];
  const tracks = ['admissions'];
  if (pipelines.includes('Investment')) tracks.push('investment');

  const rawAdm = sel(f['Admission Status']);
  const rawNext = sel(f['Next Step Description']);
  const { admissions_status, status } = mapAdmissionStatus(rawAdm, rawNext);
  const { city, state } = parseLocation(f['HQ']);
  // Airtable spells this field its own way and this sync runs every morning at
  // 5:45. Passing the raw value through is how 84 rows ended up spelled 'Pre-Seed'
  // while 5,339 said 'Pre-seed' — two values, one stage, and every case-sensitive
  // `WHERE stage = ?` quietly wrong. Normalizing HERE (not just in the one-time
  // db.js migration) is what stops tomorrow's run from re-splitting them.
  const rawStage = normalizeStage(sel(f['Current Stage'])) || 'Pre-seed';

  return {
    company: (f['Company Name'] || '').trim() || null,
    company_one_liner: f['Company One-Liner'] || null,
    source: sel(f['Source']),
    location_city: city,
    location_state: state,
    // The 'Service' → 'Pre-seed' fold used to sit inline here ("'Service' isn't a
    // fundraising stage; Stu's `stage` column only speaks rounds"). It now lives in
    // lib/fundingStage's ALIASES, applied by the normalizeStage above, so the same
    // rule covers migrate-from-airtable and any future importer instead of being
    // re-typed at each edge.
    stage: rawStage,
    previous_companies: f['Previous Companies'] || null,
    pipeline_tracks: tracks.join(','),
    admissions_status,
    status,
    airtable_admission_status: rawAdm,
    airtable_next_step: rawNext,
    stage_status: rawAdm,
    // fill-if-empty half
    email: f['Email'] || null,
    linkedin_url: f['LinkedIn'] || null,
    website_url: f['Company Website'] || null,
    next_action: f['Next Action / Notes'] || null,
  };
}

function logChange(founderId, field, oldValue, newValue, recordId) {
  try {
    db.prepare(`
      INSERT INTO airtable_sync_log
        (founder_id, table_name, field_name, old_value, new_value, airtable_record_id, status)
      VALUES (?, 'founder_ecosystem_import', ?, ?, ?, ?, 'success')
    `).run(founderId, field, oldValue == null ? null : String(oldValue),
           newValue == null ? null : String(newValue), recordId);
  } catch (err) {
    console.error('[AirtableImport] sync-log write failed:', err.message);
  }
}

/**
 * @param {object}  opts
 * @param {boolean} opts.dryRun  Compute and return the diff, write nothing.
 */
async function syncFromAirtable(opts = {}) {
  const dryRun = opts.dryRun === true;

  if (!AIRTABLE_API_KEY) {
    console.warn('[AirtableImport] No AIRTABLE_API_KEY set, skipping sync');
    return { imported: 0, updated: 0, unchanged: 0, skipped: 0, changes: [] };
  }

  const records = await fetchAirtable(FOUNDER_TABLE);
  console.log(`[AirtableImport] Fetched ${records.length} records from Airtable${dryRun ? ' (DRY RUN)' : ''}`);

  let imported = 0, updated = 0, unchanged = 0, skipped = 0;
  const changes = [];
  const conflicts = [];   // one person, two Airtable records — see Matching below

  // Every record id Airtable still has. A Stu row whose airtable id is NOT in here
  // is held by a deleted record, which is to say it is not held at all.
  const liveRecordIds = new Set(records.map(r => r.id));

  for (const record of records) {
    const f = record.fields || {};
    const name = (f['Founder Name'] || '').trim();
    if (!name || name === '?') { skipped++; continue; }

    const want = desiredFrom(f);

    // ── Matching ──
    // The record id is the only identifier that means anything. Name is a fallback
    // for rows imported before the id was backfilled, and it is fenced: a name
    // match may only claim a Stu row that no LIVE Airtable record already holds.
    //
    // Both halves of that sentence are load-bearing, and each came from a real row.
    //
    // "already holds" — Kevin Pierce genuinely has two Airtable records:
    //   recnQV4jNo4qRkwuh  "Lumitra, Inc."  Stage 4: Admitted (Resident)
    //   recLkVa5rpg19559X  "Lumitra"        Stage 5: Hold / Nurture
    // Both match him by name. Unfenced, each run rewrote the other's answer and
    // his stage flipped between Active Resident and Hold/Nurture nightly — the
    // sync never converged and whichever record Airtable returned last won.
    //
    // "LIVE" — Rodrigo Mosqueira looked identical and is the opposite case. Stu
    // held recs1CLrRhf57htzs, which no longer exists in Airtable; his real record
    // (recnd1pMWD8YQsXPv, "Bizmark") was created 2026-07-15. A fence that only
    // asked "is this row claimed?" would let a DELETED record hold his row hostage
    // forever and permanently lock out the live one. A claim by a record that no
    // longer exists is not a claim.
    let existing = db.prepare(
      'SELECT * FROM founders WHERE airtable_founder_record_id = ? AND is_deleted = 0'
    ).get(record.id);

    if (!existing) {
      const candidate = (want.company && db.prepare(
        'SELECT * FROM founders WHERE is_deleted = 0 AND LOWER(TRIM(name)) = LOWER(?) AND LOWER(TRIM(company)) = LOWER(?)'
      ).get(name, want.company)) || db.prepare(
        'SELECT * FROM founders WHERE is_deleted = 0 AND LOWER(TRIM(name)) = LOWER(?)'
      ).get(name);

      const heldBy = candidate && candidate.airtable_founder_record_id;
      const heldByLiveRecord = !isBlank(heldBy) && liveRecordIds.has(heldBy);

      if (candidate && !heldByLiveRecord) {
        // Unclaimed, or claimed by a record Airtable no longer has. Adopt it —
        // the id is repointed via the diff below.
        existing = candidate;
      } else if (candidate) {
        // One person, two live Airtable records. Report it; never let them trade
        // the row back and forth. Danny merges them in Airtable, not Stu.
        conflicts.push({
          name,
          stu_founder_id: candidate.id,
          held_by: heldBy,
          also_claimed_by: record.id,
          airtable_company: want.company,
          airtable_admission_status: want.airtable_admission_status,
        });
        skipped++;
        continue;
      }
    }

    // ── New founder ──
    if (!existing) {
      if (dryRun) { imported++; changes.push({ name, kind: 'insert', fields: [] }); continue; }
      try {
        db.prepare(`
          INSERT INTO founders (
            name, company, email, linkedin_url, website_url,
            location_city, location_state, stage, domain,
            status, source, company_one_liner, next_action,
            pipeline_tracks, admissions_status,
            airtable_admission_status, airtable_next_step, airtable_synced_at,
            previous_companies, airtable_founder_record_id, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 1)
        `).run(
          name, want.company, want.email, want.linkedin_url, want.website_url,
          want.location_city, want.location_state, want.stage,
          want.status, want.source, want.company_one_liner, want.next_action,
          want.pipeline_tracks, want.admissions_status,
          want.airtable_admission_status, want.airtable_next_step,
          want.previous_companies, record.id
        );
        imported++;
        console.log(`[AirtableImport] + ${name} | ${want.company || '(stealth)'} → ${want.admissions_status}`);
      } catch (err) {
        console.error(`[AirtableImport] ! ${name}: ${err.message}`);
      }
      continue;
    }

    // ── Existing founder: reconcile field by field ──
    const diffs = [];

    for (const col of AUTHORITATIVE) {
      const now = existing[col];
      const next = want[col];
      // Never blank out a value Stu already has just because Airtable's cell is
      // empty. An empty Airtable cell means "unset", not "delete what you know".
      if (isBlank(next)) continue;
      if (isBlank(now) || String(now).trim() !== String(next).trim()) {
        diffs.push({ col, from: now, to: next });
      }
    }

    for (const col of FILL_IF_EMPTY) {
      const now = existing[col];
      const next = want[col];
      if (isBlank(next) || !isBlank(now)) continue;
      diffs.push({ col, from: now, to: next });
    }

    // ── Tracks ──
    // Union: Airtable can add Danny to a board, never remove him from one.
    //
    // UNLESS he has edited the badge himself. The badge does not publish to Airtable
    // (his rule: "stage updates... But that's it"), so Airtable cannot know he
    // switched Investment off — and the union would switch it back on tonight.
    // Once he's touched it, Stu owns it and this leaves it alone.
    if (!existing.tracks_set_by_user_at) {
      const mergedTracks = mergeTracks(existing.pipeline_tracks, want.pipeline_tracks);
      if (mergedTracks !== String(existing.pipeline_tracks || '')) {
        diffs.push({ col: 'pipeline_tracks', from: existing.pipeline_tracks, to: mergedTracks });
      }
    }

    if (existing.airtable_founder_record_id !== record.id) {
      diffs.push({ col: 'airtable_founder_record_id', from: existing.airtable_founder_record_id, to: record.id });
    }

    if (!diffs.length) { unchanged++; continue; }

    updated++;
    changes.push({
      name, id: existing.id, kind: 'update',
      fields: diffs.map(d => ({ field: d.col, from: d.from, to: d.to })),
    });

    if (dryRun) continue;

    const setSql = diffs.map(d => `${d.col} = ?`).join(', ');
    db.prepare(
      `UPDATE founders SET ${setSql}, airtable_synced_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(...diffs.map(d => d.to), existing.id);

    for (const d of diffs) logChange(existing.id, d.col, d.from, d.to, record.id);

    const stageMove = diffs.find(d => d.col === 'admissions_status');
    if (stageMove) {
      console.log(`[AirtableImport] ~ ${name}: ${stageMove.from} → ${stageMove.to}`);
    }
  }

  for (const c of conflicts) {
    console.warn(
      `[AirtableImport] CONFLICT ${c.name}: Airtable has two records for one person ` +
      `(${c.held_by} holds Stu #${c.stu_founder_id}; ${c.also_claimed_by} also matched). ` +
      `Left untouched — merge them in Airtable.`
    );
  }

  console.log(
    `[AirtableImport] Done${dryRun ? ' (DRY RUN — nothing written)' : ''}: ` +
    `${imported} imported, ${updated} updated, ${unchanged} already current, ` +
    `${skipped} skipped, ${conflicts.length} conflicts`
  );
  return { imported, updated, unchanged, skipped, conflicts, total: records.length, changes };
}

module.exports = {
  syncFromAirtable,
  __test: { desiredFrom, sel, mapAdmissionStatus, mergeTracks, AUTHORITATIVE, FILL_IF_EMPTY },
};
