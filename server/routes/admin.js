const express = require('express');
const router = express.Router();
const db = require('../db');

// All routes require admin role
router.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
});

// GET /api/admin/dashboard — top-level metrics
router.get('/dashboard', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const paidUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE has_paid = 1').get().c;
  const completedOnboarding = db.prepare('SELECT COUNT(*) as c FROM users WHERE onboarding_complete = 1').get().c;
  const totalRevenue = paidUsers * 100; // $100 per user

  // Signups over time (last 30 days, by day)
  const signupsByDay = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as count
    FROM users
    WHERE created_at >= DATE('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY day
  `).all();

  // Payments over time
  const paymentsByDay = db.prepare(`
    SELECT DATE(payment_date) as day, COUNT(*) as count
    FROM users
    WHERE payment_date IS NOT NULL AND payment_date >= DATE('now', '-30 days')
    GROUP BY DATE(payment_date)
    ORDER BY day
  `).all();

  // Conversion funnel
  const funnel = {
    registered: totalUsers,
    paid: paidUsers,
    onboarded: completedOnboarding,
    conversion_rate: totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 100) : 0,
  };

  // Platform-wide activity
  const totalFounders = db.prepare('SELECT COUNT(*) as c FROM founders WHERE is_deleted = 0').get().c;
  const totalSourced = db.prepare('SELECT COUNT(*) as c FROM sourced_founders').get().c;
  const totalAssessments = db.prepare('SELECT COUNT(*) as c FROM opportunity_assessments WHERE is_deleted = 0').get().c;
  const totalSourcingRuns = db.prepare('SELECT COUNT(*) as c FROM sourcing_runs').get().c;

  res.json({
    metrics: { totalUsers, paidUsers, completedOnboarding, totalRevenue },
    funnel,
    activity: { totalFounders, totalSourced, totalAssessments, totalSourcingRuns },
    signupsByDay,
    paymentsByDay,
  });
});

// GET /api/admin/users — all users with usage stats
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id, u.email, u.name, u.role, u.has_paid, u.onboarding_complete,
      u.stripe_customer_id, u.payment_date, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM founders f WHERE f.created_by = u.id AND f.is_deleted = 0) as founder_count,
      (SELECT COUNT(*) FROM sourced_founders sf WHERE sf.user_id = u.id) as sourced_count,
      (SELECT COUNT(*) FROM opportunity_assessments oa WHERE oa.created_by = u.id AND oa.is_deleted = 0) as assessment_count,
      (SELECT COUNT(*) FROM sourcing_runs sr WHERE sr.user_id = u.id) as sourcing_run_count,
      (SELECT COUNT(*) FROM founder_notes fn WHERE fn.created_by = u.id) as note_count
    FROM users u
    ORDER BY u.created_at DESC
  `).all();

  // Check which users have API keys configured
  const apiKeyStatus = db.prepare(`
    SELECT user_id, setting_key
    FROM user_settings
    WHERE setting_key IN ('api_key_exa', 'api_key_anthropic', 'api_key_enrichlayer', 'api_key_github')
      AND setting_value IS NOT NULL AND setting_value != '' AND setting_value != '""'
  `).all();

  const keyMap = {};
  for (const row of apiKeyStatus) {
    if (!keyMap[row.user_id]) keyMap[row.user_id] = [];
    keyMap[row.user_id].push(row.setting_key.replace('api_key_', ''));
  }

  const enrichedUsers = users.map(u => ({
    ...u,
    api_keys_configured: keyMap[u.id] || [],
  }));

  res.json(enrichedUsers);
});

// GET /api/admin/user/:id — detailed single user view
router.get('/user/:id', (req, res) => {
  const user = db.prepare(`
    SELECT id, email, name, role, has_paid, onboarding_complete,
      stripe_customer_id, payment_date, created_at, last_login
    FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Sourcing criteria
  const settings = db.prepare('SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?').all(req.params.id);
  const criteria = {};
  for (const s of settings) {
    if (s.setting_key.startsWith('api_key_')) {
      criteria[s.setting_key] = '••••••••'; // mask API keys
    } else {
      try { criteria[s.setting_key] = JSON.parse(s.setting_value); } catch { criteria[s.setting_key] = s.setting_value; }
    }
  }

  // Recent sourcing runs
  const recentRuns = db.prepare(`
    SELECT id, run_at, founders_found, founders_added, founders_deduplicated, errors
    FROM sourcing_runs WHERE user_id = ? ORDER BY run_at DESC LIMIT 10
  `).all(req.params.id);

  // Recent activity
  const recentFounders = db.prepare(`
    SELECT id, name, company, stage, created_at FROM founders
    WHERE created_by = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 10
  `).all(req.params.id);

  res.json({ user, criteria, recentRuns, recentFounders });
});

// DELETE /api/admin/user/:id — remove a user and all their data
router.delete('/user/:id', (req, res) => {
  const userId = parseInt(req.params.id);

  // Prevent self-deletion
  if (userId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Delete all user data in a transaction
  const deleteUser = db.transaction(() => {
    // Child records of founders
    db.prepare('DELETE FROM founder_notes WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM call_logs WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM founder_memos WHERE founder_id IN (SELECT id FROM founders WHERE created_by = ?)').run(userId);
    db.prepare('DELETE FROM founder_files WHERE founder_id IN (SELECT id FROM founders WHERE created_by = ?)').run(userId);
    db.prepare('DELETE FROM deal_room WHERE created_by = ?').run(userId);

    // Assessment data
    db.prepare('DELETE FROM assessment_inputs WHERE assessment_id IN (SELECT id FROM opportunity_assessments WHERE created_by = ?)').run(userId);
    db.prepare('DELETE FROM assessment_versions WHERE assessment_id IN (SELECT id FROM opportunity_assessments WHERE created_by = ?)').run(userId);
    db.prepare('DELETE FROM opportunity_assessments WHERE created_by = ?').run(userId);

    // Sourcing data
    db.prepare('DELETE FROM sourced_founders WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sourcing_runs WHERE user_id = ?').run(userId);

    // Founders
    db.prepare('DELETE FROM founders WHERE created_by = ?').run(userId);

    // Settings
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);

    // Founding seat (frees the seat if the user held one)
    db.prepare('DELETE FROM founding_seats WHERE user_id = ?').run(userId);

    // User account
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  deleteUser();
  console.log(`[Admin] User ${userId} (${user.email}) deleted by admin ${req.user.id}`);
  res.json({ deleted: true, user: { id: userId, name: user.name, email: user.email } });
});

module.exports = router;
