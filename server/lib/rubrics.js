// ══════════════════════════════════════════════════════════════════════════
// Assessment rubrics — the "what are you assessing?" layer.
//
// Every user gets their own evaluation architecture instead of inheriting
// Danny's. A rubric is a set of dimensions (phrased as questions, weighted),
// plus the scoring envelope. Presets (user_id NULL) ship with the product;
// users can duplicate a preset or build from blank, edit, and set a default.
//
// The conviction engine (lib/conviction.js) scores generically over any
// rubric's dimensions; buildRubricPrompt (agents/prompts.js) generates the
// agent prompt from the same data. This file is the data layer between them.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { PRESETS } = require('./rubric-presets');

// Evidence rungs — must match RUNG in lib/conviction.js (kept local so this
// module never imports the engine; the engine never imports this module).
const RUNG = { NONE: 0, PUBLIC: 1, STATED: 2, OBSERVED: 3, CORROBORATED: 4 };
const RUNG_LABEL = { 0: 'none', 1: 'public', 2: 'stated', 3: 'observed', 4: 'corroborated' };

function parseRubric(row) {
  if (!row) return null;
  let dimensions = [];
  let extras = { drive_lens: false, yellow_flags: false };
  try { dimensions = JSON.parse(row.dimensions || '[]'); } catch { dimensions = []; }
  try { extras = { ...extras, ...JSON.parse(row.extras || '{}') }; } catch { /* keep defaults */ }
  return {
    id: row.id,
    user_id: row.user_id,
    preset_key: row.preset_key,
    name: row.name,
    description: row.description,
    is_preset: !!row.is_preset,
    scoring: row.scoring || 'gate',
    gate_threshold: row.gate_threshold != null ? Number(row.gate_threshold) : 6,
    extras,
    dimensions: dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      question: d.question || '',
      guidance: d.guidance || '',
      weight: Number(d.weight) || 1,
      min_rung: d.min_rung != null ? Number(d.min_rung) : RUNG.OBSERVED,
      load_bearing: !!d.load_bearing,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Validation ────────────────────────────────────────────────────────────
// Returns an array of problems (empty = valid). The builder shows these, not
// a 500. Rules come from the research: cap at 7 dimensions (discrimination
// collapses past that), require ≥1 load-bearing (the gate needs a gate), and
// nudge — not require — a why-now dimension.

function validateRubric({ name, dimensions }) {
  const problems = [];
  if (!name || !String(name).trim()) problems.push('Give the rubric a name.');
  const dims = Array.isArray(dimensions) ? dimensions : [];
  if (dims.length === 0) problems.push('Add at least one dimension.');
  if (dims.length > 7) problems.push('Cap at 7 dimensions — past that, every company scores "fine" and the rubric stops discriminating.');
  const keys = dims.map((d) => String(d.key || '').trim().toLowerCase());
  if (keys.some((k) => !k)) problems.push('Every dimension needs a key (a short slug, e.g. "why_now").');
  if (new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length) problems.push('Dimension keys must be unique.');
  if (dims.some((d) => !String(d.label || '').trim())) problems.push('Every dimension needs a label.');
  if (dims.some((d) => !(Number(d.weight) > 0))) problems.push('Every dimension needs a weight above zero.');
  if (dims.some((d) => d.min_rung == null || Number(d.min_rung) < 0 || Number(d.min_rung) > 4)) {
    problems.push('Every dimension needs a minimum evidence level (website → deck → met the founder → multiple conversations).');
  }
  if (!dims.some((d) => d.load_bearing)) {
    problems.push('Mark at least one dimension load-bearing — those SET the score; the rest differentiate it.');
  }
  return problems;
}

// Soft nudge, not a validation error: the research found "why now" the most
// commonly skipped and most predictive question.
function whyNowNudge(dimensions) {
  const dims = Array.isArray(dimensions) ? dimensions : [];
  const has = dims.some((d) =>
    /why.?now/i.test(`${d.key || ''} ${d.label || ''} ${d.question || ''}`)
  );
  return has ? null : 'No "why now" dimension — the most commonly skipped and most predictive question in early-stage investing. Consider adding one.';
}

// ── Reads ────────────────────────────────────────────────────────────────

function getRubric(id) {
  const row = db.prepare('SELECT * FROM assessment_rubrics WHERE id = ?').get(id);
  return parseRubric(row);
}

function getPreset(key) {
  ensureSeeded();
  const row = db.prepare('SELECT * FROM assessment_rubrics WHERE is_preset = 1 AND preset_key = ?').get(key);
  return parseRubric(row);
}

function listRubrics(userId) {
  ensureSeeded();
  const rows = db.prepare(
    `SELECT * FROM assessment_rubrics
     WHERE is_preset = 1 OR user_id = ?
     ORDER BY is_preset DESC, updated_at DESC`
  ).all(userId);
  const def = db.prepare('SELECT rubric_id FROM user_rubric_defaults WHERE user_id = ?').get(userId);
  return rows.map((r) => {
    const rubric = parseRubric(r);
    rubric.is_default = def ? def.rubric_id === rubric.id : rubric.preset_key === 'founder-preseed';
    return rubric;
  });
}

// Resolve which rubric an assessment runs under:
//   explicit id (must be visible to the user) → user's default → pre-seed preset.
function resolveRubric(userId, rubricId) {
  ensureSeeded();
  if (rubricId) {
    const row = db.prepare(
      'SELECT * FROM assessment_rubrics WHERE id = ? AND (is_preset = 1 OR user_id = ?)'
    ).get(rubricId, userId);
    if (row) return parseRubric(row);
    // Fall through to default rather than 500 — a deleted rubric must not
    // brick the assess flow.
  }
  const def = db.prepare('SELECT rubric_id FROM user_rubric_defaults WHERE user_id = ?').get(userId);
  if (def) {
    const r = getRubric(def.rubric_id);
    if (r) return r;
  }
  return getPreset('founder-preseed');
}

// ── Writes ───────────────────────────────────────────────────────────────

function createRubric(userId, { name, description, dimensions, extras, scoring, gate_threshold, from_preset_key }) {
  let dims = dimensions;
  let base = null;
  if (from_preset_key) {
    base = getPreset(from_preset_key);
    if (!base) throw Object.assign(new Error(`Unknown preset: ${from_preset_key}`), { status: 400 });
    dims = dims || base.dimensions;
  }
  const rubric = {
    name: name || (base ? `${base.name} (copy)` : ''),
    description: description != null ? description : (base ? base.description : ''),
    dimensions: dims || [],
    extras: extras || (base ? base.extras : { drive_lens: false, yellow_flags: true }),
    scoring: scoring || (base ? base.scoring : 'gate'),
    gate_threshold: gate_threshold != null ? gate_threshold : (base ? base.gate_threshold : 6),
  };
  const problems = validateRubric(rubric);
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400, problems });
  const res = db.prepare(
    `INSERT INTO assessment_rubrics
     (user_id, name, description, is_preset, dimensions, extras, scoring, gate_threshold, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    userId, rubric.name.trim(), rubric.description || null,
    JSON.stringify(rubric.dimensions), JSON.stringify(rubric.extras),
    rubric.scoring, rubric.gate_threshold
  );
  return getRubric(res.lastInsertRowid);
}

function updateRubric(userId, id, patch) {
  const row = db.prepare('SELECT * FROM assessment_rubrics WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) {
    const preset = db.prepare('SELECT * FROM assessment_rubrics WHERE id = ? AND is_preset = 1').get(id);
    if (preset) throw Object.assign(new Error('Presets are read-only — duplicate one to make it yours.'), { status: 403 });
    throw Object.assign(new Error('Rubric not found.'), { status: 404 });
  }
  const cur = parseRubric(row);
  const next = {
    name: patch.name != null ? patch.name : cur.name,
    description: patch.description != null ? patch.description : cur.description,
    dimensions: patch.dimensions != null ? patch.dimensions : cur.dimensions,
    extras: patch.extras != null ? { ...cur.extras, ...patch.extras } : cur.extras,
    scoring: patch.scoring || cur.scoring,
    gate_threshold: patch.gate_threshold != null ? patch.gate_threshold : cur.gate_threshold,
  };
  const problems = validateRubric(next);
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400, problems });
  db.prepare(
    `UPDATE assessment_rubrics SET name = ?, description = ?, dimensions = ?, extras = ?,
     scoring = ?, gate_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(
    next.name.trim(), next.description || null, JSON.stringify(next.dimensions),
    JSON.stringify(next.extras), next.scoring, next.gate_threshold, id
  );
  return getRubric(id);
}

function deleteRubric(userId, id) {
  const row = db.prepare('SELECT * FROM assessment_rubrics WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw Object.assign(new Error('Rubric not found.'), { status: 404 });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM opportunity_assessments WHERE rubric_id = ?').get(id).n;
  // Defaults reference the rubric via FK — clear the pointer first so the
  // delete lands, then the rubric itself.
  db.prepare('DELETE FROM user_rubric_defaults WHERE user_id = ? AND rubric_id = ?').run(userId, id);
  db.prepare('DELETE FROM assessment_rubrics WHERE id = ?').run(id);
  // Assessments that used it keep their stored output; rubric_id is nulled so
  // re-runs resolve to the default rather than a ghost.
  if (inUse) db.prepare('UPDATE opportunity_assessments SET rubric_id = NULL WHERE rubric_id = ?').run(id);
  return { deleted: id, assessments_affected: inUse };
}

function setDefaultRubric(userId, id) {
  const row = db.prepare(
    'SELECT * FROM assessment_rubrics WHERE id = ? AND (is_preset = 1 OR user_id = ?)'
  ).get(id, userId);
  if (!row) throw Object.assign(new Error('Rubric not found.'), { status: 404 });
  db.prepare(
    `INSERT INTO user_rubric_defaults (user_id, rubric_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET rubric_id = excluded.rubric_id`
  ).run(userId, id);
  return getRubric(id);
}

function duplicateRubric(userId, id) {
  const row = db.prepare(
    'SELECT * FROM assessment_rubrics WHERE id = ? AND (is_preset = 1 OR user_id = ?)'
  ).get(id, userId);
  if (!row) throw Object.assign(new Error('Rubric not found.'), { status: 404 });
  const src = parseRubric(row);
  return createRubric(userId, {
    name: `${src.name} (copy)`,
    description: src.description,
    dimensions: src.dimensions,
    extras: src.extras,
    scoring: src.scoring,
    gate_threshold: src.gate_threshold,
  });
}

// ── Seed ─────────────────────────────────────────────────────────────────
// Self-seeding on first use. db.js creates the tables but must NOT require
// this module (rubrics requires db — a seed call from db.js hands a partial
// exports object to whichever side loads second, depending on entry point).
// Every read path below runs ensureSeeded() first. Idempotent.
let _seeded = false;
function ensureSeeded() {
  if (_seeded) return;
  seedPresets();
  _seeded = true; // only set on success — a throw retries on the next call
}

// Seed the four built-in presets, and refresh them when the code definitions
// change. Presets are code-owned: the DB row is a cache, not the source of
// truth. UPSERT by preset_key — a deploy with edited preset content updates
// existing rows instead of leaving stale definitions behind. User rubrics
// (is_preset = 0) are never touched.
function seedPresets() {
  const ins = db.prepare(
    `INSERT INTO assessment_rubrics
     (user_id, preset_key, name, description, is_preset, dimensions, extras, scoring, gate_threshold, updated_at)
     VALUES (NULL, ?, ?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  );
  const upd = db.prepare(
    `UPDATE assessment_rubrics
     SET name = ?, description = ?, dimensions = ?, extras = ?,
         scoring = ?, gate_threshold = ?, updated_at = CURRENT_TIMESTAMP
     WHERE is_preset = 1 AND preset_key = ?`
  );
  const get = db.prepare(
    'SELECT name, description, dimensions, extras, scoring, gate_threshold FROM assessment_rubrics WHERE is_preset = 1 AND preset_key = ?'
  );
  let changed = 0;
  db.transaction(() => {
    for (const p of PRESETS) {
      const dims = JSON.stringify(p.dimensions);
      const extras = JSON.stringify(p.extras || {});
      const cur = get.get(p.preset_key);
      if (!cur) {
        ins.run(p.preset_key, p.name, p.description, dims, extras, p.scoring, p.gate_threshold);
        changed++;
      } else if (
        cur.name !== p.name || (cur.description || '') !== (p.description || '') ||
        cur.dimensions !== dims || cur.extras !== extras ||
        cur.scoring !== p.scoring || Number(cur.gate_threshold) !== Number(p.gate_threshold)
      ) {
        upd.run(p.name, p.description, dims, extras, p.scoring, p.gate_threshold, p.preset_key);
        changed++;
      }
    }
  })();
  if (changed) console.log(`[DB] Seeded/refreshed ${changed} assessment rubric preset(s)`);
  return changed;
}

module.exports = {
  RUNG,
  RUNG_LABEL,
  getRubric,
  getPreset,
  listRubrics,
  resolveRubric,
  createRubric,
  updateRubric,
  deleteRubric,
  setDefaultRubric,
  duplicateRubric,
  validateRubric,
  whyNowNudge,
  seedPresets,
};
