const express = require('express');
const router = express.Router();
const db = require('../db');
const { anthropicFor, MODEL } = require('../lib/providerKeys');

// GET /api/calls/:founderId
router.get('/:founderId', (req, res) => {
  const founder = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(req.params.founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });
  const calls = db.prepare('SELECT c.*, u.name as logged_by FROM call_logs c LEFT JOIN users u ON c.created_by = u.id WHERE c.founder_id = ? ORDER BY c.created_at DESC').all(req.params.founderId);
  res.json(calls);
});

// POST /api/calls/:founderId — paste transcript, get structured summary
router.post('/:founderId', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'Transcript required' });

  const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(req.params.founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });

  const client = anthropicFor(req.user.id, 'call-summary');
  let structuredSummary = null;

  // Per-user identity: the Superior Studios context is the owner's private
  // context — a paying outside seat gets a neutral analyst prompt.
  const { isOwner } = require('../lib/providerKeys');
  const { getSetting } = require('../lib/aiIdentity');
  const callFund = getSetting(req.user.id, 'profile_fund_name');
  const callSystem = isOwner(req.user.id)
    ? `You are an investment analyst at Superior Studios, a Chicago-based pre-seed venture fund. Parse meeting transcripts and extract structured call summaries. Be specific, not generic. Pull exact quotes when relevant.`
    : `You are an investment analyst${callFund ? ` at ${callFund}` : ''}. Parse meeting transcripts and extract structured call summaries. Be specific, not generic. Pull exact quotes when relevant.`;

  if (client) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: callSystem,
        messages: [{
          role: 'user',
          content: `Parse this meeting transcript for a call with ${founder.name}${founder.company ? ` from ${founder.company}` : ''}. Return a JSON object with this exact structure (no markdown, just raw JSON):

{
  "date": "estimated date if mentioned, or null",
  "attendees": ["list of people mentioned"],
  "key_points": ["3-7 most important takeaways"],
  "founder_signals": {
    "speed": "evidence of speed/urgency or lack thereof",
    "storytelling": "how well they articulated their vision",
    "salesmanship": "persuasion ability signals",
    "build_ability": "evidence of building/shipping"
  },
  "open_questions": ["unresolved questions from the call"],
  "next_steps": ["agreed action items"],
  "signal": "strong_positive | positive | neutral | negative | strong_negative",
  "one_liner": "One sentence summary of the call"
}

Transcript:
${transcript}`
        }]
      });

      const text = response.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        structuredSummary = jsonMatch[0];
        // Validate it parses
        JSON.parse(structuredSummary);
      }
    } catch (err) {
      console.error('Call parsing error:', err.message);
    }
  }

  const result = db.prepare('INSERT INTO call_logs (founder_id, raw_transcript, structured_summary, created_by) VALUES (?, ?, ?, ?)').run(req.params.founderId, transcript, structuredSummary, req.user.id);
  db.prepare('UPDATE founders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.founderId);

  const call = db.prepare('SELECT c.*, u.name as logged_by FROM call_logs c LEFT JOIN users u ON c.created_by = u.id WHERE c.id = ?').get(result.lastInsertRowid);
  res.json(call);
});

module.exports = router;
