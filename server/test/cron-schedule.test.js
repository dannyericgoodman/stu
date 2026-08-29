'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Every scheduled job must declare its timezone, and the line the boot log prints
// must be the time the job actually runs.
//
// Two jobs failed this. The SEC filings pull and the talent sourcing engine had no
// `timezone` option, so they ran in the container's zone (UTC on Railway) while the
// boot log announced a CT time — right for part of the year and an hour off for the
// rest, drifting twice a year with daylight saving. Nothing caught it because a cron
// that runs at the wrong hour still runs, and the log still says what it always said.
//
// This reads the source rather than the runtime because that is where the defect
// lives: an omitted option, next to a string that claims otherwise.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Each cron.schedule(...) call, with the text that follows it up to its close.
function schedules() {
  const out = [];
  const re = /cron\.schedule\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(SRC))) {
    // The options object, when present, sits just after the handler's closing `})`.
    const tail = SRC.slice(m.index, m.index + 6000);
    const closes = /\}\s*,\s*\{\s*timezone:\s*'([^']+)'\s*\}\s*\)/.exec(tail);
    out.push({ expr: m[1], line: SRC.slice(0, m.index).split('\n').length, tz: closes ? closes[1] : null });
  }
  return out;
}

test('every cron declares America/Chicago — never the container default', () => {
  const bad = schedules().filter((s) => s.tz !== 'America/Chicago');
  assert.deepStrictEqual(
    bad.map((s) => `index.js:${s.line} "${s.expr}" tz=${s.tz}`),
    [],
    'a cron without an explicit timezone runs in UTC on Railway while the boot log claims CT'
  );
});

test('the filings pull runs BEFORE the scout it feeds', () => {
  const all = schedules();
  const mins = (e) => { const [m, h] = e.split(' '); return Number(h) * 60 + Number(m); };
  const scout = all.find((s) => s.expr === '30 4 * * *');
  const filings = all.find((s) => s.expr === '45 3 * * *');
  assert.ok(scout, 'the 4:30 CT nightly scout must exist');
  assert.ok(filings, 'the filings pull must exist');
  assert.ok(
    mins(filings.expr) < mins(scout.expr),
    'Form D filings exist to feed the scout; landing after it delays every new filing by a day'
  );
});

test('the morning jobs all finish before Danny is up (5am CT)', () => {
  // The two that must be done before he opens the app.
  const all = schedules().map((s) => s.expr);
  assert.ok(all.includes('45 3 * * *'), 'filings 3:45 CT');
  assert.ok(all.includes('30 4 * * *'), 'scout 4:30 CT');
});
