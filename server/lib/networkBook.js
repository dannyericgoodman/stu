'use strict';
// ══════════════════════════════════════════════════════════════════════════
// networkBook.js — the Network book, loaded in the shape lib/networkMatch reads.
//
// Lives in lib, not in routes/network.js, because it has two readers: the Network
// page and Hiring, which draws warm candidates from the same book. A pipeline that
// required a route file to get this would drag multer and the Airtable client in
// with it.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { stalenessLabel } = require('./relationshipStrength');

// ── The book, shaped for the matcher ──────────────────────────────────────
// One query, whole book. At ~3,000 rows a full scan is single-digit
// milliseconds, and it keeps the matcher a pure function over plain objects
// rather than something that has to know SQL.
const BOOK_SQL = `
  SELECT id, name, title, company, linkedin_url, email, expertise, notes,
         functions, personas, sectors, seniority, is_commercial, profile_signal,
         warmth, warmth_tier, months_since, relationship_receipt, sources
  FROM network_people
  WHERE user_id = ? AND is_deleted = 0
`;

function parseJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

function toMatcherShape(r) {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    company: r.company,
    linkedin_url: r.linkedin_url,
    email: r.email,
    profile: {
      functions: parseJson(r.functions, []),
      personas: parseJson(r.personas, []),
      sectors: parseJson(r.sectors, []),
      seniority: r.seniority,
      company: r.company,
      is_commercial: !!r.is_commercial,
      signal: r.profile_signal || 'none',
    },
    relationship: {
      warmth: r.warmth || 0,
      tier: r.warmth_tier || 'name_only',
      months_since: r.months_since,
      staleness: stalenessLabel(r.months_since),
      receipt: r.relationship_receipt,
    },
  };
}

function loadBook(userId) {
  return db.prepare(BOOK_SQL).all(userId).map(toMatcherShape);
}

module.exports = { loadBook, toMatcherShape, parseJson };
