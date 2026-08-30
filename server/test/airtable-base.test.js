const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const base = require('../lib/airtableBase');

// ══════════════════════════════════════════════════════════════════════════
// Stu touches exactly ONE Airtable base, and that is checkable.
//
// WHY THIS EXISTS: `appfE9DVrSUOrkkpu` was typed out by hand in six files —
// lib/airtableVocab (under a header calling itself "the ONLY copy"),
// services/airtable-import, services/airtable-sync, pipeline/hiring-warm,
// migrate-from-airtable and backfill-airtable-ids. Two of those WRITE to the
// base, which Danny's team maintains by hand. Six independent copies of a write
// target means "what base does Stu touch?" can only be answered by grepping and
// trusting the grep — and it means a seventh copy can be added tomorrow without
// anyone noticing.
//
// Danny scoped Stu to one named base and no other. A scope enforced in one place
// is a scope; a scope repeated in six places is a hope. So this asserts the
// structural property directly: no file under server/ builds an Airtable URL or
// writes a base/table id literal except lib/airtableBase.js.
// ══════════════════════════════════════════════════════════════════════════

const ROOT = path.join(__dirname, '..');
const OWNER = path.join('lib', 'airtableBase.js');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Comments may legitimately NAME a base or table — hiring-warm documents which
// Airtable tables it reads, and that documentation is worth keeping. What must
// not exist is a literal the CODE resolves. So comment lines are stripped before
// scanning rather than the whole file being exempted.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

// Application code is the subject. `test/` is excluded for the same reason
// scripts/check-sql.js excludes it: these files issue no requests, and a scanner
// necessarily contains the very pattern it scans for — this file would flag
// itself on the `api.airtable.com` literal two functions down. Fixtures also
// quote real ids on purpose (airtable-vocab.test.js records the base it
// transcribed the vocabulary from).
const files = walk(ROOT).filter(
  (f) => !f.endsWith(OWNER) && !path.relative(ROOT, f).startsWith('test' + path.sep)
);

test('only lib/airtableBase.js builds Airtable API URLs', () => {
  const offenders = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (line.includes('api.airtable.com')) {
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'These files build an Airtable URL directly. Use recordsUrl()/recordUrl() from ' +
    `lib/airtableBase so the base is decided once:\n  ${offenders.join('\n  ')}`
  );
});

test('no base or table id literal lives outside lib/airtableBase.js', () => {
  // Airtable ids are `app`/`tbl` + 14 chars. Matching the SHAPE (not the specific
  // known ids) is what catches a literal for a base nobody reviewed — which is the
  // case that actually matters for a scoped grant.
  const ID = /\b(?:app|tbl)[A-Za-z0-9]{14}\b/;
  const offenders = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      const m = line.match(ID);
      if (m) offenders.push(`${path.relative(ROOT, f)}:${i + 1} → ${m[0]}`);
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'Airtable id literals outside lib/airtableBase.js. Add the table to TABLE and ' +
    `import it instead:\n  ${offenders.join('\n  ')}`
  );
});

test('AIRTABLE_BASE_ID overrides the default, and is what every URL addresses', () => {
  // The override is the migration path Danny gets if the team moves bases: one
  // env var repoints every reader and writer. If it silently failed to apply,
  // the failure mode is reading the OLD base while believing you moved — so it
  // is asserted, not assumed.
  const fresh = `${ROOT}/lib/airtableBase.js`;
  const prev = process.env.AIRTABLE_BASE_ID;
  process.env.AIRTABLE_BASE_ID = 'appTESToverride1';
  delete require.cache[require.resolve(fresh)];
  try {
    const overridden = require(fresh);
    assert.strictEqual(overridden.BASE_ID, 'appTESToverride1');
    assert.match(
      overridden.recordsUrl(overridden.TABLE.FOUNDERS).toString(),
      /\/v0\/appTESToverride1\//,
      'the override must reach the URL, not just the exported constant'
    );
  } finally {
    if (prev === undefined) delete process.env.AIRTABLE_BASE_ID;
    else process.env.AIRTABLE_BASE_ID = prev;
    delete require.cache[require.resolve(fresh)];
  }
});

test('an unknown table is refused, not silently addressed', () => {
  // The whole point of a scoped grant is that a table nobody reviewed cannot be
  // reached. A typo'd or newly-invented table id must throw rather than issue a
  // request against the team's hand-maintained base.
  assert.throws(() => base.recordsUrl('tblNOTINSCOPE01'), /Refusing to build a URL/);
  assert.throws(() => base.recordUrl('tblNOTINSCOPE01', 'rec123'), /Refusing to build a URL/);
});

test('known tables build the URLs the callers expect', () => {
  const list = base.recordsUrl(base.TABLE.FOUNDERS, { pageSize: 100 });
  assert.strictEqual(list.searchParams.get('pageSize'), '100');
  assert.ok(list.pathname.startsWith(`/v0/${base.BASE_ID}/${base.TABLE.FOUNDERS}`));

  // `offset: undefined` is how the paginators spell "first page". It must produce
  // no offset param at all — an `offset=undefined` string would be sent to
  // Airtable verbatim and paginate from a garbage cursor.
  const first = base.recordsUrl(base.TABLE.DEALS, { pageSize: 100, offset: undefined });
  assert.strictEqual(first.searchParams.has('offset'), false);

  const one = base.recordUrl(base.TABLE.DEALS, 'recABC123');
  assert.strictEqual(one.pathname, `/v0/${base.BASE_ID}/${base.TABLE.DEALS}/recABC123`);
});
