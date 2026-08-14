// ── /api/hiring — the greenfield Hiring surface ──
// Sub-routers are added phase by phase. Phase 1: companies (portco picker/home) +
// roles (JD ingest + CRUD). Candidates, matches, and discovery land in later phases.
const express = require('express');
const router = express.Router();

router.use('/companies', require('./companies'));
router.use('/roles', require('./roles'));
router.use('/candidates', require('./candidates'));
router.use('/matches', require('./matches').router);
router.use('/discovery', require('./discovery'));
router.use('/warm', require('./warm'));

module.exports = router;
