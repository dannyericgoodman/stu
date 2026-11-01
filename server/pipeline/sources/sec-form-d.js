/**
 * sec-form-d.js — SourceConnector: Illinois Form D filers → founder leads.
 *
 * WHY (2026-11 sourcing inspection, Harmonic parity gap #1 on new-company formation and
 * funding events): Harmonic surfaces a company the week its raise becomes public. Stu
 * already pulled Illinois Form D filings nightly (pipeline/filings-source.js) — and then
 * used them ONLY to bump rows it already had, via a fuzzy name match. A first-time
 * founder who files a Form D for a $750K SAFE round, with no LinkedIn post, no press and
 * no accelerator, was never created as a lead. That is exactly the founder this fund is
 * for, and the filing is free, sworn, and lands within 15 days of the first sale.
 *
 * What it does:
 *   1. EDGAR full-text search: forms=D, issuer location IL, last `days` days.
 *   2. Original filings only (form 'D', not 'D/A' amendments of older rounds).
 *   3. For each, the primary_doc.xml → lib/edgar.parseFormD (officers, amount, year of
 *      incorporation, industry group).
 *   4. Keeps only target-shaped issuers: incorporated in the last 3 years, offering
 *      ≤ $5M (or unstated), and not a fund / real-estate / banking / extraction vehicle.
 *   5. Emits one record per Executive Officer, with the filing as the evidence.
 *
 * Tie: the issuer's principal place of business is in Illinois. The record says so in
 * plain words ("Issuer based in Chicago, IL") so lib/ilTie types it `current` — and the
 * evidence line makes clear it is the COMPANY's address, so it can be overruled.
 *
 * Free, no key. SEC asks for a descriptive User-Agent and ≤10 requests/second; this
 * stays far under that. Network failures yield [] — never a thrown run.
 */
const https = require('https');
const { parseFormD } = require('../../lib/edgar');

const UA = process.env.SEC_USER_AGENT || 'Superior Studios Stu sourcing (sourcing@superior.studios)';
const MAX_FILINGS = parseInt(process.env.FORM_D_MAX_FILINGS || '60', 10);
const MAX_OFFERING = parseFloat(process.env.FORM_D_MAX_OFFERING || '5000000');
const MAX_COMPANY_AGE_YEARS = 3;

// Issuers that are not operating startups. Industry group strings are EDGAR's own
// (Form D Item 4). Kept literal and lower-cased for matching.
const EXCLUDED_INDUSTRY = /\b(pooled investment fund|hedge fund|private equity fund|venture capital fund|other investment fund|real estate|reits|commercial banking|insurance$|investing|investment banking|oil and gas|coal mining|mining|lodging|restaurants|retailing|tourism|travel|agriculture|electric utilities)\b/i;
// Entity names that are vehicles, not companies.
const VEHICLE_NAME = /\b(fund|capital partners|holdings|properties|realty|apartments|lp$|l\.p\.|spv|series \d+|investors|partners,? (lp|llc))\b/i;

function httpGet(url, accept = 'application/json') {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': UA, Accept: accept } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.end();
    } catch { resolve({ status: 0, body: '' }); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function searchUrl(days, now = new Date()) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - days * 86400000);
  return `https://efts.sec.gov/LATEST/search-index?q=&dateRange=custom&startdt=${fmt(start)}&enddt=${fmt(now)}&forms=D&locationCode=IL`;
}

/** Normalise one EDGAR full-text-search hit → { cik, accession, entity, city, filed, form }. */
function normalizeHit(hit) {
  if (!hit) return null;
  const s = hit._source || {};
  const idPart = String(hit._id || '').split(':')[0];
  const accession = s.adsh || idPart || null;
  const cik = (Array.isArray(s.ciks) && s.ciks[0]) || null;
  const display = (Array.isArray(s.display_names) && s.display_names[0]) || s.entityName || '';
  const entity = String(display).replace(/\s*\(CIK[^)]*\)\s*/i, '').replace(/\s+/g, ' ').trim() || null;
  const loc = (Array.isArray(s.biz_locations) && s.biz_locations[0]) || '';
  const city = String(loc).split(',')[0].trim() || null;
  const form = s.form || s.file_type || (s.root_forms && s.root_forms[0]) || null;
  return { cik, accession, entity, city, filed: s.file_date || null, form };
}

function primaryDocUrl(cik, accession) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** Is this parsed Form D a target-shaped issuer? Returns { ok, reason }. */
function isTargetIssuer(fd, entity, now = new Date()) {
  if (!fd) return { ok: false, reason: 'unparsed' };
  if (fd.industry && EXCLUDED_INDUSTRY.test(fd.industry)) return { ok: false, reason: `industry: ${fd.industry}` };
  if (entity && VEHICLE_NAME.test(entity)) return { ok: false, reason: 'investment vehicle name' };
  const y = parseInt(fd.year_of_inc, 10);
  if (Number.isFinite(y) && now.getUTCFullYear() - y > MAX_COMPANY_AGE_YEARS) return { ok: false, reason: `incorporated ${y}` };
  if (fd.offering_amount != null && fd.offering_amount > MAX_OFFERING) return { ok: false, reason: `offering $${Math.round(fd.offering_amount / 1e6)}M` };
  if (fd.state && !/^(il|illinois)$/i.test(fd.state) && !/^[A-Z]{2}$/.test(fd.state)) return { ok: false, reason: 'non-US issuer' };
  return { ok: true, reason: null };
}

const money = (n) => (n == null ? 'amount not stated' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);

/** One founder record per executive officer of a target issuer. */
function recordsFor(hit, fd) {
  const execs = (fd.people || []).filter((p) => (p.relationships || []).some((r) => /executive officer/i.test(r)));
  const people = execs.length ? execs : (fd.people || []).slice(0, 1);
  const entity = fd.entity_name || hit.entity;
  const city = hit.city || 'Illinois';
  const evidence = `SEC Form D filed ${hit.filed || ''}: ${entity} — ${fd.offering_amount != null ? `offering ${money(fd.offering_amount)}` : money(null)}`
    + `${fd.amount_sold != null ? `, ${money(fd.amount_sold)} sold` : ''}`
    + `${fd.year_of_inc ? `, incorporated ${fd.year_of_inc}` : ''}${fd.industry ? `, ${fd.industry}` : ''}.`
    + ` Issuer based in ${city}, IL (company address).`;
  return people.map((p) => ({
    name: titleName(p.name),
    entity_name: null,
    company: titleName(entity),
    role: (p.relationships || []).find((r) => /executive officer/i.test(r)) ? 'Founder / Executive Officer' : 'Officer',
    headline: `${(p.relationships || []).join(', ') || 'Officer'}, ${titleName(entity)} — Form D ${hit.filed || ''}`.trim(),
    location_city: city,
    location_state: 'IL',
    linkedin_url: null,
    url: hit.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${Number(hit.cik)}&type=D` : null,
    evidence,
    raw: { cik: hit.cik, accession: hit.accession, form_d: { ...fd, people: undefined } },
  })).filter((r) => r.name && r.company);
}

// EDGAR names are often ALL CAPS ("JANE Q DOE", "ACME LABS INC").
function titleName(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bLlc\b/g, 'LLC').replace(/\bPbc\b/g, 'PBC');
}

async function fetch({ limit = 50, deps = {}, opts = {} } = {}) {
  const get = deps.get || httpGet;
  const days = opts.days || parseInt(process.env.FORM_D_LOOKBACK_DAYS || '14', 10);
  const now = deps.now || new Date();
  const r = await get(searchUrl(days, now));
  if (r.status !== 200 || !r.body) return [];
  let data; try { data = JSON.parse(r.body); } catch { return []; }
  const hits = ((data.hits && data.hits.hits) || []).map(normalizeHit).filter(Boolean)
    .filter((h) => h.cik && h.accession && (!h.form || String(h.form).toUpperCase() === 'D'));

  const out = [];
  const seen = new Set();
  let fetched = 0;
  for (const h of hits) {
    if (fetched >= Math.min(MAX_FILINGS, Math.max(limit, 1) * 2)) break;
    if (seen.has(h.accession)) continue;
    seen.add(h.accession);
    if (h.entity && VEHICLE_NAME.test(h.entity)) continue; // skip before spending a request
    fetched++;
    if (!deps.get) await sleep(150);
    const doc = await get(primaryDocUrl(h.cik, h.accession), 'application/xml');
    if (doc.status !== 200 || !doc.body) continue;
    let fd; try { fd = parseFormD(doc.body); } catch { continue; }
    if (!isTargetIssuer(fd, fd.entity_name || h.entity, now).ok) continue;
    out.push(...recordsFor(h, fd));
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  key: 'sec_form_d',
  label: 'SEC Form D — new Illinois raises',
  emits: 'form_d_filing',
  free: true,
  cadence: 'daily',
  nationalWatchlist: false,
  fetch,
  normalizeHit,
  isTargetIssuer,
  recordsFor,
  searchUrl,
  primaryDocUrl,
  titleName,
};
