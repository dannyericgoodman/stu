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

// This is the only module in Stu that WRITES to Airtable, so it is the one that
// most needs its target to be unambiguous. Base id, table ids and key come from
// lib/airtableBase; recordUrl refuses to address a table that isn't in scope.
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
// CREATE A PIPELINE ROW (2026-09-16)
//
// Danny's "Add to Pipeline" button in the sourcing inbox means "I'm interested":
// the founder lands in Stu's pipeline as Watching AND a row is created in the
// team's Airtable Pipeline table with Investment Status = Watching (Pipeline
// Stage formula then reads "4 · Watching").
//
// GATED like every other writer: only Danny's explicit click reaches this with
// { explicit: true }. This is deliberately NOT a stage push — it creates a row
// in the team's hand-maintained base, which the old "stage updates only" rule
// did not cover. The button IS the publish-to-team decision.
//
// `opts.post` exists for the same reason as `opts.patch` on pushStage: the live
// round-trip is Danny's to make by clicking the button. What is testable offline
// is the payload — that we send field names Airtable accepts and a status value
// from its own vocabulary.
// ══════════════════════════════════════════════════════════════════════════
async function createPipelineRecord(founder, opts = {}) {
  // DISABLED 2026-09-17 — Danny: Stu never writes to Airtable.
  return { skipped: 'writes_disabled' };
  const blockedCreate = gatedOut(opts, founder, 'create');
  if (blockedCreate) return { skipped: blockedCreate };
  const post = opts.post || postAirtableRecord;
  // The status this record is born with. The inbox "Add to Pipeline" flow used
  // to publish as Watching; the personal ledger's Stage 4a ("Add to Investment
  // Pipeline") publishes as Under Consideration — the honest Airtable spelling
  // of entering the investment pipeline.
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

// GATE: Airtable is the TEAM's shared base. Nothing writes to it except a deliberate
// "publish to team" action. Both writers refuse unless opts.explicit === true, so an
// accidental auto-push (the old fire-and-forget behavior) can never leak in-progress
// founder data to the team. SQLite stays canonical; Airtable self-heals on next publish.
/**
 * The central choke point for every Airtable write. Returns null when the write
 * may proceed, or a skip-reason string when it must not.
 *
 * Two independent locks, both required:
 *  1. explicit — the call must pass { explicit: true } (Danny's own drag /
 *     publish-to-team action). No agent, cron, or background job may write.
 *  2. owner — the call must name the owner's userId. The team base is the
 *     owner's CRM; a paying outside seat must never write to it. Route-level
 *     checks exist, but this is the layer that cannot be forgotten by a future
 *     caller — forgetting userId fails closed.
 */
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
// THE MERGED BOARD'S WRITE PATH (2026-07-16)
//
// EXACTLY ONE THING PUBLISHES: the stage. Danny drew the line himself —
//
//   "I'm comfortable with you publishing stage updates to Airtable. But that's it.
//    I'm going to primarily work in Stu, and then choose to enter my own context to
//    the team view in Airtable depending on what I want them to see."
//
// So Stu is where he works and Airtable is what his team sees, and he decides what
// crosses. The stage crosses because the team's view of where a deal stands must
// not silently disagree with his. Everything else — the Resident/Investment badge,
// his notes, Stu's read — stays in Stu until he says otherwise. There was a
// pushTracks() here; it is deleted rather than left unused, because an unused
// writer to a shared base is one call site away from being a used one.
//
// This does NOT loosen the standing rule. No AGENT writes to the team's base —
// nothing scheduled, nothing inferred, nothing fired off in the background. Every
// writer below still refuses without { explicit: true }, and the only caller that
// passes it is the endpoint behind Danny's own drag. A cron can never reach it.
//
// Unlike the legacy pushers below, this sends Airtable's OWN vocabulary straight
// through (lib/airtableVocab) — no stuAdmissionsToAirtable() translation, because
// the board now speaks Airtable's words natively. Nothing to mistranslate. Field
// IDs, not names, so a rename in Airtable's UI can't silently 422 us.
// ══════════════════════════════════════════════════════════════════════════

const vocab = require('../lib/airtableVocab');

// `opts.patch` exists so the PAYLOAD can be tested without writing to the team's
// shared base. The rule is that agents don't touch Airtable, and that includes the
// agent writing this file: the live round-trip is Danny's to make by dragging a
// card. What is testable offline is the thing most likely to be wrong — that we
// send the right field id and a value Airtable will actually accept.
/** Push the merged board's stage. `stage` must already be a valid Airtable option. */
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
 * Push admissions_status change to Airtable Founder Ecosystem table.
 * GATED: only runs when called with { explicit: true } (publish-to-team).
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
 * Push deal_status change to Airtable Investment Pipeline table.
 * GATED: only runs when called with { explicit: true } (publish-to-team).
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
