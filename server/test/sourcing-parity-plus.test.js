'use strict';
// 2026-11 sourcing inspection (docs/sourcing-inspection.md). One test per behaviour
// change, so each fix is pinned to the finding that motivated it.
const { test } = require('node:test');
const assert = require('node:assert');
const { verifyIlTie, propagateCofounderTies, tieStrength } = require('../lib/ilTie');
const ff = require('../lib/founderFit');
const { extractPatterns } = require('../lib/founderPatterns');
const formD = require('../pipeline/sources/sec-form-d');
const speedrun = require('../pipeline/sources/a16z-speedrun');
const se = require('../pipeline/sourcing-engine');

const ev = (bio, extra = {}) => ff.evaluate({ raw_data: JSON.stringify({ bio }), ...extra });

// ── Illinois tie hierarchy: lives here > from here / school here > worked here > co-founder ──
test('tie hierarchy: lives here now outranks went to school here, which outranks worked here', () => {
  assert.equal(verifyIlTie('Based in Chicago, IL. UIUC alum.').type, 'current');
  assert.equal(verifyIlTie('UIUC alum. Previously engineer at Grubhub. Lives in Austin.').type, 'school');
  assert.equal(verifyIlTie('Grew up in Naperville. Engineer at Stripe in New York.').type, 'hometown');
  assert.equal(verifyIlTie('Previously an engineer at Grubhub. Now in Austin.').type, 'worked');
  assert.ok(tieStrength('current') > tieStrength('school'));
  assert.equal(tieStrength('school'), tieStrength('hometown'), 'from IL and IL school share a rank');
  assert.ok(tieStrength('school') > tieStrength('worked'));
  assert.ok(tieStrength('worked') > tieStrength('cofounder'));
  assert.ok(tieStrength('cofounder') > tieStrength('mention'));
});

test('a past job line ending ", IL" is a worked tie, not a current one', () => {
  const r = verifyIlTie('Founder in Austin. Previously product lead at Motorola, Schaumburg, IL.');
  assert.equal(r.verified, true);
  assert.equal(r.type, 'worked');
});

test('a common-word employer name needs an employment cue', () => {
  assert.equal(verifyIlTie('We cut the amount of time teams spend on audits.').verified, false);
  assert.equal(verifyIlTie('Building in SF. Previously an engineer at Amount.').type, 'worked');
});

test('a bare "Illinois" is a mention (weakest), not a current residence', () => {
  const r = verifyIlTie('We sell to hospitals in Illinois and Ohio.');
  assert.equal(r.type, 'mention');
  assert.equal(r.weak, true);
  assert.equal(r.strength, 0);
});

test('co-founder propagation still anchors on the strongest direct tie', () => {
  const rows = [
    { id: 1, name: 'A', company: 'Acme', headline: 'UChicago alum' },
    { id: 2, name: 'B', company: 'Acme', headline: 'Based in Chicago, IL' },
    { id: 3, name: 'C', company: 'Acme', headline: 'CTO' },
  ];
  const out = propagateCofounderTies(rows, (r) => verifyIlTie(r.headline));
  assert.equal(out.get(3).type, 'cofounder');
  assert.equal(out.get(3).via, 'B');
});

// ── Ranking uses tie strength ──
test('equal founders rank by tie strength', () => {
  const lives = ev('Stealth founder. YC W26. Based in Chicago, IL.');
  const school = ev('Stealth founder. YC W26. DePaul University alum. Lives in Boston.');
  const worked = ev('Stealth founder. YC W26. Previously engineer at Grubhub. Lives in Boston.');
  assert.ok(lives.priority > school.priority, `${lives.priority} > ${school.priority}`);
  assert.ok(school.priority > worked.priority, `${school.priority} > ${worked.priority}`);
});

test('a weak (co-founder / mention) tie cannot carry a founder to must-meet', () => {
  const v = ev('Stealth founder. Previously founded Foo (acquired by Bar in 2022).', { location_type: 'cofounder' });
  assert.equal(v.tier, 'strong');
});

// ── Criteria: hard technical pedigree over prestige ──
test('a frontier AI lab outweighs a generic hyperscaler, and technical outweighs non-technical', () => {
  const lab = ev('Stealth founder. Previously research engineer at OpenAI. Based in Chicago, IL.');
  const tech = ev('Stealth founder. Previously software engineer at Google. Based in Chicago, IL.');
  const nontech = ev('Stealth founder. Previously account manager at Google. Based in Chicago, IL.');
  const w = (v) => v.markers.find((m) => m.key === 'hyperscale').weight;
  assert.equal(w(lab), 8);
  assert.equal(w(tech), 7);
  assert.equal(w(nontech), 6);
});

test('a fellowship alone no longer qualifies a founder (prestige down-weight)', () => {
  const v = ev('Z Fellows. Stealth founder. Based in Chicago, IL.');
  assert.equal(v.meetWorthy, false);
  assert.ok(v.markers.some((m) => m.key === 'fellowship' && m.modifier));
});

test('Thiel / Z / Neo no longer count as top programs on the caliber axis', () => {
  const c = se.computeCaliber('Thiel Fellow, building in stealth.', '');
  assert.notEqual(c.tier, 'A');
  assert.equal(c.hardSignalPresent, false);
});

test('two program badges are ONE corroborating signal', () => {
  const v = ev('Stealth founder. YC S24 and South Park Commons member. Based in Chicago, IL.');
  assert.equal(v.tier, 'strong', 'YC + SPC alone is not two independent signals');
  const v2 = ev('Stealth founder. YC S24. Previously software engineer at Google. Based in Chicago, IL.');
  assert.equal(v2.tier, 'must-meet', 'a program + a background marker is');
});

// ── Five judgment patterns ──
test('patterns are filled only with verbatim quotes, and silent records stay null', () => {
  const silent = extractPatterns('Founder. Building developer tools. Based in Chicago.');
  assert.equal(silent.count, 0);
  for (const k of ['persistence', 'lived_problem', 'self_taught', 'frontline', 'trusted_complement']) assert.equal(silent[k], null);

  const text = 'After my first startup failed I kept building. Self-taught: started coding at 12. '
    + 'I talked to 120 nurses before writing code. Co-founder is my college roommate.';
  const p = extractPatterns(text);
  assert.ok(p.persistence && text.includes(p.persistence.quote));
  assert.ok(p.self_taught);
  assert.ok(p.frontline);
  assert.ok(p.trusted_complement);
  assert.equal(p.lived_problem, null, 'never inferred');
});

test('patterns are recorded but do not move the ranking', () => {
  const plain = ev('Stealth founder. YC W26. Based in Chicago, IL.');
  const rich = ev('Stealth founder. YC W26. Based in Chicago, IL. Self-taught engineer. Co-founder is my college roommate.');
  assert.equal(rich.priority, plain.priority);
  assert.ok(rich.patterns.count >= 2);
});

test('a sweep-LLM pattern quote survives only if it is verbatim in the profile', () => {
  const v = ev('Stealth founder. Based in Chicago, IL.', {
    evidence_map: JSON.stringify({ founder_patterns: { frontline: 'I personally installed every unit for our first customers' } }),
  });
  assert.equal(v.patterns.frontline, null);
});

// ── Form D connector ──
const SEARCH = JSON.stringify({ hits: { hits: [
  { _id: '0001999999-26-000001:primary_doc.xml', _source: { ciks: ['0001999999'], display_names: ['ACME LABS INC  (CIK 0001999999)'], biz_locations: ['Chicago, IL'], file_date: '2026-10-20', form: 'D' } },
  { _id: '0001888888-26-000002:primary_doc.xml', _source: { ciks: ['0001888888'], display_names: ['WINDY CITY OPPORTUNITY FUND LP  (CIK 0001888888)'], biz_locations: ['Chicago, IL'], file_date: '2026-10-21', form: 'D' } },
  { _id: '0001777777-26-000003:primary_doc.xml', _source: { ciks: ['0001777777'], display_names: ['OLDCO INC  (CIK 0001777777)'], biz_locations: ['Evanston, IL'], file_date: '2026-10-22', form: 'D/A' } },
] } });
const XML = `<edgarSubmission><primaryIssuer><entityName>ACME LABS INC</entityName><issuerAddress><stateOrCountry>IL</stateOrCountry></issuerAddress><yearOfInc><value>2025</value></yearOfInc></primaryIssuer>
<relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>JANE</firstName><lastName>DOE</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Director</relationship></relatedPersonRelationshipList></relatedPersonInfo>
<relatedPersonInfo><relatedPersonName><firstName>BOB</firstName><lastName>ANGEL</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList></relatedPersonInfo></relatedPersonsList>
<offeringData><industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup><offeringSalesAmounts><totalOfferingAmount>1500000</totalOfferingAmount><totalAmountSold>750000</totalAmountSold></offeringSalesAmounts></offeringData></edgarSubmission>`;

test('Form D: an IL startup filing becomes one lead per executive officer; funds and amendments are skipped', async () => {
  const calls = [];
  const get = async (url) => { calls.push(url); return url.includes('efts') ? { status: 200, body: SEARCH } : { status: 200, body: XML }; };
  const recs = await formD.fetch({ deps: { get, now: new Date('2026-11-01') } });
  assert.equal(recs.length, 1, 'only the executive officer of the startup');
  assert.equal(recs[0].name, 'Jane Doe');
  assert.equal(recs[0].company, 'Acme Labs Inc');
  assert.match(recs[0].evidence, /Form D filed 2026-10-20/);
  assert.match(recs[0].evidence, /\$1\.5M/);
  assert.equal(calls.filter((u) => u.includes('primary_doc')).length, 1, 'the fund and the D/A never cost a request');
  // The record's own words establish the (company-address) Illinois tie.
  const tie = verifyIlTie(`Based in ${recs[0].location_city}, ${recs[0].location_state}. ${recs[0].evidence}`);
  assert.equal(tie.type, 'current');
});

test('Form D: old companies and large raises are not target-shaped', () => {
  const now = new Date('2026-11-01');
  assert.equal(formD.isTargetIssuer({ year_of_inc: '2015', industry: 'Other Technology' }, 'X Inc', now).ok, false);
  assert.equal(formD.isTargetIssuer({ year_of_inc: '2025', offering_amount: 20e6 }, 'X Inc', now).ok, false);
  assert.equal(formD.isTargetIssuer({ year_of_inc: '2025', industry: 'Pooled Investment Fund' }, 'X Inc', now).ok, false);
  assert.equal(formD.isTargetIssuer({ year_of_inc: '2025', offering_amount: 1e6, industry: 'Other Technology' }, 'X Inc', now).ok, true);
});

test('Form D: a network failure yields no records, never a thrown run', async () => {
  const recs = await formD.fetch({ deps: { get: async () => ({ status: 0, body: '' }) } });
  assert.deepEqual(recs, []);
});

// ── Sweep recall ──
test('YC batch tokens are computed from the clock, not typed', () => {
  assert.deepEqual(se.recentYcBatches(new Date('2026-11-01'), 4), ['F26', 'S26', 'X26', 'W26']);
  assert.deepEqual(se.recentYcBatches(new Date('2027-02-01'), 3), ['W27', 'F26', 'S26']);
  const q = se.freshenQuery('("YC W25" OR "YC S25" OR "YC W26") founder 2025', new Date('2026-11-01'));
  assert.ok(!/W25|S25|2025/.test(q), q);
});

test('daily mode runs custom queries and the curated stealth banks', () => {
  const criteria = { locations: ['chicago'], schools: [], companies: [], domains: [], stageFilter: 'Pre-seed',
    customQueries: [{ name: 'Mine', query: 'my custom query' }] };
  const q = se.buildUserSearchQueries(criteria, false);
  assert.equal(q[0].query, 'my custom query', 'custom queries first, never sliced off');
  assert.ok(q.some((x) => x.name === 'LinkedIn stealth Chicago strict'), 'evergreen stealth bank runs daily');
});

test('the sweep and the connectors share one tie gate for an Illinois user', () => {
  const t = se.checkTie('GitHub user x. Based in Chicago.', '', { locations: ['chicago'], schools: ['stanford'] });
  assert.equal(t.verified, true);
  const s = se.checkTie('Stanford alum building in Palo Alto.', '', { locations: ['chicago'], schools: ['stanford'] });
  assert.equal(s.verified, false, 'a pedigree school in the settings never establishes a tie');
  assert.ok(se.VALID_TIE_TYPES.includes('worked') && se.VALID_TIE_TYPES.includes('school'));
});

test('Speedrun defaults to the latest three cohorts the API reports', async () => {
  assert.deepEqual(speedrun.latestCohorts(['SR004', 'SR007', 'SR005', 'SR006', 'SR007']), ['SR007', 'SR006', 'SR005']);
  const pages = { results: [
    { name: 'Old', cohort: 'SR002', founder_set: [{ first_name: 'Old', last_name: 'Founder' }] },
    { name: 'New', cohort: 'SR008', founder_set: [{ first_name: 'New', last_name: 'Founder' }] },
  ], next: null };
  const recs = await speedrun.fetchAll({ deps: { getJson: async () => ({ status: 200, data: pages }) }, cohorts: 'auto' });
  assert.ok(recs.some((r) => r.company === 'New'));
});
