'use strict';
// ══════════════════════════════════════════════════════════════════════════
// roleIngest — a JD becomes a structured role. The failure to protect against is
// an INVENTED requirement: a role that silently narrows the shortlist against a
// must-have the JD never stated. So these tests pin the deterministic guards
// (coercion + text extraction). The LLM parse itself is grounded at temp 0 and
// verified live; here we lock the plumbing around it.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const { coerceRole, extractJdText, ROLE_FUNCTIONS } = require('../lib/roleIngest');

test('coerceRole: an out-of-taxonomy function falls back to "other", never guessed', () => {
  const r = coerceRole({ role_function: 'Backend', title: 'X' });
  assert.strictEqual(r.role_function, 'other');
  const ok = coerceRole({ role_function: 'engineering', title: 'X' });
  assert.strictEqual(ok.role_function, 'engineering');
  assert.ok(ROLE_FUNCTIONS.includes(r.role_function));
});

test('coerceRole: blanks stay blank — "null"/"n/a"/empty never become a value', () => {
  const r = coerceRole({ title: 'null', seniority: 'N/A', domain: '', comp_note: 'null', location_pref: undefined });
  assert.strictEqual(r.title, null);
  assert.strictEqual(r.seniority, null);
  assert.strictEqual(r.domain, null);
  assert.strictEqual(r.comp_note, null);
  assert.strictEqual(r.location_pref, null);
});

test('coerceRole: array fields tolerate junk and drop empties', () => {
  const r = coerceRole({ must_have_stack: ['Python', '', '  ', 'Postgres'], nice_to_have_stack: 'null', must_haves: null });
  assert.deepStrictEqual(r.must_have_stack, ['Python', 'Postgres']);
  assert.deepStrictEqual(r.nice_to_have_stack, []); // a non-array becomes []
  assert.deepStrictEqual(r.must_haves, []);
});

test('coerceRole: remote_ok is 1 unless explicitly false', () => {
  assert.strictEqual(coerceRole({ role_function: 'engineering' }).remote_ok, 1);
  assert.strictEqual(coerceRole({ role_function: 'engineering', remote_ok: false }).remote_ok, 0);
  assert.strictEqual(coerceRole({ role_function: 'engineering', remote_ok: true }).remote_ok, 1);
});

test('extractJdText: a typed sentence is its own JD text, no network', async () => {
  const r = await extractJdText({ jdSource: 'sentence', text: 'Need a founding backend eng for Hale, Chicago.', userId: 1 });
  assert.strictEqual(r.jd_source, 'sentence');
  assert.match(r.text, /founding backend/i);
  assert.strictEqual(r.jd_ref, null);
});

test('extractJdText: nothing provided fails loudly rather than inventing a role', async () => {
  const r = await extractJdText({ jdSource: 'sentence', text: '   ', userId: 1 });
  assert.ok(r.error, 'empty input should error');
});

test('extractJdText: a LinkedIn URL is refused (crawlers get a login wall)', async () => {
  const r = await extractJdText({ jdSource: 'url', url: 'https://www.linkedin.com/jobs/view/123', userId: 1, deps: { exaKey: 'x' } });
  assert.ok(r.error && /LinkedIn/i.test(r.error));
});
