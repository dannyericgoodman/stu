// ── /api/hiring/roles ──
// A role is a JD, structured, linked to a portco (founders row). The front door is
// POST /ingest — PDF, link, or a typed sentence, all landing on the same structured
// role. Everything else is CRUD so Danny can correct the parse before matching.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../db');
const { extractJdText, parseRole } = require('../../lib/roleIngest');
const { startSourcing, latestRun } = require('../../pipeline/hiring-source');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const SCALAR_FIELDS = [
  'founder_id', 'company_name', 'title', 'role_function', 'seniority', 'domain',
  'location_pref', 'remote_ok', 'il_only', 'comp_note', 'jd_content', 'jd_source',
  'jd_ref', 'parse_json', 'status', 'priority', 'notes',
];
const ARRAY_FIELDS = ['must_have_stack', 'nice_to_have_stack', 'must_haves'];
const ALL_FIELDS = [...SCALAR_FIELDS, ...ARRAY_FIELDS];

function serialize(body, field) {
  if (ARRAY_FIELDS.includes(field)) {
    const v = body[field];
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  return body[field] === undefined ? null : body[field];
}

function hydrate(row) {
  if (!row) return row;
  for (const f of ARRAY_FIELDS) {
    if (row[f]) { try { row[f] = JSON.parse(row[f]); } catch { row[f] = []; } }
    else row[f] = [];
  }
  return row;
}

// Resolve the portco snapshot label from a founder row (survives a later unlink/rename).
function companyLabelFor(userId, founderId) {
  if (!founderId) return null;
  const f = db.prepare('SELECT company, name FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(founderId, userId);
  return f ? (f.company || f.name || null) : null;
}

// GET /api/hiring/roles?founder_id=&status=&search=
router.get('/', (req, res) => {
  const { founder_id, status, search } = req.query;
  let where = 'r.user_id = ? AND r.is_deleted = 0';
  const params = [req.user.id];
  if (founder_id) { where += ' AND r.founder_id = ?'; params.push(founder_id); }
  if (status && status !== 'all') { where += ' AND r.status = ?'; params.push(status); }
  if (search) { where += ' AND r.title LIKE ?'; params.push(`%${search}%`); }

  const rows = db.prepare(`
    SELECT r.*, f.name AS founder_name, f.company AS founder_company, f.investment_amount,
      (SELECT COUNT(*) FROM hiring_matches m WHERE m.role_id = r.id AND m.is_deleted = 0) AS match_count,
      (SELECT COUNT(*) FROM hiring_matches m WHERE m.role_id = r.id AND m.is_deleted = 0 AND m.status = 'shortlisted') AS shortlisted_count
    FROM hiring_roles r
    LEFT JOIN founders f ON r.founder_id = f.id
    WHERE ${where}
    ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, r.updated_at DESC
  `).all(...params);
  res.json(rows.map(r => ({ ...hydrate(r), invested: (r.investment_amount || 0) > 0 })));
});

// GET /api/hiring/roles/:id — role + its shortlist (matches join fills in from Phase 3)
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, f.name AS founder_name, f.company AS founder_company, f.company_one_liner, f.investment_amount
    FROM hiring_roles r LEFT JOIN founders f ON r.founder_id = f.id
    WHERE r.id = ? AND r.user_id = ? AND r.is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const matches = db.prepare(`
    SELECT m.*, c.name AS candidate_name, c.headline, c.current_company, c.current_role,
      c.linkedin_url, c.github_url, c.website_url, c.location_city, c.location_state, c.tier AS candidate_tier,
      c.warm_source, c.il_tie_type, c.il_tie_place, c.il_tie_evidence, c.github_slope_score
    FROM hiring_matches m
    JOIN hiring_candidates c ON m.candidate_id = c.id
    WHERE m.role_id = ? AND m.is_deleted = 0
    ORDER BY m.rank_score DESC, m.fit_score DESC, m.id ASC
  `).all(req.params.id);
  // Hydrate the JSON arrays so the client gets the SAME shape as GET /matches —
  // this is the bug live verification caught: the card did strengths.slice().map on
  // a raw JSON string.
  for (const m of matches) {
    for (const f of ['strengths', 'gaps', 'breakdown']) {
      if (m[f]) { try { m[f] = JSON.parse(m[f]); } catch { m[f] = f === 'breakdown' ? {} : []; } }
      else m[f] = f === 'breakdown' ? {} : [];
    }
  }

  res.json({ ...hydrate(row), invested: (row.investment_amount || 0) > 0, matches });
});

// POST /api/hiring/roles/ingest — the front door. PDF (multipart), link, or sentence.
// Extracts JD text → structured role (temp-0, grounded) → inserts an 'open' role.
router.post('/ingest', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    const founderId = body.founder_id ? Number(body.founder_id) : null;
    // If linked, verify the founder is Danny's and snapshot its company label.
    let companyName = body.company_name || null;
    if (founderId) {
      const label = companyLabelFor(req.user.id, founderId);
      if (!label && !companyName) return res.status(400).json({ error: 'Invalid portfolio company.' });
      companyName = companyName || label;
    }

    // 1. Get readable JD text from whichever input arrived.
    const extracted = await extractJdText({
      jdSource: body.jd_source,
      buffer: req.file ? req.file.buffer : null,
      fileName: req.file ? req.file.originalname : null,
      url: body.url || null,
      text: body.text || null,
      userId: req.user.id,
    });
    if (extracted.error) return res.status(422).json({ error: extracted.error });

    // 2. Structure it. Grounded; leaves unstated fields blank.
    const parsed = await parseRole({ userId: req.user.id, jdText: extracted.text, hintTitle: body.title });
    if (parsed.error) return res.status(422).json({ error: parsed.error });
    const role = parsed.role;

    // 3. Insert. jd_content is stored verbatim — the grounding source for rationale later.
    const record = {
      founder_id: founderId,
      company_name: companyName,
      title: role.title || (body.title || 'Untitled role'),
      role_function: role.role_function,
      seniority: role.seniority,
      domain: role.domain,
      location_pref: role.location_pref,
      remote_ok: role.remote_ok,
      il_only: body.il_only ? 1 : 0,
      comp_note: role.comp_note,
      jd_content: extracted.text.slice(0, 20000),
      jd_source: extracted.jd_source,
      jd_ref: extracted.jd_ref,
      parse_json: JSON.stringify(role),
      status: 'open',
      priority: body.priority || 'normal',
      must_have_stack: role.must_have_stack,
      nice_to_have_stack: role.nice_to_have_stack,
      must_haves: role.must_haves,
    };
    const cols = ['user_id', ...ALL_FIELDS];
    const vals = [req.user.id, ...ALL_FIELDS.map(f => serialize(record, f))];
    const result = db.prepare(`INSERT INTO hiring_roles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
    const row = db.prepare('SELECT * FROM hiring_roles WHERE id = ?').get(result.lastInsertRowid);
    res.json(hydrate(row));
  } catch (e) {
    console.error('[Hiring] ingest failed:', e.message);
    res.status(500).json({ error: `Ingest failed: ${e.message}` });
  }
});

// POST /api/hiring/roles — create a role directly from an already-structured body.
router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.title || !String(body.title).trim()) return res.status(400).json({ error: 'Title is required' });
  const founderId = body.founder_id ? Number(body.founder_id) : null;
  let companyName = body.company_name || null;
  if (founderId) companyName = companyName || companyLabelFor(req.user.id, founderId);
  const record = { ...body, founder_id: founderId, company_name: companyName, status: body.status || 'open' };
  const cols = ['user_id', ...ALL_FIELDS];
  const vals = [req.user.id, ...ALL_FIELDS.map(f => serialize(record, f))];
  const result = db.prepare(`INSERT INTO hiring_roles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const row = db.prepare('SELECT * FROM hiring_roles WHERE id = ?').get(result.lastInsertRowid);
  res.json(hydrate(row));
});

// PUT /api/hiring/roles/:id — Danny corrects the parse (or edits any field).
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Re-snapshot the company label if the founder link changed.
  if ('founder_id' in req.body && req.body.founder_id && !('company_name' in req.body)) {
    req.body.company_name = companyLabelFor(req.user.id, Number(req.body.founder_id));
  }
  const updates = [], params = [];
  for (const f of ALL_FIELDS) {
    if (f in req.body) { updates.push(`${f} = ?`); params.push(serialize(req.body, f)); }
  }
  if (!updates.length) return res.json(hydrate(existing));
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE hiring_roles SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  res.json(hydrate(db.prepare('SELECT * FROM hiring_roles WHERE id = ?').get(req.params.id)));
});

// POST /api/hiring/roles/:id/source — the engine. Go source aligned leads (warm +
// Exa + GitHub), then rank. Runs in the background; returns a run_id to poll.
router.post('/:id/source', (req, res) => {
  const role = db.prepare('SELECT id FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { runId } = startSourcing({ userId: req.user.id, roleId: Number(req.params.id) });
  res.json({ started: true, run_id: runId });
});

// GET /api/hiring/roles/:id/source-status — poll the latest sourcing run.
router.get('/:id/source-status', (req, res) => {
  const role = db.prepare('SELECT id FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  res.json(latestRun(req.user.id, Number(req.params.id)) || { status: 'none' });
});

// GET /api/hiring/roles/:id/export?status= — the handoff artifact. A shareable,
// grounded shortlist Danny copies to the founder or works from to make intros. Stu
// NEVER contacts anyone — this is text, not a send. Defaults to the candidates worth
// sharing (shortlisted → intro_made); ?status=all includes the whole ranked list.
router.get('/:id/export', (req, res) => {
  const role = db.prepare(`
    SELECT r.*, f.name AS founder_name, f.company AS founder_company
    FROM hiring_roles r LEFT JOIN founders f ON r.founder_id = f.id
    WHERE r.id = ? AND r.user_id = ? AND r.is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!role) return res.status(404).json({ error: 'Not found' });

  const shareable = ['shortlisted', 'shared', 'intro_made', 'hired'];
  const wantAll = req.query.status === 'all';
  const matches = db.prepare(`
    SELECT m.*, c.name AS candidate_name, c.headline, c.current_company, c.current_role,
      c.linkedin_url, c.github_url, c.website_url, c.location_city, c.tier, c.warm_source,
      c.il_tie_type, c.il_tie_place, c.il_tie_evidence, c.github_slope_score
    FROM hiring_matches m JOIN hiring_candidates c ON m.candidate_id = c.id
    WHERE m.role_id = ? AND m.is_deleted = 0
    ORDER BY m.rank_score DESC, m.fit_score DESC, m.id ASC
  `).all(req.params.id).filter((m) => wantAll || shareable.includes(m.status));

  const company = role.company_name || role.founder_company || 'the company';
  const lines = [];
  lines.push(`# ${role.title} — ${company}`);
  const meta = [role.role_function, role.seniority, role.location_pref].filter(Boolean).join(' · ');
  if (meta) lines.push(`_${meta}_`);
  lines.push('');
  if (!matches.length) {
    lines.push('_No candidates shared yet. Shortlist a few first._');
  } else {
    lines.push(`${matches.length} ${matches.length === 1 ? 'name' : 'names'}, warm network first:`);
    lines.push('');
    matches.forEach((m, i) => {
      const badges = [];
      if (m.tier === 'warm') badges.push(m.warm_source ? `warm — ${m.warm_source}` : 'warm');
      if (m.il_tie_type) badges.push(`IL: ${m.il_tie_type}${m.il_tie_place ? ` (${m.il_tie_place})` : ''}`);
      const role_co = [m.current_role, m.current_company].filter(Boolean).join(' @ ');
      lines.push(`**${i + 1}. ${m.candidate_name}**${role_co ? ` — ${role_co}` : ''}${badges.length ? `  ·  ${badges.join('  ·  ')}` : ''}`);
      if (m.rationale) lines.push(`   ${m.rationale}`);
      const gaps = (() => { try { return JSON.parse(m.gaps || '[]'); } catch { return []; } })();
      if (gaps.length) lines.push(`   _Gap: ${gaps.join('; ')}_`);
      const links = [
        m.linkedin_url ? `[LinkedIn](${m.linkedin_url})` : null,
        m.github_url ? `[GitHub](${m.github_url})` : null,
        m.website_url ? `[Site](${m.website_url})` : null,
      ].filter(Boolean);
      if (links.length) lines.push(`   ${links.join(' · ')}`);
      lines.push('');
    });
  }
  const markdown = lines.join('\n').trim();
  // Plain text: strip the light markdown so it pastes clean into an email/DM.
  const text = markdown.replace(/^#\s+/gm, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2').replace(/^_(.*)_$/gm, '$1');
  res.json({ role_id: role.id, title: role.title, company, count: matches.length, markdown, text });
});

// DELETE /api/hiring/roles/:id — soft delete.
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE hiring_roles SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
