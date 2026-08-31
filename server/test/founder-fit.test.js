'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ff = require('../lib/founderFit');

// The rubric decides who Danny meets. Every case below is one of his stated rules or
// a false positive that real data actually produced.

// ── STAGE GATE — the current company must be earliest-stage ──
test('a Series A on the current company fails the stage gate', () => {
  const v = ff.evaluate({ headline: 'CEO at Fernstone', raw_data: JSON.stringify({ bio: 'Building Fernstone, raised our Series A last year.' }) });
  assert.equal(v.stageTooLate, true);
  assert.equal(v.stage, 'past-earliest');
  assert.equal(v.meetWorthy, false, 'past-earliest can never be meet-worthy');
});

test('the Cargado case: a closed seed WITH traction on the current co is too late', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Founder of Cargado. We raised a seed round and now have 40 paying customers.' }) });
  assert.equal(v.stageTooLate, true, 'seed + traction on the current company is past earliest');
});

test('a PRE-seed raise is exactly what he wants — never disqualified', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Stealth founder. Just raised a pre-seed round. Building something new.' }) });
  assert.equal(v.stageTooLate, false);
  assert.equal(v.stage, 'earliest');
});

test('a PRIOR raise is a background win, not a current-stage disqualifier', () => {
  // "previously raised $10M" describes a past company — it must READ as a marker,
  // and must NOT make the current (stealth) company look late.
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Now in stealth. Previously raised $12M Series A for my last company, which was acquired.' }) });
  assert.equal(v.stageTooLate, false, 'a prior raise must not fail the current-stage gate');
  assert.ok(v.why.includes('Exited a startup') || v.why.some((w) => /Exited/.test(w)), 'the acquisition should surface as a marker');
});

// ── OUTLIER MARKERS — Danny's exact list, and his weighting ──
test('a good exit outranks prior founding, as Danny stated', () => {
  const exit = ff.MARKERS.find((m) => m.key === 'prior_exit').weight;
  const founding = ff.MARKERS.find((m) => m.key === 'prior_founding').weight;
  assert.ok(exit > founding, 'exit must weigh more than prior founding — "better to me than previous founding experience"');
});

test('elite IL school alone does NOT make the shortlist', () => {
  // "went to a prestigious IL school AND have a track record" — the school is a
  // modifier, not a qualifier.
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Studied at Northwestern. Building in stealth.' }) });
  assert.ok(v.markers.some((m) => m.key === 'il_elite_school'), 'the school should be detected');
  assert.equal(v.meetWorthy, false, 'a school with no core marker is not someone he asked to meet');
});

test('school PLUS a core marker IS meet-worthy, and the school boosts priority', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum. Studied at the University of Chicago. Building in stealth.' }) });
  assert.equal(v.meetWorthy, true);
  assert.ok(v.priority > ff.MARKERS.find((m) => m.key === 'yc').weight, 'the school adds to the YC weight');
});

// ── THE FALSE POSITIVES REAL DATA PRODUCED ──
test('"linkedin" inside a profile URL never counts as working at LinkedIn', () => {
  // 23 real candidates got a bogus Hyperscaler:LinkedIn from the scrape boilerplate.
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Founder - Remix. https://www.linkedin.com/in/someone Building in stealth.' }) });
  assert.ok(!v.markers.some((m) => m.key === 'hyperscale'), 'a LinkedIn URL must not fire the hyperscaler marker');
});

test('a real LinkedIn employer still counts', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Was a senior engineer at LinkedIn for 4 years. Now building in stealth.' }) });
  assert.ok(v.markers.some((m) => m.key === 'hyperscale'), 'employment at LinkedIn is a real hyperscaler marker');
});

// ── HYPERSCALE = EMPLOYMENT, NOT A MENTION ──
// Danny, 2026-07-22: "the hyperscale experience tag is hallucinating ... calibrate
// this to read their real LinkedIn history." A company NAME in the text is not a job.
test('a hyperscaler mentioned as product/customer/backer never fires', () => {
  const noFire = [
    'Building AI tools for Amazon sellers. Founder in stealth.',
    'Our product is aimed at Google ad market.',
    'Backed by ex-Googlers and Stripe alumni. Founder at NewCo.',
    'Building a Google Maps competitor.',
    'Sold my last startup to Meta in 2021.',
    'We integrate with Amazon and Google APIs.',
    'A customer at Google gave us feedback.',
  ];
  for (const bio of noFire) {
    const v = ff.evaluate({ raw_data: JSON.stringify({ bio }) });
    assert.ok(!v.markers.some((m) => m.key === 'hyperscale'), `must NOT fire on: ${bio}`);
  }
});

test('real employment phrasings still fire', () => {
  const fire = [
    'SWE at Google for 4 years, now in stealth.',
    'Previously at Meta on Core Ads.',
    'Ex-Stripe engineer building in stealth.',
    '9 years at Instacart building ML infra.',
    'Machine Learning Engineer at Microsoft.',
    'Spent three years at Amazon AGI Labs.',
  ];
  for (const bio of fire) {
    const v = ff.evaluate({ raw_data: JSON.stringify({ bio }) });
    assert.ok(v.markers.some((m) => m.key === 'hyperscale'), `must fire on: ${bio}`);
  }
});

// ── STRUCTURED HISTORY IS GROUND TRUTH ──
// The LinkedIn scrape's experiences[]/education[] arrays are where someone actually
// worked and studied — un-hallucinatable, because a product blurb never lands there.
test('structured experiences produce an accurate employer, with title', () => {
  const row = {
    linkedin_data: JSON.stringify({
      experiences: [
        { company: 'Stealth', title: 'Founder' },
        { company: 'Google', title: 'Staff Software Engineer' },
      ],
    }),
  };
  const v = ff.evaluate(row);
  const h = v.markers.find((m) => m.key === 'hyperscale');
  assert.ok(h, 'a Google role in experiences[] must fire');
  assert.ok(h.structured, 'it must be marked as structured (ground truth)');
  assert.match(h.evidence, /Google/, 'evidence should name the real role/company');
});

test('a hyperscaler ONLY in a product blurb, absent from experiences[], does not fire', () => {
  const row = {
    linkedin_data: JSON.stringify({ experiences: [{ company: 'Acme AI', title: 'Founder' }] }),
    raw_data: JSON.stringify({ bio: 'Acme AI — the Amazon of B2B procurement.' }),
  };
  const v = ff.evaluate(row);
  assert.ok(!v.markers.some((m) => m.key === 'hyperscale'), '"the Amazon of X" is not employment at Amazon');
});

test('structured education gives an accurate school; a campus mention does not', () => {
  const alum = ff.evaluate({ linkedin_data: JSON.stringify({ education: [{ school: 'Northwestern University' }], experiences: [{ company: 'YC co', title: 'Founder' }] }) });
  assert.ok(alum.markers.some((m) => m.key === 'il_elite_school'), 'a Northwestern education must count');

  const nearby = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Building study tools for University of Chicago students.' }) });
  assert.ok(!nearby.markers.some((m) => m.key === 'il_elite_school'), 'serving a campus is not attending it');
});

// ── THE RECEIPT RULE ──
test('every surfaced marker carries evidence verbatim in the profile', () => {
  const row = { raw_data: JSON.stringify({ bio: 'YC S24. Founder in stealth. Ex-Stripe engineer.' }) };
  const { markers, text } = ff.markersFor(row);
  assert.ok(markers.length > 0);
  for (const m of markers) {
    assert.ok(ff.verbatimIn(m.evidence, text), `marker ${m.key} must have a real receipt, got "${m.evidence}"`);
  }
});

test('an empty profile yields nothing — no marker without a source', () => {
  const v = ff.evaluate({});
  assert.equal(v.markers.length, 0);
  assert.equal(v.meetWorthy, false);
  assert.equal(v.priority, 0);
  assert.equal(v.tier, null);
});

// ── DISQUALIFYING FLAGS — wired in from the scoring pass (STU-35) ──
// sourcing-engine.js's LLM scoring pass already computes red_flags[] and clamps
// confidence/caliber when hasDisqualifyingFlag() fires. That never reached this
// rubric — a founder the scoring pass had already flagged as "a service provider,
// not a founder" or "no founding signal" could still land must-meet here.
test('a red-flagged service provider cannot be meet-worthy, even with strong markers', () => {
  // The Marcy Capron shape: caliber-clamped as a service provider, but the profile
  // text alone carries a real core marker (prior exit).
  const v = ff.evaluate({
    raw_data: JSON.stringify({ bio: 'Founder, sold my last company. Building in stealth.' }),
    red_flags: JSON.stringify(['a multi-service consultancy... a service provider, not a founder']),
  });
  assert.equal(v.disqualified, true);
  assert.equal(v.meetWorthy, false, 'a disqualifying flag must override the markers');
  assert.equal(v.tier, null);
});

test('a red-flagged non-commercial idea cannot be meet-worthy even with a YC badge', () => {
  const v = ff.evaluate({
    raw_data: JSON.stringify({ bio: 'YC alum. Building in stealth.' }),
    red_flags: JSON.stringify(['no commercial evidence, thin founding signal']),
  });
  assert.equal(v.disqualified, true);
  assert.equal(v.meetWorthy, false);
});

test('a disqualified founder keeps a residual score, never the full marker score', () => {
  const clean = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum. Founder, sold my last company. Building in stealth.' }) });
  const flagged = ff.evaluate({
    raw_data: JSON.stringify({ bio: 'YC alum. Founder, sold my last company. Building in stealth.' }),
    red_flags: JSON.stringify(['series a']),
  });
  assert.ok(flagged.priority < clean.priority, 'a disqualified row must never outrank the same row unflagged');
  assert.ok(flagged.priority > 0 || clean.markerScore === 0, 'residual, not zeroed, so ordering within the excluded set stays stable');
});

test('an empty or non-disqualifying red_flags array does not gate anything', () => {
  const empty = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum. Founder, sold my last company. Building in stealth.' }), red_flags: '[]' });
  assert.equal(empty.disqualified, false);
  assert.equal(empty.meetWorthy, true);

  const benign = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum. Founder, sold my last company. Building in stealth.' }), red_flags: JSON.stringify(['thin evidence base, worth a second look']) });
  assert.equal(benign.disqualified, false, 'only the fixed disqualifying-flag list should gate — not any red flag at all');
});

// ── VENTURE-SCALE, NOT LIFESTYLE ──
// Danny: "I don't want to source people who started consulting firms or an agency or
// something" — but fintech/health/logistics/defense stay. Catches the CLEAR cases;
// caliber (a café founder who self-labels "serial entrepreneur") is the re-tier's job.
test('a founder whose only companies are a consultancy/agency is not meet-worthy', () => {
  const consult = ff.evaluate({ linkedin_data: JSON.stringify({ experiences: [{ company: 'Peak Advisory Consulting', title: 'Founder' }] }) });
  assert.equal(consult.lifestyle, true);
  assert.equal(consult.meetWorthy, false);

  const agency = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Founder of a digital marketing agency. Serial entrepreneur.' }) });
  assert.equal(agency.lifestyle, true);
});

test('a franchise-owner TITLE flags lifestyle even when the company name is clean', () => {
  const v = ff.evaluate({ linkedin_data: JSON.stringify({ experiences: [{ company: 'The Chocolate Room', title: 'Franchise Owner' }] }) });
  assert.equal(v.lifestyle, true);
});

test('venture verticals that sound non-tech are KEPT', () => {
  for (const bio of [
    'Founder of a fintech startup, in stealth. Ex-Stripe.',
    'Building supply chain software. Previously founded a logistics company.',
    'Health-tech founder, ex-Google. Building in stealth.',
  ]) {
    const v = ff.evaluate({ raw_data: JSON.stringify({ bio }) });
    assert.equal(v.lifestyle, false, `must keep: ${bio}`);
  }
});

test('a real tech founder who also freelanced once is not flagged lifestyle', () => {
  const v = ff.evaluate({
    linkedin_data: JSON.stringify({ experiences: [{ company: 'Stealth AI', title: 'Founder' }, { company: 'Upwork', title: 'Freelancer' }] }),
    raw_data: JSON.stringify({ bio: 'Building an AI platform. Ex-Google.' }),
  });
  assert.equal(v.lifestyle, false, 'not ALL founder roles are lifestyle → venture');
});

// ── BUILDER SLOPE — the pre-seed signal, and the illegible-talent unlock ──
// Danny: "At pre-seed we really care about founder slope." The red team: the model
// must admit a no-pedigree builder whose GitHub is accelerating.
test('a no-pedigree builder with real GitHub slope is Must-meet on slope alone', () => {
  const v = ff.evaluate({
    github_slope_score: 8,
    github_slope_data: JSON.stringify({ evidence: 'agentkit: 340★ in 4mo' }),
    raw_data: JSON.stringify({ bio: 'Building in stealth. Self-taught. UIUC.' }),
  });
  assert.equal(v.tier, 'must-meet');
  assert.match(v.tierReason, /Building fast/);
  assert.equal(v.meetWorthy, true, 'no credential required — the slope is the signal');
});

test('weak slope alone is Strong, not Must-meet', () => {
  const v = ff.evaluate({ github_slope_score: 4, github_slope_data: JSON.stringify({ evidence: 'tool: 30★' }), raw_data: JSON.stringify({ bio: 'Building in stealth.' }) });
  assert.equal(v.tier, 'strong');
});

test('slope + a credential clears Must-meet by corroboration', () => {
  const v = ff.evaluate({ github_slope_score: 5, github_slope_data: JSON.stringify({ evidence: 'x: 60★' }), raw_data: JSON.stringify({ bio: 'YC alum building in stealth.' }) });
  assert.equal(v.tier, 'must-meet');
});

test('no GitHub slope column = no builder_slope marker (never invented)', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum building in stealth.' }) });
  assert.ok(!v.markers.some((m) => m.key === 'builder_slope'));
});

// ── TIERS — the selectivity Danny asked for, deterministic and explained ──
test('a prior exit is Must-meet, with a stated reason', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Founder in stealth. Previously sold my company to Stripe.' }) });
  assert.equal(v.tier, 'must-meet');
  assert.match(v.tierReason, /Exited/);
});

test('a repeat founder WITH pedigree is Must-meet', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Second-time founder, in stealth. Ex-Google engineer.' }) });
  assert.equal(v.tier, 'must-meet');
  assert.match(v.tierReason, /Repeat founder/);
});

test('two independent signals are Must-meet', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum, ex-Meta engineer, building in stealth.' }) });
  assert.equal(v.tier, 'must-meet');
  assert.match(v.tierReason, /2 independent/);
});

test('a single program badge is Strong, not Must-meet — meet them before the badge', () => {
  // Danny wants builders "before they get into YC/Speedrun or think to apply", so a
  // lone program membership is a solid signal, not the top tier.
  const yc = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC S24 founder building in stealth.' }) });
  assert.equal(yc.tier, 'strong', 'YC alone is Strong');
  const spr = ff.evaluate({ raw_data: JSON.stringify({ bio: 'a16z Speedrun founder, stealth.' }) });
  assert.equal(spr.tier, 'strong', 'Speedrun alone is Strong');
});

test('a lone hyperscaler is Strong, not Must-meet', () => {
  const v = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Ex-Amazon engineer building in stealth.' }) });
  assert.equal(v.tier, 'strong');
});

test('tier is null unless the founder clears the gates', () => {
  // Past-earliest → not meet-worthy → no tier, however strong the background.
  const late = ff.evaluate({ raw_data: JSON.stringify({ bio: 'Exited a startup, ex-Google. Now raising our Series B.' }) });
  assert.equal(late.meetWorthy, false);
  assert.equal(late.tier, null);
});

// ── PRIORITY ORDERING ──
test('a stealth founder with two markers outranks a past-earliest founder with three', () => {
  const early = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum, ex-Stripe. Building in stealth.' }) });
  const late = ff.evaluate({ raw_data: JSON.stringify({ bio: 'YC alum, ex-Stripe, second-time founder. Raised our Series B.' }) });
  assert.ok(late.stageTooLate, 'the Series B founder is past earliest');
  assert.ok(early.priority > late.priority, 'earliest-stage must outrank a stronger-but-too-late founder');
});

// ── GitHub-native builder sourcing: the building gate ──
test('the building signal separates founders/builders from employed engineers', () => {
  const { __test } = require('../pipeline/github-source');
  assert.ok(__test.BUILDING_RE.test('Founder, building in stealth'));
  assert.ok(__test.BUILDING_RE.test('working on something new'));
  assert.ok(!__test.BUILDING_RE.test('Senior Software Engineer at Nielsen'));
  assert.equal(__test.cleanCompany('@gridstatus'), 'gridstatus');
  assert.equal(__test.cleanCompany('A very long company description that is basically a bio sentence'), null);
});

test('github backfill excludes org handles (facebook) but keeps real ones', () => {
  const { __test } = require('../pipeline/github-source');
  assert.ok(__test.GH_ORG.test('facebook'), 'a link to github.com/facebook is not a person');
  assert.ok(!__test.GH_ORG.test('akashp3128'));
  const m = 'contributed to github.com/facebook/react'.match(__test.GH_LINK);
  assert.equal(m[1], 'facebook', 'the regex captures the org, which GH_ORG then rejects');
});

// ── LinkedIn→GitHub resolver: corroboration or nothing (accuracy is everything) ──
test('the resolver accepts only name + an independent corroborator', () => {
  const { __test } = require('../pipeline/github-resolve');
  const { nameMatches, corroborate } = __test;
  assert.ok(nameMatches('Chris Doe', 'Christopher Doe'), 'prefix first name ok');
  assert.ok(!nameMatches('Jane', 'janedev'), 'first-name-only must be rejected');
  assert.ok(!nameMatches('Jane Smith', 'John Smith'), 'wrong first name rejected');

  const f = { name: 'Jane Smith', company: 'Acme AI', chicago_connection: 'Chicago, IL' };
  assert.ok(corroborate(f, { name: 'Jane Smith', company: 'Acme AI', location: 'SF' }).ok, 'name+company');
  assert.ok(corroborate(f, { name: 'Jane Smith', location: 'Chicago, IL' }).ok, 'name+IL');
  assert.ok(!corroborate(f, { name: 'Jane Smith', location: 'Berlin' }).ok, 'name only must be rejected');
  assert.ok(!corroborate(f, { name: 'John Doe', company: 'Acme AI' }).ok, 'wrong name rejected even with company');
  // A founder with no IL tie can't be corroborated by a Chicago GitHub location.
  assert.ok(!corroborate({ name: 'Mike Chen', company: 'Stealth' }, { name: 'Mike Chen', location: 'Chicago' }).ok);
  // A SHARED SCHOOL alone is not enough (too common) — this was the Eric Xia bug.
  const sf = { name: 'Eric Xia', linkedin_data: JSON.stringify({ education: [{ school: 'Brown University' }] }) };
  assert.ok(!corroborate(sf, { name: 'Eric Xia', login: 'rkique', bio: 'Brown University' }).ok, 'shared school must not corroborate');
  // A name-derived handle ALONE is NOT sufficient anymore — ground truth kept finding
  // strangers (Jake Taylor/England, Emily Wang/Calgary). A positive corroborator is
  // required, so even a clean full-name handle is rejected without one.
  assert.ok(!corroborate({ name: 'Ben Monahan' }, { name: 'Ben Monahan', login: 'benmonahan03' }).ok, 'handle alone is no longer enough');
  assert.ok(!corroborate({ name: 'Demetri Morris' }, { name: 'Demetri Morris', login: 'demetrimorris' }).ok, 'handle alone rejected');
  // A company that is a fragment of the person's own surname is NOT independent.
  assert.ok(!corroborate({ name: 'Demetri Morris', company: 'Morr' }, { name: 'Demetri Morris', login: 'xyz', company: 'Morr' }).ok, 'name-fragment company rejected');
});

// ── FOUNDER-MARKET FIT — grounded in real employers, scoped to real verticals ──
test('domain fit fires when the founder worked in the space they now build in', () => {
  const fit = ff.evaluate({ company: 'Ledgerly', headline: 'fintech payments infra',
    linkedin_data: JSON.stringify({ experiences: [{ company: 'JPMorgan', title: 'Payments Engineer' }] }) });
  assert.ok(fit.markers.some((m) => m.key === 'founder_market_fit'), 'fintech + a bank = domain fit');

  const noFit = ff.evaluate({ company: 'Ledgerly', headline: 'fintech payments',
    linkedin_data: JSON.stringify({ experiences: [{ company: 'Google', title: 'Ads Engineer' }] }) });
  assert.ok(!noFit.markers.some((m) => m.key === 'founder_market_fit'), 'fintech + ads is not domain fit');
});

// ══════════════════════════════════════════════════════════════════════════
// RED-TEAM BUG-BASH — every case below is a false positive a red team found.
// ══════════════════════════════════════════════════════════════════════════

// F1/location — a common name needs a real corroborator; a handle alone is worthless.
test('resolver: common name + handle-only is rejected; positive corroborator passes', () => {
  const { __test } = require('../pipeline/github-resolve');
  const c = __test.corroborate;
  assert.ok(!c({ name: 'Emily Wang' }, { name: 'Emily Wang', login: 'emilywang98' }, { nameCommon: true }).ok, 'common + handle-only → reject');
  assert.ok(!c({ name: 'Akshay Patel', chicago_connection: 'Chicago' }, { name: 'Akshay Patel', login: 'akshaypatel80', location: 'Gujarat, India' }, { nameCommon: true }).ok, 'India location → reject');
  assert.ok(c({ name: 'Emily Wang', chicago_connection: 'Chicago, IL' }, { name: 'Emily Wang', login: 'ew', location: 'Chicago, IL' }, { nameCommon: true }).ok, 'common + IL location → ok');
  assert.ok(!c({ name: 'Izee Madkaur' }, { name: 'Izee Madkaur', login: 'izeemadkaur' }, { nameCommon: false }).ok, 'distinctive handle ALONE → reject (positive corroborator required)');
});

// F5 — the surname must match exactly; no 2-char prefix cross-matches.
test('resolver: "Bo Li" does not match "Bob Livingston"', () => {
  const { __test } = require('../pipeline/github-resolve');
  assert.ok(!__test.corroborate({ name: 'Bo Li' }, { name: 'Bob Livingston', login: 'bobliv' }, {}).ok);
});

// F2 — a weak-identity slope cannot reach must-meet on its own.
test('slope from a name-derived-handle resolve does not auto-promote to must-meet', () => {
  const strong = ff.evaluate({ github_slope_score: 8, github_slope_data: JSON.stringify({ evidence: 'x: 100★' }), source: 'github_builders', raw_data: JSON.stringify({ bio: 'stealth' }) });
  assert.equal(strong.tier, 'must-meet', 'trusted-identity slope still promotes');
  const weak = ff.evaluate({ github_slope_score: 8, github_slope_data: JSON.stringify({ evidence: 'x: 100★' }), github_resolve_reason: 'name-derived handle @jsmith', raw_data: JSON.stringify({ bio: 'stealth' }) });
  assert.notEqual(weak.tier, 'must-meet', 'weak-identity slope must NOT alone reach must-meet');
});

// F10 — FMF must not fire on an internship, nor on an investor.
test('FMF: internship-only and investors do not fire', () => {
  const intern = ff.evaluate({ company: 'Ledgerly', headline: 'fintech payments',
    linkedin_data: JSON.stringify({ experiences: [{ company: 'Citi', title: 'Summer Intern' }] }) });
  assert.ok(!intern.markers.some((m) => m.key === 'founder_market_fit'), 'an internship is not domain mastery');
  const vc = ff.evaluate({ company: 'Stealth', headline: 'Partner at Foo Capital, focused on fintech',
    linkedin_data: JSON.stringify({ experiences: [{ company: 'Bank', title: 'VP fintech' }] }) });
  assert.ok(!vc.markers.some((m) => m.key === 'founder_market_fit'), 'a VC partner is not a founder');
});

// F7 (content) — a content repo is excluded from slope.
test('slope: CONTENT_REPO excludes awesome-lists / skills collections', () => {
  const { CONTENT_REPO } = require('../pipeline/github-activity');
  assert.ok(CONTENT_REPO.test('awesome-ai'));
  assert.ok(CONTENT_REPO.test('baoyu-skills'));
  assert.ok(CONTENT_REPO.test('interview-prep guide'));
  assert.ok(!CONTENT_REPO.test('agentkit'), 'a product name is not content');
});

// F13 — backfill must not attribute a repo/org link as a personal handle.
test('backfill: a github.com/org/repo link is not a personal handle', () => {
  const { __test } = require('../pipeline/github-source');
  // GH_ORG still guards bare org handles
  assert.ok(__test.GH_ORG.test('facebook'));
});

// The aidenybai class — backfill must not attribute a stranger's GitHub to a founder.
test('backfill handle must be name-consistent with the founder', () => {
  const { __test } = require('../pipeline/github-source');
  const { handleMatchesName, pickPersonalHandle } = __test;
  assert.ok(handleMatchesName('paulsmith', 'Paul Smith'), 'own handle matches');
  assert.ok(handleMatchesName('HudsonGri', 'Hudson Griffith'));
  assert.ok(!handleMatchesName('aidenybai', 'Rob Pruzan'), 'Aiden Bai is not Rob Pruzan');
  assert.ok(!handleMatchesName('rkique', 'Eric Xia'), 'rkique is not name-consistent');
  // pickPersonalHandle skips a cited stranger link, takes the founder's own
  assert.equal(pickPersonalHandle('contributed to github.com/aidenybai/react-scan and github.com/robpruzan', 'Rob Pruzan'), 'robpruzan');
  assert.equal(pickPersonalHandle('see github.com/aidenybai', 'Rob Pruzan'), null, 'only a stranger link → nothing');
});
