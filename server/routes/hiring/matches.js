// ── /api/hiring/matches ── run the matcher, read the shortlist, move the handoff status.
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { runMatch } = require('../../pipeline/hiring-match');

// The handoff spine. Stu never contacts anyone — these are Danny's states as he works
// a candidate from the pool out to the founder. Order matters for the UI stepper.
const STATUSES = ['sourced', 'shortlisted', 'shared', 'intro_made', 'hired', 'passed'];

function hydrate(row) {
  if (!row) return row;
  for (const f of ['strengths', 'gaps', 'breakdown']) {
    if (row[f]) { try { row[f] = JSON.parse(row[f]); } catch { row[f] = f === 'breakdown' ? {} : []; } }
    else row[f] = f === 'breakdown' ? {} : [];
  }
  return row;
}

// POST /api/hiring/matches/run — rank the pool for a role → shortlist. Budget-checked
// upstream (expensiveLimiter). The LLM explanation is the only paid step; ranking is free.
router.post('/run', async (req, res) => {
  const roleId = Number(req.body?.role_id);
  if (!roleId) return res.status(400).json({ error: 'role_id is required' });
  const role = db.prepare('SELECT id FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, req.user.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  try {
    const result = await runMatch({ userId: req.user.id, roleId, limit: Number(req.body?.limit) || 10, explain: req.body?.explain !== false });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[Hiring] match run failed:', e.message);
    res.status(500).json({ error: `Match failed: ${e.message}` });
  }
});

// GET /api/hiring/matches?role_id=&status= — the shortlist for a role, joined to the
// candidate so the card has everything (links, tie receipt, warm source) in one shot.
router.get('/', (req, res) => {
  const { role_id, status } = req.query;
  let where = 'm.user_id = ? AND m.is_deleted = 0';
  const params = [req.user.id];
  if (role_id) { where += ' AND m.role_id = ?'; params.push(role_id); }
  if (status && status !== 'all') { where += ' AND m.status = ?'; params.push(status); }
  const rows = db.prepare(`
    SELECT m.*, c.name AS candidate_name, c.headline, c.linkedin_url, c.github_url, c.website_url,
      c.current_company, c.current_role, c.location_city, c.location_state, c.warm_source,
      c.superior_connection, c.il_tie_type, c.il_tie_place, c.il_tie_evidence, c.github_slope_score
    FROM hiring_matches m JOIN hiring_candidates c ON m.candidate_id = c.id
    WHERE ${where}
    ORDER BY m.rank_score DESC
  `).all(...params);
  res.json(rows.map(hydrate));
});

// PUT /api/hiring/matches/:id — move the handoff status (the tracking spine, Phase 5).
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hiring_matches WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const patch = req.body || {};
  const updates = [], params = [];
  if ('status' in patch) {
    if (!STATUSES.includes(patch.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    updates.push('status = ?', 'status_changed_at = CURRENT_TIMESTAMP');
    params.push(patch.status);
  }
  if ('rationale' in patch) { updates.push('rationale = ?'); params.push(patch.rationale); }
  if (!updates.length) return res.json(hydrate(existing));
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE hiring_matches SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  res.json(hydrate(db.prepare('SELECT * FROM hiring_matches WHERE id = ?').get(req.params.id)));
});

// DELETE /api/hiring/matches/:id — drop a candidate from a role's shortlist (soft).
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM hiring_matches WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE hiring_matches SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = { router, STATUSES };
