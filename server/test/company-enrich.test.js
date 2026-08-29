const test = require('node:test');
const assert = require('node:assert');
const { fetchHeadcountSeries, fetchHeadcountAt, fetchCompanyProfile, enrichCompany } = require('../pipeline/company-enrich');

// ══════════════════════════════════════════════════════════════════════════
// Company enrichment. The HTTP call is injected, so every path/param below is
// asserted against EnrichLayer's documented contract without touching network.
//
// This matters more than usual here. Two connectors in this repo call endpoints
// that don't do what their code claims — USPTO hits a path that has never
// existed, and Form D passed `locationCode` (singular), which EDGAR silently
// ignores while cheerfully returning identical nationwide results for every
// state. Both shipped because nobody asserted the request. So: assert the
// request, not just the response.
// ══════════════════════════════════════════════════════════════════════════

const KEY = 'test-key';
const URL_ = 'https://linkedin.com/company/acme';

function stub(handler) {
  const calls = [];
  return {
    calls,
    getJson: async (url, headers) => { calls.push({ url, headers }); return handler(url, headers); },
  };
}

test('company profile hits the documented path with Bearer auth', async () => {
  const s = stub(() => ({ status: 200, data: { name: 'Acme', industry: 'Software Development' } }));
  await fetchCompanyProfile(URL_, KEY, { deps: { getJson: s.getJson } });

  const { url, headers } = s.calls[0];
  assert.ok(url.startsWith('https://enrichlayer.com/api/v2/company?'), `wrong path: ${url}`);
  assert.match(url, /url=https%3A%2F%2Flinkedin\.com%2Fcompany%2Facme/);
  assert.match(url, /funding_data=include/);
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});

test('headcount hits the employees/count path and passes at_date', async () => {
  const s = stub(() => ({ status: 200, data: { verified_employee_count: 12 } }));
  await fetchHeadcountAt(URL_, KEY, '2026-01-15', { deps: { getJson: s.getJson } });

  const { url } = s.calls[0];
  assert.ok(url.startsWith('https://enrichlayer.com/api/v2/company/employees/count?'), `wrong path: ${url}`);
  assert.match(url, /at_date=2026-01-15/);
});

test('no at_date means today — the param is omitted, not sent empty', async () => {
  const s = stub(() => ({ status: 200, data: { verified_employee_count: 12 } }));
  await fetchHeadcountAt(URL_, KEY, null, { deps: { getJson: s.getJson } });
  assert.ok(!s.calls[0].url.includes('at_date'), 'at_date must be absent, not blank');
});

// A verified 12 and an estimated 12 are not the same claim.
test('verified count wins over estimated, and says which it used', async () => {
  const s = stub(() => ({ status: 200, data: { verified_employee_count: 12, estimated_employee_count: 40 } }));
  const r = await fetchHeadcountAt(URL_, KEY, null, { deps: { getJson: s.getJson } });
  assert.equal(r.count, 12);
  assert.equal(r.verified, true);

  const s2 = stub(() => ({ status: 200, data: { estimated_employee_count: 40 } }));
  const r2 = await fetchHeadcountAt(URL_, KEY, null, { deps: { getJson: s2.getJson } });
  assert.equal(r2.count, 40);
  assert.equal(r2.verified, false);
});

// ── The growth curve ──
test('a growth series computes a real slope', async () => {
  // 12mo ago: 20 people. now: 50. -> +30, +150%, growing.
  const counts = [50, 40, 30, 20]; // now, -3, -6, -12
  let i = 0;
  const s = stub(() => ({ status: 200, data: { verified_employee_count: counts[i++] } }));

  const r = await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } });
  assert.equal(r.now, 50);
  assert.equal(r.delta_12mo, 30);
  assert.equal(r.growth_12mo_pct, 150);
  assert.equal(r.hiring, 'growing');
  assert.equal(r.series.length, 4);
  // Oldest first — a curve reads left to right.
  assert.equal(r.series[0].months_ago, 12);
});

// ── The percentage is suppressed at pre-seed scale ──
// From the first live run: Permute AI went 1 -> 2 -> 3 -> 3 over 12 months, and
// the honest arithmetic is "+200% growth". True, and useless — they hired two
// people. Danny's entire book is 2-10 person companies, so a ratio off a base
// this small is always noise, and a number that reads precise while meaning
// nothing invites a comparison between a 1->3 and a 40->120 that the arithmetic
// supports and reality does not.
test('a tiny base suppresses the percentage and leads with the delta', async () => {
  const counts = [3, 3, 2, 1]; // the real Permute curve
  let i = 0;
  const s = stub(() => ({ status: 200, data: { verified_employee_count: counts[i++] } }));

  const r = await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } });
  assert.equal(r.now, 3);
  assert.equal(r.delta_12mo, 2, 'the delta is the whole truth: they hired 2 people');
  assert.equal(r.growth_12mo_pct, null, '+200% off a base of 1 is not a growth rate');
  assert.match(r.pct_suppressed, /too small/);
  assert.equal(r.hiring, 'growing', 'direction is still knowable');
});

test('at real scale the percentage survives', async () => {
  const counts = [120, 90, 60, 40]; // base of 40 — a ratio means something here
  let i = 0;
  const s = stub(() => ({ status: 200, data: { verified_employee_count: counts[i++] } }));
  const r = await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } });
  assert.equal(r.growth_12mo_pct, 200);
  assert.equal(r.pct_suppressed, null);
});

test('shrinking is reported as shrinking, not as a negative growth number to squint at', async () => {
  const counts = [4, 6, 8, 10]; // now=4 … 12mo ago=10
  let i = 0;
  const s = stub(() => ({ status: 200, data: { verified_employee_count: counts[i++] } }));
  const r = await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } });
  assert.equal(r.hiring, 'shrinking');
  assert.equal(r.delta_12mo, -6);
});

// The conviction engine's rule, one layer up: an unmeasured company is not a flat
// company. n=1 must not render as 0% growth.
test('a single data point yields NULL growth, never 0', async () => {
  let i = 0;
  const s = stub(() => (i++ === 0 ? { status: 200, data: { verified_employee_count: 10 } } : { status: 404, data: null }));
  const r = await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } });
  assert.equal(r.now, 10);
  assert.equal(r.growth_12mo_pct, null, 'one point is not a trend');
  assert.equal(r.delta_12mo, null);
  assert.equal(r.hiring, null, 'null means unknown — not flat');
});

test('a company that returns nothing enriches to null, it does not invent zeros', async () => {
  const s = stub(() => ({ status: 404, data: null }));
  assert.equal(await fetchHeadcountSeries(URL_, KEY, { deps: { getJson: s.getJson } }), null);
  assert.equal(await enrichCompany(URL_, { deps: { key: KEY, getJson: s.getJson } }), null);
});

test('dormant without a key — never throws, never calls out', async () => {
  const s = stub(() => ({ status: 200, data: {} }));
  assert.equal(await enrichCompany(URL_, { deps: { key: null, getJson: s.getJson } }), null);
  assert.equal(s.calls.length, 0, 'must not call the API without a key');
});

test('no linkedin url means no call', async () => {
  const s = stub(() => ({ status: 200, data: {} }));
  assert.equal(await enrichCompany(null, { deps: { key: KEY, getJson: s.getJson } }), null);
  assert.equal(s.calls.length, 0);
});

// company_size is a [min,max] bucket; company_size_on_linkedin is the real count.
// They disagree constantly, so both are kept rather than reconciled.
test('both size fields survive — the range and the integer', async () => {
  const s = stub((url) =>
    url.includes('employees/count')
      ? { status: 200, data: { verified_employee_count: 7 } }
      : { status: 200, data: { name: 'Acme', company_size: [2, 10], company_size_on_linkedin: 7, founded_year: 2024 } }
  );
  const r = await enrichCompany(URL_, { deps: { key: KEY, getJson: s.getJson } });
  assert.deepEqual(r.size_range, [2, 10]);
  assert.equal(r.size_on_linkedin, 7);
  assert.equal(r.founded_year, 2024);
});

// ══════════════════════════════════════════════════════════════════════════
// The roster path — one call for the curve, the team, and prior employers.
//
// Danny, showing LinkedIn Premium's "400% employee growth" card: "They have
// employee growth data in LinkedIn. I think you can learn these insights
// cheaply." He was right and I'd built it the expensive way: at_date buys one
// crude snapshot per credit and can never say WHO those people are.
//
// Fixture is the real Permute AI response (2026-07-15).
// ══════════════════════════════════════════════════════════════════════════
const { fetchRoster, rosterToPeople, curveFromPeople } = require('../pipeline/company-enrich');

const PERMUTE = [
  { profile_url: 'https://linkedin.com/in/scottnelson', profile: {
    full_name: 'Scott Nelson', occupation: 'Co-Founder & CEO at Permute AI',
    experiences: [
      { company: 'Permute AI', title: 'Co-Founder & CEO', starts_at: { year: 2025, month: 7 }, ends_at: null },
      { company: 'Density Collective', title: 'Founder', starts_at: { year: 2021, month: 1 }, ends_at: { year: 2025, month: 6 } },
      { company: 'Scout Space', title: 'PM', starts_at: { year: 2019, month: 3 }, ends_at: { year: 2021, month: 1 } },
    ], education: [{ school: 'Northwestern University' }] } },
  { profile_url: 'https://linkedin.com/in/ericmills', profile: {
    full_name: 'Eric Mills', occupation: 'Co-founder and CTO at Permute AI',
    experiences: [
      { company: 'Permute AI', title: 'Co-founder and CTO', starts_at: { year: 2025, month: 8 }, ends_at: null },
      { company: 'Density Collective', title: 'Eng', starts_at: { year: 2022, month: 1 }, ends_at: { year: 2025, month: 7 } },
    ], education: [] } },
  { profile_url: 'https://linkedin.com/in/parsia', profile: {
    full_name: 'Parsia Hedayat', occupation: 'Founding AI Researcher',
    experiences: [
      { company: 'Permute AI', title: 'Founding AI Researcher', starts_at: { year: 2026, month: 3 }, ends_at: null },
      { company: 'Integral Ad Science', title: 'ML Eng', starts_at: { year: 2023, month: 5 }, ends_at: { year: 2026, month: 2 } },
    ], education: [] } },
];

test('roster: never sends sort_by — it costs +50 base and we can sort for free', async () => {
  const s = stub(() => ({ status: 200, data: { employees: [] } }));
  await fetchRoster(URL_, KEY, { deps: { getJson: s.getJson } });
  const { url, headers } = s.calls[0];
  assert.ok(url.startsWith('https://enrichlayer.com/api/v2/company/employees/?'), `wrong path: ${url}`);
  assert.ok(!url.includes('sort_by'), 'sort_by is +50 base +10/employee — never send it');
  assert.match(url, /enrich_profiles=enrich/);
  assert.match(url, /employment_status=current/);
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});

test('roster yields who they are, when they joined, and where they were before', () => {
  const people = rosterToPeople(PERMUTE, 'Permute AI');
  assert.equal(people.length, 3);
  const scott = people[0];
  assert.equal(scott.name, 'Scott Nelson');
  assert.equal(scott.joined, '2025-07');
  assert.equal(scott.title, 'Co-Founder & CEO');
  // Danny's explicit ask. at_date can never answer this.
  assert.ok(scott.previously.includes('Density Collective'));
  assert.ok(!scott.previously.includes('Permute AI'), 'this company is not a PRIOR employer');
});

test('the curve is derived from start dates — zero extra API calls', () => {
  // Pinned clock. The fixture joins are 2025-07, 2025-08 and 2026-03, so the
  // assertions below only hold inside a window that starts in 2025-07 (one person)
  // and ends after 2026-03 (all three). With a live `new Date()` this test silently
  // changed answer as those months aged out of the trailing 12 — it began failing on
  // wall-clock time rather than on a code change.
  const c = curveFromPeople(rosterToPeople(PERMUTE, 'Permute AI'), { asOf: new Date('2026-07-15T00:00:00Z') });
  assert.equal(c.now, 3);
  assert.equal(c.delta, 2);
  assert.equal(c.series.length, 13, 'one point per month, not 4 sampled guesses');
  assert.equal(c.series[c.series.length - 1].count, 3);
});

// A name mismatch must never silently drop a real employee.
test('an employee whose company string differs still resolves via the open role', () => {
  const odd = [{ profile_url: 'x', profile: { full_name: 'Jane', experiences: [
    { company: 'Permute', title: 'Eng', starts_at: { year: 2026, month: 1 }, ends_at: null },
  ] } }];
  const p = rosterToPeople(odd, 'Permute AI, Inc.');
  assert.equal(p[0].joined, '2026-01');
  assert.equal(p[0].title, 'Eng');
});

test('nobody with a start date means a null curve, not a zero curve', () => {
  const p = rosterToPeople([{ profile_url: 'x', profile: { full_name: 'Ghost', experiences: [] } }], 'Acme');
  assert.equal(curveFromPeople(p), null);
});
