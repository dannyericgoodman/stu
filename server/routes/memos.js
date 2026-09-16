const express = require('express');
const router = express.Router();
const db = require('../db');
const { anthropicFor, MODEL } = require('../lib/providerKeys');

// GET /api/founders/:founderId/memos — list all memos for a founder
router.get('/:founderId', (req, res) => {
  const founder = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(req.params.founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });
  const memos = db.prepare('SELECT * FROM founder_memos WHERE founder_id = ? ORDER BY created_at DESC').all(req.params.founderId);
  res.json(memos);
});

// POST /api/founders/:founderId/memos — generate a new IC memo
router.post('/:founderId', async (req, res) => {
  const client = anthropicFor(req.user.id, 'memo');
  if (!client) return res.status(503).json({ error: 'AI unavailable — add your Anthropic API key in Settings' });

  const founderId = parseInt(req.params.founderId);
  const founder = db.prepare('SELECT * FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });

  // Get existing memo count for versioning
  const memoCount = db.prepare('SELECT COUNT(*) as count FROM founder_memos WHERE founder_id = ?').get(founderId).count;
  const version = memoCount + 1;

  // Gather ALL data about this founder
  const notes = db.prepare('SELECT content, created_at FROM founder_notes WHERE founder_id = ? ORDER BY created_at DESC').all(founderId);
  const calls = db.prepare('SELECT structured_summary, raw_transcript, created_at FROM call_logs WHERE founder_id = ? ORDER BY created_at DESC').all(founderId);
  const assessments = db.prepare(`
    SELECT a.*, av.change_summary
    FROM opportunity_assessments a
    LEFT JOIN assessment_versions av ON av.assessment_id = a.id
    WHERE a.founder_id = ? AND a.is_deleted = 0 AND a.status = 'complete'
    ORDER BY a.created_at DESC
  `).all(founderId);
  const deals = db.prepare('SELECT * FROM deal_room WHERE founder_id = ? ORDER BY created_at DESC').all(founderId);
  const files = db.prepare('SELECT file_name, file_type, content_text, url FROM founder_files WHERE founder_id = ? ORDER BY created_at DESC').all(founderId);

  // Build comprehensive context
  let context = `FOUNDER PROFILE:
Name: ${founder.name}
Company: ${founder.company || 'N/A'}
Role: ${founder.role || 'Founder'}
Location: ${founder.location_city || ''} ${founder.location_state || ''}
Stage: ${founder.stage || 'Pre-seed'}
Domain: ${founder.domain || 'N/A'}
One-liner: ${founder.company_one_liner || 'N/A'}
LinkedIn: ${founder.linkedin_url || 'N/A'}
Bio: ${founder.bio || 'N/A'}
Previous Companies: ${founder.previous_companies || 'N/A'}
Notable Background: ${founder.notable_background || 'N/A'}
Chicago Connection: ${founder.chicago_connection || 'N/A'}
Source: ${founder.source || 'N/A'}
Fit Score: ${founder.fit_score || 'Not scored'}/10
Fit Rationale: ${founder.fit_score_rationale || 'N/A'}`;

  // Deal data
  if (founder.deal_status || founder.valuation || founder.round_size) {
    context += `\n\nDEAL DATA:
Deal Status: ${founder.deal_status || 'N/A'}
Deal Lead: ${founder.deal_lead || 'N/A'}
Security Type: ${founder.security_type || 'N/A'}
Valuation: ${founder.valuation ? '$' + founder.valuation.toLocaleString() : 'N/A'}
Round Size: ${founder.round_size ? '$' + founder.round_size.toLocaleString() : 'N/A'}
Our Investment: ${founder.investment_amount ? '$' + founder.investment_amount.toLocaleString() : 'N/A'}
ARR: ${founder.arr ? '$' + founder.arr.toLocaleString() : 'N/A'}
Monthly Burn: ${founder.monthly_burn ? '$' + founder.monthly_burn.toLocaleString() : 'N/A'}
Runway: ${founder.runway_months ? founder.runway_months + ' months' : 'N/A'}
Diligence: ${founder.diligence_status || 'Not started'}`;
  }

  // Notes
  if (notes.length > 0) {
    context += '\n\nTEAM NOTES:';
    notes.forEach((n, i) => {
      context += `\n[${new Date(n.created_at).toLocaleDateString()}] ${n.content}`;
    });
  }

  // Call summaries
  if (calls.length > 0) {
    context += '\n\nCALL HISTORY:';
    calls.forEach((c, i) => {
      const summary = c.structured_summary ? JSON.parse(c.structured_summary) : null;
      if (summary) {
        context += `\n\n[Call ${i + 1} - ${new Date(c.created_at).toLocaleDateString()}]`;
        if (summary.one_liner) context += `\nSummary: ${summary.one_liner}`;
        if (summary.signal) context += `\nSignal: ${summary.signal}`;
        if (summary.key_points) context += `\nKey Points: ${summary.key_points.join('; ')}`;
        if (summary.next_steps) context += `\nNext Steps: ${summary.next_steps.join('; ')}`;
        if (summary.concerns) context += `\nConcerns: ${summary.concerns.join('; ')}`;
      } else if (c.raw_transcript) {
        context += `\n\n[Call ${i + 1} - ${new Date(c.created_at).toLocaleDateString()}]\n${c.raw_transcript.slice(0, 3000)}`;
      }
    });
  }

  // Assessment outputs
  if (assessments.length > 0) {
    const latest = assessments[0];
    context += '\n\nLATEST ASSESSMENT OUTPUTS:';
    // overall_signal is now a rubric band label — "Anchor-grade" | "Top-quartile" |
    // "Monitor" | "Pass with respect" — or "Insufficient evidence" when the conviction
    // engine could not score. It is NOT Invest/Monitor/Pass any more.
    context += `\nOverall Signal: ${latest.overall_signal || 'N/A'}`;

    let syn = null;
    if (latest.synthesis_output) {
      try { syn = JSON.parse(latest.synthesis_output); } catch {}
    }

    if (syn) {
      if (syn.executive_summary) context += `\nExecutive Summary: ${syn.executive_summary}`;
      // The depth layer. Three pillars — team / product / market. The old
      // signal_scores schema (founder/market/economics/pattern_fit/risk_profile)
      // no longer exists, which is why memos shipped with no scores at all.
      if (syn.pillar_scores) {
        const p = syn.pillar_scores;
        const fmt = v => (typeof v === 'number' ? `${v}/10` : 'not scored');
        context += `\nPillar Scores (depth layer, not the verdict): Team ${fmt(p.team)}, Product ${fmt(p.product)}, Market ${fmt(p.market)}`;
      }
      if (typeof syn.bear_adjustment === 'number' && syn.bear_adjustment !== 0) {
        context += `\nBear Adjustment: ${syn.bear_adjustment}`;
      }
      if (syn.agent_consensus) context += `\nConsensus: ${syn.agent_consensus.join('; ')}`;
      if (syn.agent_disagreements) context += `\nDisagreements: ${syn.agent_disagreements.join('; ')}`;
      if (syn.top_questions) context += `\nOpen Questions: ${syn.top_questions.join('; ')}`;
    }

    // ── Conviction (the verdict layer) ──────────────────────────────────────
    // Computed deterministically in lib/conviction.js. Prefer the dedicated column;
    // fall back to the copy stamped onto synthesis. When it is indeterminate there is
    // NO score — there is a question list, and the memo must say so rather than imply
    // a number exists.
    let conviction = null;
    if (latest.conviction_output) {
      try { conviction = JSON.parse(latest.conviction_output); } catch {}
    }
    if (!conviction && syn && syn.conviction) conviction = syn.conviction;

    if (conviction) {
      context += '\n\nCONVICTION (deterministic — computed by code, not by an agent):';
      context += `\nEvidence Rung: ${conviction.rung_label || 'Unknown'}`;
      if (conviction.determinate) {
        context += `\nConviction Score: ${conviction.score}/10`;
        if (conviction.band) context += `\nBand: ${conviction.band.label} — ${conviction.band.action}`;
        if (conviction.calculation) context += `\nCalculation: ${conviction.calculation}`;
        if (conviction.docks && conviction.docks.length) {
          context += `\nDocks Applied: ${conviction.docks.map(d => `${d.amount} (${d.why})`).join('; ')}`;
        }
      } else {
        context += '\nConviction Score: NONE — INDETERMINATE. Do not state or infer a conviction score in the memo.';
        if (conviction.reason) context += `\nWhy: ${conviction.reason}`;
        if (conviction.missing_load_bearing && conviction.missing_load_bearing.length) {
          context += `\nUnscorable load-bearing movements: ${conviction.missing_load_bearing.join('; ')}`;
        }
      }
      if (conviction.movements) {
        for (const m of Object.values(conviction.movements)) {
          const val = m.scorable ? `${m.score}/10` : `not scorable — ${m.reason || 'no evidence'}`;
          context += `\n- ${m.label} (weight ${m.weight}): ${val}`;
          if (m.evidence) context += `\n    Evidence: ${m.evidence}`;
        }
      }
    }

    // What we were handed but could not actually read. A gap, not evidence. This lives
    // in its own column — computeConviction's output does not carry it.
    if (latest.evidence_output) {
      try {
        const evidence = JSON.parse(latest.evidence_output);
        if (evidence.meaning) context += `\nWhat this evidence supports: ${evidence.meaning}`;
        if (evidence.dropped && evidence.dropped.length) {
          context += `\nInputs we could NOT read (gaps, not evidence): ${evidence.dropped.map(d => `${d.label} (${d.reason})`).join('; ')}`;
        }
      } catch {}
    }

    // Individual agent outputs for depth. The DB column names are legacy and do NOT
    // match what they hold — see routes/assessments.js ~line 660 and
    // client/src/pages/AssessmentDetail.jsx lines 6-11. Mapping them by name is what
    // caused every memo to label the PRODUCT agent's output as "MARKET".
    // pattern_agent_output is hard-set to NULL by the runner — dropped.
    const agentFields = [
      { field: 'founder_agent_output', label: 'TEAM' },
      { field: 'market_agent_output', label: 'PRODUCT' },
      { field: 'economics_agent_output', label: 'MARKET' },
      { field: 'bear_agent_output', label: 'BEAR' },
    ];
    for (const { field, label } of agentFields) {
      if (latest[field]) {
        try {
          const output = JSON.parse(latest[field]);
          if (output.narrative) context += `\n\n${label} AGENT NARRATIVE:\n${output.narrative}`;
          if (output.key_questions) context += `\nKey Questions: ${output.key_questions.join('; ')}`;
        } catch {}
      }
    }
  }

  // Uploaded files content
  if (files.length > 0) {
    context += '\n\nUPLOADED DOCUMENTS:';
    files.forEach(f => {
      context += `\n\n[${f.file_name}]`;
      if (f.content_text) context += `\n${f.content_text.slice(0, 5000)}`;
      if (f.url) context += `\nSource: ${f.url}`;
    });
  }

  // Cap context
  context = context.slice(0, 120000);

  // Create a placeholder memo record immediately
  const insertResult = db.prepare(
    'INSERT INTO founder_memos (founder_id, memo_type, content, version, data_snapshot, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(founderId, 'ic_memo', '', version, JSON.stringify({ notes: notes.length, calls: calls.length, assessments: assessments.length, files: files.length }), req.user.id);
  const memoId = insertResult.lastInsertRowid;

  res.json({ id: memoId, version, status: 'generating' });

  // Generate memo in background
  // Per-user identity: the Superior Studios context (fund size, team names,
  // thesis) is the owner's private context — a paying outside seat gets the
  // same memo structure with their own firm referenced, never Danny's.
  const { isOwner } = require('../lib/providerKeys');
  const { getSetting } = require('../lib/aiIdentity');
  const memoOwner = isOwner(req.user.id);
  const memoFund = getSetting(req.user.id, 'profile_fund_name');
  const firmRef = memoOwner ? 'Superior Studios' : (memoFund || 'the firm');
  const icRef = memoOwner ? 'the investment committee (Brandon Cruz, Managing Partner)' : 'the investment committee';
  const frameworksRef = memoOwner
    ? "Use the frameworks Danny's team uses: Eniac dimensions, Gurley unit economics, Marks risk asymmetry, Munger mental models, Helmer 7 Powers."
    : 'Use proven investment frameworks: unit economics, risk asymmetry, mental models, Helmer 7 Powers.';
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      // 0, like every other scoring path. This was unset — i.e. 1.0 — so the IC
      // memo, the most consequential artifact Stu produces, was being SAMPLED.
      // Regenerate it twice on identical inputs and you'd get two different
      // recommendations, which is the exact bug routes/assessments.js documents
      // finding empirically: six founders assessed twice on byte-identical inputs
      // moved up to 1.1 points, because Stu was sampling its own verdicts.
      // Every agent got the fix; this one was missed because it lives in another
      // file and never ran often enough for anyone to notice.
      // ⚠️ Sonnet 5 / Opus 4.7+ REJECT non-default temperature with a 400.
      temperature: 0,
      system: `You are the IC Memo Writer for ${memoOwner ? 'Superior Studios, a Chicago-based pre-seed venture fund (~$10M Fund I)' : (memoFund ? `${memoFund}, a venture fund` : 'a venture fund')}.

You write investment committee memos that are direct, evidence-based, and intellectually honest. Your memos are the primary decision document for ${icRef}.

MEMO STRUCTURE:
1. **Executive Summary** — 3-4 sentences: what the company does, why it matters, and the investment recommendation
2. **Company Overview** — What they build, for whom, how it works, current stage
3. **Founder Assessment** — Deep dive on the founder: background, traits (Speed/Storytelling/Salesmanship/Build+Motivate), stage classification (Freshman/Sophomore/Junior/Senior), founding insight type (Earned Insider vs Synthesized)
4. **Market Opportunity** — TAM/SAM/SOM, Why Now, competitive landscape, market timing
5. **Business Model & Unit Economics** — Revenue model, pricing, current metrics (if any), path to unit economics
6. **Competitive Advantage & Moat** — What's defensible? Apply Hamilton Helmer's 7 Powers where relevant
7. **Key Risks & Mitigants** — Top 3-5 risks with severity and what would mitigate them
8. **Investment Terms** — Round details, valuation, our check size, ownership
9. **Portfolio Fit** — How this fits the ${firmRef} thesis and existing portfolio
10. **Recommendation** — Clear: Commit / Continue Diligence / Pass, with reasoning

CONVICTION — READ THIS BEFORE WRITING:
- The conviction score is computed deterministically in code from the Founder Rubric. You do NOT
  compute it, adjust it, average it, or infer one. Report the number you are given, or report none.
- If the CONVICTION block says INDETERMINATE, the memo must contain NO conviction score and no
  numeric stand-in for one. There is no verdict yet — there is a question list. Say exactly that,
  state the evidence rung reached, and make the Recommendation the step that would earn a score
  (usually: take the call). Do not hedge it into an implied number.
- Assessment signal bands are: Anchor-grade (first call within a week) / Top-quartile (write a memo) /
  Monitor (track the next data point) / Pass with respect — or "Insufficient evidence" when
  indeterminate. These are NOT Invest/Monitor/Pass; do not translate between the two vocabularies.
- Pillar scores (Team / Product / Market) are the DEPTH layer for reading, not the verdict. Never
  present a pillar score, or any combination of them, as the conviction score.

STYLE:
- Be direct. No filler, no "this is an exciting opportunity."
- Lead with evidence, not opinion.
- Flag what you DON'T know — data gaps matter. An input we could not read is a gap, not evidence.
- ${frameworksRef}
- Write for an audience of experienced investors who want signal, not noise.

Return the memo as clean markdown text (no JSON wrapping). Use ## headers for each section.`,
      messages: [{
        role: 'user',
        content: `Generate a comprehensive IC memo for this opportunity. Use ALL the data provided — notes, calls, assessments, documents. Be thorough but concise. Flag gaps where data is missing.\n\n${context}`
      }]
    });

    const memoContent = response.content[0].text.trim();
    db.prepare('UPDATE founder_memos SET content = ? WHERE id = ?').run(memoContent, memoId);

    // Also update the founder's memo_status
    db.prepare("UPDATE founders SET memo_status = 'Complete', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (memo_status IS NULL OR memo_status != 'Complete')").run(founderId);
  } catch (err) {
    console.error('[Memo] Generation error:', err);
    db.prepare("UPDATE founder_memos SET content = ? WHERE id = ?").run(`Error generating memo: ${err.message}`, memoId);
  }
});

// DELETE /api/founders/:founderId/memos/:id
router.delete('/:founderId/:id', (req, res) => {
  const founder = db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(req.params.founderId, req.user.id);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });
  const memo = db.prepare('SELECT * FROM founder_memos WHERE id = ? AND founder_id = ?').get(req.params.id, req.params.founderId);
  if (!memo) return res.status(404).json({ error: 'Memo not found' });
  db.prepare('DELETE FROM founder_memos WHERE id = ?').run(req.params.id);
  res.json({ message: 'Memo deleted' });
});

module.exports = router;
