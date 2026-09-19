'use strict';
// Paywall middleware — requirePaid fails CLOSED for authenticated users.
//
// requirePaid sits in front of /api; it only knows about req.user, so:
//   · no req.user (no JWT) → passes through to requireAuth, which 401s;
//   · req.user with has_paid → next();
//   · req.user without has_paid → 402, never the route.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requirePaid, mcpScopeFor, denyMcpToken, denyMcpRest } = require('../auth');

const TAG = 'TEST::paywall-';
let unpaidId;

before(() => {
  const r = db.prepare("INSERT INTO users (email, name, role, password_hash, has_paid) VALUES (?, 'Paywall Unpaid', 'member', ?, 0)")
    .run(`${TAG}@t.t`, bcrypt.hashSync('x', 4));
  unpaidId = r.lastInsertRowid;
});

after(() => {
  db.prepare('DELETE FROM users WHERE id = ?').run(unpaidId);
});

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ next: false, res: this }); return this; },
    };
    mw(req, res, () => resolve({ next: true, res }));
  });
}

test('unpaid authenticated user gets 402', async () => {
  // requirePaid re-reads has_paid from the DB — it never trusts the claim on req.user.
  const r = await run(requirePaid, { user: { id: unpaidId, has_paid: 1 } });
  assert.equal(r.next, false);
  assert.equal(r.res.statusCode, 402);
  assert.match(r.res.body.error, /active Stu account/i);
});

test('paid authenticated user passes through', async () => {
  const r = await run(requirePaid, { user: { id: 1, has_paid: 0 } });
  assert.equal(r.next, true);
});

test('unauthenticated request passes through (requireAuth 401s downstream)', async () => {
  const r = await run(requirePaid, {});
  assert.equal(r.next, true);
});

test('mcpScopeFor: token with the read scope passes GET, fails writes outside scope', async () => {
  const mw = mcpScopeFor('sourcing');
  const reader = await run(mw, { method: 'GET', apiTokenId: 1, tokenScopes: ['sourcing:read'] });
  assert.equal(reader.next, true);
  // sourcing tokens may NOT write via REST (writes go through the MCP protocol endpoint)
  const writer = await run(mw, { method: 'POST', apiTokenId: 1, tokenScopes: ['sourcing:read', 'sourcing:write'] });
  assert.equal(writer.next, false);
  assert.equal(writer.res.statusCode, 403);
  // web sessions pass through untouched
  const web = await run(mw, { method: 'POST', user: { id: 1 } });
  assert.equal(web.next, true);
});

test('denyMcpToken 403s MCP tokens, lets humans through', async () => {
  const blocked = await run(denyMcpToken, { user: { id: 1 }, apiTokenId: 1 });
  assert.equal(blocked.next, false);
  assert.equal(blocked.res.statusCode, 403);
  const allowed = await run(denyMcpToken, { user: { id: 1 } });
  assert.equal(allowed.next, true);
});

test('denyMcpRest 403s MCP tokens on unscoped REST, lets web sessions through', async () => {
  const blocked = await run(denyMcpRest, { user: { id: 1 }, apiTokenId: 9 });
  assert.equal(blocked.next, false);
  assert.equal(blocked.res.statusCode, 403);
  const allowed = await run(denyMcpRest, { user: { id: 1 } });
  assert.equal(allowed.next, true);
});
