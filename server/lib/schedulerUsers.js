'use strict';
// schedulerUsers.js — who do the scheduled jobs run for?
//
// Single-tenant Stu hardcoded userId: 1 everywhere. Now the crons iterate over
// PAID users and each engine resolves that user's own keys through providerKeys
// (BYOK: the owner's saved key first, env fallback for the owner only —
// non-owners with no saved key resolve null and are skipped, never billed to
// the platform key).
const db = require('../db');

function paidUserIds() {
  try {
    return db.prepare('SELECT id FROM users WHERE has_paid = 1 ORDER BY id').all().map((r) => r.id);
  } catch {
    return [];
  }
}

// Users who can actually run `need` (e.g. 'exa','anthropic'): paid + keys resolve.
function usersWithKeys(...providers) {
  const { loadUserApiKeys } = require('./providerKeys');
  const out = [];
  for (const id of paidUserIds()) {
    let keys;
    try { keys = loadUserApiKeys(id); } catch { continue; }
    if (providers.every((p) => keys[p])) out.push({ id, keys });
  }
  return out;
}

module.exports = { paidUserIds, usersWithKeys };
