'use strict';
// ══════════════════════════════════════════════════════════════════════════
// hiring-exa.js — the active sourcing arm. Take Danny's description and GO FIND
// people whose experience actually aligns with it.
//
// The warm pool is small and the GitHub arm only finds people who publish code.
// Neither answers "source me a senior full-stack engineer with consumer e-commerce
// experience in Chicago." Exa's semantic people-search does — it reads the open web
// (LinkedIn-style profiles) for a described person. This module:
//   1. turns the role into a few precise people-search queries (LLM, grounded in the JD),
//   2. searches Exa (category: people), biased hard to Chicago/Illinois,
//   3. extracts each hit into a structured candidate with its ALIGNED experience —
//      grounded in the profile text, never invented, evidence gated by verify.js,
//   4. attaches a verified IL tie where the text supports one.
//
// Cost: two LLM calls per sourcing run (derive queries + extract the batch) plus the
// Exa search — cents. Billed to the user's key via anthropicFor / resolveKey.
// ══════════════════════════════════════════════════════════════════════════

const https = require('https');
const db = require('../db');
const { anthropicFor, resolveKey, recordCost, describeLlmError, MODEL } = require('../lib/providerKeys');
const { verifyIlTie } = require('../lib/ilTie');
const { buildContextIndex, classifyQuote } = require('../agents/verify');

function httpPost(url, headers, body) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, data: null }); } });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    req.write(data); req.end();
  });
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)]; } catch { return [v]; }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Role → people-search queries, grounded in the JD.
//
// THE CHICAGO BIAS USED TO BE UNCONDITIONAL, AND THAT IS A CATEGORY ERROR.
//
// The system prompt asked for "a Chicago/Illinois location bias" and the no-LLM
// fallback appended "in Chicago or Illinois", on every role, regardless of what the
// role said. hiring_roles.il_only exists precisely to express this and was never read
// here.
//
// The Illinois preference is Danny's FOUNDER thesis — he wants to be early to
// builders in his own back yard, and geography is the moat. It is not how his
// portfolio hires. Perspectives Health needs a founding engineer with healthtech
// scale-up experience; Hale needs a CMO who has built a consumer brand. The best of
// either is wherever they are, and biasing the search to Illinois quietly searched
// for a worse person.
//
// So the bias now follows the role: hard when il_only is set, a stated preference
// when the role names a location, and absent otherwise.
// ══════════════════════════════════════════════════════════════════════════
function locationClause(role) {
  if (role.il_only) return { hard: true, text: 'in Chicago or Illinois' };
  const pref = String(role.location_pref || '').trim();
  if (pref) return { hard: false, text: `based in or open to ${pref}` };
  return { hard: false, text: '' };
}

async function deriveQueries({ client, role }) {
  const stack = parseArr(role.must_have_stack).join(', ');
  const musts = parseArr(role.must_haves).join('; ');
  const base = `${role.seniority || ''} ${role.title || role.role_function || 'person'}`.trim();
  const loc = locationClause(role);
  // A sane fallback if the LLM is unavailable: one query straight from the fields.
  const fallback = [`${base}${stack ? ` with ${stack}` : ''}${role.domain ? ` in ${role.domain}` : ''}${loc.text ? ` ${loc.text}` : ''}`.trim()];
  if (!client) return fallback;

  const locRule = loc.hard
    ? `This role is Illinois-only: every query MUST require a Chicago/Illinois location.`
    : loc.text
      ? `The role states a location preference (${loc.text}); mention it as a preference, never as a requirement.`
      : `The role states NO location requirement. Do NOT add a geographic constraint of any kind — the best candidate may be anywhere.`;

  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 500, temperature: 0.2,
      system: `You turn a role into 3-4 semantic people-search queries for finding candidates whose EXPERIENCE aligns with it. Each query is a natural-language description of the ideal person — seniority, function, concrete skills, and domain. Prefer specifics from the role over generic titles, and make the queries DIFFERENT from each other (e.g. one on the core skill set, one on the domain background, one on the seniority/scope) so together they cover the role rather than repeating it.

LOCATION: ${locRule}

Return ONLY JSON: {"queries":["...","..."]}.`,
      messages: [{ role: 'user', content: `ROLE: ${role.title || ''}\nFUNCTION: ${role.role_function || ''}\nSENIORITY: ${role.seniority || ''}\nMUST-HAVE STACK: ${stack || '(none)'}\nDOMAIN: ${role.domain || '(none)'}\nOTHER MUST-HAVES: ${musts || '(none)'}\nLOCATION PREF: ${role.location_pref || '(none stated)'}\nJD:\n${(role.jd_content || '').slice(0, 2000)}` }],
    });
    const raw = (resp.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const qs = m ? (JSON.parse(m[0]).queries || []) : [];
    const cleaned = qs.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
    return cleaned.length ? cleaned : fallback;
  } catch { return fallback; }
}

// ── 2. Exa people search ──
async function searchExaPeople(query, apiKey, numResults = 10) {
  const { status, data } = await httpPost('https://api.exa.ai/search', { 'x-api-key': apiKey }, {
    query, type: 'auto', num_results: numResults, category: 'people',
    contents: { text: { max_characters: 3000 } },
  });
  if (status !== 200 || !data) return [];
  return (data.results || []).filter((r) => r && (r.url || r.title));
}

// ── 3. Extract structured, GROUNDED candidates from the raw results ──
// One LLM call over the batch. Each candidate's fields and its "aligned experience"
// line must come only from that result's text; an evidence quote is required and
// gated against the result text (verify.js), so an invented company/skill is dropped.
// The function vocabulary the matcher speaks. The extractor must pick from this list
// or say nothing — a free-text function would never match role_function and would
// silently hard-mismatch every role.
const FUNCTIONS = ['engineering', 'gtm', 'product', 'design', 'ops', 'data', 'finance', 'marketing', 'other'];

// ══════════════════════════════════════════════════════════════════════════
// EXTRACT IN CHUNKS. One call over the whole batch capped out.
//
// This sent every result in a single request at max_tokens 2000. That was survivable
// only because the batch was capped at 14 — and the cap was the real problem: three
// queries × eight results, deduped, sliced to 14, then the honesty gate dropped the
// ungrounded. Measured runs returned "12 new (24 considered)" and "4 new (22
// considered)". Four candidates is a sample, not a search.
//
// pipeline/enrichment.js already learned this lesson the expensive way: batches over
// ~30 hit the token ceiling EXACTLY, returned truncated JSON, and the whole batch was
// silently discarded — $0.34 spent for zero rows. So the fix is not a bigger single
// call, it is chunking, at a size well under where that failure begins.
// ══════════════════════════════════════════════════════════════════════════
const EXTRACT_CHUNK = 12;

// Returns { rows, errors, extracted, dropped } — the funnel, not just the survivors.
// `rows` is the graded list; `errors` is why any chunk produced nothing; `dropped` is
// how many the honesty gate rejected. sourceViaExa puts all of it in the run summary.
async function extractCandidates({ client, role, results }) {
  if (!client) return { rows: [], errors: ['No Anthropic key — candidate extraction cannot run.'], extracted: 0, dropped: 0 };
  if (!results.length) return { rows: [], errors: [], extracted: 0, dropped: 0 };
  const stack = parseArr(role.must_have_stack).join(', ');

  const SYSTEM = `You extract candidate profiles from web search results for a VC helping a portfolio company hire. For each result that is clearly a PERSON who could plausibly fit the role, output a structured record using ONLY facts in that result's text.

HARD RULES:
- Never invent a company, title, skill, school, or location not in the text. If a field isn't in the text, use null (or [] for lists).
- "aligned" = one sentence on why THIS person's experience fits the role, grounded in their text. If they don't fit, omit them entirely.
- "evidence" = a short verbatim quote copied EXACTLY from that result's text supporting the alignment.
- "functions" = what THIS PERSON actually does, read from their own title and history, chosen from: ${FUNCTIONS.join(', ')}. This describes the person, NOT the role being hired for — a marketer found while searching for engineers is a marketer. Use [] if their text doesn't say.
- Skip results that aren't a single identifiable person (company pages, directories, articles).

Return ONLY JSON: {"candidates":[{"i":<index>,"name":str,"current_role":str|null,"current_company":str|null,"location":str|null,"tech_stack":[str],"functions":[str],"seniority":str|null,"aligned":str,"evidence":str}]}`;

  // Index against the ORIGINAL array, not the chunk — the model echoes back the
  // number it was shown, and re-basing it per chunk is how a candidate gets attached
  // to a stranger's profile text and passes the evidence gate against the wrong page.
  const chunks = [];
  for (let i = 0; i < results.length; i += EXTRACT_CHUNK) chunks.push(i);

  const parsedAll = [];
  // ══════════════════════════════════════════════════════════════════════
  // A FAILED EXTRACTION AND AN EMPTY ONE LOOK IDENTICAL FROM THE RUN SUMMARY.
  //
  // Chunk errors were console.error'd and otherwise swallowed, so a run whose
  // every chunk 401'd returned zero candidates and reported "Exa: 0 new (60
  // considered, 0 IL)" — which is also exactly what a healthy run looks like when
  // the honesty gate rejects everything. That is the bug 9d6061f fixed for founder
  // sourcing ("'exa 0' could not distinguish a dead key from a working one"), and
  // this arm still had it. Errors are counted and returned so the run summary can
  // say which of the two happened.
  // ══════════════════════════════════════════════════════════════════════
  const errors = [];
  for (const startIdx of chunks) {
    const slice = results.slice(startIdx, startIdx + EXTRACT_CHUNK);
    const blocks = slice.map((r, j) => `#${startIdx + j}\nURL: ${r.url || ''}\nTITLE: ${r.title || ''}\nTEXT: ${String(r.text || '').slice(0, 1200)}`).join('\n\n');
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 3000, temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: `ROLE: ${role.title || role.role_function}${role.seniority ? ` (${role.seniority})` : ''}\nMUST-HAVE STACK: ${stack || '(none)'}\nDOMAIN: ${role.domain || '(none)'}\n\nRESULTS:\n${blocks}` }],
      });
      const raw = (resp.content?.[0]?.text || '').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsedAll.push(...(JSON.parse(m[0]).candidates || []));
      else errors.push(describeLlmError(new Error('no JSON in response'), 'Extraction').message);
    } catch (e) {
      // One bad chunk must not discard the ones that worked — but it must be counted.
      const d = describeLlmError(e, 'Extraction');
      console.error(`[HiringExa] extract chunk at ${startIdx} failed:`, e.message);
      errors.push(d.message);
    }
  }
  const parsed = { candidates: parsedAll };

  const out = [];
  let dropped = 0;
  for (const c of (parsed.candidates || [])) {
    const src = results[Number(c.i)];
    if (!src || !c.name) continue;
    const text = String(src.text || '');
    // Honesty gate: the alignment must be backed by a quote that's really in the text.
    const idx = buildContextIndex(text);
    const grounded = c.evidence && classifyQuote(String(c.evidence), idx) !== 'unverified';
    if (!grounded) { dropped++; continue; } // no real receipt → drop, don't surface an ungrounded lead
    const tie = verifyIlTie([c.location, text].filter(Boolean).join(' • '));
    const url = String(src.url || '');
    const isLinkedIn = /linkedin\.com\/in\//i.test(url);
    out.push({
      name: String(c.name).slice(0, 120),
      headline: [c.current_role, c.current_company].filter(Boolean).join(' @ ') || (c.aligned || '').slice(0, 160),
      current_role: c.current_role || null,
      current_company: c.current_company || null,
      location_city: c.location || (tie.verified ? tie.place : null),
      tech_stack: JSON.stringify(Array.isArray(c.tech_stack) ? c.tech_stack.slice(0, 12) : []),
      // ── The function describes the PERSON, not the search that found them ──
      // This used to be `[role.role_function]` — whichever role's search surfaced
      // someone permanently labelled them that. The pool is global and every role is
      // scored against all of it with function mismatch as the only separator, so
      // that label was a self-fulfilling one: everybody matched the search that found
      // them and nothing else, and the pool could never honestly be reused across
      // Perspectives' engineer and Hale's CMO. Read it from their own title instead,
      // and fall back to the role only when their text genuinely doesn't say.
      role_function: JSON.stringify(
        (Array.isArray(c.functions) ? c.functions : [])
          .map((f) => String(f).toLowerCase().trim())
          .filter((f) => FUNCTIONS.includes(f))
          .slice(0, 3)
          .length
          ? [...new Set((c.functions || []).map((f) => String(f).toLowerCase().trim()).filter((f) => FUNCTIONS.includes(f)))].slice(0, 3)
          : [role.role_function || 'other']
      ),
      linkedin_url: isLinkedIn ? url : null,
      website_url: isLinkedIn ? null : url,
      tier: 'cold',
      source: 'exa',
      il_tie_type: tie.verified && !tie.weak ? tie.type : null,
      il_tie_place: tie.verified && !tie.weak ? tie.place : null,
      il_tie_evidence: tie.verified && !tie.weak ? tie.evidence : null,
      external_id: `exa:${url || c.name}`,
      notes: c.aligned ? `Aligned: ${c.aligned}` : null,
      raw_data: JSON.stringify({ aligned: c.aligned, evidence: c.evidence, url }),
    });
  }
  return { rows: out, errors, extracted: (parsed.candidates || []).length, dropped };
}

// Upsert a cold Exa candidate by (user_id, external_id), then by linkedin_url so the
// same person found twice doesn't duplicate.
const COLS = ['name', 'headline', 'current_role', 'current_company', 'location_city', 'tech_stack', 'role_function', 'linkedin_url', 'website_url', 'tier', 'source', 'il_tie_type', 'il_tie_place', 'il_tie_evidence', 'external_id', 'notes', 'raw_data'];

// ══════════════════════════════════════════════════════════════════════════
// FINDING SOMEONE ON THE OPEN WEB DOES NOT MAKE THEM A STRANGER.
//
// The dedup-by-linkedin_url branch below exists so the same person found twice
// isn't duplicated — correct. But it then wrote the FULL cold row over whatever
// was there, `tier = 'cold'` and `source = 'exa'` included. So the first time an
// Exa query surfaced somebody already in the warm pool, that person stopped being
// warm: they lost the +12 warm bonus in the ranker, lost the "warm · Permute
// Hackathon" badge on the card, and lost the "warm — <source>" line in the export
// Danny sends the founder.
//
// This is latent rather than historical — there are no warm/cold URL collisions in
// the pool today — but it is squarely in the path of normal use. The warm pool is
// sixteen Chicago engineers; the Exa arm searches for Chicago engineers. Kamil
// Chmielewski ("CTO/Full Stack, Masters @ UChicago") is exactly who a query for a
// Chicago full-stack engineer returns, and the warmth would have been deleted by
// the search that found him — silently, with no way to notice from the UI, and in
// the direction that destroys the product's only real edge.
//
// Warmth is provenance: a fact about Danny's relationship, established elsewhere,
// that a web search has no standing to revoke. So on a warm row the enrichment is
// applied (a scraped profile genuinely knows more about their current job than a
// one-line Airtable bio) and the warmth columns are left alone.
// ══════════════════════════════════════════════════════════════════════════
// Warmth and identity are Danny's, established elsewhere; a scrape never rewrites
// them. `name` and `headline` are his too — his own one-line Airtable bio beats a
// scraped summary, and a scrape's rendering of a name ("Kamil C.") is often worse.
const WARM_PRESERVED = new Set(['tier', 'source', 'external_id', 'name', 'headline']);

// An empty JSON array is the extractor saying "the text didn't say", not "they have
// no stack" — treat it as absent so it can't blank a real value.
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') { const s = v.trim(); return !s || s === '[]' || s === '{}'; }
  if (Array.isArray(v)) return !v.length;
  return false;
}

function upsert(userId, row) {
  let existing = db.prepare('SELECT id, tier FROM hiring_candidates WHERE user_id = ? AND external_id = ?').get(userId, row.external_id);
  if (!existing && row.linkedin_url) existing = db.prepare('SELECT id, tier FROM hiring_candidates WHERE user_id = ? AND linkedin_url = ?').get(userId, row.linkedin_url);
  if (existing) {
    // A cold row is fully owned by this engine — overwrite it. A warm row is only
    // ENRICHED: fill what's blank and improve what the scrape genuinely knows
    // better, and never write a null over something we already had. A rescrape that
    // happened not to mention Chicago must not delete a verified Illinois tie.
    const cols = existing.tier === 'warm'
      ? COLS.filter((c) => !WARM_PRESERVED.has(c) && !isEmptyValue(row[c]))
      : COLS;
    if (!cols.length) return 'updated'; // warm row, nothing new to add
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE hiring_candidates SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...cols.map((c) => row[c] ?? null), existing.id);
    return 'updated';
  }
  const cols = ['user_id', ...COLS];
  db.prepare(`INSERT INTO hiring_candidates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(userId, ...COLS.map((c) => row[c] ?? null));
  return 'inserted';
}

/**
 * Source cold candidates for a role via Exa. Returns { inserted, updated, considered, il_tied }.
 */
async function sourceViaExa({ userId = 1, role, deps = {} }) {
  const apiKey = deps.exaKey || resolveKey(userId, 'exa');
  const client = deps.client || anthropicFor(userId, 'hiring_exa_source');
  if (!apiKey) return { error: 'no_exa_key', inserted: 0, updated: 0, considered: 0 };

  const queries = deps.queries || await deriveQueries({ client, role });
  const out = { inserted: 0, updated: 0, considered: 0, il_tied: 0, queries };
  const search = deps.searchExaPeople || searchExaPeople;

  // Run the searches in PARALLEL (each ~2s), then ONE extraction over the combined,
  // deduped set (~20-25s). Doing an extract per query was 3× the wall-clock for no
  // gain — the LLM call is the cost, so we make exactly one.
  // 15 per query, not 8. The whole point of several distinct queries is coverage, and
  // eight results each meant the deduped pool was barely larger than one query's worth.
  const lists = await Promise.all(queries.map((q) => search(q, apiKey, 15).catch(() => [])));
  recordCost(userId, { provider: 'exa', feature: 'hiring_source', estCostUsd: 0.015 * queries.length });
  const seen = new Set();
  const fresh = [];
  for (const list of lists) {
    for (const r of list) {
      const k = r.url || r.title;
      if (!k || seen.has(k)) continue;
      seen.add(k); fresh.push(r);
    }
  }
  out.considered = fresh.length;
  // 36, chunked, rather than 14 in one capped call. This is the number that decides
  // how many real names a founder ever sees.
  const ex = await extractCandidates({ client, role, results: fresh.slice(0, 36) });
  for (const row of ex.rows) {
    const res = upsert(userId, row);
    out[res]++;
    if (row.il_tie_type) out.il_tied++;
  }
  // The funnel, so "0 new" can be read. Without these, a dead Anthropic key and a
  // strict honesty gate produce byte-identical summaries.
  out.extracted = ex.extracted;
  out.ungrounded_dropped = ex.dropped;
  if (ex.errors.length) out.errors = [...new Set(ex.errors)];
  return out;
}

module.exports = { sourceViaExa, deriveQueries, searchExaPeople, extractCandidates, locationClause, FUNCTIONS, __httpPost: httpPost };
