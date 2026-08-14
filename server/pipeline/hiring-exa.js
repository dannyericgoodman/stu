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
const { anthropicFor, resolveKey, recordCost, MODEL } = require('../lib/providerKeys');
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

// ── 1. Role → people-search queries (grounded in the JD; Chicago/IL-biased) ──
async function deriveQueries({ client, role }) {
  const stack = parseArr(role.must_have_stack).join(', ');
  const musts = parseArr(role.must_haves).join('; ');
  const base = `${role.seniority || ''} ${role.title || role.role_function || 'person'}`.trim();
  // A sane fallback if the LLM is unavailable: one query straight from the fields.
  const fallback = [`${base}${stack ? ` with ${stack}` : ''}${role.domain ? ` in ${role.domain}` : ''} in Chicago or Illinois`];
  if (!client) return fallback;
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 400, temperature: 0.2,
      system: `You turn a role into 2-3 semantic people-search queries for finding candidates whose EXPERIENCE aligns with it. Each query is a natural-language description of the ideal person — seniority, function, concrete skills, domain, and a Chicago/Illinois location bias. Prefer specifics from the role over generic titles. Return ONLY JSON: {"queries":["...","..."]}.`,
      messages: [{ role: 'user', content: `ROLE: ${role.title || ''}\nFUNCTION: ${role.role_function || ''}\nSENIORITY: ${role.seniority || ''}\nMUST-HAVE STACK: ${stack || '(none)'}\nDOMAIN: ${role.domain || '(none)'}\nOTHER MUST-HAVES: ${musts || '(none)'}\nJD:\n${(role.jd_content || '').slice(0, 2000)}` }],
    });
    const raw = (resp.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const qs = m ? (JSON.parse(m[0]).queries || []) : [];
    const cleaned = qs.map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
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
async function extractCandidates({ client, role, results }) {
  if (!client || !results.length) return [];
  const blocks = results.map((r, i) => `#${i}\nURL: ${r.url || ''}\nTITLE: ${r.title || ''}\nTEXT: ${String(r.text || '').slice(0, 1200)}`).join('\n\n');
  const stack = parseArr(role.must_have_stack).join(', ');
  let parsed;
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 2000, temperature: 0,
      system: `You extract candidate profiles from web search results for a VC helping a portfolio company hire. For each result that is clearly a PERSON who could plausibly fit the role, output a structured record using ONLY facts in that result's text.

HARD RULES:
- Never invent a company, title, skill, school, or location not in the text. If a field isn't in the text, use null (or [] for lists).
- "aligned" = one sentence on why THIS person's experience fits the role, grounded in their text. If they don't fit, omit them entirely.
- "evidence" = a short verbatim quote copied EXACTLY from that result's text supporting the alignment.
- Skip results that aren't a single identifiable person (company pages, directories, articles).

Return ONLY JSON: {"candidates":[{"i":<index>,"name":str,"current_role":str|null,"current_company":str|null,"location":str|null,"tech_stack":[str],"seniority":str|null,"aligned":str,"evidence":str}]}`,
      messages: [{ role: 'user', content: `ROLE: ${role.title || role.role_function}${role.seniority ? ` (${role.seniority})` : ''}\nMUST-HAVE STACK: ${stack || '(none)'}\nDOMAIN: ${role.domain || '(none)'}\n\nRESULTS:\n${blocks}` }],
    });
    const raw = (resp.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { candidates: [] };
  } catch (e) { console.error('[HiringExa] extract failed:', e.message); return []; }

  const out = [];
  for (const c of (parsed.candidates || [])) {
    const src = results[Number(c.i)];
    if (!src || !c.name) continue;
    const text = String(src.text || '');
    // Honesty gate: the alignment must be backed by a quote that's really in the text.
    const idx = buildContextIndex(text);
    const grounded = c.evidence && classifyQuote(String(c.evidence), idx) !== 'unverified';
    if (!grounded) continue; // no real receipt → drop, don't surface an ungrounded lead
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
      role_function: JSON.stringify([role.role_function || 'other']),
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
  return out;
}

// Upsert a cold Exa candidate by (user_id, external_id), then by linkedin_url so the
// same person found twice doesn't duplicate.
const COLS = ['name', 'headline', 'current_role', 'current_company', 'location_city', 'tech_stack', 'role_function', 'linkedin_url', 'website_url', 'tier', 'source', 'il_tie_type', 'il_tie_place', 'il_tie_evidence', 'external_id', 'notes', 'raw_data'];
function upsert(userId, row) {
  let existing = db.prepare('SELECT id FROM hiring_candidates WHERE user_id = ? AND external_id = ?').get(userId, row.external_id);
  if (!existing && row.linkedin_url) existing = db.prepare('SELECT id FROM hiring_candidates WHERE user_id = ? AND linkedin_url = ?').get(userId, row.linkedin_url);
  if (existing) {
    const sets = COLS.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE hiring_candidates SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...COLS.map((c) => row[c] ?? null), existing.id);
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
  const lists = await Promise.all(queries.map((q) => search(q, apiKey, 8).catch(() => [])));
  recordCost(userId, { provider: 'exa', feature: 'hiring_source', estCostUsd: 0.01 * queries.length });
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
  const cands = await extractCandidates({ client, role, results: fresh.slice(0, 14) });
  for (const row of cands) {
    const res = upsert(userId, row);
    out[res]++;
    if (row.il_tie_type) out.il_tied++;
  }
  return out;
}

module.exports = { sourceViaExa, deriveQueries, searchExaPeople, extractCandidates, __httpPost: httpPost };
