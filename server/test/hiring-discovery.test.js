'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Cold discovery is the founder-sourcing engine with its founder gate REMOVED —
// that removal is the whole point, so it's the thing to pin: an employed senior
// engineer with a verified IL tie and public work is KEPT (they'd be dropped by
// github-source's "building" gate). And the IL tie stays a HARD gate — a strong
// builder with no Illinois evidence is never a cold hiring candidate.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const { buildQueries, roleLanguages, topLanguages, assessForHiring } = require('../pipeline/hiring-discovery');

test('roleLanguages maps stack to GitHub languages, dedups, ignores frameworks', () => {
  const langs = roleLanguages({ must_have_stack: JSON.stringify(['Python', 'Postgres', 'node.js']), nice_to_have_stack: JSON.stringify(['JavaScript', 'AWS']) });
  assert.ok(langs.includes('Python'));
  assert.ok(langs.includes('JavaScript')); // node.js + JavaScript collapse to one
  assert.strictEqual(langs.filter((l) => l === 'JavaScript').length, 1);
  assert.ok(!langs.includes('Postgres')); // a datastore is not a language qualifier
});

test('buildQueries crosses IL locations with role languages, capped', () => {
  const qs = buildQueries({ must_have_stack: JSON.stringify(['Python']) }, { maxQueries: 5 });
  assert.ok(qs.length <= 5);
  assert.ok(qs.every((q) => /location:/.test(q) && /type:user/.test(q)));
  assert.ok(qs.some((q) => /language:Python/.test(q)));
  // No known language → location-only queries, no language: qualifier.
  const generic = buildQueries({ must_have_stack: JSON.stringify(['Postgres']) }, { maxQueries: 3 });
  assert.ok(generic.every((q) => !/language:/.test(q)));
});

test('topLanguages tallies repo languages, ignoring forks and language-less repos', () => {
  const repos = [
    { language: 'Python', fork: false }, { language: 'Python', fork: false },
    { language: 'Go', fork: false }, { language: 'JavaScript', fork: true }, { language: null, fork: false },
  ];
  assert.deepStrictEqual(topLanguages(repos), ['Python', 'Go']);
});

test('assessForHiring KEEPS an employed IL engineer with no founder/building signal', async () => {
  const role = { role_function: 'engineering', must_have_stack: JSON.stringify(['Python']) };
  const deps = {
    ghGet: async (path) => {
      if (/\/users\/janedev$/.test(path)) return { data: { login: 'janedev', name: 'Jane Dev', location: 'Chicago, IL', company: 'Citadel Securities', bio: 'Senior software engineer. UChicago CS.', public_repos: 20, followers: 40, blog: '' } };
      if (/\/repos/.test(path)) return { data: [{ language: 'Python', fork: false }, { language: 'Python', fork: false }, { language: 'Go', fork: false }] };
      return { data: null };
    },
    computeGithubSlope: async () => ({ slope_score: 4, data: { login: 'janedev', top_repo: { name: 'x', stars: 30 } }, evidence: 'x: 30★' }),
  };
  const a = await assessForHiring('janedev', role, 't', deps);
  assert.ok(a.row, 'employed engineer kept (no founder gate)');
  assert.strictEqual(a.row.tier, 'cold');
  assert.strictEqual(a.row.il_tie_type, 'current'); // "Chicago, IL"
  assert.deepStrictEqual(JSON.parse(a.row.tech_stack), ['Python', 'Go']);
  assert.strictEqual(a.row.source, 'github_builders');
});

test('assessForHiring DROPS a strong builder with no Illinois tie (hard gate)', async () => {
  const role = { role_function: 'engineering', must_have_stack: JSON.stringify(['Python']) };
  const deps = {
    ghGet: async (path) => {
      if (/\/users\/sfdev$/.test(path)) return { data: { login: 'sfdev', name: 'SF Dev', location: 'San Francisco, CA', company: 'Stripe', bio: 'Staff engineer', public_repos: 50 } };
      if (/\/repos/.test(path)) return { data: [{ language: 'Python', fork: false }] };
      return { data: null };
    },
    computeGithubSlope: async () => ({ slope_score: 9, data: {}, evidence: 'strong' }),
  };
  const a = await assessForHiring('sfdev', role, 't', deps);
  assert.ok(a.skip && /IL tie/i.test(a.skip), 'no Illinois evidence → dropped');
});
