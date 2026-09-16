'use strict';
// Founding-seat cap — the $349 / 10-seat offer.
//
// The cap is a promise ("one of ten"), so the tests pin the places it is
// enforced:
//   - the exported constants ($349, 10 seats);
//   - reserveSeat(): atomic, idempotent, refuses the 11th buyer BEFORE Stripe;
//   - expired reservations free the seat (abandoned checkouts don't wedge the cap);
//   - the webhook claims the reservation, stays idempotent, and refuses to mark
//     paid when over cap (Stripe has already taken the money by webhook time —
//     over cap we must NOT mark paid, so Danny refunds instead of silently
//     selling an 11th seat).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const payments = require('../routes/payments');
const { seatsClaimed, seatsRemaining, reserveSeat, FOUNDING_SEATS, PRICE_CENTS, webhook } = payments;
const { generateToken } = require('../auth');

const TAG = 'TEST::seat-';
let app, server, base;
let buyerIds = [];

function fakeStripe() {
  return {
    checkout: { sessions: { create: async () => ({ id: 'cs_test_x', url: 'https://checkout.stripe.test/cs_x' }) } },
    webhooks: {
      constructEvent: (body, sig, secret) => JSON.parse(body.toString()),
    },
  };
}

before(async () => {
  // Stub the stripe module before the router's getStripe() can require it.
  const resolved = require.resolve('stripe');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: () => fakeStripe() };
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';

  app = express();
  app.use('/api/payments', payments.router);
  app.post('/api/payments/webhook', express.raw({ type: '*/*' }), webhook);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/payments`;
});

after(() => {
  db.prepare(`DELETE FROM founding_seats WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}%')`).run();
  db.prepare(`DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}%')`).run();
  db.prepare(`DELETE FROM users WHERE email LIKE '${TAG}%'`).run();
  server.close();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

function makeUser(i, paid) {
  const email = `${TAG}${i}@t.t`;
  const r = db.prepare("INSERT INTO users (email, name, role, password_hash, has_paid) VALUES (?, ?, 'member', ?, ?)")
    .run(email, `Seat Test ${i}`, bcrypt.hashSync('x', 4), paid ? 1 : 0);
  return r.lastInsertRowid;
}

const post = (p, uid, body) => {
  const u = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(uid);
  return fetch(base + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + generateToken(u),
    },
    body: JSON.stringify(body || {}),
  });
};

test('constants: $349 one-time, 10 seats', () => {
  assert.equal(PRICE_CENTS, 34900);
  assert.equal(FOUNDING_SEATS, 10);
});

test('reserveSeat: atomic, idempotent, counts toward the cap', () => {
  const a = makeUser('a', false);
  const b = makeUser('b', false);
  buyerIds.push(a, b);

  const s1 = reserveSeat(a);
  assert.ok(s1 && s1.status === 'reserved');
  // Re-reserving returns the SAME seat — no double-count.
  const s1b = reserveSeat(a);
  assert.equal(s1b.id, s1.id);
  assert.equal(seatsRemaining(), FOUNDING_SEATS - 1);

  const s2 = reserveSeat(b);
  assert.ok(s2.id !== s1.id);
  assert.equal(seatsRemaining(), FOUNDING_SEATS - 2);
});

test('checkout refuses the 11th buyer before Stripe is touched', async () => {
  // Fill every remaining seat with reservations.
  const need = seatsRemaining();
  const fillers = [];
  for (let i = 0; i < need; i++) fillers.push(makeUser(`fill${i}`, false));
  buyerIds.push(...fillers);
  for (const f of fillers) reserveSeat(f);
  assert.equal(seatsRemaining(), 0);

  const late = makeUser('late', false);
  buyerIds.push(late);
  const res = await post('/create-checkout-session', late);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'sold_out');
  // No seat row was created for the refused buyer.
  const row = db.prepare('SELECT * FROM founding_seats WHERE user_id = ?').get(late);
  assert.equal(row, undefined);
});

test('expired reservations free the seat', () => {
  // Backdate one filler's reservation past expiry (not user a's — the webhook
  // test below needs a's reservation live); the next reserveSeat call must
  // release it and hand the seat to the waiter.
  const victim = db.prepare(
    `SELECT id, user_id FROM founding_seats
     WHERE status = 'reserved' AND user_id = (SELECT id FROM users WHERE email = '${TAG}fill0@t.t')`
  ).get();
  db.prepare(`UPDATE founding_seats SET expires_at = datetime('now', '-1 hour') WHERE id = ?`)
    .run(victim.id);
  const waiter = makeUser('waiter', false);
  buyerIds.push(waiter);
  const s = reserveSeat(waiter);
  assert.ok(s, 'a seat freed up');
  const v = db.prepare('SELECT status FROM founding_seats WHERE id = ?').get(victim.id);
  assert.equal(v.status, 'released');
});

test('webhook claims the reservation and is idempotent', async () => {
  const a = db.prepare(`SELECT id FROM users WHERE email = '${TAG}a@t.t'`).get().id;
  const seat = db.prepare(`SELECT * FROM founding_seats WHERE user_id = ?`).get(a);
  const res = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
    body: JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_claim1', customer: 'cus_x', metadata: { user_id: String(a), seat_id: String(seat.id) } } },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT has_paid FROM users WHERE id = ?').get(a).has_paid, 1);
  assert.equal(db.prepare('SELECT status FROM founding_seats WHERE id = ?').get(seat.id).status, 'claimed');
  assert.equal(seatsClaimed(), 1);

  // Stripe retries the webhook — must not double-claim or error.
  const res2 = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
    body: JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_claim1', customer: 'cus_x', metadata: { user_id: String(a), seat_id: String(seat.id) } } },
    }),
  });
  assert.equal(res2.status, 200);
  assert.equal(seatsClaimed(), 1);
});

test('webhook: over-cap payment is NOT marked paid (refund path)', async () => {
  // Simulate the pathological case: 10 seats already claimed by others, and a
  // payment arrives for a user with no live reservation (lapsed).
  db.prepare(`UPDATE founding_seats SET status = 'claimed', claimed_at = datetime('now') WHERE status = 'reserved'`).run();
  assert.equal(seatsClaimed(), FOUNDING_SEATS);

  const over = makeUser('over', false);
  buyerIds.push(over);
  const res = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
    body: JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_overcap', customer: 'cus_x', metadata: { user_id: String(over) } } },
    }),
  });
  assert.equal(res.status, 200); // Stripe gets 200 so it doesn't retry
  const u = db.prepare('SELECT has_paid FROM users WHERE id = ?').get(over);
  assert.equal(u.has_paid, 0, 'over-cap buyer must NOT be marked paid');
});
