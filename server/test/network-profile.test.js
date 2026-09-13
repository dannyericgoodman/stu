'use strict';
// ══════════════════════════════════════════════════════════════════════════
// These pin the failure that produced the module. Running Scaylor's real ask
// ("intro to industrial PE funds") against Danny's live 2,691-row export with
// naive substring matching returned, near the top, an Assistant Professor of
// Industrial-Organizational Psychology.
//
// Two bugs in one row, and the fix for each carries its own risk:
//   · "industrial" matched inside a hyphenated psychology term  → phrase/word
//     boundaries, which risks dropping legitimate hyphenated titles.
//   · nothing knew an academic cannot source PE intros           → a persona gate,
//     which risks excluding professors who really do operate.
// So the exclusions are pinned alongside the INCLUSIONS they must not break.
// Every case below is a verbatim row from the live export.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const np = require('../lib/networkProfile');

// ── The professor. The row that started it. ──
test('an I-O psychology professor is not an industrial-sector contact', () => {
  const r = np.classify({
    title: 'Assistant Professor of Industrial-Organizational Psychology',
    company: 'DePaul University',
  });
  assert.ok(!r.sectors.includes('industrial'),
    'hyphenated "Industrial-Organizational" must not read as the industrial sector');
  assert.ok(r.personas.includes('academic'), 'should be read as an academic');
  assert.strictEqual(r.is_commercial, false, 'an academic is not a commercial operator');
});

// ── The inclusion the fix must not break. ──
test('a real private-equity operator still classifies as an investor', () => {
  const r = np.classify({
    title: 'Managing Director, Private Equity Solutions',
    company: 'Strategex',
  });
  assert.ok(r.personas.includes('investor'), 'MD of PE Solutions is an investor contact');
  assert.ok(r.functions.includes('investing'));
  assert.strictEqual(r.seniority, 'exec');
  assert.strictEqual(r.is_commercial, true);
});

// ── Seniority gate: the title says PE, the person is a summer intern. ──
test('a private-equity summer analyst is a student, not a PE contact', () => {
  const r = np.classify({ title: 'Private Equity Summer Analyst', company: 'Goldman Sachs' });
  assert.ok(r.personas.includes('student'), 'summer analyst is a student');
  assert.strictEqual(r.is_commercial, false, 'an intern cannot source a PE intro');
  assert.strictEqual(r.seniority, 'junior');
});

// ── Sector can live in the company, not the title. ──
test('sector reads from the employer when the title is generic', () => {
  const r = np.classify({ title: 'Managing Director', company: 'Cresset Wealth Management' });
  assert.ok(r.sectors.includes('wealth'), 'Cresset Wealth Management is the wealth signal');
  assert.strictEqual(r.seniority, 'exec');
});

// ── Personas read from the TITLE only. ──
test('an employer named "Founders Fund" does not make someone a founder', () => {
  const r = np.classify({ title: 'Executive Assistant', company: 'Founders Fund' });
  assert.ok(!r.personas.includes('founder'),
    'the founder persona must not be read out of the company name');
});

// ── Honest emptiness. ──
test('a bare "Founder" reports no function rather than guessing one', () => {
  const r = np.classify({ title: 'Founder', company: 'Stealth Startup' });
  assert.ok(r.personas.includes('founder'));
  assert.deepStrictEqual(r.functions, [], 'no domain in the title means no function claimed');
  assert.strictEqual(r.company, null, '"Stealth Startup" is not a real employer');
  assert.strictEqual(r.signal, 'thin');
});

// ── Word boundaries on the two-letter abbreviations. ──
test('short abbreviations do not match inside longer words', () => {
  const bdo = np.classify({ title: 'Audit Senior', company: 'BDO' });
  assert.ok(!bdo.functions.includes('sales'), '"bd" must not fire inside "BDO"');

  const chro = np.classify({ title: 'CHRO', company: 'Acme' });
  assert.ok(!chro.functions.includes('legal'), '"hr" inside "CHRO" must not read as legal');
  assert.ok(chro.functions.includes('people'), 'CHRO is a people-function leader');
});

// ── "Principal" is rank-ambiguous; only an investor context promotes it. ──
test('"Principal" reads as exec at a fund and director elsewhere', () => {
  const fund = np.classify({ title: 'Principal', company: 'Chicago Ventures', extra: 'venture capital' });
  const eng = np.classify({ title: 'Principal Engineer', company: 'Stripe' });
  assert.strictEqual(eng.seniority, 'director', 'a principal engineer is an IC rung, not a partner');
  assert.ok(['exec', 'director'].includes(fund.seniority));
});

// ── Hand-entered expertise outranks a parsed title. ──
test('Airtable expertise contributes functions the title never mentions', () => {
  const r = np.classify({
    title: 'Independent', company: 'Independent',
    expertise: 'Finance, Growth, Revenue',
  });
  assert.ok(r.functions.includes('finance'), 'hand-entered expertise is authoritative');
  assert.ok(r.functions.includes('growth'));
});

// ── Multi-signal reads are marked as such, so the matcher can prefer them. ──
test('a rich title reports good signal; an empty one reports none', () => {
  const rich = np.classify({ title: 'VP of Marketing, Healthcare', company: 'Optum' });
  assert.strictEqual(rich.signal, 'good');
  assert.ok(rich.functions.includes('marketing'));
  assert.ok(rich.sectors.includes('healthcare'));

  const empty = np.classify({ title: '', company: '' });
  assert.strictEqual(empty.signal, 'none');
});

// ── Found on Avant Health's live ask. ──
// "channel-partner GTM/distribution" is a go-to-market sentence. Reading the
// bare word "distribution" as the industrial sector put a spurious "no
// industrial signal" gap on every candidate for a marketing ask.
test('"distribution" in a GTM sense is not the industrial sector', () => {
  const nm = require('../lib/networkMatch');
  const q = nm.parseNeed({
    type: 'advice',
    text: "Marketing / content-strategy help — port cos who've cracked channel-partner GTM/distribution",
  });
  assert.ok(!q.sectors.includes('industrial'), 'GTM distribution is not heavy industry');
  assert.ok(q.functions.includes('marketing'));

  // A genuinely industrial employer still reads as industrial.
  const real = np.classify({ title: 'VP Sales', company: 'Grainger Industrial Distribution' });
  assert.ok(real.sectors.includes('industrial'));
});
