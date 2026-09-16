const express = require('express');
const router = express.Router();
const db = require('../db');
const { anthropicFor, MODEL } = require('../lib/providerKeys');

const { buildAiSystem, buildScorerPersona } = require('../lib/aiIdentity');

// POST /api/ai/chat — streaming Danny AI
router.post('/chat', async (req, res) => {
  const client = anthropicFor(req.user.id, 'ai-chat');
  if (!client) return res.status(503).json({ error: 'AI unavailable — add your Anthropic API key in Settings' });

  const { messages, context } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'Messages required' });

  const systemPrompt = buildAiSystem(req.user.id) + (context ? `\n\n[CURRENT CONTEXT]\n${context}` : '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });

    req.on('close', () => {
      stream.abort();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// POST /api/ai/fit-score
router.post('/fit-score', async (req, res) => {
  const client = anthropicFor(req.user.id, 'fit-score');
  if (!client) return res.status(503).json({ error: 'AI unavailable — add your Anthropic API key in Settings' });

  const { founderId } = req.body;
  const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildScorerPersona(req.user.id),
      messages: [{
        role: 'user',
        content: `Score this founder 1-10 on fit with the investor's thesis. Return JSON only:
{
  "score": <1-10>,
  "rationale": "<2-3 sentences>",
  "strengths": ["..."],
  "concerns": ["..."]
}

Founder: ${founder.name}
Company: ${founder.company || 'N/A'}
Role: ${founder.role || 'Founder'}
Location: ${founder.location_city || ''} ${founder.location_state || ''}
Stage: ${founder.stage || 'Pre-seed'}
Domain: ${founder.domain || 'N/A'}
LinkedIn: ${founder.linkedin_url || 'N/A'}
Bio: ${founder.bio || 'N/A'}
Previous companies: ${founder.previous_companies || 'N/A'}
Notable background: ${founder.notable_background || 'N/A'}
Chicago connection: ${founder.chicago_connection || 'N/A'}`
      }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // Save score to founder
      db.prepare('UPDATE founders SET fit_score = ?, fit_score_rationale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND created_by = ?').run(result.score, result.rationale, founderId, req.user.id);
      res.json(result);
    } else {
      res.status(500).json({ error: 'Could not parse AI response' });
    }
  } catch (err) {
    res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
});

module.exports = router;
