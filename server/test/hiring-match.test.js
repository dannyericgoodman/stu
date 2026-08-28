'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The matcher's promises, pinned:
//   · warm-first — a warm fit outranks an EQUAL/near-equal cold fit, but a much
//     stronger cold match still beats a weak warm one (bonus, not tier dominance).
//   · never pair an eng role with a GTM person (hard function mismatch is dropped).
//   · IL-only is a hard filter; otherwise a verified tie is a soft boost.
//   · strengths/gaps are grounded facts (matched stack, stated missing stack).
//   · re-running a role refreshes scores but PRESERVES the handoff status — a
//     re-match must never reset where Danny moved a candidate.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const { rankCandidates, computeFit, isDescribable, runMatch } = require('../pipeline/hiring-match');

const engRole = { role_function: 'engineering', title: 'Founding Backend Engineer', seniority: 'senior', domain: 'healthcare', must_have_stack: ['Python', 'Postgres'], nice_to_have_stack: ['AWS'], il_only: 0 };
const cand = (o) => ({ role_function: '["engineering"]', tier: 'cold', ...o });

test('a GTM person is never returned for an engineering role', () => {
  const pool = [cand({ id: 1, name: 'Eng', headline: 'Python Postgres backend' }), { id: 2, name: 'Sales', tier: 'warm', role_function: '["gtm"]', headline: 'Head of Sales' }];
  const ranked = rankCandidates(engRole, pool);
  assert.ok(!ranked.find((r) => r.candidate.id === 2), 'GTM filtered');
  assert.ok(ranked.find((r) => r.candidate.id === 1), 'eng kept');
});

// ══════════════════════════════════════════════════════════════════════════
// This test used to assert the OPPOSITE — that "a qualifying warm contact still
// outranks a strong cold one" — because warmth was a flat +1,000 offset.
//
// Measured against Danny's real data, that rule put six Permute Hackathon attendees
// with empty role/company/city (fit 43-52) above Ezekiel Chow — Founding Full Stack
// Engineer, stealth, Chicago, React + Node + Postgres, fit 82 — for Hale's founding
// engineer role. His whole warm pool is 16 people from one event, so the "tier" was
// an attendance list outranking the JD.
//
// The intent survives and is what's asserted now: an EQUAL cold match loses to
// someone he knows. That is what "warm wins" should ever have meant.
// ══════════════════════════════════════════════════════════════════════════
test('warm is a BONUS: it wins ties and near-ties, it does not erase a fit gap', () => {
  // Identical profiles, one warm. The ONLY difference is the relationship.
  const bio = 'Senior Python Postgres backend, healthcare';
  const tie = [
    cand({ id: 1, name: 'WarmTwin', tier: 'warm', headline: bio }),
    cand({ id: 2, name: 'ColdTwin', headline: bio }),
  ];
  const tied = rankCandidates(engRole, tie);
  assert.strictEqual(tied[0].candidate.id, 1, 'at equal fit, the warm contact leads');
  assert.strictEqual(tied[0].fit, tied[1].fit, 'and they really were equal on fit');

  // A materially stronger cold candidate is NOT displaced. This is the assertion
  // that would have caught the Hale shortlist: a 12-point bonus cannot erase the
  // gap between "Python backend engineer" and a senior full-stack match.
  const gap = [
    cand({ id: 3, name: 'WarmWeaker', tier: 'warm', headline: 'Python backend engineer' }),
    cand({ id: 4, name: 'ColdStrong', headline: 'Senior Python Postgres AWS backend healthcare', github_slope_score: 9 }),
  ];
  const ranked = rankCandidates(engRole, gap);
  assert.strictEqual(ranked[0].candidate.id, 4, 'a clearly better cold candidate outranks a weaker warm one');
  assert.ok(ranked[0].fit - ranked[1].fit > 12, 'and the gap really was larger than the warm bonus');
});

test('a candidate nobody can describe is never shortlisted', () => {
  // The six warm names at the top of Hale's real shortlist had no role, no company
  // and no headline. The export renders "**1. Name** — role @ company · why", so the
  // founder received a bare name. A lead you cannot describe is not a lead.
  const nameOnly = cand({ id: 9, name: 'Just A Name', tier: 'warm', headline: '', current_role: '', current_company: '' });
  const ranked = rankCandidates(engRole, [nameOnly]);
  assert.strictEqual(ranked.length, 0, 'dropped from the shortlist');
  // ...but only from the SHORTLIST. It stays in the pool for enrichment to fill in.
  assert.strictEqual(isDescribable(nameOnly), false);
  assert.strictEqual(isDescribable(cand({ name: 'X', headline: 'CTO/Full Stack, UChicago MS' })), true,
    'a one-line bio IS describable — that is what most warm rows have');
});

test('an unreadable profile scores stack as UNKNOWN, not as missing', () => {
  // A 3,000-char scraped profile with no "Postgres" is evidence. A 60-char bio is not.
  // Scoring both as 0/30 is what buried every warm contact Danny actually knows.
  const thin = computeFit(engRole, cand({ name: 'Thin', headline: 'CTO/Full Stack' }));
  const thick = computeFit(engRole, cand({
    name: 'Thick',
    headline: 'Senior engineer'.padEnd(260, ' building distributed services and internal tooling'),
  }));
  assert.ok(thin.gaps.some((g) => /not evidenced/i.test(g)), 'the uncertainty is stated, not hidden');
  assert.ok(thin.fit > thick.fit, 'unknown beats a profile long enough to have shown the stack and did not');
});

test('IL-only is a hard filter', () => {
  const pool = [cand({ id: 1, name: 'IL', headline: 'Python Postgres', il_tie_type: 'current' }), cand({ id: 2, name: 'noIL', headline: 'Python Postgres' })];
  const ranked = rankCandidates({ ...engRole, il_only: 1 }, pool);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].candidate.id, 1);
});

test('gaps state the missing stack, never guess it', () => {
  const f = computeFit(engRole, cand({ name: 'Partial', headline: 'Python backend engineer' })); // has Python, not Postgres
  assert.ok(f.strengths.some((s) => /Python/.test(s)));
  assert.ok(f.gaps.some((g) => /Postgres/i.test(g)), 'missing Postgres stated as a gap');
});

test('end-to-end runMatch persists a shortlist and preserves handoff status on re-run', async () => {
  // FK-safe: hiring_* rows reference users(id), so we use the seeded owner (id=1) and
  // clean up only the exact rows we create — never touching real hiring data.
  const uid = 1;
  const roleId = db.prepare(`INSERT INTO hiring_roles (user_id, title, role_function, must_have_stack, status) VALUES (?, '__TEST Backend Eng', 'engineering', ?, 'open')`).run(uid, JSON.stringify(['Python', 'Postgres'])).lastInsertRowid;
  const c1 = db.prepare(`INSERT INTO hiring_candidates (user_id, name, headline, role_function, tier, warm_source, il_tie_type) VALUES (?, '__TEST Warm Eng', 'Senior Python Postgres backend', '["engineering"]', 'warm', 'Permute Hackathon', 'school')`).run(uid).lastInsertRowid;
  const c2 = db.prepare(`INSERT INTO hiring_candidates (user_id, name, headline, role_function, tier, github_slope_score) VALUES (?, '__TEST Cold Eng', 'Python Postgres backend', '["engineering"]', 'cold', 7)`).run(uid).lastInsertRowid;
  const cleanup = () => {
    // Delete children before the role — hiring_runs and hiring_matches both FK role_id.
    db.prepare('DELETE FROM hiring_matches WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM hiring_runs WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM hiring_candidates WHERE id IN (?, ?)').run(c1, c2);
    db.prepare('DELETE FROM hiring_roles WHERE id = ?').run(roleId);
  };

  try {
    const r1 = await runMatch({ userId: uid, roleId, explain: false });
    assert.ok(r1.shortlisted >= 2, 'both eng candidates shortlisted');
    assert.strictEqual(r1.shortlist[0].tier, 'warm', 'warm ranked first');
    const m1 = db.prepare('SELECT status FROM hiring_matches WHERE role_id = ? AND candidate_id = ?').get(roleId, c1);
    assert.strictEqual(m1.status, 'sourced', 'new match starts sourced');

    // Move the warm candidate down the pipeline, then re-run.
    db.prepare('UPDATE hiring_matches SET status = ? WHERE role_id = ? AND candidate_id = ?').run('shared', roleId, c1);
    await runMatch({ userId: uid, roleId, explain: false });
    const m2 = db.prepare('SELECT status FROM hiring_matches WHERE role_id = ? AND candidate_id = ?').get(roleId, c1);
    assert.strictEqual(m2.status, 'shared', 're-match preserved the handoff status');
  } finally {
    cleanup();
  }
});
