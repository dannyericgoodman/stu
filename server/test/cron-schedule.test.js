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

// ── Read code, not prose ──
// This test scans source text, so a cron.schedule(...) written inside a COMMENT
// counted as a real schedule. That happened for real: the note explaining that the
// 8am digest is now deliberately unscheduled names the call you would re-add to
// restore it, and this test then reported a live cron with no timezone — failing on
// a job that does not exist, and pointing at a comment as the offending line.
//
// Blanking comments to SPACES rather than removing them preserves every byte offset,
// so the reported `index.js:NNN` still lands on the real line. String and template
// literals are tracked too, so a `//` inside a URL is not read as a comment and does
// not swallow the rest of its line.
function stripComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | single | double | template
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c;
      continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } else out += ' '; continue; }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    // Inside a literal: honour escapes, so an escaped quote does not end it early.
    if (c === '\\') { out += c + (next === undefined ? '' : next); i++; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
    out += c;
  }
  return out;
}

const CODE = stripComments(SRC);

// Each cron.schedule(...) call, with the text that follows it up to its close.
function schedules() {
  const out = [];
  const re = /cron\.schedule\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(CODE))) {
    // The options object, when present, sits just after the handler's closing `})`.
    const tail = CODE.slice(m.index, m.index + 6000);
    const closes = /\}\s*,\s*\{\s*timezone:\s*'([^']+)'\s*\}\s*\)/.exec(tail);
    out.push({ expr: m[1], line: CODE.slice(0, m.index).split('\n').length, tz: closes ? closes[1] : null });
  }
  return out;
}

test('the scanner reads real calls, not cron schedules named in comments', () => {
  const sample = [
    "cron.schedule('1 1 * * *', a, { timezone: 'America/Chicago' });",
    "// cron.schedule('2 2 * * *', b);",
    "/* cron.schedule('3 3 * * *', c); */",
    "const u = 'https://x/y'; cron.schedule('4 4 * * *', d);",
  ].join('\n');
  const stripped = stripComments(sample);
  const found = [...stripped.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1]);

  assert.deepStrictEqual(found, ['1 1 * * *', '4 4 * * *'],
    'a schedule named in prose is documentation; only a real call may fail the timezone check');
  assert.strictEqual(stripped.split('\n').length, 4,
    'comments blank to spaces, never collapse — the reported line number must stay true');
});

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

// ══════════════════════════════════════════════════════════════════════════
// The morning list of founders is DELIVERED ON THE HOMEPAGE, not by email.
//
// This assertion was the reverse a day ago — it required the 8am send to exist,
// because a daily list of founders to meet is the one scheduled thing Danny asked
// for by name, and it had shipped Friday-only.
//
// Danny, 2026-08-31: "I don't need the newly sourced founders to be emailed to me.
// If they could just appear on Stu's homepage every morning that's fine."
//
// The requirement did not go away, it changed surface. So the test still guards the
// requirement — Danny sees new founders every morning — and now pins the surface
// that owns it. What must NOT happen is the delivery quietly reverting to email, or
// the cron being removed while the homepage still cannot show a new founder, which
// would leave him with no view of new names at all and no failing test to say so.
// ══════════════════════════════════════════════════════════════════════════
test('the 8am founder digest email is not scheduled — the homepage delivers instead', () => {
  assert.strictEqual(schedules().find((s) => s.expr === '0 8 * * *'), undefined,
    'Danny asked for the morning list on the homepage rather than in his inbox; a live '
    + '8am cron means the email came back');
});

test('the homepage can actually show a founder sourced last night', () => {
  // The cron above may only be absent because this exists to replace it.
  const list = fs.readFileSync(path.join(__dirname, '..', 'lib', 'morningList.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');

  assert.ok(/pickShortlist/.test(route),
    'the shortlist route must source its ids from morningList, or the homepage reverts to '
    + 'a pure tier ranking that no new founder can enter');
  assert.ok(/is_new: isNew\(/.test(route),
    'the "new" badge must come from the reserved-slot boundary, not `created_at >= lastRun` — '
    + 'that comparison is false for every row the scout inserts and made new_today always 0');
  assert.ok(/LIMIT 2/.test(list),
    'the boundary must be the PREVIOUS run, not the run that inserted the rows');
});

test('the digest service survives unscheduled, for manual sends', () => {
  // Unscheduling is not deleting: POST /api/sourcing/digest still sends on demand,
  // so the service and its idempotency guard must keep working.
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'founder-digest.js'), 'utf8');
  assert.ok(/sendFounderDigest/.test(svc), 'the manual-send path must not be collateral damage');
});

test('the digest is idempotent per DAY, not per week', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'founder-digest.js'), 'utf8');
  assert.ok(
    !/6 \* 24 \* 3600 \* 1000/.test(svc),
    'the 6-day cooldown paired with a Friday cron; on a daily schedule it silently skips six mornings'
  );
  assert.ok(/already sent today/.test(svc), 'the skip reason must be same-day, not same-week');
  assert.ok(
    /timeZone: 'America\/Chicago'/.test(svc),
    "the idempotency key must be a Chicago day — a UTC key rolls over mid-evening CT and can double- or skip-send"
  );
});
