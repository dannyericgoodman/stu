// ── /api/hiring/companies ──
// The portco universe is the founders table — the single source of truth for Danny's
// companies. There is NO separate hiring portco table (greenfield decision): a role
// links straight to a founders row.
//
// Reality check that shaped this: the two live test portcos, Hale (Sam Burke) and
// Perspectives Health (Eshan Dosani), are in founders but have investment_amount = null
// — they are NOT flagged invested. So the picker can't be limited to the invested set;
// it lets Danny link a role to ANY founder, with invested ones surfaced first and
// badged. "Invested" stays a useful sort/label, never a gate.
const express = require('express');
const router = express.Router();
const db = require('../../db');

// GET /api/hiring/companies — the Hiring home: every portco that has ≥1 role, with
// role counts and the shortlist state rolled up. Grouped-by-portco view.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id AS founder_id, f.name AS founder_name, f.company AS company,
           f.company_one_liner, f.investment_amount,
           COUNT(r.id) AS total_roles,
           SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open_roles
    FROM hiring_roles r
    JOIN founders f ON r.founder_id = f.id
    WHERE r.user_id = ? AND r.is_deleted = 0
    GROUP BY f.id
    ORDER BY (f.investment_amount > 0) DESC, open_roles DESC, f.company COLLATE NOCASE
  `).all(req.user.id);
  res.json(rows.map(r => ({ ...r, invested: (r.investment_amount || 0) > 0 })));
});

// GET /api/hiring/companies/pick?search= — searchable founder list for linking a new
// role. Invested + most-recent first; any founder is pickable. Used by the role form.
router.get('/pick', (req, res) => {
  const search = (req.query.search || '').trim();
  const params = [req.user.id];
  let where = 'is_deleted = 0';
  if (search) { where += ' AND (company LIKE ? OR name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const rows = db.prepare(`
    SELECT id, name, company, company_one_liner, investment_amount, stage, status
    FROM founders
    WHERE created_by = ? AND ${where}
    ORDER BY (investment_amount > 0) DESC, updated_at DESC
    LIMIT 50
  `).all(...params);
  res.json(rows.map(r => ({
    founder_id: r.id, founder_name: r.name, company: r.company,
    company_one_liner: r.company_one_liner, stage: r.stage, status: r.status,
    invested: (r.investment_amount || 0) > 0,
  })));
});

module.exports = router;
