'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vocab = require('../lib/airtableVocab');

// The merged board speaks Airtable's words. These tests exist because the last
// time Stu kept its own vocabulary and mapped onto Airtable's, the mapping quietly
// destroyed four months of Danny's stage changes.

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

// ── 1. THE TWO AXES ARE AIRTABLE'S, EXACTLY ──
// Verbatim from the live base schema (appxd2l3BXJAdTWSQ / tbl9MulpgagFUmNQf,
// fields fldCucmNaHQfZRAch "Investment Status" and fld3wjkjGCoggjYvR "Resident
// Status"), re-read 2026-08-30. If Airtable 422s a stage push, this is the first
// place to look: an option was added or renamed in the Airtable UI.
//
// The old base fused these into one `Admission Status` string, and this test
// asserted that fused list. Asserting the OLD shape is what made this test fail
// the cutover instead of catching it, so the assertion now follows the base's real
// shape: two independent selects, composed by a formula nobody may write.
test('the two status axes match Airtable\'s select options exactly', () => {
  assert.deepStrictEqual(vocab.INVESTMENT_STATUSES, [
    'Under Consideration', 'Watching', 'Diligence', 'IC', 'Invested', 'Passed',
  ]);
  assert.deepStrictEqual(vocab.RESIDENT_STATUSES, [
    'Identified', 'Interviewed', 'Admitted', 'Hold', 'Not admitted', 'Density',
  ]);
  assert.deepStrictEqual(vocab.TRACKS, ['Resident', 'Investment']);
});

// ── 1b. THE COMPOSED STAGE REPRODUCES AIRTABLE'S FORMULA ──
// Stu has to predict the stage a write will produce, which means owning a copy of
// Airtable's precedence rule. The load-bearing fact is that Investment Status wins
// outright: a row that is "Passed" reads "9 · Passed" no matter what its Resident
// Status says. Get that backwards and the board shows a stage the base does not.
test('pipelineStage composes the two axes the way the formula does', () => {
  assert.strictEqual(vocab.pipelineStage('IC', null), '1 · IC');
  assert.strictEqual(vocab.pipelineStage(null, 'Hold'), '7 · Resident — Hold');
  // Precedence, both ways round.
  assert.strictEqual(vocab.pipelineStage('Passed', 'Admitted'), '9 · Passed');
  assert.strictEqual(vocab.pipelineStage('Invested', 'Not admitted'), '8 · Invested');
  // Neither axis set is the formula's own fallback, not an error.
  assert.strictEqual(vocab.pipelineStage(null, null), vocab.NO_STAGE);
  assert.strictEqual(vocab.pipelineStage('', ''), vocab.NO_STAGE);
  // Every option on either axis must compose to a real stage.
  for (const s of vocab.INVESTMENT_STATUSES) assert.ok(vocab.isStage(vocab.pipelineStage(s, null)), s);
  for (const s of vocab.RESIDENT_STATUSES) assert.ok(vocab.isStage(vocab.pipelineStage(null, s)), s);
});

// ── 2. THE CLIENT MUST NOT KEEP ITS OWN COPY ──
// The stage list ships to the browser in the /api/pipeline response. A second
// hard-coded list in the client is a second thing to drift, which is the entire
// reason the old DEAL_STAGES/ADMISSIONS_STAGES constants were deleted.
test('the client holds no hard-coded stage list', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'Pipeline.jsx'), 'utf8'
  );
  assert.ok(!/^const DEAL_STAGES = \[/m.test(src), 'DEAL_STAGES is back in the client');
  assert.ok(!/^const ADMISSIONS_STAGES = \[/m.test(src), 'ADMISSIONS_STAGES is back in the client');
  assert.ok(/data\.vocab\?\.stages/.test(src), 'the board must take its stages from the server payload');
});

// ── 3. THE TRACK TRANSLATION ROUNDTRIPS ──
// Stu stores 'admissions'; Airtable says 'Resident'. Same thing, two words. This
// is the only mapping in the file and it has to be lossless in both directions.
test('track translation roundtrips losslessly', () => {
  assert.deepStrictEqual(vocab.tracksFromStu('admissions,investment'), ['Resident', 'Investment']);
  assert.deepStrictEqual(vocab.tracksFromStu('investment'), ['Investment']);
  assert.deepStrictEqual(vocab.tracksFromStu(''), []);
  assert.deepStrictEqual(vocab.tracksFromStu(null), []);

  assert.strictEqual(vocab.tracksToStu(['Resident', 'Investment']), 'admissions,investment');
  // Storage order is canonical, so a badge toggled in either order stores the same
  // string — otherwise 'investment,admissions' and 'admissions,investment' would
  // look like a change to the sync's diff and rewrite the row every night.
  assert.strictEqual(vocab.tracksToStu(['Investment', 'Resident']), 'admissions,investment');
  assert.strictEqual(vocab.tracksToStu([]), '');
  assert.strictEqual(vocab.tracksToStu(['Nonsense']), '');

  for (const csv of ['admissions', 'investment', 'admissions,investment', '']) {
    assert.strictEqual(vocab.tracksToStu(vocab.tracksFromStu(csv)), csv, `roundtrip failed for ${csv}`);
  }
});

// ── 4. EVERY DERIVED STAGE IS A REAL AIRTABLE OPTION ──
// If either axis map produced a string the base doesn't have, the card would sit
// in a phantom column and any push would 422. The old base derived stage from a
// single `deal_status` (DEAL_STATUS_TO_STAGE); the new one derives it from the two
// real selects, so the invariant is asserted over both maps instead.
test('both axis maps only ever produce real Airtable stages', () => {
  assert.strictEqual(vocab.DEAL_STATUS_TO_STAGE, undefined,
    'DEAL_STATUS_TO_STAGE belonged to the old base and must not come back');

  for (const [status, stage] of Object.entries(vocab.INVESTMENT_TO_STAGE)) {
    assert.ok(vocab.isStage(stage), `Investment Status "${status}" maps to "${stage}", which Airtable does not have`);
    assert.ok(vocab.isInvestmentStatus(status), `"${status}" is not a live Investment Status option`);
  }
  for (const [status, stage] of Object.entries(vocab.RESIDENT_TO_STAGE)) {
    assert.ok(vocab.isStage(stage), `Resident Status "${status}" maps to "${stage}", which Airtable does not have`);
    assert.ok(vocab.isResidentStatus(status), `"${status}" is not a live Resident Status option`);
  }

  // Every stage must be reachable from exactly one axis, or a drag onto it has no
  // write to perform. STAGES is the union of the two maps' outputs and nothing else.
  const reachable = new Set([
    ...Object.values(vocab.INVESTMENT_TO_STAGE),
    ...Object.values(vocab.RESIDENT_TO_STAGE),
  ]);
  assert.deepStrictEqual([...reachable].sort(), [...vocab.STAGES].sort());
});

// ── 5. TERMINAL STAGES ARE REAL, AND ARE THE RIGHT ONES ──
// 22 founders Danny had declined showed as live prospects because nothing knew
// which stages mean "over". Anything counting live pipeline reads this list.
test('terminal stages are real stages and cover the declined outcomes', () => {
  for (const s of vocab.TERMINAL_STAGES) assert.ok(vocab.isStage(s), `${s} is not a real stage`);
  // Both ways a founder can be over, one per axis.
  assert.ok(vocab.isTerminal('9 · Passed'));
  assert.ok(vocab.isTerminal('9 · Resident — Not admitted'));
  // Hold is NOT terminal — it's Danny's largest live cohort and counting it as
  // dead would hide the deals most likely to come back.
  assert.ok(!vocab.isTerminal('7 · Resident — Hold'));
  assert.ok(!vocab.isTerminal('6 · Resident — Identified'));
  // "Invested" is an outcome, but it is not a DECLINED one. Anything counting live
  // pipeline excludes terminal stages, and a portfolio company is not a dead deal.
  assert.ok(!vocab.isTerminal('8 · Invested'));
  // The old base's terminal strings must not survive as live-looking stages.
  assert.ok(!vocab.isStage('Stage 5: Not Admitted'));
  assert.ok(!vocab.isStage('Stage 5: Pass on Investment'));
});

// ── 6. THE PUSH PAYLOAD ──
// Tested with a stub, deliberately. The standing rule is that agents don't write to
// the team's shared base, and that includes whatever is running these tests — the
// live round-trip belongs to Danny dragging a card. What CAN be checked offline is
// the part most likely to be wrong: that we address the right field by id and send
// a value Airtable's select will accept rather than 422 on.
test('pushStage decomposes the stage onto the axis that produced it', async () => {
  const sync = require('../services/airtable-sync');
  const calls = [];
  const patch = async (table, rec, fields) => { calls.push({ table, rec, fields }); return {}; };

  // An investment stage writes Investment Status — NOT `Pipeline Stage`, which is a
  // formula and would 422, and not the composed string, which no field accepts.
  const founder = { id: 1, name: 'T', airtable_founder_record_id: 'recX', stage_status: '4 · Watching' };
  const r = await sync.pushStage(founder, '2 · Diligence', { explicit: true, patch });
  assert.strictEqual(r.pushed, true);
  assert.strictEqual(r.axis, 'investment');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].table, vocab.FOUNDER_TABLE);
  assert.strictEqual(calls[0].rec, 'recX');
  // Field ID, not name: renaming the column in Airtable's UI must not break the write.
  assert.deepStrictEqual(calls[0].fields, { [vocab.FIELD.INVESTMENT_STATUS]: 'Diligence' });

  // A resident stage writes the other field, with the bare option Airtable accepts.
  const resident = { id: 2, name: 'R', airtable_founder_record_id: 'recY' };
  const r2 = await sync.pushStage(resident, '7 · Resident — Hold', { explicit: true, patch });
  assert.strictEqual(r2.pushed, true);
  assert.strictEqual(r2.axis, 'resident');
  assert.deepStrictEqual(calls[1].fields, { [vocab.FIELD.RESIDENT_STATUS]: 'Hold' });

  // The regression this replaced: the payload must never carry a key that isn't a
  // real field id. A missing vocab entry used to stringify to the key "undefined".
  for (const c of calls) {
    for (const k of Object.keys(c.fields)) {
      assert.ok(/^fld[A-Za-z0-9]+$/.test(k), `payload key "${k}" is not an Airtable field id`);
    }
  }
});

// ── 6b. THE PRECEDENCE TRAP ──
// Investment Status wins in the formula. So setting Resident Status on a row that
// already has an investment status changes the cell but NOT the stage the board
// shows. Reporting success there tells Danny his drag landed while the card sits
// still — the same "status message decoupled from the thing it describes" bug this
// codebase keeps producing. It must refuse, and say what is shadowing it.
test('a resident drag on a row with an investment status refuses rather than lying', async () => {
  const sync = require('../services/airtable-sync');
  let called = false;
  const patch = async () => { called = true; return {}; };
  const founder = {
    id: 3, name: 'S', airtable_founder_record_id: 'recZ',
    deal_status: 'Passed',            // the shadowing axis
  };

  const r = await sync.pushStage(founder, '5 · Resident — Admitted', { explicit: true, patch });
  assert.strictEqual(r.pushed, undefined);
  assert.strictEqual(r.skipped, 'shadowed_by_investment_status');
  assert.strictEqual(r.shadowedBy, '9 · Passed');
  assert.strictEqual(called, false, 'a write that could not change the board must not be sent');

  // The same drag on a row with no investment status goes through.
  const clean = { id: 4, name: 'S2', airtable_founder_record_id: 'recW', deal_status: null };
  const r2 = await sync.pushStage(clean, '5 · Resident — Admitted', { explicit: true, patch });
  assert.strictEqual(r2.pushed, true);
});

// ── STAGE PUBLISHES. NOTHING ELSE DOES. ──
// Danny: "I'm comfortable with you publishing stage updates to Airtable. But that's
// it. I'm going to primarily work in Stu, and then choose to enter my own context
// to the team view in Airtable depending on what I want them to see."
//
// So the track pusher is DELETED, not merely unused. An unused writer to a shared
// base is one call site away from being a used one.
test('there is no track pusher — the badge can never reach Airtable', () => {
  const sync = require('../services/airtable-sync');
  assert.strictEqual(sync.pushTracks, undefined, 'pushTracks must not exist');

  const src = read('services/airtable-sync.js');
  assert.ok(!/FIELD\.PIPELINE/.test(src), 'nothing in the push service may address the Pipeline field');

  const pipeline = read('routes/pipeline.js');
  const tracks = pipeline.match(/router\.patch\('\/:id\/tracks'[\s\S]*?\n\}\);/);
  assert.ok(tracks, 'the badge endpoint must exist');
  assert.ok(!/explicit: true/.test(tracks[0]), 'the badge endpoint must never publish to Airtable');
});

// ── AND THE CONSEQUENCE OF THAT ──
// The badge not publishing means Airtable cannot learn Danny switched Investment
// off. The nightly sync unions tracks, so it would switch it straight back on.
// `tracks_set_by_user_at` is what stops his edit being undone overnight.
test('once Danny edits a badge, the sync stops unioning that founder\'s tracks', () => {
  const pipeline = read('routes/pipeline.js');
  const tracks = pipeline.match(/router\.patch\('\/:id\/tracks'[\s\S]*?\n\}\);/);
  assert.ok(/tracks_set_by_user_at = CURRENT_TIMESTAMP/.test(tracks[0]),
    'editing the badge must record that Danny owns this founder\'s tracks');

  const imp = read('services/airtable-import.js');
  assert.ok(/if \(!existing\.tracks_set_by_user_at\)/.test(imp),
    'the sync must skip the track union for founders whose badge Danny has edited');
});

test('a stage Airtable does not have never reaches the network', async () => {
  const sync = require('../services/airtable-sync');
  let called = false;
  const patch = async () => { called = true; return {}; };
  const founder = { id: 1, name: 'T', airtable_founder_record_id: 'recX' };

  // The OLD base's vocabulary. If this ever got through it would 422.
  const r = await sync.pushStage(founder, 'Stage 3: Evaluating (Investment + Resident)', { explicit: true, patch });
  assert.strictEqual(r.skipped, 'not_a_valid_stage');
  assert.strictEqual(called, false);

  // A bare axis OPTION is not a stage either. "Under Consideration" is a real
  // Investment Status value, so it reads plausible — but the field expects the
  // option and the board speaks composed stages, and only "3 · Under
  // Consideration" is both. Accepting the bare string would write the right cell
  // by luck here and the wrong one the moment the two lists diverge.
  const r2 = await sync.pushStage(founder, 'Under Consideration', { explicit: true, patch });
  assert.strictEqual(r2.skipped, 'not_a_valid_stage');
  assert.strictEqual(called, false);
});

test('the gate still refuses a push without explicit:true, stub or not', async () => {
  const sync = require('../services/airtable-sync');
  let called = false;
  const patch = async () => { called = true; return {}; };
  const founder = { id: 1, name: 'T', airtable_founder_record_id: 'recX' };

  assert.deepStrictEqual(await sync.pushStage(founder, '2 · Diligence', { patch }), { skipped: 'not_explicit' });
  assert.strictEqual(called, false, 'a non-explicit call must not touch the network at all');
});

test('an orphan with no Airtable record is skipped, not errored', async () => {
  const sync = require('../services/airtable-sync');
  let called = false;
  const patch = async () => { called = true; return {}; };
  // One of the 26 from Airtable's separate Investment Pipeline table.
  const orphan = { id: 2, name: 'Deskpilot (Company)', airtable_founder_record_id: null };
  const r = await sync.pushStage(orphan, '2 · Diligence', { explicit: true, patch });
  assert.deepStrictEqual(r, { skipped: 'no_airtable_record' });
  assert.strictEqual(called, false);
});

// ── THE NARROW COLUMN LIST, CAUGHT STRUCTURALLY ──
// PIPELINE_SQL lists columns explicitly (it runs over ~190 rows and a wide payload
// is paid on every page load). That narrowness has now shipped the SAME bug three
// times: a column the board reasons about is missing, so the check reads
// `undefined`, and the board silently does the wrong thing while the card — which
// selects f.* — does the right one.
//   · investment_amount omitted → every portfolio company rendered as "met"
//   · company_linkedin_url omitted → "add the company LinkedIn URL" on a card that had one
//   · represented_by_founder_id omitted → both Permute cards stayed on the board
// So: any column the GET handler references must actually be selected.
test('every founders column the board filters on is in PIPELINE_SQL', () => {
  const src = read('routes/pipeline.js');
  const sql = src.match(/const PIPELINE_SQL = `([\s\S]*?)`;/);
  assert.ok(sql, 'PIPELINE_SQL must exist');
  const selected = sql[1];

  // Columns the board's own logic depends on, by name.
  const required = [
    'stage_status',              // the merged board's axis
    'represented_by_founder_id', // folded co-founders are filtered out
    'pipeline_tracks',           // the R/I badge
    'investment_amount',         // stageOf() derives "invested" from it
    'airtable_next_step',        // rendered on the card
  ];
  for (const col of required) {
    assert.ok(
      new RegExp(`f\\.${col}\\b`).test(selected),
      `PIPELINE_SQL does not select f.${col} — the board reasons about it, so it will read undefined`
    );
  }
});

// ── 7. ONLY A HUMAN DRAG MAY WRITE TO AIRTABLE ──
// Danny chose "Drag in Stu, and it writes to Airtable". That relaxes the rule for
// HIS action, not for background jobs. The gate stays; the two board endpoints are
// the only callers allowed through it.
test('the stage drag is the ONLY explicit Airtable write in the codebase', () => {
  const pipeline = read('routes/pipeline.js');
  const stage = pipeline.match(/router\.patch\('\/:id\/stage'[\s\S]*?\n\}\);/);
  assert.ok(stage && /explicit: true/.test(stage[0]), 'the stage drag must push explicitly');

  // Count every explicit:true in real CODE — comments talk about the flag and must
  // not be counted, or this test measures prose. Danny scoped the write to stage
  // updates and nothing else, so there is exactly one.
  const code = pipeline.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = (code.match(/explicit:\s*true/g) || []).length;
  assert.strictEqual(hits, 1, `routes/pipeline.js has ${hits} explicit Airtable writes in code; only the stage drag may publish`);

  // No scheduled job may pass the flag.
  for (const f of ['index.js', 'services/airtable-import.js']) {
    assert.ok(!/explicit:\s*true/.test(read(f)), `${f} must never pass explicit:true — agents do not write to Airtable`);
  }
});
