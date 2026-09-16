// ── /api/hiring — the greenfield Hiring surface ──
// Sub-routers are added phase by phase. Phase 1: companies (portco picker/home) +
// roles (JD ingest + CRUD). Candidates, matches, and discovery land in later phases.
//
// OWNER-ONLY. Hiring is the owner's portfolio-recruiting surface: it reads the
// team's shared Airtable talent tables, which do not exist in any outside seat's
// authorized base. Non-owners get a 403 on the whole tree (the client also hides
// the tab — this is the enforcement behind it).
const express = require('express');
const router = express.Router();
const { isOwner } = require('../../lib/providerKeys');

router.use((req, res, next) => {
  if (!isOwner(req.user?.id)) return res.status(403).json({ error: 'Hiring is only available on the owner account.' });
  next();
});

router.use('/companies', require('./companies'));
router.use('/roles', require('./roles'));
router.use('/candidates', require('./candidates'));
router.use('/matches', require('./matches').router);
router.use('/discovery', require('./discovery'));
router.use('/warm', require('./warm'));

module.exports = router;
