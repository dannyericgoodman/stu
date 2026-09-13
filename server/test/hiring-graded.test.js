'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Graded hiring. Every case is shaped by the live Avant Health role (2026-09-13):
// "Clinical Member Advocate" — active RN license, case management, utilization
// management, health-insurance fluency, Chicago, IL-only.
//
// The deterministic ranker put a marketing co-founder at #1 (65/100) and a 28-year
// utilization-management RN at 33/100. These tests pin the inversion's fix and the
// three ways the fix itself could lie:
//   · a model asserting a credential the profile does not show (the quote gate);
//   · the transcript-built gate rejecting real short credentials ("RN, BSN");
//   · re-sourcing leaving the stale co-founder on the page.
// No test calls a network. The model is a scripted fake.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const g = require('../lib/hiringGrade');
const { interleave } = require('../pipeline/hiring-exa');
const { updatesFromProfile, isFresh, enrichCandidatesForRole } = require('../pipeline/hiring-linkedin');
const { rowFromMatch, upsertNetworkCandidate, roleAsNeed } = require('../pipeline/hiring-network');
const hm = require('../pipeline/hiring-match');

const NURSE_TEXT = 'Utilization Management RN, BSN, CPUR, CPHM @ HCSC-BCBS Illinois. 28 years in managed care utilization review, case management, and prior authorization. Greater Chicago Area.';
const COFOUNDER_TEXT = 'Co-Founder @ AbridgeRx. Background in marketing, sales, and operations at early-stage startups. Greater Chicago Area.';

const RUBRIC = {
  requirements: [
    { id: 'r1', text: 'Active RN license', weight: 'core' },
    { id: 'r2', text: 'Case management or utilization management experience', weight: 'core' },
    { id: 'r3', text: 'Health insurance fundamentals (claims, prior authorization)', weight: 'supporting' },
  ],
  dropped: ['Comfortable with a mostly in-office schedule'],
  source: 'model',
};

// A scripted model. For grading it reads each candidate block and answers the way a
// sloppy model might: it CLAIMS the co-founder holds an RN license, with a quote that
// is not in his profile. The gate must catch that.
function fakeClient({ onCall } = {}) {
  return {
    messages: {
      create: async ({ system, messages }) => {
        if (onCall) onCall(system);
        if (/turn a job description into the requirements/.test(system)) {
          return { content: [{ text: JSON.stringify({ requirements: RUBRIC.requirements.map(({ text, weight }) => ({ text, weight })), dropped: RUBRIC.dropped }) }] };
        }
        const user = messages[0].content;
        const blocks = user.split(/=== CANDIDATE (\d+) ===/).slice(1);
        const grades = [];
        for (let k = 0; k < blocks.length; k += 2) {
          const i = Number(blocks[k]);
          const text = blocks[k + 1];
          if (/RN, BSN/.test(text)) {
            grades.push({ i, requirements: [
              { id: 'r1', status: 'met', quote: 'RN, BSN' },
              { id: 'r2', status: 'met', quote: 'case management' },
              { id: 'r3', status: 'met', quote: 'prior authorization' },
            ], why: 'Long utilization-management nursing career at a Blue Cross plan.', why_quote: '28 years in managed care utilization review' });
          } else {
            grades.push({ i, requirements: [
              { id: 'r1', status: 'met', quote: 'active registered nurse license' },   // fabricated
              { id: 'r2', status: 'contradicted', quote: 'marketing, sales, and operations' },
              { id: 'r3', status: 'not_shown' },
            ], why: 'Experienced clinical leader.', why_quote: 'licensed clinical leader' });  // fabricated
          }
        }
        return { content: [{ text: JSON.stringify({ grades }) }] };
      },
    },
  };
}

// ── The quote gate ────────────────────────────────────────────────────────

test('short real credentials pass the gate; absent ones and word fragments do not', () => {
  assert.ok(g.quoteInProfile('RN, BSN', NURSE_TEXT));
  assert.ok(g.quoteInProfile('CPUR', NURSE_TEXT));
  assert.ok(g.quoteInProfile('BCBS', NURSE_TEXT), 'hyphenated HCSC-BCBS still yields BCBS');
  assert.ok(!g.quoteInProfile('Active RN license', NURSE_TEXT), 'the requirement text is not a quote from the profile');
  assert.ok(!g.quoteInProfile('rn', 'Modern care teams'), '"rn" inside "modern" is not an RN');
});

test('a "met" verdict with a fabricated quote becomes "not shown"', () => {
  const v = g.gateVerdicts(RUBRIC, [{ id: 'r1', status: 'met', quote: 'active registered nurse license' }], COFOUNDER_TEXT);
  assert.strictEqual(v[0].status, 'not_shown');
  assert.strictEqual(v[0].ungrounded, true);
  assert.strictEqual(v[0].quote, null, 'a rejected quote is never shown on the card');
});

test('requirements the model skipped or invented ids for are not credited', () => {
  const v = g.gateVerdicts(RUBRIC, [{ id: 'r9', status: 'met', quote: 'RN, BSN' }], NURSE_TEXT);
  assert.deepStrictEqual(v.map((x) => x.status), ['not_shown', 'not_shown', 'not_shown']);
});

// ── The arithmetic ────────────────────────────────────────────────────────

test('core requirements weigh double and a contradicted core halves the score', () => {
  const met = (id, weight) => ({ id, weight, status: 'met' });
  assert.strictEqual(g.scoreVerdicts([met('r1', 'core'), { id: 'r2', weight: 'supporting', status: 'not_shown' }]), 67);
  const contradicted = [{ id: 'r1', weight: 'core', status: 'contradicted' }, met('r2', 'supporting'), met('r3', 'supporting')];
  assert.strictEqual(g.scoreVerdicts(contradicted), 25, '2 of 4 weight earned = 50, halved for the contradicted core');
  assert.strictEqual(g.scoreVerdicts([]), 0);
});

// ── The inversion, end to end through the grader ─────────────────────────

test('the RN outranks the marketing co-founder, and his invented credential earns nothing', async () => {
  const nurse = { id: 1, name: 'Doina Anderson', profile_text: NURSE_TEXT };
  const cofounder = { id: 2, name: 'Daniel Bodde', profile_text: COFOUNDER_TEXT };
  const r = await g.gradeCandidates({ client: fakeClient(), role: { title: 'Clinical Member Advocate' }, rubric: RUBRIC, candidates: [cofounder, nurse] });
  const n = r.grades.get(1);
  const c = r.grades.get(2);
  assert.strictEqual(n.fit, 100);
  assert.strictEqual(c.fit, 0, 'no grounded requirement met, and a contradicted core');
  assert.ok(c.fit < hm.GRADED_FLOOR, 'he must not reach the shortlist');
  assert.strictEqual(c.why_grounded, false, 'his fabricated rationale is replaced with a grounded line');
  assert.match(c.why, /No requirement/);
  assert.ok(n.strengths.some((s) => /RN, BSN/.test(s)), 'the card shows the credential with its quote');
  assert.ok(c.gaps.some((s) => /contradicts/.test(s)));
});

test('an unchanged candidate against an unchanged rubric is not re-graded', async () => {
  const nurse = { id: 1, name: 'N', profile_text: NURSE_TEXT };
  const first = await g.gradeCandidates({ client: fakeClient(), role: {}, rubric: RUBRIC, candidates: [nurse] });
  let calls = 0;
  const again = await g.gradeCandidates({ client: fakeClient({ onCall: () => calls++ }), role: {}, rubric: RUBRIC, candidates: [nurse], cached: first.grades });
  assert.strictEqual(calls, 0, 'a re-source must not re-pay for the same grade');
  assert.strictEqual(again.reused, 1);

  const edited = { ...nurse, profile_text: `${NURSE_TEXT} Now at Aetna.` };
  const third = await g.gradeCandidates({ client: fakeClient({ onCall: () => calls++ }), role: {}, rubric: RUBRIC, candidates: [edited], cached: first.grades });
  assert.strictEqual(calls, 1, 'new profile text is re-graded');
  assert.strictEqual(third.graded, 1);
});

test('without a key nothing is graded, and the result says so', async () => {
  const r = await g.gradeCandidates({ client: null, role: {}, rubric: RUBRIC, candidates: [{ id: 1, profile_text: NURSE_TEXT }] });
  assert.strictEqual(r.grades.size, 0);
  assert.match(r.errors[0], /No Anthropic key/);
});

test('a rubric is capped, re-numbered, and always has a core requirement', () => {
  const many = { requirements: Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, text: `Req ${i}`, weight: 'supporting' })) };
  const r = g.normalizeRubric(many, { title: 'T' });
  assert.strictEqual(r.requirements.length, g.MAX_REQUIREMENTS);
  assert.deepStrictEqual(r.requirements.map((q) => q.id).slice(0, 3), ['r1', 'r2', 'r3']);
  assert.strictEqual(r.requirements[0].weight, 'core');
  assert.strictEqual(g.normalizeRubric({ requirements: [] }, { title: 'Nurse', must_haves: '["RN"]' }).source, 'fallback');
});

test('a LinkedIn profile flattens into quotable lines, certifications included', () => {
  const t = g.linkedinText({
    headline: 'Utilization Review Nurse', city: 'Chicago', state: 'Illinois',
    experiences: [{ title: 'UM Nurse', company: 'BCBS of Illinois', starts_at: { year: 2019 }, ends_at: null }],
    education: [{ school: 'Loyola University Chicago', degree_name: 'BSN' }],
    certifications: [{ name: 'Registered Nurse', authority: 'IDFPR' }],
  });
  assert.match(t, /Experience: UM Nurse at BCBS of Illinois \(2019–present\)/);
  assert.match(t, /Certification: Registered Nurse \(IDFPR\)/);
  assert.ok(g.quoteInProfile('Registered Nurse', t));
});

// ── Search breadth ────────────────────────────────────────────────────────

test('results interleave across queries so every query\'s best is read first', () => {
  const a = [{ url: 'a1' }, { url: 'a2' }, { url: 'a3' }];
  const b = [{ url: 'b1' }, { url: 'a1' }];
  assert.deepStrictEqual(interleave([a, b]).map((r) => r.url), ['a1', 'b1', 'a2', 'a3']);
});

// ── LinkedIn read ─────────────────────────────────────────────────────────

test('a LinkedIn read adds an Illinois tie and fills blanks, but never overwrites or removes', () => {
  const blank = updatesFromProfile({ current_role: null, il_tie_type: null }, { city: 'Chicago', state: 'Illinois', experiences: [{ title: 'UM Nurse', company: 'BCBS' }] });
  assert.ok(blank.il_tie_type, 'a stated Chicago location establishes the tie the excerpt missed');
  assert.strictEqual(blank.current_role, 'UM Nurse');

  const kept = updatesFromProfile({ current_role: 'Nurse Lead', il_tie_type: 'school' }, { city: 'Denver', state: 'Colorado', experiences: [{ title: 'Other' }] });
  assert.ok(!('il_tie_type' in kept), 'a profile that does not mention Illinois never removes a verified tie');
  assert.ok(!('current_role' in kept), 'an existing role is not overwritten');
});

test('reads within the freshness window are reused; no key means a stated skip', async () => {
  assert.ok(isFresh(new Date(Date.now() - 2 * 86400000).toISOString()));
  assert.ok(!isFresh(new Date(Date.now() - 45 * 86400000).toISOString()));
  const r = await enrichCandidatesForRole({ candidates: [{ id: 1, linkedin_url: 'https://www.linkedin.com/in/x' }], deps: { enrichKey: null } });
  assert.strictEqual(r.skipped, 'no EnrichLayer key');
});

// ── Network pool ──────────────────────────────────────────────────────────

test('only a real relationship enters as warm; a never-messaged connection does not', () => {
  const base = { person_id: 7, name: 'A', title: 'UM Nurse', company: 'BCBS', linkedin_url: 'https://www.linkedin.com/in/a' };
  const real = rowFromMatch({ ...base, warmth: 60, warmth_tier: 'real', how_you_know_them: '6 messages both ways' });
  const thin = rowFromMatch({ ...base, warmth: 5, warmth_tier: 'thin', how_you_know_them: 'Connected, never messaged' });
  assert.strictEqual(real.tier, 'warm');
  assert.strictEqual(real.warm_source, '6 messages both ways');
  assert.strictEqual(thin.tier, 'cold', 'a card forwarded to a founder must not call a stranger warm');
  assert.strictEqual(thin.warm_source, null);
});

test('the role becomes a Network hire ask built from its requirements', () => {
  const n = roleAsNeed({ title: 'Clinical Member Advocate', role_function: 'ops', domain: 'health insurance', must_haves: '["Active RN license"]' });
  assert.strictEqual(n.type, 'hire');
  assert.match(n.text, /Active RN license/);
});

// ── The match, against the real schema ────────────────────────────────────

test('graded runMatch: IL-only filters, stale matches retire, moved matches stay, warmth ranks by tier', async () => {
  const uid = 1;
  const ins = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
  const roleId = ins(`INSERT INTO hiring_roles (user_id, title, role_function, must_haves, il_only, status) VALUES (?, '__TEST Clinical Member Advocate', 'ops', ?, 1, 'open')`, uid, JSON.stringify(['Active RN license']));
  const nurseWarm = ins(`INSERT INTO hiring_candidates (user_id, name, headline, profile_text, tier, warmth_tier, warm_source, il_tie_type, source) VALUES (?, '__TEST Warm Nurse', 'UM RN @ BCBS', ?, 'warm', 'real', '6 messages both ways', 'current', 'network')`, uid, NURSE_TEXT);
  const nurseCold = ins(`INSERT INTO hiring_candidates (user_id, name, headline, profile_text, tier, il_tie_type, source) VALUES (?, '__TEST Cold Nurse', 'UM RN @ HCSC', ?, 'cold', 'current', 'exa')`, uid, NURSE_TEXT.replace('28 years', '27 years'));
  const cofounder = ins(`INSERT INTO hiring_candidates (user_id, name, headline, profile_text, tier, il_tie_type, source) VALUES (?, '__TEST Cofounder', 'Co-Founder @ AbridgeRx', ?, 'cold', 'current', 'exa')`, uid, COFOUNDER_TEXT);
  const outOfState = ins(`INSERT INTO hiring_candidates (user_id, name, headline, profile_text, tier, source) VALUES (?, '__TEST Denver Nurse', 'UM RN @ Anthem', ?, 'cold', 'exa')`, uid, NURSE_TEXT);
  const movedWeak = ins(`INSERT INTO hiring_candidates (user_id, name, headline, profile_text, tier, il_tie_type, source) VALUES (?, '__TEST Shared Earlier', 'Ops @ Startup', ?, 'cold', 'current', 'exa')`, uid, COFOUNDER_TEXT.replace('AbridgeRx', 'Other Co'));
  // The stale state the live role was in: the co-founder already on the list, untouched,
  // and someone Danny had already shared with the founder.
  ins(`INSERT INTO hiring_matches (user_id, role_id, candidate_id, tier, fit_score, rank_score, status) VALUES (?, ?, ?, 'cold', 65, 65, 'sourced')`, uid, roleId, cofounder);
  ins(`INSERT INTO hiring_matches (user_id, role_id, candidate_id, tier, fit_score, rank_score, status) VALUES (?, ?, ?, 'cold', 40, 40, 'shared')`, uid, roleId, movedWeak);

  const cleanup = () => {
    db.prepare('DELETE FROM hiring_matches WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM hiring_runs WHERE role_id = ?').run(roleId);
    db.prepare(`DELETE FROM hiring_candidates WHERE id IN (${[nurseWarm, nurseCold, cofounder, outOfState, movedWeak].join(',')})`).run();
    db.prepare('DELETE FROM hiring_roles WHERE id = ?').run(roleId);
  };

  try {
    const r = await hm.runMatch({ userId: uid, roleId, priorityIds: [nurseWarm, nurseCold, cofounder, outOfState], deps: { client: fakeClient() } });
    assert.strictEqual(r.graded, true);
    const live = db.prepare('SELECT candidate_id, status, fit_score, rank_score FROM hiring_matches WHERE role_id = ? AND is_deleted = 0 ORDER BY rank_score DESC').all(roleId);
    const ids = live.map((m) => Number(m.candidate_id));

    assert.strictEqual(ids[0], Number(nurseWarm), 'equal fit — the nurse Danny knows ranks first');
    assert.ok(ids.includes(Number(nurseCold)));
    assert.ok(!ids.includes(Number(cofounder)), 'the stale co-founder is retired from the page');
    assert.ok(!ids.includes(Number(outOfState)), 'IL-only: no verified tie, not shortlisted');
    assert.ok(ids.includes(Number(movedWeak)), 'a match Danny already shared is never dropped');
    assert.strictEqual(live.find((m) => Number(m.candidate_id) === Number(movedWeak)).status, 'shared');
    assert.match(r.summary, /stale matches retired/);
    assert.match(r.summary, /not gradable from a profile: Comfortable with a mostly in-office schedule/);

    const role = db.prepare('SELECT grading_rubric, rubric_hash FROM hiring_roles WHERE id = ?').get(roleId);
    assert.ok(role.rubric_hash, 'the model-built rubric is stored on the role');
  } finally {
    cleanup();
  }
});

test('a fallback rubric built while the key was dead is never pinned to the role', async () => {
  const uid = 1;
  const roleId = db.prepare(`INSERT INTO hiring_roles (user_id, title, must_haves, status) VALUES (?, '__TEST Fallback Role', '["RN"]', 'open')`).run(uid).lastInsertRowid;
  const dead = { messages: { create: async () => { const e = new Error('API key is invalid'); e.status = 401; throw e; } } };
  try {
    const role = db.prepare('SELECT * FROM hiring_roles WHERE id = ?').get(roleId);
    const rb = await hm.ensureRubric({ role, client: dead });
    assert.strictEqual(rb.source, 'fallback');
    assert.match(rb.error, /invalid or expired/);
    assert.strictEqual(db.prepare('SELECT rubric_hash FROM hiring_roles WHERE id = ?').get(roleId).rubric_hash, null);
  } finally {
    db.prepare('DELETE FROM hiring_roles WHERE id = ?').run(roleId);
  }
});

test('a network person already found by web search is promoted to warm, not duplicated', () => {
  const uid = 1;
  const existing = db.prepare(`INSERT INTO hiring_candidates (user_id, name, linkedin_url, tier, source, external_id) VALUES (?, '__TEST Found By Exa', 'https://www.linkedin.com/in/__test-slug-xyz', 'cold', 'exa', 'exa:__test')`).run(uid).lastInsertRowid;
  try {
    const row = rowFromMatch({ person_id: 999999, name: '__TEST Found By Exa', title: 'UM Nurse', company: 'BCBS',
      linkedin_url: 'https://www.linkedin.com/in/__TEST-slug-xyz/', warmth: 70, warmth_tier: 'strong', how_you_know_them: '40 messages both ways' });
    const { id, result } = upsertNetworkCandidate(uid, row);
    assert.strictEqual(result, 'updated');
    assert.strictEqual(Number(id), Number(existing));
    const after = db.prepare('SELECT tier, warm_source, warmth_tier, current_role FROM hiring_candidates WHERE id = ?').get(existing);
    assert.strictEqual(after.tier, 'warm');
    assert.strictEqual(after.warm_source, '40 messages both ways');
    assert.strictEqual(after.current_role, 'UM Nurse', 'a blank role is filled');
  } finally {
    db.prepare('DELETE FROM hiring_candidates WHERE id = ?').run(existing);
  }
});

// ── The orchestrator: order, stages, and a skipped step that says so ──────
test('a sourcing run goes network → web → LinkedIn → grade, and names every skipped step', async () => {
  const { runSourcing } = require('../pipeline/hiring-source');
  const uid = 1;
  const roleId = db.prepare(`INSERT INTO hiring_roles (user_id, title, status) VALUES (?, '__TEST Orchestrated Role', 'open')`).run(uid).lastInsertRowid;
  const runId = db.prepare("INSERT INTO hiring_runs (user_id, role_id, kind, status, found) VALUES (?, ?, 'source', 'running', 0)").run(uid, roleId).lastInsertRowid;
  const order = [];
  const stages = [];
  const origPrepare = db.prepare.bind(db);
  let matchArgs = null;
  try {
    await runSourcing(runId, uid, roleId, {
      sourceFromNetwork: () => { order.push('network'); stages.push(origPrepare('SELECT stage FROM hiring_runs WHERE id = ?').get(runId).stage); return { ids: [101, 102], considered: 3100, qualified: 40, warm: 1, inserted: 2 }; },
      sourceViaExa: async () => { order.push('web'); return { ids: [201], queries: ['q1', 'q2'], considered: 50, read: 50, extracted: 20, ungrounded_dropped: 2, inserted: 1, updated: 0 }; },
      enrichCandidatesForRole: async () => { order.push('linkedin'); stages.push(origPrepare('SELECT stage FROM hiring_runs WHERE id = ?').get(runId).stage); return { enriched: 0, reused: 0, failed: 0, ties_added: 0, skipped: 'no EnrichLayer key' }; },
      runMatch: async (args) => { order.push('grade'); matchArgs = args; return { summary: 'graded 3 of 3', shortlisted: 2, warm_considered: 1, cold_considered: 2 }; },
    });
    const run = origPrepare('SELECT status, stage, summary, found FROM hiring_runs WHERE id = ?').get(runId);
    assert.deepStrictEqual(order, ['network', 'web', 'linkedin', 'grade']);
    assert.strictEqual(run.status, 'done');
    assert.strictEqual(run.stage, null, 'a finished run shows no stage');
    assert.match(stages[0], /network/i);
    assert.match(stages[1], /LinkedIn/);
    assert.deepStrictEqual(matchArgs.priorityIds, [101, 102, 201], 'network finds are graded before web finds');
    assert.match(run.summary, /LinkedIn not read \(no EnrichLayer key — add one in Settings\)/);
    assert.match(run.summary, /web: 2 queries → 50 profiles/);
    assert.strictEqual(run.found, 3);
  } finally {
    origPrepare('DELETE FROM hiring_runs WHERE role_id = ?').run(roleId);
    origPrepare('DELETE FROM hiring_roles WHERE id = ?').run(roleId);
  }
});
