// ══════════════════════════════════════════════════════════════════════════
// roleIngest.js — a JD becomes a structured role.
//
// Three ways a job description arrives (the brief's hard requirement — all must
// work): a PDF, a link (Greenhouse/Lever/Notion/a careers page), or a sentence
// Danny types ("need a founding backend eng for Hale, Chicago"). This module turns
// any of the three into ONE thing: readable JD text, then a structured role.
//
// TWO RULES, both borrowed from the sourcing side's scars:
//   1. EXTRACT THE TEXT OR FAIL LOUDLY. A JD we couldn't read must not become a
//      role with invented requirements. The PDF/URL guards here mirror lib/ingest.js
//      deliberately (an image-only PDF, a login wall, a JS-gated page all yield
//      text-that-isn't-a-JD) — copied rather than shared so the founder ingest path
//      is left completely untouched.
//   2. PARSE AT TEMPERATURE 0, AND NEVER INVENT. The model fills only what the JD
//      states. A senior title the JD doesn't give, a stack it doesn't name, a comp
//      band it doesn't quote — all stay blank. An invented must-have is worse than a
//      missing one: it silently narrows the shortlist against a requirement the
//      founder never had.
// ══════════════════════════════════════════════════════════════════════════

const https = require('https');
const { anthropicFor, resolveKey, recordCost, MODEL } = require('./providerKeys');

// Canonical functions — the same set the warm pool (Airtable Function(s)) and the
// matcher speak, so a role's function lines up with a candidate's without translation.
const ROLE_FUNCTIONS = ['engineering', 'data', 'product', 'design', 'gtm', 'ops', 'finance', 'marketing', 'other'];

// ── URL read (Exa), mirroring lib/ingest.js's guards ──
const BLOCKED_HOSTS = [/(^|\.)linkedin\.com$/i];
const AUTH_WORDS = /\b(sign in|sign up|log ?in|create (an )?account|forgot password|continue with (google|github|sso)|access denied|403 forbidden|page not found|enable javascript|verify you are human|are you a robot)\b/i;

function httpPostJson(hostname, path, headers, body) {
  return new Promise((resolve) => {
    const d = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, data: null }); } });
      }
    );
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    req.write(d);
    req.end();
  });
}

async function readUrl({ url, userId, deps = {} }) {
  const key = 'exaKey' in deps ? deps.exaKey : resolveKey(userId, 'exa');
  if (!key) return { error: 'No Exa key configured — add one in Settings to read a JD link.' };

  let host;
  try { host = new URL(url).hostname; } catch { return { error: `Not a URL: ${url}` }; }
  if (BLOCKED_HOSTS.some((re) => re.test(host))) {
    return { error: 'LinkedIn blocks crawlers — paste the JD text in instead.' };
  }

  const post = deps.post || httpPostJson;
  const { status, data } = await post('api.exa.ai', '/contents', { 'x-api-key': key },
    { urls: [url], text: { maxCharacters: 20000 } });
  if (status !== 200 || !data?.results?.length) return { error: `Couldn't read ${host} (HTTP ${status}).` };

  const r = data.results[0];
  const text = String(r.text || '').trim();
  const title = String(r.title || '');
  if (text.length < 120) return { error: `${host} returned almost no text (${text.length} chars) — probably JS-rendered or gated. Paste the JD in as text.` };

  const titleIsGate = AUTH_WORDS.test(title) || /^\s*(404|403|error)\b/i.test(title);
  const bodyIsGate = AUTH_WORDS.test(text.slice(0, 160)) && text.length < 700;
  if (titleIsGate || bodyIsGate) {
    return { error: `${host} served a login or error page, not a JD. Paste the JD text in instead.` };
  }
  recordCost(userId, { provider: 'exa', feature: 'hiring_jd_read', estCostUsd: 0.005 });
  return { text, jd_ref: url };
}

async function readPdf({ buffer, fileName }) {
  let parsed;
  try {
    const pdf = require('pdf-parse');
    parsed = await pdf(buffer);
  } catch (e) {
    return { error: `Couldn't read that PDF: ${e.message}` };
  }
  const text = String(parsed.text || '').trim();
  // The classic failure: a JD exported as images. Parses fine, yields ~nothing.
  if (text.length < 120) {
    return { error: `That PDF has almost no extractable text (${text.length} chars across ${parsed.numpages} pages) — probably an image export. Use a text PDF or paste the JD in.` };
  }
  return { text, jd_ref: fileName || 'uploaded.pdf' };
}

/**
 * Get readable JD text from whichever of the three inputs was provided.
 * @returns { text, jd_source, jd_ref } | { error }
 */
async function extractJdText({ jdSource, buffer, fileName, url, text, userId, deps = {} }) {
  if (jdSource === 'pdf' || buffer) {
    const r = await readPdf({ buffer, fileName });
    return r.error ? r : { ...r, jd_source: 'pdf' };
  }
  if (jdSource === 'url' || (url && !text)) {
    const r = await readUrl({ url, userId, deps });
    return r.error ? r : { ...r, jd_source: 'url' };
  }
  const body = String(text || '').trim();
  if (!body) return { error: 'No JD provided — upload a PDF, paste a link, or describe the role.' };
  // A described role can be a single sentence; a full pasted JD can be long. Both fine.
  return { text: body, jd_source: 'sentence', jd_ref: null };
}

// ── The parse. One temp-0 grounded call. Blanks over guesses. ──
const PARSE_SYSTEM = `You convert a job description (or a one-line description of a role) into a STRUCTURED role object for a VC helping a portfolio company hire.

HARD RULES:
- Fill a field ONLY if the text states or unambiguously implies it. If it doesn't, leave it null (or [] for lists). Do NOT invent requirements, seniority, stack, domain, or comp the text doesn't give. A missing field is correct; a guessed one is a bug.
- must_have_stack = concrete technologies/skills the role REQUIRES (languages, frameworks, tools). nice_to_have_stack = ones it prefers but doesn't require.
- must_haves = hard non-stack requirements the text states (e.g. "5+ years", "on-site in Chicago", "prior founding experience"). Short phrases, quoting the JD's own words where possible.
- role_function must be one of: engineering, data, product, design, gtm, ops, finance, marketing, other. Pick the single best fit. (gtm = sales/BD/marketing-led growth roles; use marketing only for a dedicated marketing role.)
- seniority: one of junior, mid, senior, staff, lead, founding, exec — only if stated/clear; else null.
- comp_note: quote comp/equity exactly as stated; null if the text doesn't mention it. Never fabricate a band.
- location_pref: the location/remote language as stated (e.g. "Chicago, hybrid", "remote (US)"); null if unstated.
- remote_ok: true unless the text clearly requires on-site/in-person.

Return ONLY JSON, no prose:
{"title": string|null, "role_function": string, "seniority": string|null, "must_have_stack": string[], "nice_to_have_stack": string[], "domain": string|null, "must_haves": string[], "location_pref": string|null, "remote_ok": boolean, "comp_note": string|null}`;

function coerceRole(parsed) {
  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [];
  const str = (v) => { const s = v == null ? '' : String(v).trim(); return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'n/a' ? s : null; };
  let fn = String(parsed.role_function || '').toLowerCase().trim();
  if (!ROLE_FUNCTIONS.includes(fn)) fn = 'other';
  return {
    title: str(parsed.title),
    role_function: fn,
    seniority: str(parsed.seniority),
    must_have_stack: arr(parsed.must_have_stack),
    nice_to_have_stack: arr(parsed.nice_to_have_stack),
    domain: str(parsed.domain),
    must_haves: arr(parsed.must_haves),
    location_pref: str(parsed.location_pref),
    remote_ok: parsed.remote_ok === false ? 0 : 1,
    comp_note: str(parsed.comp_note),
  };
}

/**
 * JD text → structured role. Grounded (temp 0), never inventing.
 * @returns { role, model } | { error }
 */
async function parseRole({ userId, jdText, hintTitle }) {
  const client = anthropicFor(userId, 'hiring_jd_parse');
  if (!client) return { error: 'No Anthropic key configured — add one in Settings to parse a JD.' };
  const jd = String(jdText || '').slice(0, 12000);
  if (!jd.trim()) return { error: 'Empty JD.' };
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0,
      system: PARSE_SYSTEM,
      messages: [{ role: 'user', content: `${hintTitle ? `ROLE TITLE HINT: ${hintTitle}\n\n` : ''}JOB DESCRIPTION / DESCRIPTION:\n${jd}` }],
    });
    const raw = (resp.content && resp.content[0] && resp.content[0].text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'Could not parse the JD into a role (no JSON returned).' };
    const role = coerceRole(JSON.parse(m[0]));
    if (!role.title && hintTitle) role.title = String(hintTitle).trim();
    return { role, model: MODEL };
  } catch (e) {
    return { error: `JD parse failed: ${e.message}` };
  }
}

module.exports = { extractJdText, parseRole, coerceRole, ROLE_FUNCTIONS, readUrl, readPdf, __system: PARSE_SYSTEM };
