// The Gmail transport must connect to an IPv4 literal, with SNI preserved.
//
// This regressed once already: `family: 4` looked like a fix, read like a fix in review,
// and was silently ignored by nodemailer — production sent zero email for days while
// every code path looked correct. These tests assert the two properties that actually
// matter at the socket, so the no-op version can't come back.
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const Module = require('module');

const smtp = require('../services/smtp');

// Intercept `require('nodemailer')` from inside services/smtp.js so we can inspect the
// options it builds without opening a connection.
function withStubbedNodemailer(fn) {
  const orig = Module.prototype.require;
  let captured = null;
  Module.prototype.require = function (id) {
    if (id === 'nodemailer') {
      return { createTransport: (opts) => { captured = opts; return { sendMail: async () => ({}) }; } };
    }
    return orig.apply(this, arguments);
  };
  return fn().then(
    (r) => { Module.prototype.require = orig; return { captured, result: r }; },
    (e) => { Module.prototype.require = orig; throw e; }
  );
}

test('transport connects to an IPv4 literal, not a hostname', async () => {
  smtp._resetCache();
  const { captured } = await withStubbedNodemailer(() =>
    smtp.createTransport({ address: 'a@b.com', appPassword: 'pw' }));

  assert.equal(net.isIP(captured.host), 4,
    `host must be an IPv4 literal so nodemailer's resolver is bypassed, got ${captured.host}`);
  assert.equal(captured.port, 465);
  assert.equal(captured.secure, true);
});

test('SNI servername is set, because the host is a bare IP', async () => {
  smtp._resetCache();
  const { captured } = await withStubbedNodemailer(() =>
    smtp.createTransport({ address: 'a@b.com', appPassword: 'pw' }));

  // Without this the TLS cert is validated against an IP and every send fails.
  assert.equal(captured.tls && captured.tls.servername, 'smtp.gmail.com');
});

test('credentials are passed through', async () => {
  smtp._resetCache();
  const { captured } = await withStubbedNodemailer(() =>
    smtp.createTransport({ address: 'danny@example.com', appPassword: 'app-pw' }));

  assert.equal(captured.auth.user, 'danny@example.com');
  assert.equal(captured.auth.pass, 'app-pw');
});

test('neither digest reintroduces the family:4 no-op', () => {
  const fs = require('fs');
  for (const f of ['../services/email-digest.js', '../services/founder-digest.js']) {
    // Strip comments first — the fix is *documented* in both files, and the docs
    // naturally quote the thing they're warning about.
    const src = fs.readFileSync(require.resolve(f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/family:\s*4/.test(src),
      `${f} sets family:4 — nodemailer ignores it; use services/smtp.js instead`);
    assert.ok(!/createTransport\(\{[\s\S]{0,200}smtp\.gmail\.com/.test(src),
      `${f} builds its own Gmail transport; it must go through services/smtp.js`);
  }
});
