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
const { rankCandidates, computeFit, runMatch } = require('../pipeline/hiring-match');

const engRole = { role_function: 'engineering', title: 'Founding Backend Engineer', seniority: 'senior', domain: 'healthcare', must_have_stack: ['Python', 'Postgres'], nice_to_have_stack: ['AWS'], il_only: 0 };
const cand = (o) => ({ role_function: '["engineering"]', tier: 'cold', ...o });

test('a GTM person is never returned for an engineering role', () => {
  const pool = [cand({ id: 1, name: 'Eng', headline: 'Python Postgres backend' }), { id: 2, name: 'Sales', tier: 'warm', role_function: '["gtm"]', headline: 'Head of Sales' }];
  const ranked = rankCandidates(engRole, pool);
  assert.ok(!ranked.find((r) => r.candidate.id === 2), 'GTM filtered');
  assert.ok(ranked.find((r) => r.candidate.id === 1), 'eng kept');
});

test('warm is a TIER: the whole warm tier ranks above cold; fit orders within a tier', () => {
  const pool = [
    cand({ id: 1, name: 'WarmStrong', tier: 'warm', headline: 'Senior Python Postgres backend, healthcare' }),
    cand({ id: 2, name: 'ColdStrong', headline: 'Senior Python Postgres AWS backend healthcare', github_slope_score: 9 }),
    // A qualifying-but-weaker warm contact still ranks above even a strong cold one —
    // the VC's edge is a warm intro. (Below the fit floor it would be dropped entirely.)
    cand({ id: 3, name: 'WarmWeaker', tier: 'warm', headline: 'Python backend engineer' }),
  ];
  const ranked = rankCandidates(engRole, pool);
  const pos = (id) => ranked.findIndex((r) => r.candidate.id === id);
  assert.ok(pos(1) < pos(3), 'higher-fit warm leads within the warm tier');
  assert.ok(pos(3) < pos(2), 'a qualifying warm contact still outranks a strong cold one (tier)');
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
