const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return require('stripe')(key);
}

const APP_URL = process.env.APP_URL || 'https://www.stu.vc';
const PRICE_CENTS = 34900; // $349.00 — founding seat, one-time
const FOUNDING_SEATS = 10;
const PRODUCT_NAME = 'Stu — Founding Seat';
// How long a buyer gets to finish Stripe checkout before the seat goes back
// in the pool. Matches the Stripe session expiry set at checkout time.
const RESERVATION_TTL_MIN = 30;

// Run fn inside a write transaction that takes the lock UP FRONT. better-sqlite3's
// db.transaction() is DEFERRED — two concurrent checkouts could both read "9
// claimed" before either writes. BEGIN IMMEDIATE serializes them: the second
// blocks until the first commits, then sees the true count. This is what makes
// "one of ten" a promise instead of a hope.
function immediate(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

function releaseExpiredSeats() {
  db.prepare(
    `UPDATE founding_seats SET status = 'released'
     WHERE status = 'reserved' AND expires_at <= datetime('now')`
  ).run();
}

// Seats currently held: claimed (paid) + live reservations. The cap counts both —
// a reservation IS a seat spoken for until it lapses.
function activeSeatCount() {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM founding_seats WHERE status IN ('reserved', 'claimed')`
  ).get();
  return row ? row.c : 0;
}

// Seats paid for — the public "X of 10 claimed" counter.
function seatsClaimed() {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM founding_seats WHERE status = 'claimed'`
  ).get();
  return row ? row.c : 0;
}

function seatsRemaining() {
  return Math.max(0, FOUNDING_SEATS - activeSeatCount());
}

/**
 * Atomically reserve one of the ten seats for a user. Returns the seat row,
 * or null when every seat is spoken for.
 *
 * Idempotent: a user who already holds a live reservation (or a claimed seat)
 * gets it back — re-clicking "buy" after a Stripe hiccup must not eat a second
 * seat, and must not 403 a buyer who already paid.
 */
function reserveSeat(userId) {
  return immediate(() => {
    releaseExpiredSeats();
    const existing = db.prepare(
      `SELECT * FROM founding_seats WHERE user_id = ? AND status IN ('reserved', 'claimed')`
    ).get(userId);
    if (existing) return existing;
    if (activeSeatCount() >= FOUNDING_SEATS) return null;
    // A lapsed reservation leaves a 'released' row behind, and user_id is
    // UNIQUE — flip that row back to 'reserved' instead of INSERTing a second
    // one (bare INSERT throws SQLITE_CONSTRAINT_UNIQUE and locks the buyer out
    // of ever retrying after expiry).
    const stale = db.prepare(
      `SELECT id FROM founding_seats WHERE user_id = ? AND status = 'released'`
    ).get(userId);
    if (stale) {
      db.prepare(
        `UPDATE founding_seats SET status = 'reserved', expires_at = datetime('now', ?),
         stripe_session_id = NULL WHERE id = ?`
      ).run(`+${RESERVATION_TTL_MIN} minutes`, stale.id);
      return db.prepare('SELECT * FROM founding_seats WHERE id = ?').get(stale.id);
    }
    const r = db.prepare(
      `INSERT INTO founding_seats (user_id, status, expires_at)
       VALUES (?, 'reserved', datetime('now', ?))`
    ).run(userId, `+${RESERVATION_TTL_MIN} minutes`);
    return db.prepare('SELECT * FROM founding_seats WHERE id = ?').get(r.lastInsertRowid);
  });
}

function releaseSeat(seatId) {
  db.prepare(
    `UPDATE founding_seats SET status = 'released' WHERE id = ? AND status = 'reserved'`
  ).run(seatId);
}

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const user = db.prepare('SELECT id, email, has_paid FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Unknown user' });
  if (user.has_paid) return res.json({ already_paid: true });

  // Reserve BEFORE touching Stripe — the 11th buyer gets 403 here and is never
  // charged. Without this, two buyers racing for the last seat could both pay.
  const seat = reserveSeat(user.id);
  if (!seat) {
    return res.status(403).json({ error: 'All 10 founding seats are claimed.', code: 'sold_out' });
  }
  if (seat.status === 'claimed') return res.json({ already_paid: true });

  try {
    // Prefer a configured Stripe Price (STRIPE_FOUNDING_PRICE_ID); otherwise
    // build the $349 one-time price inline.
    const lineItem = process.env.STRIPE_FOUNDING_PRICE_ID
      ? { price: process.env.STRIPE_FOUNDING_PRICE_ID, quantity: 1 }
      : {
          price_data: {
            currency: 'usd',
            product_data: {
              name: PRODUCT_NAME,
              description: `Founding seat — pay once, use Stu forever. Bring your own API keys.`,
            },
            unit_amount: PRICE_CENTS,
          },
          quantity: 1,
        };
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      line_items: [lineItem],
      metadata: {
        user_id: String(user.id),
        seat_id: String(seat.id),
      },
      // The reservation lapses after 30 minutes; the Stripe session lapses with
      // it, so nobody can pay for a seat that has already gone back in the pool.
      allow_promotion_codes: true,
      expires_at: Math.floor(Date.now() / 1000) + RESERVATION_TTL_MIN * 60,
      success_url: `${APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/payment`,
    });

    db.prepare('UPDATE founding_seats SET stripe_session_id = ? WHERE id = ?')
      .run(session.id, seat.id);
    res.json({ url: session.url });
  } catch (err) {
    // Stripe is down or the session failed — don't hold the seat hostage.
    releaseSeat(seat.id);
    console.error('[Payments] Checkout session error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/payments/status
router.get('/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT has_paid, payment_date FROM users WHERE id = ?').get(req.user.id);
  const paid = !!user?.has_paid;
  let seat_number = null;
  if (paid) {
    // 1-based seat number by claim order.
    const seat = db.prepare(
      `SELECT id, claimed_at FROM founding_seats WHERE user_id = ? AND status = 'claimed'`
    ).get(req.user.id);
    if (seat) {
      const earlier = db.prepare(
        `SELECT COUNT(*) AS c FROM founding_seats
         WHERE status = 'claimed' AND (claimed_at < ? OR (claimed_at = ? AND id < ?))`
      ).get(seat.claimed_at, seat.claimed_at, seat.id);
      seat_number = (earlier ? earlier.c : 0) + 1;
    }
  }
  res.json({
    has_paid: paid,
    payment_date: user?.payment_date || null,
    seat_number,
    seats_claimed: seatsClaimed(),
    seats_total: FOUNDING_SEATS,
  });
});

// GET /api/payments/seats — availability for the paywall page.
router.get('/seats', requireAuth, (req, res) => {
  res.json({ claimed: seatsClaimed(), total: FOUNDING_SEATS, remaining: seatsRemaining() });
});

// Webhook handler — exported separately, mounted with raw body parser
async function webhook(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(503).send('Payments not configured');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[Payments] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Payments] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata?.user_id, 10);
    const seatId = parseInt(session.metadata?.seat_id, 10);
    const customerId = session.customer;

    if (!userId) {
      console.error('[Payments] Webhook missing user_id in metadata:', session.id);
    } else {
      // Claim inside a write transaction. Stripe has ALREADY taken the money by
      // the time this runs; the reservation made at checkout is what keeps an
      // 11th buyer from being charged in the first place. The over-cap guard
      // below is the backstop for the pathological case (reservation lapsed
      // before the webhook arrived and someone else took the seat): in that
      // case we do NOT mark paid — Danny refunds instead of silently selling
      // an 11th seat.
      const outcome = immediate(() => {
        releaseExpiredSeats();
        const u = db.prepare('SELECT has_paid FROM users WHERE id = ?').get(userId);
        if (!u) return 'no_user';
        if (u.has_paid) return 'already_paid'; // idempotent — Stripe retries webhooks

        let seat = seatId
          ? db.prepare('SELECT * FROM founding_seats WHERE id = ?').get(seatId)
          : db.prepare(
              `SELECT * FROM founding_seats WHERE user_id = ? AND status IN ('reserved','claimed')
               ORDER BY id DESC`
            ).get(userId);

        if (seat && seat.status === 'claimed') return 'already_paid';
        if (seat && seat.user_id !== userId) seat = null; // never claim someone else's seat

        // Seats held by everyone else right now.
        const others = db.prepare(
          `SELECT COUNT(*) AS c FROM founding_seats
           WHERE status IN ('reserved','claimed') AND id != ?`
        ).get(seat ? seat.id : -1).c;

        if (seat && seat.status === 'reserved') {
          if (others >= FOUNDING_SEATS) {
            releaseSeat(seat.id);
            return 'sold_out';
          }
          db.prepare(
            `UPDATE founding_seats SET status = 'claimed', claimed_at = datetime('now'),
             stripe_session_id = ? WHERE id = ?`
          ).run(session.id, seat.id);
        } else {
          // No live reservation (old session or lapsed) — claim only if a seat
          // is genuinely free. A lapsed reservation leaves a 'released' row
          // behind and user_id is UNIQUE, so flip that row to 'claimed' instead
          // of INSERTing: a bare INSERT throws SQLITE_CONSTRAINT_UNIQUE, the
          // transaction rolls back, Stripe never gets its 200, and a buyer who
          // already paid is never marked paid.
          if (others >= FOUNDING_SEATS) return 'sold_out';
          const stale = db.prepare(
            `SELECT id FROM founding_seats WHERE user_id = ? AND status = 'released'`
          ).get(userId);
          if (stale) {
            db.prepare(
              `UPDATE founding_seats SET status = 'claimed', claimed_at = datetime('now'),
               stripe_session_id = ? WHERE id = ?`
            ).run(session.id, stale.id);
          } else {
            db.prepare(
              `INSERT INTO founding_seats (user_id, status, stripe_session_id, claimed_at)
               VALUES (?, 'claimed', ?, datetime('now'))`
            ).run(userId, session.id);
          }
        }
        db.prepare(
          `UPDATE users SET has_paid = 1, stripe_customer_id = ?, payment_date = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(customerId || null, userId);
        return 'paid';
      });

      if (outcome === 'paid') {
        console.log(
          `[Payments] User ${userId} payment confirmed — founding seat ${seatsClaimed()} of ${FOUNDING_SEATS} (session: ${session.id})`
        );
      } else if (outcome === 'sold_out') {
        console.error(
          `[Payments] OVER-CAP payment for user ${userId} (session: ${session.id}) — NOT marked paid, refund manually.`
        );
      } else {
        console.error(`[Payments] Webhook ${outcome} for user ${userId} (session: ${session.id})`);
      }
    }
  }

  res.json({ received: true });
}

module.exports = { router, webhook, seatsClaimed, seatsRemaining, reserveSeat, FOUNDING_SEATS, PRICE_CENTS };
