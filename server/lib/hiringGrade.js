'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiringGrade.js — grade a candidate against what the job description REQUIRES.
//
// ── WHY THIS EXISTS ──
// The deterministic ranker was built for engineering roles: function label, stack
// tokens, a GitHub axis. On Avant Health's Clinical Member Advocate role (2026-09-13)
// it ranked a marketing co-founder #1 at 65/100 — his own rationale said "no health
// insurance, TPA, clinical, or member advocacy" — and a utilization-management RN with
// 28 years in managed care at 33/100. The JD's must-haves ("Active RN license", "2+
// years of case management") were never read by the score at all. The nurse was
// labelled function "other"; the co-founder was "ops"; function carried 35 points.
//
// A job description states its requirements in words. Reading "RN, BSN, CPUR" as
// satisfying "Active RN license" is a language task, so a model does the reading.
//
// ── THE LAW, CARRIED OVER FROM THE CONVICTION ENGINE ──
// The model produces EVIDENCE, never the verdict. For each requirement it returns a
// status and a verbatim quote from the candidate's profile. Code then:
//   · checks every quote against the profile text (agents/verify.js) — a "met" with a
//     quote that is not really there is downgraded to "not shown", so an invented
//     credential cannot raise a score;
//   · computes the score arithmetically from the surviving verdicts.
// Same inputs, same score. The model cannot award points it cannot cite.
//
// ── UNASSESSABLE REQUIREMENTS ARE DROPPED, NOT FAILED ──
// "Comfortable with a mostly in-office schedule" and "willing to relocate" cannot be
// read off any public profile. Scoring them as unmet penalises every candidate equally
// and compresses the whole list toward zero; scoring them as met invents a fact. The
// rubric step removes them and says which it removed.
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { MODEL, describeLlmError } = require('./providerKeys');
const { buildContextIndex, classifyQuote } = require('../agents/verify');

const CORE_WEIGHT = 2;
const SUPPORTING_WEIGHT = 1;
const CREDIT = { met: 1, partial: 0.5, not_shown: 0, contradicted: 0 };
const MAX_REQUIREMENTS = 8;
const GRADE_CHUNK = 5;          // candidates per grading call
const GRADE_CONCURRENCY = 3;
const PROFILE_CHARS = 5000;     // per candidate, per call — enough for a full LinkedIn history

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

async function runPool(thunks, concurrency) {
  const out = new Array(thunks.length);
  let next = 0;
  const worker = async () => {
    while (next < thunks.length) {
      const i = next++;
      out[i] = await thunks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, worker));
  return out;
}

function firstJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ── 1. The rubric ─────────────────────────────────────────────────────────

/** The inputs a rubric depends on. Change any of them and the stored rubric is stale. */
function rubricHash(role) {
  return sha([role.title, role.role_function, role.seniority, role.domain,
    parseArr(role.must_haves), parseArr(role.must_have_stack), String(role.jd_content || '').slice(0, 4000)]);
}

/**
 * Requirements straight from the parsed role, no model. Used when there is no key,
 * and as the floor the model's rubric is checked against.
 */
function fallbackRubric(role) {
  const reqs = [];
  const work = [role.title, role.domain ? `in ${role.domain}` : ''].filter(Boolean).join(' ');
  if (work) reqs.push({ id: 'r1', text: `Has done this kind of work: ${work}`, weight: 'core' });
  for (const m of parseArr(role.must_haves)) reqs.push({ id: `r${reqs.length + 1}`, text: String(m), weight: 'supporting' });
  for (const s of parseArr(role.must_have_stack)) reqs.push({ id: `r${reqs.length + 1}`, text: `Hands-on with ${s}`, weight: 'supporting' });
  return { requirements: reqs.slice(0, MAX_REQUIREMENTS), dropped: [], source: 'fallback' };
}

/**
 * Normalize a rubric object into the stored shape, whatever the model returned.
 * Ids are reassigned r1..rN so a candidate verdict can never point at a requirement
 * that does not exist.
 */
function normalizeRubric(raw, role) {
  const reqs = (raw && Array.isArray(raw.requirements) ? raw.requirements : [])
    .map((r) => ({ text: String((r && r.text) || '').trim(), weight: r && r.weight === 'core' ? 'core' : 'supporting' }))
    .filter((r) => r.text)
    .slice(0, MAX_REQUIREMENTS)
    .map((r, i) => ({ id: `r${i + 1}`, ...r }));
  if (!reqs.length) return fallbackRubric(role);
  if (!reqs.some((r) => r.weight === 'core')) reqs[0].weight = 'core';
  const dropped = (raw && Array.isArray(raw.dropped) ? raw.dropped : []).map(String).slice(0, 12);
  return { requirements: reqs, dropped, source: 'model' };
}

async function buildRubric({ client, role }) {
  if (!client) return fallbackRubric(role);
  const musts = parseArr(role.must_haves);
  const stack = parseArr(role.must_have_stack);
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 900, temperature: 0,
      system: `You turn a job description into the requirements a recruiter would check a candidate's PUBLIC PROFILE (LinkedIn history, title, education, certifications) against.

RULES:
- Requirement 1 is always the core work experience the role needs, stated concretely (e.g. "Utilization management or case management experience at a payer or health plan"), weight "core".
- Keep only requirements a public profile can show: credentials, licenses, years or type of experience, domain background, specific skills or tools, seniority.
- DROP anything a profile cannot show: willingness to relocate, schedule or office preferences, travel tolerance, salary expectations, personality traits, "passion for". List what you dropped.
- Mark a requirement "core" only if the JD makes it non-negotiable (a license, a hard experience bar). Everything else is "supporting".
- At most ${MAX_REQUIREMENTS} requirements. Merge near-duplicates. Use the JD's own terms.

Return ONLY JSON: {"requirements":[{"text":"...","weight":"core"|"supporting"}],"dropped":["..."]}`,
      messages: [{ role: 'user', content: `TITLE: ${role.title || ''}\nFUNCTION: ${role.role_function || ''}\nSENIORITY: ${role.seniority || ''}\nDOMAIN: ${role.domain || ''}\nMUST-HAVES: ${musts.join(' | ') || '(none)'}\nMUST-HAVE STACK: ${stack.join(', ') || '(none)'}\n\nJD:\n${String(role.jd_content || '').slice(0, 4000)}` }],
    });
    return normalizeRubric(firstJson(resp.content?.[0]?.text), role);
  } catch (e) {
    const rb = fallbackRubric(role);
    rb.error = describeLlmError(e, 'Rubric').message;
    return rb;
  }
}

// ── 2. Candidate text ─────────────────────────────────────────────────────

/**
 * Everything we can honestly quote about a person, most authoritative first.
 * A LinkedIn read beats a search excerpt beats a one-line headline.
 */
function candidateText(c) {
  const parts = [];
  const li = linkedinText(c.linkedin_data);
  if (li) parts.push(li);
  if (c.profile_text) parts.push(String(c.profile_text));
  parts.push([c.headline, c.current_role, c.current_company].filter(Boolean).join(' • '));
  if (c.location_city || c.location_state) parts.push(`Location: ${[c.location_city, c.location_state].filter(Boolean).join(', ')}`);
  if (c.notes) parts.push(String(c.notes));
  if (c.superior_connection) parts.push(String(c.superior_connection));
  return parts.filter(Boolean).join('\n').slice(0, PROFILE_CHARS);
}

/** Flatten an EnrichLayer profile into readable, quotable lines. */
function linkedinText(raw) {
  let p = raw;
  if (typeof raw === 'string') { try { p = JSON.parse(raw); } catch { return ''; } }
  if (!p || typeof p !== 'object' || !Object.keys(p).length) return '';
  const lines = [];
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.city || p.state) lines.push(`Location: ${[p.city, p.state, p.country].filter(Boolean).join(', ')}`);
  if (p.summary) lines.push(`About: ${String(p.summary).slice(0, 800)}`);
  const exps = Array.isArray(p.experiences) ? p.experiences : [];
  for (const e of exps.slice(0, 8)) {
    if (!e) continue;
    const yr = (d) => (d && d.year ? d.year : null);
    const span = [yr(e.starts_at), e.ends_at ? yr(e.ends_at) : 'present'].filter(Boolean).join('–');
    lines.push(`Experience: ${[e.title, e.company].filter(Boolean).join(' at ')}${span ? ` (${span})` : ''}${e.description ? ` — ${String(e.description).slice(0, 300)}` : ''}`);
  }
  for (const ed of (Array.isArray(p.education) ? p.education : []).slice(0, 4)) {
    if (ed) lines.push(`Education: ${[ed.degree_name, ed.field_of_study, ed.school].filter(Boolean).join(', ')}`);
  }
  for (const cert of (Array.isArray(p.certifications) ? p.certifications : []).slice(0, 8)) {
    if (cert && cert.name) lines.push(`Certification: ${cert.name}${cert.authority ? ` (${cert.authority})` : ''}`);
  }
  return lines.join('\n');
}

// ── 3. The honesty gate and the arithmetic — pure, no model ───────────────

// ══════════════════════════════════════════════════════════════════════════
// SHORT QUOTES ARE THE ONES THAT MATTER HERE.
//
// agents/verify.js was built for founder-call transcripts, where a one-word "quote"
// occurs by coincidence and proves nothing, so it rejects anything under two content
// words of 3+ letters. Measured against a real utilization-management nurse's profile
// it rejected "RN, BSN", "CPUR" and "BCBS" — precisely the credential evidence a
// clinical role turns on — which would have scored every nurse zero.
//
// A profile is not a transcript: it is short, and a credential token in it is a
// deliberate statement, not a coincidence. So a quote is grounded when it appears in
// the profile as a WHOLE-WORD run (after normalizing punctuation), however short —
// "rn" matches "RN, BSN" and never the "rn" inside "modern" — or when verify.js
// accepts it as verbatim/paraphrased for the longer quotes it was built for.
// ══════════════════════════════════════════════════════════════════════════
const normWords = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9%$+#]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

function quoteInProfile(quote, text, index) {
  const q = normWords(quote).trim();
  if (q.length < 2) return false;
  if (normWords(text).includes(` ${q} `)) return true;
  return classifyQuote(String(quote), index || buildContextIndex(String(text || ''))) !== 'unverified';
}

/**
 * Apply the quote gate to one candidate's raw verdicts. A "met", "partial", or
 * "contradicted" verdict survives only if its quote is really in the profile text;
 * otherwise it becomes "not_shown". Unknown requirement ids are ignored.
 */
function gateVerdicts(rubric, rawVerdicts, text) {
  const index = buildContextIndex(String(text || ''));
  const byId = new Map((Array.isArray(rawVerdicts) ? rawVerdicts : []).map((v) => [String(v && v.id), v]));
  return rubric.requirements.map((req) => {
    const v = byId.get(req.id) || {};
    let status = ['met', 'partial', 'contradicted'].includes(v.status) ? v.status : 'not_shown';
    const quote = v.quote ? String(v.quote).trim() : '';
    let ungrounded = false;
    if (status !== 'not_shown') {
      const grounded = quote && quoteInProfile(quote, text, index);
      if (!grounded) { status = 'not_shown'; ungrounded = true; }
    }
    return { id: req.id, text: req.text, weight: req.weight, status, quote: status === 'not_shown' ? null : quote, ungrounded };
  });
}

/**
 * Score gated verdicts. Core requirements weigh double. A contradicted core
 * requirement halves the score — the profile shows the person is NOT what the role
 * non-negotiably needs, which is stronger than silence.
 */
function scoreVerdicts(verdicts) {
  if (!verdicts.length) return 0;
  let total = 0;
  let earned = 0;
  let coreContradicted = false;
  for (const v of verdicts) {
    const w = v.weight === 'core' ? CORE_WEIGHT : SUPPORTING_WEIGHT;
    total += w;
    earned += w * (CREDIT[v.status] || 0);
    if (v.weight === 'core' && v.status === 'contradicted') coreContradicted = true;
  }
  let fit = Math.round((earned / total) * 100);
  if (coreContradicted) fit = Math.round(fit / 2);
  return fit;
}

/** Strengths and gaps in the card's existing vocabulary — facts with their quotes. */
function strengthsAndGaps(verdicts) {
  const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const strengths = verdicts
    .filter((v) => v.status === 'met' || v.status === 'partial')
    .map((v) => `${v.status === 'partial' ? 'partly: ' : ''}${short(v.text, 70)} — "${short(v.quote, 60)}"`);
  const gaps = verdicts
    .filter((v) => v.weight === 'core' && (v.status === 'not_shown' || v.status === 'contradicted'))
    .map((v) => `${v.status === 'contradicted' ? 'profile contradicts' : 'not shown'}: ${short(v.text, 80)}`);
  return { strengths, gaps };
}

/** A grounded one-liner when the model's own sentence is missing or fails the gate. */
function fallbackWhy(verdicts) {
  const met = verdicts.filter((v) => v.status === 'met');
  if (!met.length) return 'No requirement of this role is shown on the profile.';
  return `Profile shows: ${met.slice(0, 3).map((v) => v.text).join('; ')}.`;
}

// ── 4. Grading calls ──────────────────────────────────────────────────────

const GRADE_SYSTEM = `You check candidates' public profiles against a role's requirements for a VC helping a portfolio company hire.

For EACH candidate and EACH requirement, return a status:
- "met": the profile clearly shows it.
- "partial": the profile shows something close but not the full requirement (e.g. 1 year where 2 are required, an adjacent domain).
- "contradicted": the profile shows the person is clearly NOT this (e.g. requirement is clinical experience and their whole history is software sales).
- "not_shown": the profile does not say either way.

HARD RULES:
- Every "met", "partial", or "contradicted" MUST include "quote": a short phrase copied EXACTLY, character for character, from THAT candidate's profile. No quote you can copy exactly → use "not_shown".
- Judge only from the profile text given. Never assume a credential from a job title unless the title states it (an "RN" in the title shows an RN license; "Care Coordinator" does not).
- "why": one plain sentence on the fit, citing only what the profile shows. "why_quote": an exact phrase from the profile supporting it.

Return ONLY JSON: {"grades":[{"i":<candidate number>,"requirements":[{"id":"r1","status":"...","quote":"..."}],"why":"...","why_quote":"..."}]}`;

/**
 * Grade candidates against a rubric. Returns a Map candidate.id → grade, plus the
 * errors that made any chunk produce nothing (never swallowed).
 *
 * @param deps.cached  Map candidate.id → prior grade; reused when the rubric and the
 *                     candidate's text are unchanged, so a re-source does not re-pay.
 */
async function gradeCandidates({ client, role, rubric, candidates, cached = new Map() }) {
  const rHash = sha(rubric.requirements);
  const grades = new Map();
  const todo = [];
  for (const c of candidates) {
    const text = candidateText(c);
    const tHash = sha(text);
    const prior = cached.get(c.id);
    if (prior && prior.rubric_hash === rHash && prior.text_hash === tHash && Array.isArray(prior.requirements)) {
      grades.set(c.id, { ...prior, reused: true });
    } else {
      todo.push({ c, text, tHash });
    }
  }
  if (!client || !todo.length) return { grades, errors: client ? [] : ['No Anthropic key — candidates were not graded.'], graded: 0, reused: grades.size };

  const reqList = rubric.requirements.map((r) => `${r.id} [${r.weight}]: ${r.text}`).join('\n');
  const chunks = [];
  for (let i = 0; i < todo.length; i += GRADE_CHUNK) chunks.push(todo.slice(i, i + GRADE_CHUNK));
  const errors = [];

  await runPool(chunks.map((chunk) => async () => {
    const blocks = chunk.map((t, j) => `=== CANDIDATE ${j} ===\n${t.text}`).join('\n\n');
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 400 + 450 * chunk.length, temperature: 0,
        system: GRADE_SYSTEM,
        messages: [{ role: 'user', content: `ROLE: ${role.title || ''}${role.domain ? ` — ${role.domain}` : ''}\n\nREQUIREMENTS:\n${reqList}\n\n${blocks}` }],
      });
      const parsed = firstJson(resp.content?.[0]?.text);
      if (!parsed || !Array.isArray(parsed.grades)) { errors.push('Grading returned no usable JSON for one batch.'); return; }
      for (const g of parsed.grades) {
        // The model echoes the index it was shown WITHIN this chunk. Resolve it here and
        // nowhere else — re-basing it wrongly is how a grade lands on a stranger.
        const t = chunk[Number(g && g.i)];
        if (!t) continue;
        const verdicts = gateVerdicts(rubric, g.requirements, t.text);
        const whyQuote = g.why_quote ? String(g.why_quote) : '';
        const whyGrounded = g.why && whyQuote && quoteInProfile(whyQuote, t.text);
        grades.set(t.c.id, {
          fit: scoreVerdicts(verdicts),
          requirements: verdicts,
          why: whyGrounded ? String(g.why).trim() : fallbackWhy(verdicts),
          why_grounded: !!whyGrounded,
          ungrounded_quotes: verdicts.filter((v) => v.ungrounded).length,
          rubric_hash: rHash,
          text_hash: t.tHash,
          ...strengthsAndGaps(verdicts),
        });
      }
    } catch (e) {
      errors.push(describeLlmError(e, 'Grading').message);
    }
  }), GRADE_CONCURRENCY);

  const graded = [...grades.values()].filter((g) => !g.reused).length;
  return { grades, errors: [...new Set(errors)], graded, reused: grades.size - graded };
}

module.exports = {
  buildRubric, fallbackRubric, normalizeRubric, rubricHash,
  candidateText, linkedinText,
  gateVerdicts, scoreVerdicts, strengthsAndGaps, fallbackWhy, quoteInProfile,
  gradeCandidates, runPool, sha,
  CORE_WEIGHT, SUPPORTING_WEIGHT, MAX_REQUIREMENTS, GRADE_CHUNK,
};
