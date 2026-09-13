'use strict';
// ══════════════════════════════════════════════════════════════════════════
// relationshipStrength.js — how well Danny actually knows someone, computed
// from message history rather than asserted.
//
// ── WHY THIS IS THE UNCOPYABLE PART ──
// Any fund can buy a contact database. The LinkedIn export carries something
// no vendor sells: 8,163 messages across 1,577 people, with direction and
// timestamps. That turns "1st-degree connection" (which means nothing — Danny
// has 2,691 of them) into a graded, evidenced answer to the only question that
// matters before an intro: will this person reply?
//
// ── DEPTH AND RECENCY ARE SEPARATE, ON PURPOSE ──
// The obvious move is one blended score with time-decay. It is wrong here, and
// the data shows why: Danny and Stephanie Krantz exchanged 226 messages, last
// in 2021. Decayed into a single number that reads as a weak relationship,
// which is false — it is a deep relationship that is cold. Those need different
// actions (a re-opener, not a cold ask), so they stay different fields.
// `warmth` measures depth. `months_since` measures neglect. The UI shows both.
//
// ── THE RECIPROCITY RULE ──
// Sent-with-no-reply is the most over-claimed relationship in any CRM. 1,335
// people here have been messaged by Danny; only 892 ever wrote back. A person
// who never replied is not a warm path no matter how many times he tried, so
// reciprocity gates the top two tiers rather than merely adding points.
// ══════════════════════════════════════════════════════════════════════════

// Tiers, strongest first. Names are what the UI prints, so they are plain.
const TIERS = ['strong', 'real', 'light', 'thin', 'name_only'];

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function monthsBetween(then, now) {
  if (!then) return null;
  const t = then instanceof Date ? then : new Date(then);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - t.getTime()) / MONTH_MS));
}

/** "May 2026" — the form a human reads in a receipt. */
function monthLabel(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Score one relationship.
 *
 * @param {object} s
 * @param {number} s.sent        messages Danny sent this person
 * @param {number} s.received    messages they sent Danny
 * @param {number} s.threads     distinct conversation ids
 * @param {string} s.last_at     ISO date of the most recent message
 * @param {string} s.first_at    ISO date of the earliest message
 * @param {boolean} s.is_connection   1st-degree on LinkedIn
 * @param {string} s.connected_on     when the connection was made
 * @param {boolean} s.curated       Danny hand-added them to a network list
 * @param {string} s.curated_source  which list ("Advisor Network")
 * @param {boolean} s.danny_invited   Danny sent the invitation (vs. received it)
 * @param {string} s.invite_note      the personal note on that invitation, if any
 * @param {Date}   s.now         injectable clock, for tests
 * @returns {{warmth:number, tier:string, reciprocal:boolean, months_since:number|null,
 *            receipt:string, components:object}}
 */
function score(s = {}) {
  const sent = Number(s.sent || 0);
  const received = Number(s.received || 0);
  const threads = Number(s.threads || 0);
  const total = sent + received;
  const now = s.now instanceof Date ? s.now : new Date();
  const monthsSince = monthsBetween(s.last_at, now);
  const reciprocal = sent > 0 && received > 0;

  const c = {};

  // ── Reciprocity: the load-bearing component. ──
  // A two-way exchange is worth far more than the same volume one-way, and the
  // BALANCE matters too — 169 sent against 34 received is a person Danny chases.
  if (reciprocal) {
    const balance = Math.min(sent, received) / Math.max(sent, received); // 0..1
    c.reciprocity = 22 + Math.round(18 * balance);                        // 22..40
  } else if (received > 0) {
    c.reciprocity = 12;   // they wrote, he never answered — still a real contact
  } else {
    c.reciprocity = 0;    // sent into the void
  }

  // ── Volume, log-scaled. ──
  // The 10th message says much more than the 200th; linear volume would let a
  // handful of hyper-active threads dominate the entire book.
  //
  // The coefficient is calibrated so the ceiling lands near the top of the real
  // distribution (~226 messages), NOT at its floor. An earlier 9× saturated the
  // cap at six messages, which flattened everything above that into a tie and
  // let a recent six-message exchange outrank a 226-message relationship. Above
  // the cap the scorer has no opinion, so the cap belongs at the top.
  c.volume = total > 0 ? Math.min(25, Math.round(3.2 * Math.log2(total + 1))) : 0;

  // ── Threads: re-engagement over time. ──
  // Three separate conversations across years is a durable relationship;
  // one long thread can be a single transaction.
  c.threads = threads > 1 ? Math.min(15, 6 * (threads - 1)) : 0;

  // ── Recency: a light touch only, since depth is reported separately. ──
  if (monthsSince === null) c.recency = 0;
  else if (monthsSince <= 3) c.recency = 12;
  else if (monthsSince <= 12) c.recency = 8;
  else if (monthsSince <= 24) c.recency = 4;
  else c.recency = 0;

  // ── Being connected at all is a floor, not a signal. ──
  c.connection = s.is_connection ? 5 : 0;

  // ── Curation is intent, and it is Danny's own. ──
  // A person he typed into the Advisor or Investor Network by hand is not a
  // stranger, even with no LinkedIn tie and no messages — someone decided they
  // were worth keeping. Without this they scored as `name_only`, identical to a
  // name scraped off a group thread, which is plainly false for a list he curates.
  c.curated = s.curated ? 6 : 0;

  // ── A personal note on an outbound invite is intent, and it is Danny's own
  // words about why this person mattered — worth keeping, worth a point or two.
  c.intent = s.danny_invited && s.invite_note ? 3 : 0;

  const warmth = Math.max(0, Math.min(100,
    c.reciprocity + c.volume + c.threads + c.recency + c.connection + c.intent + c.curated));

  // ── Tier. Reciprocity gates the top two: no reply, no warm path. ──
  let tier;
  if (reciprocal && (total >= 10 || threads >= 2)) tier = 'strong';
  else if (reciprocal && total >= 3) tier = 'real';
  else if (total > 0) tier = 'light';
  else if (s.is_connection || s.curated) tier = 'thin';
  else tier = 'name_only';

  return {
    warmth, tier, reciprocal,
    months_since: monthsSince,
    receipt: receiptFor({ sent, received, threads, total, reciprocal, tier, ...s }),
    components: c,
  };
}

/**
 * The one line shown under a match. It may only state what the data says —
 * counts, direction, dates. No adjectives the numbers do not support.
 */
function receiptFor(s) {
  const { sent, received, threads, total, reciprocal } = s;
  const last = monthLabel(s.last_at);

  if (total === 0) {
    // Curation is the more specific fact, so it is the one reported.
    if (s.curated) {
      const where = s.curated_source ? `your ${s.curated_source}` : 'a network list you curate';
      return s.is_connection
        ? `On ${where}; connected on LinkedIn, never messaged`
        : `On ${where}; no LinkedIn messages on record`;
    }
    if (s.is_connection) {
      const since = monthLabel(s.connected_on);
      return since ? `Connected ${since}, never messaged` : 'Connected on LinkedIn, never messaged';
    }
    return 'In the network, no direct contact on record';
  }

  const threadPart = threads > 1 ? ` across ${threads} threads` : '';
  const lastPart = last ? `, last ${last}` : '';

  if (reciprocal) {
    return `${total} messages both ways (${sent} sent, ${received} received)${threadPart}${lastPart}`;
  }
  if (received > 0) {
    return `${received} message${received === 1 ? '' : 's'} from them, never answered${lastPart}`;
  }
  return `${sent} message${sent === 1 ? '' : 's'} sent, no reply${lastPart}`;
}

/**
 * How stale, in words. Separate from warmth by design (see header).
 * Returns null when there is no contact history to be stale.
 */
function stalenessLabel(monthsSince) {
  if (monthsSince === null || monthsSince === undefined) return null;
  if (monthsSince <= 3) return 'active';
  if (monthsSince <= 12) return 'recent';
  if (monthsSince <= 36) return 'cold';
  return 'dormant';
}

module.exports = { score, receiptFor, stalenessLabel, monthLabel, monthsBetween, TIERS };
