'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The matcher's whole job is to resist one temptation: sorting Danny's friends
// and calling it a shortlist. Every test here is a form of that failure, and
// each was found by running the four LIVE Founder Asks from Airtable against
// the real 3,173-person book rather than against fixtures.
//
// The three that changed the design:
//   1. "Intro to industrial PE funds" returned an I-O psychology professor.
//   2. The same ask then returned the right KIND of person (investors) with the
//      qualifier silently dropped — nobody in the book is an industrial PE
//      investor, and the first fix hid that instead of saying it.
//   3. "Marketing / content-strategy help" parsed "Marketing" as a company name.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const nm = require('../lib/networkMatch');
const np = require('../lib/networkProfile');

// Build a person the way the ingest does, so tests exercise the real path.
function person(id, name, title, company, rel = {}) {
  return {
    id, name, title, company,
    linkedin_url: `https://www.linkedin.com/in/${id}`,
    profile: np.classify({ title, company }),
    relationship: { warmth: 0, tier: 'thin', receipt: 'Connected, never messaged', ...rel },
  };
}

const CLOSE = { warmth: 90, tier: 'strong', receipt: '80 messages both ways', months_since: 1 };
const DISTANT = { warmth: 5, tier: 'thin', receipt: 'Connected, never messaged' };

// ── The law: fit gates, warmth ranks. ──
test('a close friend with no relevance never outranks a relevant stranger', () => {
  const people = [
    person(1, 'Close Friend', 'Elementary School Teacher', 'CPS', CLOSE),
    person(2, 'Relevant Stranger', 'General Partner', 'Industrial Growth Partners', DISTANT),
  ];
  const r = nm.matchNeed({ type: 'capital', text: 'Intros to private equity funds' }, people);
  assert.strictEqual(r.results.length, 1, 'the irrelevant friend must be dropped, not ranked');
  assert.strictEqual(r.results[0].name, 'Relevant Stranger');
});

test('among comparable fits, the person Danny actually knows wins', () => {
  const people = [
    person(1, 'Known Investor', 'General Partner', 'Alpha Ventures', CLOSE),
    person(2, 'Unknown Investor', 'General Partner', 'Beta Ventures', DISTANT),
  ];
  const r = nm.matchNeed({ type: 'capital', text: 'Intros to venture investors' }, people);
  assert.strictEqual(r.results[0].name, 'Known Investor');
  assert.strictEqual(r.results[0].fit, r.results[1].fit, 'identical fit — warmth broke the tie');
});

// ── The professor, end to end. ──
test('the I-O psychology professor never reaches an industrial PE shortlist', () => {
  const people = [
    person(1, 'Ian M. Katz', 'Assistant Professor of Industrial-Organizational Psychology', 'DePaul University', CLOSE),
    person(2, 'Anthony Bahr', 'Managing Director, Private Equity Solutions', 'Strategex', DISTANT),
  ];
  const r = nm.matchNeed({ type: 'intro', text: 'Intro to industrial PE funds' }, people);
  assert.ok(!r.results.some((x) => x.name === 'Ian M. Katz'), 'the professor must be gated out');
  assert.strictEqual(r.results[0].name, 'Anthony Bahr');
});

// ── Bug 2: the qualifier must not be silently dropped. ──
test('an unmet dimension of the ask is reported, not hidden', () => {
  const people = [
    person(1, 'Generic VC', 'Investor', 'Some Ventures', CLOSE),
  ];
  const r = nm.matchNeed({ type: 'intro', text: 'Intro to industrial PE funds' }, people);
  assert.ok(r.unmet.includes('industrial'), 'nobody is industrial — the response must say so');
  assert.strictEqual(r.coverage.industrial, 0);
  assert.ok(r.results[0].gaps.some((g) => /industrial/.test(g)),
    'and the row itself must carry the gap');
});

test('a full match outranks a partial one of the same persona', () => {
  const people = [
    person(1, 'Generalist', 'General Partner', 'Some Ventures', CLOSE),
    person(2, 'Specialist', 'General Partner', 'Industrial Manufacturing Capital', DISTANT),
  ];
  const r = nm.matchNeed({ type: 'intro', text: 'Intro to industrial PE funds' }, people);
  assert.strictEqual(r.results[0].name, 'Specialist',
    'meeting the sector must beat being better known, despite an 85-point warmth gap');
  assert.deepStrictEqual(r.results[0].gaps.filter((g) => /industrial/.test(g)), []);
});

// ── Bug 3: ask parsing. ──
test('a capitalized common noun is not read as a company name', () => {
  const q = nm.parseNeed({ type: 'advice', text: 'Marketing / content-strategy help for channel-partner GTM' });
  assert.deepStrictEqual(q.orgs, [], '"Marketing" is a discipline, not an employer');
  assert.ok(q.functions.includes('marketing'));
});

test('named organizations survive extraction and outrank inferred signals', () => {
  const q = nm.parseNeed({
    type: 'intro',
    text: 'Intros to tech-enabled RIAs (Compound, Savvy, Facet, Range) + aggregators (Hightower, Focus Financial, Dynasty)',
  });
  assert.ok(q.orgs.includes('Focus Financial'));
  assert.ok(q.orgs.includes('Range'));
  assert.ok(q.sectors.includes('wealth'), '"RIAs" must expand to the wealth vocabulary');
});

test('a single-token org demands an exact employer match', () => {
  assert.strictEqual(nm.orgMatch('Range', ['Range']), 'Range');
  assert.strictEqual(nm.orgMatch('Range Rover of Naperville', ['Range']), null,
    'a car dealership is not the RIA named Range');
  assert.strictEqual(nm.orgMatch('Focus Financial Partners', ['Focus Financial']), 'Focus Financial',
    'a multi-token org may match as a phrase');
});

test('working at a named organization is the strongest single signal', () => {
  const people = [
    person(1, 'At The Target', 'Tax Planner', 'Range', DISTANT),
    person(2, 'Warm Wealth Exec', 'Managing Director', 'Cresset Wealth Management', CLOSE),
  ];
  const r = nm.matchNeed({ type: 'intro', text: 'Intros to tech-enabled RIAs (Compound, Savvy, Facet, Range)' }, people);
  assert.strictEqual(r.results[0].name, 'At The Target');
  assert.match(r.results[0].why[0], /named in the ask/);
});

// ── Ask shorthand expands; job titles never do. ──
test('"PE" expands in an ask but not in a job title', () => {
  const q = nm.parseNeed({ type: 'intro', text: 'intro to PE funds' });
  assert.ok(q.target_personas.includes('investor'), 'the ask means private equity');

  const gymTeacher = np.classify({ title: 'PE Teacher', company: 'Niles West High School' });
  assert.ok(!gymTeacher.personas.includes('investor'),
    'a gym teacher must never be read as a private-equity contact');
});

// ── Type gates. ──
test('a hire ask admits juniors; a capital ask does not', () => {
  const grad = person(1, 'New Grad', 'Software Engineering Intern', 'Google', DISTANT);
  const hire = nm.matchNeed({ type: 'hire', text: 'Need a founding software engineer' }, [grad]);
  const capital = nm.matchNeed({ type: 'capital', text: 'Need angel investors' }, [grad]);
  assert.strictEqual(hire.results.length, 1, 'a strong student can be a real hire');
  assert.strictEqual(capital.results.length, 0, 'an intern cannot write a check');
});

test('an advice ask with a named discipline drops people showing none of it', () => {
  const people = [
    person(1, 'Wrong Discipline', 'Staff Accountant', 'Deloitte', CLOSE),
    person(2, 'Right Discipline', 'VP of Marketing', 'HubSpot', DISTANT),
  ];
  const r = nm.matchNeed({ type: 'advice', text: 'Marketing and content strategy help' }, people);
  assert.deepStrictEqual(r.results.map((x) => x.name), ['Right Discipline']);
});

// ── Never invent a relationship. ──
test('every result carries a relationship receipt', () => {
  const people = [person(1, 'Someone', 'General Partner', 'Alpha Ventures', DISTANT)];
  const r = nm.matchNeed({ type: 'capital', text: 'venture investors' }, people);
  assert.ok(r.results[0].how_you_know_them.length > 0);
  assert.strictEqual(r.results[0].warmth_tier, 'thin', 'a stranger must be labelled a stranger');
});

test('a person with no title at all is never matched on nothing', () => {
  const blank = person(1, 'Mystery', '', '', CLOSE);
  const r = nm.matchNeed({ type: 'advice', text: 'marketing help' }, [blank]);
  assert.strictEqual(r.results.length, 0, 'warmth alone is not a match');
});

// ── Found by running the LIVE Founder Asks with real company context. ──
// The ask and the company blob used to go through one vocabulary scan. Prizm's
// portfolio row carries a 4,000-character investor update mentioning SOC 2,
// engineering, marketing and growth, so a two-line capital ask "read as" eight
// functions and five sectors — and every candidate came back with eleven
// "no X signal" gaps. A requirement nobody typed is not a requirement.
test('company context adds industry, never a requirement', () => {
  const q = nm.parseNeed({
    type: 'capital',
    text: 'Intros to fintech/wealth angels + family offices to close the $200K SAFE',
    company_context: 'We achieved SOC 2 Type II compliance. Hired a founding engineer. '
      + 'Our marketing strategy and content cadence are the weak spot. Insurance brokerage distribution.',
  });
  assert.deepStrictEqual(q.functions.sort(), ['investing'],
    'the ask names capital only — the update must not add engineering or marketing');
  assert.ok(q.sectors.includes('fintech') && q.sectors.includes('wealth'));
  assert.ok(!q.sectors.includes('security'), 'SOC 2 in an update is not a security ASK');
  assert.ok(q.context_sectors.includes('insurance'),
    'the company industry is still captured — just separately');
});

test('gaps only ever name what the ask asked for', () => {
  const people = [person(1, 'An Investor', 'Investor', 'Alpha Capital', CLOSE)];
  const r = nm.matchNeed({
    type: 'capital', text: 'Intros to angels',
    company_context: 'construction robotics logistics manufacturing healthcare marketing design legal',
  }, people);
  assert.strictEqual(r.results.length, 1);
  assert.ok(r.results[0].gaps.length <= 2,
    `context must not manufacture gaps, got: ${r.results[0].gaps.join('; ')}`);
});

test('sharing the company industry is a bonus, not a requirement', () => {
  const inIndustry = person(1, 'Health Investor', 'Investor', 'Healthcare Ventures', DISTANT);
  const outIndustry = person(2, 'Other Investor', 'Investor', 'Generic Ventures', DISTANT);
  const r = nm.matchNeed(
    { type: 'capital', text: 'Intros to angels', company_context: 'digital health payer hospital' },
    [inIndustry, outIndustry]
  );
  assert.strictEqual(r.results[0].name, 'Health Investor');
  assert.ok(r.results.some((x) => x.name === 'Other Investor'),
    'being outside the industry is not disqualifying — nobody asked for it');
});

test('deal terms in an ask are not read as company names', () => {
  const q = nm.parseNeed({ type: 'capital', text: 'Investor intros for the $1M SAFE / seed ($18M post-money)' });
  assert.deepStrictEqual(q.orgs, [], '"$18M post-money" is a deal term, not an employer');
});

// ── Callers are not trusted with paging. ──
// Array.slice(0, -5) silently returns everything EXCEPT the last five — so a
// negative limit would drop the highest-scoring matches off the shortlist and
// look like a working request.
test('a negative or absurd limit cannot silently truncate the shortlist', () => {
  const people = Array.from({ length: 30 }, (_, i) =>
    person(i + 1, `Investor ${i}`, 'Investor', `Fund ${i}`, { warmth: i, tier: 'real', receipt: 'x' }));
  const ask = { type: 'capital', text: 'Intros to angel investors' };

  assert.strictEqual(nm.matchNeed(ask, people, { limit: -5 }).results.length, 10,
    'a negative limit falls back to the default, never to a reversed slice');
  assert.strictEqual(nm.matchNeed(ask, people, { limit: 0 }).results.length, 10);
  assert.strictEqual(nm.matchNeed(ask, people, { limit: 5 }).results.length, 5);
  assert.ok(nm.matchNeed(ask, people, { limit: 99999 }).results.length <= 200);
});

test('the top result is the highest scorer, whatever the limit', () => {
  const people = Array.from({ length: 30 }, (_, i) =>
    person(i + 1, `Investor ${i}`, 'Investor', `Fund ${i}`, { warmth: i, tier: 'real', receipt: 'x' }));
  const r = nm.matchNeed({ type: 'capital', text: 'Intros to angel investors' }, people, { limit: 3 });
  assert.strictEqual(r.results[0].name, 'Investor 29', 'warmest of the equally-fitting');
  assert.ok(r.results[0].score >= r.results[1].score);
});

test('an empty book returns an empty, well-formed result rather than throwing', () => {
  const r = nm.matchNeed({ type: 'capital', text: 'angels' }, []);
  assert.deepStrictEqual(r.results, []);
  assert.strictEqual(r.considered, 0);
  assert.strictEqual(r.qualified, 0);
  assert.ok(Array.isArray(r.unmet));
});

test('a malformed person row is skipped, not fatal', () => {
  const people = [
    { id: 1, name: 'No Profile' },                                  // no profile, no relationship
    { id: 2, name: 'Null Profile', profile: null, relationship: null },
    person(3, 'Real Investor', 'Investor', 'Alpha Capital', { warmth: 40, tier: 'real', receipt: 'x' }),
  ];
  const r = nm.matchNeed({ type: 'capital', text: 'Intros to angel investors' }, people);
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].name, 'Real Investor');
});
