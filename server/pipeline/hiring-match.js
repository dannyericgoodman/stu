'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-match.js — role → ranked shortlist. The heart of the Hiring product.
//
// Replaces the old match-engine.js (a heuristic weighted sum with no IL tie, no
// warmth, no slope, no grounded rationale) AND the old talent-engine's LLM scoring
// of every candidate. The new shape: score CHEAPLY for everyone (deterministic
// signals), then spend the LLM ONLY on explaining the handful that make the
// shortlist. Cents per role, not dollars.
//
// FOUR AXES, the way a top-decile VC actually ranks a hiring shortlist:
//   1. role-fit    — function match (a GTM person is not an eng hire), must-have
//                    stack overlap, seniority, domain. Cheap, deterministic, grounded.
//   2. IL tie      — verifyIlTie's receipt. A soft boost normally; a HARD filter when
//                    the role is IL-only.
//   3. builder     — github slope + builderSignals. Mostly lifts cold GitHub finds.
//   4. warmth      — a warm fit ALWAYS outranks an EQUAL cold fit. Implemented as a
//                    real bonus (wins ties and near-ties) rather than absolute tier
//                    dominance, so a much stronger cold match can still rank above a
//                    barely-relevant warm contact. "Equal fit → warm wins," not "any
//                    warm beats any cold."
//
// Every strength/gap is a fact about the candidate or a stated requirement of the
// role — never invented. The LLM rationale is honesty-gated (verify.js): its quoted
// evidence must appear in the candidate's own profile text, or it's dropped.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');
const { detectSignals } = require('../lib/builderSignals');
const { anthropicFor, MODEL } = require('../lib/providerKeys');
const { buildContextIndex, classifyQuote } = require('../agents/verify');

// ══════════════════════════════════════════════════════════════════════════
// WARM IS A BONUS. IT USED TO BE A 1,000-POINT TIER, AND THAT WAS WRONG ON THE
// REAL DATA.
//
// The old rule: `rank = (warm ? 1000 : 0) + fit + il`. A flat 1,000 means the whole
// warm tier sorts above the whole cold tier no matter what, so fit stops being a
// ranking input across the boundary and becomes a tiebreak within it.
//
// What that produced for Hale's Founding Full-Stack Engineer role, measured:
//
//   #1-6  warm, fit 43-52, current_role EMPTY, current_company EMPTY, city EMPTY
//         all six from one event, six near-identical rationales
//   #7    Ezekiel Chow — Founding Full Stack Engineer, stealth, Chicago,
//         React + Node + Postgres — fit 82
//
// Danny would have sent his founder six names he cannot describe and buried the one
// that matches the JD. The entire warm pool is 16 people from a single hackathon, so
// "warm" here was never a strong relationship — it was an attendance list.
//
// The intent behind the tier is still right and is preserved: an EQUAL cold match
// should lose to someone Danny knows. A bonus does exactly that — it wins ties and
// near-ties, which is what "equal fit → warm wins" actually means — without letting
// a 33-point fit gap be erased by knowing someone's name.
//
// 12 is calibrated, not picked: it is slightly above the IL bonus (a real
// relationship beats a geography match) and comfortably below the smallest gap that
// should decide a hire. On the measured Hale data it puts Ezekiel Chow first and
// keeps every warm candidate on the list.
//
// rank_score stays an ORDERING KEY only — never shown. The card shows fit_score.
// ══════════════════════════════════════════════════════════════════════════
const WARM_BONUS = 12;
const IL_BONUS = 8;      // a verified Illinois tie, when the role isn't IL-only
const SHORTLIST_FLOOR = 22; // below this fit, don't put someone in front of a founder

// ══════════════════════════════════════════════════════════════════════════
// YOU CANNOT INTRODUCE SOMEONE YOU CANNOT DESCRIBE.
//
// The handoff artifact renders "**1. Name** — role @ company · why". For the six
// warm names above, every one of those fields was empty, so the founder received a
// bare name and a hackathon. That is not a lead, and sending it costs Danny more
// credibility than sending nothing.
//
// So a row needs at least one substantive fact about what this person actually does
// — a current role, a current company, or a headline — before it can be put in front
// of a founder. This is a SHORTLIST gate, not a delete: the candidate stays in the
// pool and the moment enrichment fills any of those fields they rank normally.
// ══════════════════════════════════════════════════════════════════════════
function isDescribable(c) {
  return !!(String(c.current_role || '').trim()
    || String(c.current_company || '').trim()
    || String(c.headline || '').trim());
}

// ── candidate text: everything we can honestly cite about a person ──
function profileText(c) {
  return [
    c.headline, c.current_role, c.current_company, c.superior_connection,
    c.il_tie_evidence, c.notes, c.location_city, c.location_state,
    ...(parseArr(c.tech_stack)), ...(parseArr(c.builder_signals)),
  ].filter(Boolean).join(' • ');
}
function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

// A tech token normalized for comparison: lowercase, dots/pluses/spaces stripped, so
// "Node.js" ~ "nodejs", "C++" ~ "c", "React Native" ~ "reactnative".
function techKey(s) { return String(s || '').toLowerCase().replace(/[.+\s/_-]/g, ''); }

// ── function fit ──
// A candidate can carry multiple functions (warm rows do). 'other' on either side is
// a wildcard — we don't hard-exclude an unknown function, we just don't reward it.
function functionFit(role, cand) {
  const need = String(role.role_function || 'other').toLowerCase();
  const have = parseArr(cand.role_function).map((x) => String(x).toLowerCase());
  if (need === 'other') return { score: 0.6, hardMismatch: false, note: 'role function unspecified' };
  if (!have.length) return { score: 0.5, hardMismatch: false, note: 'candidate function unknown' };
  if (have.includes(need)) return { score: 1, hardMismatch: false, note: `function: ${need}` };
  if (have.includes('other')) return { score: 0.45, hardMismatch: false, note: 'adjacent function' };
  // A concrete, different function (eng role vs a gtm person) is a hard mismatch.
  return { score: 0, hardMismatch: true, note: `function mismatch: role wants ${need}, candidate is ${have.join('/')}` };
}

// ── stack overlap ──
// Match each must-have against the candidate's tech_stack AND their free-text profile
// (warm rows have no structured stack — the bio is the evidence). Returns matched +
// missing so gaps are stated, never guessed.
function stackOverlap(role, cand, text) {
  const must = parseArr(role.must_have_stack);
  const nice = parseArr(role.nice_to_have_stack);
  const haveKeys = new Set(parseArr(cand.tech_stack).map(techKey));
  const textKey = techKey(text);
  const present = (tok) => { const k = techKey(tok); return !!k && (haveKeys.has(k) || textKey.includes(k)); };

  const matched = must.filter(present);
  const missing = must.filter((t) => !present(t));
  const niceMatched = nice.filter(present);

  // ══════════════════════════════════════════════════════════════════════
  // ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE.
  //
  // This scored 0/30 whenever a candidate's text didn't contain the role's stack
  // tokens — which silently punished people for having a SHORT PROFILE rather than
  // for lacking the skill. Danny's warm pool is one-line Airtable bios ("CTO/Full
  // Stack. Masters @ UChicago in computer science"), so every person he actually
  // knows took a 30-point zero on an axis nobody had evidence about, and ranked
  // below a stranger whose scraped profile happened to list React.
  //
  // A 3,000-character scraped LinkedIn profile with no "React" in it IS evidence.
  // A 60-character bio is not. So when there's no structured tech_stack and barely
  // any text, the axis returns null — computeFit renormalizes over the axes it can
  // actually read, exactly as seniorityFit already does for an unknown seniority —
  // and the uncertainty is stated as a gap instead of being hidden inside a score.
  //
  // This never invents a match: `matched` stays empty, so no strength is claimed.
  // It only stops us asserting a weakness we cannot see.
  // ══════════════════════════════════════════════════════════════════════
  const READABLE_PROFILE_CHARS = 200;
  const unreadable = !haveKeys.size && String(text || '').length < READABLE_PROFILE_CHARS;
  const score = !must.length ? null : (unreadable && !matched.length ? null : matched.length / must.length);

  return { score, matched, missing, niceMatched, hasMust: must.length > 0, unevidenced: !!(must.length && score === null) };
}

// ── seniority alignment (light; only when the role states one) ──
const SENIORITY_RANK = { junior: 1, mid: 2, senior: 3, staff: 4, lead: 4, founding: 4, exec: 5 };
function seniorityFit(role, text) {
  const want = SENIORITY_RANK[String(role.seniority || '').toLowerCase()];
  if (!want) return { score: null, note: null };
  // We rarely have a structured candidate seniority; read cues from the text.
  const t = String(text).toLowerCase();
  const cues = [
    [/\b(founder|founding|co-?founder|cto|chief|vp|head of|principal|staff)\b/, 4],
    [/\b(senior|sr\.?|lead|manager|director)\b/, 3],
    [/\b(junior|jr\.?|new grad|graduate|intern|student|undergrad)\b/, 1],
  ];
  let have = null;
  for (const [re, r] of cues) if (re.test(t)) { have = Math.max(have || 0, r); }
  if (have == null) return { score: 0.6, note: null }; // unknown → mild neutral
  const gap = Math.abs(want - have);
  return { score: gap === 0 ? 1 : gap === 1 ? 0.7 : 0.4, note: gap >= 2 ? 'seniority gap' : null };
}

// ── domain fit (only when the role states a domain) ──
function domainFit(role, text) {
  const d = String(role.domain || '').toLowerCase().trim();
  if (!d) return { score: null };
  return { score: techKey(text).includes(techKey(d)) || String(text).toLowerCase().includes(d) ? 1 : 0.4 };
}

/**
 * Deterministic role-fit for one candidate. Returns fit_score (0-100), the score
 * breakdown, and grounded strengths/gaps. No LLM, no network.
 */
function computeFit(role, cand) {
  const text = profileText(cand);
  const fn = functionFit(role, cand);
  const stack = stackOverlap(role, cand, text);
  const sen = seniorityFit(role, text);
  const dom = domainFit(role, text);

  // Cold builders earn a slope/signal contribution; warm rows usually score 0 here
  // (they earn their rank from warmth + fit instead).
  const slope = Number(cand.github_slope_score) || 0;
  const sigs = detectSignals(cand, { source: 'talent' }).matched;
  const builder = Math.min(1, slope / 10 + (sigs.length ? 0.2 : 0));

  // Weighted sum. Weights renormalize over the axes the role actually specifies, so a
  // sparse JD (title + function only) still produces a sane 0-100 rather than being
  // dragged down by "missing" stack/domain it never asked for.
  const parts = [
    { w: 35, s: fn.score },
    { w: 30, s: stack.score },
    { w: 10, s: sen.score },
    { w: 10, s: dom.score },
    { w: 15, s: builder },
  ].filter((p) => p.s != null);
  const totalW = parts.reduce((a, p) => a + p.w, 0) || 1;
  const fit = Math.round(parts.reduce((a, p) => a + p.w * p.s, 0) / totalW * 100);

  // Grounded strengths / gaps — facts, not adjectives.
  const strengths = [];
  const gaps = [];
  if (fn.score === 1) strengths.push(`${role.role_function} function match`);
  if (stack.matched.length) strengths.push(`stack: ${stack.matched.join(', ')}`);
  if (stack.niceMatched && stack.niceMatched.length) strengths.push(`nice-to-have: ${stack.niceMatched.join(', ')}`);
  if (cand.il_tie_type) strengths.push(`Illinois tie (${cand.il_tie_type}${cand.il_tie_place ? `: ${cand.il_tie_place}` : ''})`);
  if (slope >= 5) strengths.push(`GitHub slope ${slope}/10`);
  for (const sg of sigs.slice(0, 2)) strengths.push(sg.label.toLowerCase());
  if (stack.unevidenced) gaps.push(`stack not evidenced — profile is one line, ${parseArr(role.must_have_stack).join('/')} unverified`);
  else if (stack.hasMust && stack.missing.length) gaps.push(`no stated ${stack.missing.join('/')}`);
  if (fn.hardMismatch) gaps.push(fn.note);
  if (sen.note) gaps.push(sen.note);

  return { fit, breakdown: { function: fn, stack, seniority: sen, domain: dom, builder: Math.round(builder * 100) / 100 }, strengths, gaps, hardMismatch: fn.hardMismatch };
}

/**
 * Rank the whole pool for a role. Applies the IL-only hard filter, drops hard
 * function mismatches and below-floor fits, then sorts by warmth-weighted rank_score.
 * @returns ranked array of { candidate, fit, rank_score, tier, strengths, gaps, breakdown, il }
 */
function rankCandidates(role, candidates) {
  const ilOnly = !!role.il_only;
  const ranked = [];
  for (const cand of candidates) {
    if (ilOnly && !cand.il_tie_type) continue;            // hard filter
    const f = computeFit(role, cand);
    if (f.hardMismatch) continue;                          // never pair an eng role with a GTM person
    if (f.fit < SHORTLIST_FLOOR) continue;                 // don't waste the founder's attention
    if (!isDescribable(cand)) continue;                    // nothing to tell the founder
    const warm = cand.tier === 'warm';
    const rank = (warm ? WARM_BONUS : 0) + f.fit + (cand.il_tie_type && !ilOnly ? IL_BONUS : 0);
    ranked.push({
      candidate: cand, fit: f.fit, rank_score: Math.round(rank * 10) / 10,
      tier: cand.tier || 'cold', strengths: f.strengths, gaps: f.gaps, breakdown: f.breakdown,
      il: cand.il_tie_type ? { type: cand.il_tie_type, place: cand.il_tie_place, evidence: cand.il_tie_evidence } : null,
    });
  }
  // One list, best first. Warmth and an IL tie are weights inside the score, not
  // partitions around it, so a strong stranger and a known name compete directly.
  ranked.sort((a, b) => b.rank_score - a.rank_score || b.fit - a.fit);
  return ranked;
}

// ── the LLM explanation, honesty-gated. ONE call for the whole shortlist. ──
// The model writes a one-line "why this match" per candidate, grounded in that
// candidate's profile text and the role's stated needs. We verify every quote it
// offers against the candidate's own text; an ungrounded quote is dropped and the
// line falls back to the deterministic strengths. The model NEVER invents skills.
function buildExplainPrompt(role, items) {
  const roleLine = [role.title, role.role_function, role.seniority, role.domain].filter(Boolean).join(' · ');
  const must = parseArr(role.must_have_stack).join(', ');
  const cands = items.map((it, i) => {
    const c = it.candidate;
    return `#${i} ${c.name} [${it.tier}]${c.il_tie_type ? ` (IL: ${c.il_tie_type})` : ''}\nprofile: ${profileText(c).slice(0, 400)}\nsignals: ${it.strengths.join('; ') || '—'}`;
  }).join('\n\n');
  return {
    system: `You explain why each candidate fits a role a VC is helping a portfolio company hire. One tight sentence per candidate — concrete, grounded, no fluff.

HARD RULES:
- Cite ONLY facts present in that candidate's profile text. Never claim a skill, company, or credential not in their profile.
- If a candidate is warm (from Danny's network), that's the lead — say so plainly.
- State the gap if there's a material one; don't paper over it.
- Return ONLY JSON: {"lines":[{"i":<index>,"why":"<one sentence>","evidence":["<short verbatim quote from THIS candidate's profile>"]}]}. The evidence quote MUST be copied verbatim from the profile text.`,
    user: `ROLE: ${roleLine}\nMUST-HAVE STACK: ${must || '(unspecified)'}\n\nCANDIDATES:\n${cands}`,
  };
}

async function explainShortlist({ userId, role, items }) {
  const client = anthropicFor(userId, 'hiring_shortlist_explain');
  if (!client || !items.length) return items.map((it) => ({ ...it, rationale: fallbackLine(it) }));
  const { system, user } = buildExplainPrompt(role, items);
  try {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 1200, temperature: 0.2, system, messages: [{ role: 'user', content: user }] });
    const raw = (resp.content && resp.content[0] && resp.content[0].text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { lines: [] };
    const byIdx = new Map((parsed.lines || []).map((l) => [Number(l.i), l]));
    return items.map((it, i) => {
      const line = byIdx.get(i);
      if (!line || !line.why) return { ...it, rationale: fallbackLine(it) };
      // Honesty gate: every offered quote must appear in THIS candidate's profile.
      const idx = buildContextIndex(profileText(it.candidate));
      const groundedEvidence = (line.evidence || []).filter((q) => q && classifyQuote(String(q), idx) !== 'unverified');
      // If the model offered evidence and NONE of it grounded, distrust the line and
      // fall back to the deterministic (fully grounded) strengths.
      if ((line.evidence || []).length && !groundedEvidence.length) return { ...it, rationale: fallbackLine(it), rationale_ungrounded: true };
      return { ...it, rationale: String(line.why).trim(), evidence: groundedEvidence };
    });
  } catch (e) {
    console.error('[HiringMatch] explain failed:', e.message);
    return items.map((it) => ({ ...it, rationale: fallbackLine(it) }));
  }
}

// A grounded one-liner from the deterministic signals — used when no LLM key, or when
// the model's line failed the honesty gate. Always true by construction.
function fallbackLine(it) {
  const bits = [];
  if (it.tier === 'warm' && it.candidate.warm_source) bits.push(`Warm — ${it.candidate.warm_source}`);
  if (it.strengths.length) bits.push(it.strengths.slice(0, 3).join('; '));
  return bits.join('. ') || `${it.fit}/100 fit`;
}

/**
 * Run the matcher for one role: rank the pool, take the top N, explain the shortlist,
 * upsert hiring_matches, log the run. Returns the shortlist + counts.
 */
async function runMatch({ userId = 1, roleId, warmCap = 6, coldCap = 8, explain = true } = {}) {
  const role = db.prepare('SELECT * FROM hiring_roles WHERE id = ? AND user_id = ? AND is_deleted = 0').get(roleId, userId);
  if (!role) return { error: 'Role not found' };
  const pool = db.prepare('SELECT * FROM hiring_candidates WHERE user_id = ? AND is_deleted = 0').all(userId);

  const ranked = rankCandidates(role, pool);
  const warmConsidered = pool.filter((c) => c.tier === 'warm').length;
  const coldConsidered = pool.length - warmConsidered;
  // ── ONE RANKED SHORTLIST ──
  // This used to fill a warm quota and a cold quota separately, which was the only
  // way to stop the 1,000-point warm offset from swallowing the whole list. With
  // warmth scored as a bonus the quotas are not just unnecessary, they're harmful:
  // a warm cap would drop a well-matched known contact at #7 to make room for a
  // weaker stranger, and a cold cap would do the reverse. Take the top N of one list.
  const shortlist = ranked.slice(0, Math.max(1, warmCap + coldCap));
  const explained = explain ? await explainShortlist({ userId, role, items: shortlist }) : shortlist.map((it) => ({ ...it, rationale: fallbackLine(it) }));

  // Upsert matches. Re-running a role refreshes scores/rationale but PRESERVES the
  // handoff status (sourced→shortlisted→shared→…) — a re-match must not reset where
  // Danny has already moved a candidate in the pipeline.
  const upsertMatch = db.transaction((rows) => {
    for (const it of rows) {
      const existing = db.prepare('SELECT id, status FROM hiring_matches WHERE role_id = ? AND candidate_id = ?').get(roleId, it.candidate.id);
      const payload = {
        tier: it.tier, fit_score: it.fit, rank_score: it.rank_score, rationale: it.rationale || null,
        strengths: JSON.stringify(it.strengths || []), gaps: JSON.stringify(it.gaps || []),
        breakdown: JSON.stringify(it.breakdown || {}),
      };
      if (existing) {
        db.prepare(`UPDATE hiring_matches SET tier=?, fit_score=?, rank_score=?, rationale=?, strengths=?, gaps=?, breakdown=?, is_deleted=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(payload.tier, payload.fit_score, payload.rank_score, payload.rationale, payload.strengths, payload.gaps, payload.breakdown, existing.id);
      } else {
        db.prepare(`INSERT INTO hiring_matches (user_id, role_id, candidate_id, tier, fit_score, rank_score, rationale, strengths, gaps, breakdown, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sourced')`)
          .run(userId, roleId, it.candidate.id, payload.tier, payload.fit_score, payload.rank_score, payload.rationale, payload.strengths, payload.gaps, payload.breakdown);
      }
    }
  });
  upsertMatch(explained);

  const warmN = shortlist.filter((it) => it.tier === 'warm').length;
  const summary = `matched role "${role.title}": ${warmConsidered} warm + ${coldConsidered} cold considered → ${shortlist.length} shortlisted (${warmN} warm, ${shortlist.length - warmN} cold)`;
  try { db.prepare(`INSERT INTO hiring_runs (user_id, role_id, kind, warm_considered, cold_considered, shortlisted, summary) VALUES (?, ?, 'match', ?, ?, ?, ?)`).run(userId, roleId, warmConsidered, coldConsidered, shortlist.length, summary); } catch { /* run-log best-effort */ }

  return { role_id: roleId, warm_considered: warmConsidered, cold_considered: coldConsidered, shortlisted: shortlist.length, shortlist: explained, summary };
}

module.exports = {
  runMatch, rankCandidates, computeFit, functionFit, stackOverlap, seniorityFit, domainFit,
  profileText, explainShortlist, fallbackLine, isDescribable, WARM_BONUS, IL_BONUS, SHORTLIST_FLOOR,
};
