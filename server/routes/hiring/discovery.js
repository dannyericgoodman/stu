// ── /api/hiring/discovery ── cold GitHub discovery for a role, then re-match.
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { resolveKey } = require('../../lib/providerKeys');
const { discoverForRole } = require('../../pipeline/hiring-discovery');
const { runMatch } = require('../../pipeline/hiring-match');

// POST /api/hiring/discovery/run { role_id, rematch? } — sweep IL builders for the
// role's stack, insert the keepers as cold candidates, then (default) re-run the
// matcher so the new finds land in the shortlist. Free API, but rate-limited upstream.
router.post('/run', async (req, res) => {
  const roleId = Number(req.body?.role_id);
  if (!roleId) return res.status(400).json({ error: 'role_id is required' });
  const role = db.prepare('SELECT id FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, req.user.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const token = resolveKey(req.user.id, 'github');
  if (!token) return res.status(400).json({ error: 'No GitHub token configured — add one in Settings to discover cold builders.' });

  try {
    const discovery = await discoverForRole({ userId: req.user.id, roleId, token });
    if (discovery.error) return res.status(400).json(discovery);
    // Fold the new cold finds into the ranked shortlist unless asked not to.
    let match = null;
    if (req.body?.rematch !== false) match = await runMatch({ userId: req.user.id, roleId, explain: req.body?.explain !== false });
    res.json({ discovery, match });
  } catch (e) {
    console.error('[Hiring] discovery failed:', e.message);
    res.status(500).json({ error: `Discovery failed: ${e.message}` });
  }
});

module.exports = router;
