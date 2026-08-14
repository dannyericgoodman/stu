// ── /api/hiring/warm ── owner-gated warm-pool refresh from Airtable (read-only).
// The import uses the platform Airtable key, so only the owner can trigger it.
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { isOwner } = require('../../lib/providerKeys');
const { importWarmPool } = require('../../pipeline/hiring-warm');

// POST /api/hiring/warm/import — pull the warm pool from Airtable into hiring_candidates.
router.post('/import', async (req, res) => {
  if (!isOwner(req.user.id)) return res.status(403).json({ error: 'Owner only — the warm import uses the shared Airtable key.' });
  try {
    const result = await importWarmPool({ userId: req.user.id });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[Hiring] warm import failed:', e.message);
    res.status(500).json({ error: `Warm import failed: ${e.message}` });
  }
});

// GET /api/hiring/warm/status — pool size + last refresh, for the UI.
router.get('/status', (req, res) => {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN il_tie_type IS NOT NULL THEN 1 ELSE 0 END) AS il_tied,
      SUM(CASE WHEN source = 'airtable_talent_db' THEN 1 ELSE 0 END) AS talent_db,
      SUM(CASE WHEN source = 'airtable_master_contacts' THEN 1 ELSE 0 END) AS master_contacts
    FROM hiring_candidates WHERE user_id = ? AND tier = 'warm' AND is_deleted = 0
  `).get(req.user.id);
  const last = db.prepare(`SELECT run_at, summary FROM hiring_runs WHERE user_id = ? AND kind = 'warm_import' ORDER BY run_at DESC LIMIT 1`).get(req.user.id);
  res.json({ ...counts, last_import: last || null });
});

module.exports = router;
