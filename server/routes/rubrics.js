// ── Assessment Architect: rubric CRUD + describe-to-rubric generation ──
// Investors define what THEY are assessing instead of inheriting a rubric.
// Presets (is_preset=1, user_id NULL) are read-only; users duplicate or build
// their own. See server/lib/rubrics.js for the data layer.
const express = require('express');
const router = express.Router();
const {
  listRubrics,
  getRubric,
  createRubric,
  updateRubric,
  deleteRubric,
  duplicateRubric,
  setDefaultRubric,
  validateRubric,
  whyNowNudge,
} = require('../lib/rubrics');
const { anthropicFor, MODEL } = require('../lib/providerKeys');

// ── Reads ──

router.get('/', (req, res) => {
  try {
    res.json({ rubrics: listRubrics(req.user.id) });
  } catch (e) {
    console.error('[Rubrics] list failed:', e.message);
    res.status(500).json({ error: 'Could not load rubrics.' });
  }
});

// ── Writes (user rubrics only; presets are read-only) ──

router.post('/', (req, res) => {
  const errors = validateRubric(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  try {
    const rubric = createRubric(req.user.id, req.body);
    res.json({ rubric, nudge: whyNowNudge(rubric) });
  } catch (e) {
    console.error('[Rubrics] create failed:', e.message);
    res.status(500).json({ error: 'Could not save rubric.' });
  }
});

router.put('/:id', (req, res) => {
  const errors = validateRubric(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  try {
    const rubric = updateRubric(req.user.id, req.params.id, req.body);
    if (!rubric) return res.status(404).json({ error: 'Rubric not found.' });
    res.json({ rubric, nudge: whyNowNudge(rubric) });
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'Rubric not found.' });
    if (e.message === 'PRESET_READONLY') return res.status(403).json({ error: 'Presets cannot be edited. Duplicate one to make it yours.' });
    console.error('[Rubrics] update failed:', e.message);
    res.status(500).json({ error: 'Could not save rubric.' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ok = deleteRubric(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Rubric not found.' });
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'PRESET_READONLY') return res.status(403).json({ error: 'Presets cannot be deleted.' });
    console.error('[Rubrics] delete failed:', e.message);
    res.status(500).json({ error: 'Could not delete rubric.' });
  }
});

router.post('/:id/duplicate', (req, res) => {
  try {
    const rubric = duplicateRubric(req.user.id, req.params.id, req.body && req.body.name);
    if (!rubric) return res.status(404).json({ error: 'Rubric not found.' });
    res.json({ rubric });
  } catch (e) {
    console.error('[Rubrics] duplicate failed:', e.message);
    res.status(500).json({ error: 'Could not duplicate rubric.' });
  }
});

router.post('/:id/default', (req, res) => {
  try {
    const ok = setDefaultRubric(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Rubric not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Rubrics] set-default failed:', e.message);
    res.status(500).json({ error: 'Could not set default rubric.' });
  }
});

// ── The Assessment Architect: describe what matters → draft rubric ──
// The investor answers a few guided questions (or just writes a paragraph);
// the model drafts a rubric they then edit in the builder. The draft is
// validated server-side before it comes back — the UI never has to guess.

const ARCHITECT_SYSTEM = `You are the Assessment Architect. An investor described what they look for in founders and companies. Turn it into an evaluation rubric they can use to score deals.

RULES — follow them exactly:
- 4 to 7 dimensions. Fewer, sharper dimensions beat a long checklist.
- Each dimension is phrased as a QUESTION the investor is really asking (e.g. "Did they live the problem, or did they research it?"), plus 2-4 sentences of guidance for the scoring agent: what evidence looks like, what a high vs low score means, what to never infer.
- Mark 1-3 dimensions load_bearing: true. These are the dimensions that SET the score — the ones where a low score should sink the deal even if everything else shines. Everything else only nudges ±1. At least one is required.
- weight: 1-5, relative emphasis among dimensions.
- min_rung: the minimum evidence needed to score honestly — 1 = public material (website/deck), 2 = founder's own words (deck/transcript), 3 = observed behavior (call notes, references). Default 2. Dimensions about how someone behaves under pressure need 3; dimensions about the market thesis can be 1-2.
- evidence_strength: "STRONG", "MIXED", or null (whether the literature supports judging this from early material).
- gate_threshold: 6 default. The minimum score on EVERY load-bearing dimension to clear the gate.
- If they named instant deal-killers, turn up to 3 into yellow_flags: { key (snake_case), label, why (one sentence), amount (0.5 or 1.0) }. These dock the score in code.
- If a base framework was provided, keep its structure where it fits and adapt it to what they described — don't start from zero.
- Plain language. No jargon, no consultant-speak. Name the rubric after what it is, e.g. "Pre-seed SaaS" not "Holistic Founder Evaluation Matrix".

Return JSON only (no markdown wrapping):
{
  "name": "Short rubric name",
  "description": "One sentence on what this rubric is for.",
  "gate_threshold": 6,
  "dimensions": [
    { "key": "snake_case", "label": "Short Label", "question": "The question, as a question.", "guidance": "2-4 sentences for the scoring agent.", "weight": 3, "min_rung": 2, "evidence_strength": "MIXED", "load_bearing": true }
  ],
  "extras": { "yellow_flags": [ { "key": "...", "label": "...", "why": "...", "amount": 0.5 } ] }
}`;

function architectUserText({ description, answers, base }) {
  const parts = [];
  if (description && description.trim()) parts.push(`IN THEIR OWN WORDS:\n${description.trim()}`);
  if (answers) {
    if (answers.focus && answers.focus.trim()) parts.push(`WHAT THEY INVEST IN: ${answers.focus.trim()}`);
    if (answers.excitement && answers.excitement.trim()) parts.push(`WHAT HAS TO BE TRUE FOR THEM TO GET EXCITED: ${answers.excitement.trim()}`);
    if (answers.deal_killers && answers.deal_killers.trim()) parts.push(`INSTANT DEAL-KILLERS: ${answers.deal_killers.trim()}`);
  }
  if (base && base.dimensions) {
    parts.push(`BASE FRAMEWORK THEY STARTED FROM ("${base.name}"): adapt this, don't discard it.\n` +
      base.dimensions.map((d) => `- ${d.label}: "${d.question}"${d.load_bearing ? ' [load-bearing]' : ''}`).join('\n'));
  }
  parts.push('Draft the rubric now. Return JSON only.');
  return parts.join('\n\n');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
}

router.post('/generate', async (req, res) => {
  const { description = '', answers = {}, base_preset_key = null } = req.body || {};
  const hasContent = description.trim() || answers.focus?.trim() || answers.excitement?.trim() || answers.deal_killers?.trim();
  if (!hasContent) return res.status(400).json({ error: 'Describe what matters to you first — a sentence or two is enough.' });

  let base = null;
  if (base_preset_key) {
    const { getPreset } = require('../lib/rubrics');
    base = getPreset(base_preset_key);
  }

  try {
    const client = anthropicFor(req.user.id, 'assessment');
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: ARCHITECT_SYSTEM,
      messages: [{ role: 'user', content: architectUserText({ description, answers, base }) }],
    });
    const text = (response.content?.[0]?.text || '').trim();
    const draft = extractJson(text);
    if (!draft) return res.status(502).json({ error: 'The architect returned something unreadable. Try again.' });

    const errors = validateRubric(draft);
    if (errors.length) {
      // The draft is close but not shippable — hand it back with the problems
      // named so the builder can show them inline rather than failing silently.
      return res.json({ draft, errors, nudge: whyNowNudge(draft) });
    }
    res.json({ draft, errors: [], nudge: whyNowNudge(draft) });
  } catch (e) {
    console.error('[Rubrics] generate failed:', e.message);
    res.status(502).json({ error: 'The architect is unreachable right now. Try again in a bit.' });
  }
});

module.exports = router;
