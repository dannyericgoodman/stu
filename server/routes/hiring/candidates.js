// ── /api/hiring/candidates ── the pool (warm + cold), read + light edit.
const express = require('express');
const router = express.Router();
const db = require('../../db');

function hydrate(row) {
  if (!row) return row;
  for (const f of ['role_function', 'tech_stack', 'builder_signals']) {
    if (row[f]) { try { row[f] = JSON.parse(row[f]); } catch { /* leave as-is (csv) */ } }
  }
  return row;
}

// GET /api/hiring/candidates?tier=&function=&search=&il_only=
router.get('/', (req, res) => {
  const { tier, function: fn, search, il_only } = req.query;
  let where = 'user_id = ? AND is_deleted = 0';
  const params = [req.user.id];
  if (tier && tier !== 'all') { where += ' AND tier = ?'; params.push(tier); }
  if (fn) { where += ' AND role_function LIKE ?'; params.push(`%${fn}%`); }
  if (il_only === '1' || il_only === 'true') { where += ' AND il_tie_type IS NOT NULL'; }
  if (search) { where += ' AND (name LIKE ? OR headline LIKE ? OR current_company LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const rows = db.prepare(`
    SELECT id, name, headline, linkedin_url, github_url, current_company, current_role,
           location_city, location_state, role_function, tech_stack, tier, source, warm_source,
           superior_connection, il_tie_type, il_tie_place, github_slope_score, builder_signals
    FROM hiring_candidates WHERE ${where}
    ORDER BY (tier = 'warm') DESC, COALESCE(github_slope_score, 0) DESC, name COLLATE NOCASE
    LIMIT 300
  `).all(...params);
  res.json(rows.map(hydrate));
});

// GET /api/hiring/candidates/:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM hiring_candidates WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(hydrate(row));
});

// DELETE /api/hiring/candidates/:id — soft delete (a warm re-import won't resurrect it).
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM hiring_candidates WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE hiring_candidates SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
