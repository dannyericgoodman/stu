'use strict';
// ══════════════════════════════════════════════════════════════════════════
// deal-research.js — the cited market-research layer for an assessment.
//
// The house memos are grounded RESEARCH documents: funded comps with rounds and
// valuations, a dated why-now, market-size anchors, a valuation benchmark. The panel
// synthesis was walled off from all of it ("materials-only, no web"), so Stu could
// write the read but not the research the memo is made of. This closes that gap using
// the same Exa plumbing Source already runs every night — but pointed at the deal, and
// honesty-gated the same way the rest of Stu is.
//
// THE HONESTY GATE (same spirit as the verbatim-quote gate): the model extracts
// structured findings, each one citing a source_url. `gateResearch` then DROPS any
// finding whose url isn't one Exa actually returned. The model cannot invent a
// citation, because a citation it made up names a page that isn't in the set.
//
// This module does NO model calls. It gathers pages (Exa, network) and gates results
// (pure). The one LLM extraction in between is run by the caller through the existing
// runAgent path, so every Anthropic call stays in one place (routes/assessments.js).
// ══════════════════════════════════════════════════════════════════════════

const https = require('https');
const { resolveKey, recordCost, assertWithinBudget } = require('../lib/providerKeys');

const EST_EXA_COST_PER_SEARCH = 0.01; // mirror discovery-engine's flat estimate
const PER_QUERY = 6;
const TEXT_CHARS = 3000;
const MAX_CONTEXT_CHARS = 42_000;

function httpPost(url, headers, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      { method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf || '{}') }); }
          catch { resolve({ status: res.statusCode, data: {} }); }
        });
      }
    );
    req.on('error', () => resolve({ status: 0, data: {} }));
    req.write(data);
    req.end();
  });
}

// General-web Exa search (NOT category:people — this looks for company pages, news,
// funding records, research). Returns [{url,title,text}].
async function exaResearchSearch(apiKey, query, numResults = PER_QUERY, deps = {}) {
  if (deps.exaSearch) return deps.exaSearch(apiKey, query, numResults);
  const resp = await httpPost('https://api.exa.ai/search', { 'x-api-key': apiKey }, {
    query, type: 'auto', num_results: numResults,
    contents: { text: { max_characters: TEXT_CHARS } },
  });
  if (resp.status !== 200) return { results: [], error: `Exa HTTP ${resp.status}` };
  return { results: resp.data.results || [] };
}

// Build the handful of research queries from what we know about the company.
function buildResearchQueries({ name, domain, one_liner } = {}) {
  const co = (name || '').trim();
  const dom = (domain || one_liner || '').trim();
  const subject = co || dom;
  if (!subject) return [];
  const q = [];
  if (co) q.push(`${co} startup ${dom} competitors funding raised seed Series A valuation`);
  q.push(`${dom || co} market size TAM growth 2025 2026`);
  q.push(`${dom || co} 2025 2026 regulation launch acquisition shift why now`);
  q.push(`median seed and pre-seed startup valuation 2026 PitchBook OR Carta OR NVCA`);
  return [...new Set(q.filter(Boolean))];
}

// Gather pages for the deal. Network-only, resilient: any failure degrades to an empty
// result with a status the caller can surface, never throws into the assessment.
async function gatherDealResearch({ userId, company = {}, deps = {} } = {}) {
  let exaKey;
  try {
    assertWithinBudget(userId);
    exaKey = resolveKey(userId, 'exa');
  } catch (e) {
    return { status: e.code === 'spend_cap_exceeded' ? 'spend_cap' : 'error', sources: [], urlSet: new Set(), queries: [], asContext: '' };
  }
  if (!exaKey) return { status: 'no_key', sources: [], urlSet: new Set(), queries: [], asContext: '' };

  const queries = buildResearchQueries(company);
  if (!queries.length) return { status: 'no_subject', sources: [], urlSet: new Set(), queries: [], asContext: '' };

  const settled = await Promise.all(queries.map(async (query) => {
    recordCost(userId, { provider: 'exa', feature: 'deal-research', estCostUsd: EST_EXA_COST_PER_SEARCH });
    try { const r = await exaResearchSearch(exaKey, query, PER_QUERY, deps); return r.error ? [] : r.results; }
    catch { return []; }
  }));

  // Dedupe by url; keep the first text we saw.
  const byUrl = new Map();
  for (const r of settled.flat()) {
    const url = (r.url || '').trim();
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, { url, title: (r.title || '').trim() || url, text: (r.text || '').trim() });
  }
  const sources = [...byUrl.values()];
  const urlSet = new Set(sources.map((s) => s.url));

  // The pages, formatted for the extraction prompt, capped so a long crawl can't blow
  // the token budget. Each page is numbered and carries its url for the citation gate.
  let asContext = '';
  for (const s of sources) {
    const block = `\n[SOURCE] ${s.title}\nURL: ${s.url}\n${s.text}\n`;
    if (asContext.length + block.length > MAX_CONTEXT_CHARS) break;
    asContext += block;
  }

  return { status: sources.length ? 'ok' : 'empty', sources, urlSet, queries, asContext };
}

// The citation honesty gate. Keep only findings whose source_url is one Exa returned.
// `extracted` is whatever the marketResearch agent produced (may be {error}).
function gateResearch(extracted, urlSet) {
  const empty = { comps: [], market_size: [], why_now: [], valuation_benchmarks: [] };
  if (!extracted || extracted.error || typeof extracted !== 'object') {
    return { status: 'empty', findings: empty, dropped: 0, sources: [] };
  }
  let dropped = 0;
  const keep = (arr) => (Array.isArray(arr) ? arr : []).filter((f) => {
    const url = f && typeof f.source_url === 'string' ? f.source_url.trim() : '';
    const ok = url && urlSet.has(url);
    if (!ok) dropped++;
    return ok;
  });
  const findings = {
    comps: keep(extracted.comps),
    market_size: keep(extracted.market_size),
    why_now: keep(extracted.why_now),
    valuation_benchmarks: keep(extracted.valuation_benchmarks),
  };
  // The sources actually cited by a surviving finding, for a tidy "sources" list.
  const cited = new Set();
  for (const arr of Object.values(findings)) for (const f of arr) cited.add(f.source_url);
  const anything = Object.values(findings).some((a) => a.length);
  return {
    status: anything ? 'ok' : 'empty',
    findings,
    dropped,
    sources: [...cited],
  };
}

module.exports = { gatherDealResearch, gateResearch, buildResearchQueries, exaResearchSearch };
