/**
 * Stu → Airtable push service — DISABLED 2026-09-17
 *
 * Danny: "I don't want you writing to Airtable." Every writer in this module
 * now returns { skipped: 'writes_disabled' } before touching the network.
 * Airtable is read-only from Stu (airtable-import.js still pulls); the team
 * base is hand-maintained and Stu never mutates it.
 *
 * This module stays as the single choke point: if writes are ever re-enabled,
 * re-enabling them here restores the old explicit-gate behavior in one place.
 */

const https = require('https');
const db = require('../db');
const { stuAdmissionsToAirtable, stuDealToAirtable } = require('./stage-mapping');

// This was once the only module in Stu that WROTE to Airtable; every writer
// is now a stub that returns { skipped: 'writes_disabled' } before touching
// the network. The machinery below (recordUrl/table ids, the HTTPS helpers,
// the gate) is dead code kept so the stubs stay structurally intact and the
// no-write tests keep covering them.
const { TABLE, recordUrl, recordsUrl, API_KEY: AIRTABLE_API_KEY } = require('../lib/airtableBase');

const FOUNDER_TABLE = TABLE.FOUNDERS;
const DEAL_TABLE = TABLE.DEALS;

function patchAirtableRecord(tableId, recordId, fields) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ fields });
    const url = recordUrl(tableId, recordId);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Airtable ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postAirtableRecord(tableId, fields) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ fields });
    const url = recordsUrl(tableId);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Airtable ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// CREATE A PIPELINE ROW — DISABLED 2026-09-17 (historical note)
//
// Used to create a row in the team's Airtable Pipeline table when Danny hit
// "Add to Pipeline" in the sourcing inbox. Stu never writes to Airtable now:
// the stub below returns { skipped: 'writes_disabled' } before any of the
// payload-building code below can run. The function and its shape stay so the
// no-write tests keep asserting the refusal.
// ══════════════════════════════════════════════════════════════════════════
async function createPipelineRecord(founder, opts = {}) {
  // DISABLED 2026-09-17 — Danny: Stu never writes to Airtable.
  return { skipped: 'writes_disabled' };
  const blockedCreate = gatedOut(opts, founder, 'create');
  if (blockedCreate) return { skipped: blockedCreate };
  const post = opts.post || postAirtableRecord;
  // Dead-code note: the status this record used to be born with. The inbox
  // "Add to Pipeline" flow used to publish as Watching; the personal ledger's
  // Stage 4a ("Add to Investment Pipeline") would have published as Under
  // Consideration — the honest Airtable spelling of entering the investment
  // pipeline. None of it runs anymore.
  const investmentStatus = opts.investmentStatus || 'Watching';

  // Descriptive fields go by NAME (the import service reads by name too); the
  // status goes by FIELD ID with a value from Airtable's own vocabulary, so a
  // UI rename can't silently mistarget the one field that drives the board.
  const fields = {
    'Company / Founder': founder.company || founder.name,
    'Founder': founder.name,
    [vocab.FIELD.INVESTMENT_STATUS]: investmentStatus,
    // No 'Stu' option exists on Source Channel; Outbound is the closest true value.
    'Source Channel': 'Outbound',
  };
  if (founder.linkedin_url) fields['LinkedIn'] = founder.linkedin_url;
  if (founder.company_one_liner) fields['One-liner'] = founder.company_one_liner;
  if (founder.website_url) fields['Website'] = founder.website_url;
  if (founder.email) fields['Email'] = founder.email;

  try {
    const rec = await post(TABLE.PIPELINE, fields);
    logSync(founder.id, 'pipeline', 'Investment Status', null, investmentStatus, rec.id, 'success', null);
    return { created: true, recordId: rec.id };
  } catch (err) {
    logSync(founder.id, 'pipeline', 'Investment Status', null, investmentStatus, null, 'failed', err.message);
    console.error(`[AirtableSync] ✗ create pipeline record failed for "${founder.name}":`, err.message);
    return { error: err.message };
  }
}

function logSync(founderId, tableName, fieldName, oldValue, newValue, recordId, status, errorMessage) {
  try {
    db.prepare(`
      INSERT INTO airtable_sync_log (founder_id, table_name, field_name, old_value, new_value, airtable_record_id, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(founderId, tableName, fieldName, oldValue, newValue, recordId, status, errorMessage);
  } catch (err) {
    console.error('[AirtableSync] Failed to write sync log:', err.message);
  }
}

// GATE (dead code, kept for structure) — the old rule that nothing reached
// Airtable except a deliberate publish-to-team action. Every writer now
// refuses before this gate is even consulted, and it can never fire again.
// gatedOut stays so the dead branches below it still read as dead branches.
function gatedOut(opts, founder, kind) {
  if (!opts || opts.explicit !== true) {
    console.warn(`[AirtableSync] BLOCKED non-explicit ${kind} push for "${founder && founder.name}" — Airtable writes require an explicit publish-to-team action.`);
    return 'not_explicit';
  }
  const { isOwner } = require('../lib/providerKeys');
  if (!isOwner(opts.userId)) {
    console.warn(`[AirtableSync] BLOCKED ${kind} push for "${founder && founder.name}" — not the owner account (user ${opts && opts.userId}).`);
    return 'not_owner';
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// THE MERGED BOARD'S WRITE PATH (2026-07-16) — DISABLED 2026-09-17 (historical)
//
// The old deal: stage changes (Danny's drags) were the one thing allowed to
// cross into the team's Airtable base, in Airtable's own vocabulary. That rule
// ended 2026-09-17: Stu never writes to Airtable, full stop. The stubs below
// return { skipped: 'writes_disabled' } before touching the network; the rest
// of this file is dead code kept for structure and for the no-write tests.
// ══════════════════════════════════════════════════════════════════════════

const vocab = require('../lib/airtableVocab');

// Dead-code note: the opts.patch/opt.post injection points below existed so the
// payload could be tested without writing to the team's shared base. No live
// round-trip happens anymore — every writer returns before them.
/** DISABLED stub — pushStage always returns { skipped: 'writes_disabled' }. */
async function pushStage(founder, stage, opts = {}) {
  // DISABLED 2026-09-17 — Danny: Stu never writes to Airtable.
  return { skipped: 'writes_disabled' };
  const blockedStage = gatedOut(opts, founder, 'stage');
  if (blockedStage) return { skipped: blockedStage };
  const recordId = founder.airtable_founder_record_id;
  // The 26 Investment-Pipeline orphans have no Founder Ecosystem record. Their
  // stage is Stu-local and that is correct — this is not an error to shout about.
  if (!recordId) return { skipped: 'no_airtable_record' };
  if (!vocab.isStage(stage)) return { skipped: 'not_a_valid_stage', stage };

  // `Pipeline Stage` is a FORMULA in the authorized base — patching it is a 422.
  // Every drag has to be decomposed back into the axis that produced it, which is
  // what stageWriteFor owns. This used to send `{ [FIELD.ADMISSION_STATUS]: stage }`;
  // that key no longer exists in the new base's vocabulary, so the computed
  // property evaluated to the literal string "undefined" and every push 422'd.
  const write = vocab.stageWriteFor(stage, { investmentStatus: founder.deal_status });
  if (!write) return { skipped: 'not_a_valid_stage', stage };

  // The precedence trap: Investment Status wins over Resident Status in the
  // formula. Writing a resident stage onto a row that already carries an
  // investment status changes the stored cell but NOT the stage the board shows.
  // Returning { pushed: true } there would tell Danny his drag landed while the
  // card visibly sat still, which is the exact class of lie this codebase keeps
  // producing. Refuse instead, and name what is shadowing it.
  if (write.shadowed) {
    return { skipped: 'shadowed_by_investment_status', stage, shadowedBy: write.shadowedBy };
  }

  const patch = opts.patch || patchAirtableRecord;
  const fieldLabel = write.axis === 'investment' ? 'Investment Status' : 'Resident Status';
  try {
    await patch(vocab.FOUNDER_TABLE, recordId, { [write.field]: write.value });
    logSync(founder.id, 'pipeline', fieldLabel, founder.stage_status, stage, recordId, 'success', null);
    return { pushed: true, stage, field: write.field, value: write.value, axis: write.axis };
  } catch (err) {
    logSync(founder.id, 'pipeline', fieldLabel, founder.stage_status, stage, recordId, 'failed', err.message);
    console.error(`[AirtableSync] ✗ ${founder.name} stage push failed:`, err.message);
    return { error: err.message };
  }
}

/**
 * DISABLED stub — pushAdmissionsChange always returns { skipped: 'writes_disabled' }.
 */
async function pushAdmissionsChange(founder, oldStatus, opts = {}) {
  // DISABLED 2026-09-17 — Danny: Stu never writes to Airtable.
  return { skipped: 'writes_disabled' };
  const blockedAdm = gatedOut(opts, founder, 'admissions');
  if (blockedAdm) return { skipped: blockedAdm };
  const recordId = founder.airtable_founder_record_id;
  if (!recordId) {
    console.warn(`[AirtableSync] No Airtable record ID for founder ${founder.id} (${founder.name}), skipping admissions push`);
    return;
  }

  const hasInvestment = (founder.pipeline_tracks || '').includes('investment');
  const airtableValue = stuAdmissionsToAirtable(founder.admissions_status, hasInvestment);

  if (!airtableValue) {
    console.warn(`[AirtableSync] No Airtable mapping for admissions_status="${founder.admissions_status}", skipping`);
    return;
  }

  console.log(`[AirtableSync] Pushing admissions change: ${founder.name} → ${airtableValue}`);

  try {
    await patchAirtableRecord(FOUNDER_TABLE, recordId, {
      'Admission Status': airtableValue,
    });
    logSync(founder.id, 'founder_ecosystem', 'Admission Status', oldStatus, founder.admissions_status, recordId, 'success', null);
    console.log(`[AirtableSync] ✓ ${founder.name} admissions pushed to Airtable`);
  } catch (err) {
    logSync(founder.id, 'founder_ecosystem', 'Admission Status', oldStatus, founder.admissions_status, recordId, 'failed', err.message);
    console.error(`[AirtableSync] ✗ ${founder.name} admissions push failed:`, err.message);
  }
}

/**
 * DISABLED stub — pushDealChange always returns { skipped: 'writes_disabled' }.
 */
async function pushDealChange(founder, oldStatus, opts = {}) {
  // DISABLED 2026-09-17 — Danny: Stu never writes to Airtable.
  return { skipped: 'writes_disabled' };
  const blockedDeal = gatedOut(opts, founder, 'deal');
  if (blockedDeal) return { skipped: blockedDeal };
  const recordId = founder.airtable_deal_record_id;
  if (!recordId) {
    console.warn(`[AirtableSync] No Airtable deal record ID for founder ${founder.id} (${founder.name}), skipping deal push`);
    return;
  }

  const airtableValue = stuDealToAirtable(founder.deal_status);

  if (!airtableValue) {
    console.warn(`[AirtableSync] No Airtable mapping for deal_status="${founder.deal_status}", skipping`);
    return;
  }

  console.log(`[AirtableSync] Pushing deal change: ${founder.name} → ${airtableValue}`);

  try {
    await patchAirtableRecord(DEAL_TABLE, recordId, {
      'Status': airtableValue,
    });
    logSync(founder.id, 'investment_pipeline', 'Status', oldStatus, founder.deal_status, recordId, 'success', null);
    console.log(`[AirtableSync] ✓ ${founder.name} deal pushed to Airtable`);
  } catch (err) {
    logSync(founder.id, 'investment_pipeline', 'Status', oldStatus, founder.deal_status, recordId, 'failed', err.message);
    console.error(`[AirtableSync] ✗ ${founder.name} deal push failed:`, err.message);
  }
}

module.exports = { pushAdmissionsChange, pushDealChange, pushStage, createPipelineRecord };
