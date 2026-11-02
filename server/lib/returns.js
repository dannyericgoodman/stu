'use strict';
// ══════════════════════════════════════════════════════════════════════════
// returns.js — the ownership + exit-to-return-fund math, computed in code.
//
// Every house memo (Permute, Yeet, Perspectives) carries the same table: at this
// check and this post-money, what do we own, and what exit returns the fund? That
// math is arithmetic, and arithmetic is the one thing an LLM must never do here —
// same law as conviction.js. This module is pure: no DB, no network, no model.
//
// What it answers, in the memos' own terms:
//   - Entry ownership        = check / post-money
//   - Ownership at exit       = entry ownership diluted by later rounds (memos assume
//                               we're "diluted about half by exit"; EXIT_DILUTION)
//   - Exit to return the fund = the exit enterprise value at which our diluted stake
//                               equals the whole fund ("$400K at $20M post needs a
//                               ~$1B exit", ignoring liquidation preferences)
//
// It never fabricates a term. If the round isn't priced (no post-money we can read),
// it returns { status: 'need_inputs' } naming exactly what's missing — the Read page
// shows a one-line "add the round terms" prompt instead of a made-up table.
// ══════════════════════════════════════════════════════════════════════════

// Superior Studios fund I: ~$10M pre-seed fund, check $150K–$400K. Overridable so a
// future fund (or a test) isn't hard-wired to today's numbers.
const FUND_SIZE = 10_000_000;
const EXIT_DILUTION = 0.5;                 // our stake is ~halved by exit (memo convention)
const CHECK_SCENARIOS = [150_000, 250_000, 400_000]; // the three checks the memos table

// Coerce a loosely-typed money field (number, "$5M", "5m", "$20,000,000", "5000000")
// into a number of dollars. Returns null when there's nothing usable — never a guess.
// `promoteSmall` turns a bare small number into millions — right for a VALUATION field (a
// cap is written "20" meaning $20M) but WRONG for a check (a "$400K" check typed as "400"
// must not become $400M, a 1000x error through the whole table). Callers pass false for the
// check/investment field.
function toUsd(v, { promoteSmall = true } = {}) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = s.match(/^(-?\d*\.?\d+)([km]?)(?:post|pre|cap)?$/);
  if (!m) {
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1_000;
  else if (m[2] === 'm') n *= 1_000_000;
  // A bare "20" in a VALUATION field means $20M (the memos write caps in millions). Only
  // promote when there's no magnitude suffix, the number is small, and the caller allows it.
  else if (promoteSmall && n > 0 && n < 1000) n *= 1_000_000;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Is this valuation a POST-money figure? Pre-seed SAFEs are quoted as a post-money
// cap by default now ("$5M post"), and all three memos read the cap as post. We treat
// `valuation` as post-money unless the security type explicitly says pre-money, and we
// record the assumption so the reader can override it.
function resolvePostMoney(valuation, roundSize, securityType) {
  const val = toUsd(valuation);
  const round = toUsd(roundSize);
  const t = String(securityType || '').toLowerCase();
  if (val == null) {
    // No cap/valuation at all. If we somehow have a pre + round we still can't price
    // ownership without a post — bail to need_inputs upstream.
    return { postMoney: null, basis: null, assumption: null };
  }
  if (/\bpre(-|\s)?money\b/.test(t) && round != null) {
    return { postMoney: val + round, basis: 'pre+round', assumption: `Post-money derived from a pre-money valuation (${fmt(val)}) plus the round (${fmt(round)}).` };
  }
  return { postMoney: val, basis: 'cap-as-post', assumption: `Treated the ${fmt(val)} ${/cap/.test(t) || /safe/.test(t) ? 'SAFE cap' : 'valuation'} as post-money (the pre-seed default). If it's pre-money, add the round size.` };
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `$${round1(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `$${round1(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}
function round1(n) { return Math.round(n * 10) / 10; }
function pct(n) { return `${round1(n * 100)}%`; }

// The core computation. All inputs are optional/loose; the function decides whether it
// has enough to price ownership and says so honestly.
function computeReturns({
  roundSize, valuation, securityType, investmentAmount,
  fundSize = FUND_SIZE, exitDilution = EXIT_DILUTION, checkScenarios = CHECK_SCENARIOS,
} = {}) {
  const { postMoney, basis, assumption } = resolvePostMoney(valuation, roundSize, securityType);

  if (!postMoney) {
    return {
      status: 'need_inputs',
      missing: ['post-money valuation (or a SAFE cap)'],
      note: 'No priced round on the founder record. Add the valuation / SAFE cap (and the round size if the cap is pre-money) to compute ownership and the exit that returns the fund.',
    };
  }

  const survive = Math.max(0, Math.min(1, 1 - exitDilution)); // fraction of entry stake left at exit
  const row = (check) => {
    const entryOwn = check / postMoney;
    const exitOwn = entryOwn * survive;
    return {
      check,
      check_label: fmt(check),
      entry_ownership: entryOwn,
      entry_ownership_label: pct(entryOwn),
      exit_ownership: exitOwn,
      exit_ownership_label: pct(exitOwn),
      // Exit EV at which our diluted stake = the whole fund. Ignores liquidation
      // preferences, exactly as the memos note.
      exit_to_return_fund: exitOwn > 0 ? fundSize / exitOwn : null,
      exit_to_return_fund_label: exitOwn > 0 ? fmt(fundSize / exitOwn) : '—',
    };
  };

  // The scenario table: our actual check (if we've set one) always appears, plus the
  // three standard checks for comparison — deduped so our check isn't listed twice.
  const ourCheck = toUsd(investmentAmount, { promoteSmall: false });
  const checks = [...new Set([...(ourCheck ? [ourCheck] : []), ...checkScenarios])].sort((a, b) => a - b);
  const scenarios = checks.map(row);

  return {
    status: 'ok',
    inputs: {
      post_money: postMoney,
      post_money_label: fmt(postMoney),
      post_money_basis: basis,
      round_size: toUsd(roundSize),
      security_type: securityType || null,
      fund_size: fundSize,
      fund_size_label: fmt(fundSize),
      exit_dilution: exitDilution,
    },
    our_check: ourCheck,
    entry: ourCheck ? row(ourCheck) : null,
    scenarios,
    assumptions: [
      assumption,
      `Diluted ${pct(exitDilution)} by exit (later rounds sell more shares); exit-to-return-fund is the EV where our remaining stake equals the ${fmt(fundSize)} fund, ignoring liquidation preferences.`,
    ].filter(Boolean),
  };
}

module.exports = { computeReturns, toUsd, resolvePostMoney, fmt, FUND_SIZE, EXIT_DILUTION, CHECK_SCENARIOS };
