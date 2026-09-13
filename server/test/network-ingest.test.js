'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The ingest is where a relationship can be quietly manufactured, so these
// target the four places that could invent one:
//
//   1. GROUP THREADS. A 40-person LinkedIn group chat would credit every
//      participant with messages "both ways" and mint 40 strong relationships
//      out of one mailing list. Only 1:1 traffic counts.
//   2. SELF-DETECTION. Danny is on both sides of every message; misidentifying
//      the account owner inverts sent/received for the entire book.
//   3. MERGE, NOT CLOBBER. Airtable rows arrive after the LinkedIn import and
//      know nothing about message history. A naive upsert blanks it.
//   4. THE CSV PREAMBLE. LinkedIn puts a free-text "Notes:" block above the real
//      header; parsing from row 0 adopts it as the schema and yields nothing.
//
// The Airtable fixtures are verbatim records from the live Superior Studios
// Ecosystem base, read 2026-09-03. The local Airtable PAT is expired, so this
// injected-fetch path is the only honest way to exercise the mapping.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ing = require('../pipeline/network-ingest');

// ── 4. The CSV preamble ───────────────────────────────────────────────────
test('the LinkedIn "Notes:" preamble is skipped, not adopted as a header', () => {
  const csv = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Ada,Lovelace,https://www.linkedin.com/in/adalovelace,,Analytical Engines,Founder,15 Jul 2026',
  ].join('\n');
  const rows = ing.parseLinkedInCsv(csv, 'First Name');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]['First Name'], 'Ada');
  assert.strictEqual(rows[0]['Position'], 'Founder');
});

// ── 1. Group threads ──────────────────────────────────────────────────────
test('group conversations never credit anyone with a 1:1 relationship', () => {
  const li = (s) => `https://www.linkedin.com/in/${s}`;
  const csv = [
    '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"',
    // A group blast: Danny to three people at once. Must credit nobody.
    `"c1","","Danny","${li('me')}","Group","${li('a')},${li('b')},${li('c')}","2026-01-01 10:00:00 UTC","","hi all","INBOX",""`,
    // A genuine 1:1.
    `"c2","","Danny","${li('me')}","A","${li('a')}","2026-02-01 10:00:00 UTC","","just you","INBOX",""`,
    `"c2","","A","${li('a')}","Danny","${li('me')}","2026-02-02 10:00:00 UTC","","reply","INBOX",""`,
  ].join('\n');

  const agg = ing.aggregateMessages(csv, 'me');
  assert.ok(!agg.has('b'), 'a group recipient must not become a contact');
  assert.ok(!agg.has('c'));
  const a = agg.get('a');
  assert.strictEqual(a.sent, 1, 'only the 1:1 message counts as sent');
  assert.strictEqual(a.received, 1);
  assert.strictEqual(a.last_at, '2026-02-02');
  assert.strictEqual(a.first_at, '2026-02-01');
});

test('an inbound message with other recipients is not credited either', () => {
  const li = (s) => `https://www.linkedin.com/in/${s}`;
  const csv = [
    '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"',
    `"c1","","A","${li('a')}","Many","${li('me')},${li('b')}","2026-01-01 10:00:00 UTC","","blast","INBOX",""`,
  ].join('\n');
  assert.strictEqual(ing.aggregateMessages(csv, 'me').size, 0,
    'a message sent to Danny AND others is a broadcast, not correspondence');
});

// ── 2. Self-detection ─────────────────────────────────────────────────────
test('the account owner is detected as the slug on both sides of the traffic', () => {
  const li = (s) => `https://www.linkedin.com/in/${s}`;
  const rows = ['"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"'];
  for (let i = 0; i < 10; i++) {
    rows.push(`"c${i}","","Danny","${li('danielericgoodman')}","P${i}","${li('p' + i)}","2026-01-0${i % 9 + 1} 10:00:00 UTC","","x","INBOX",""`);
  }
  assert.strictEqual(ing.detectSelfSlug(rows.join('\n')), 'danielericgoodman');
});

// ── Identity + dedupe ─────────────────────────────────────────────────────
test('the LinkedIn slug is the dedupe key, with a name+company fallback', () => {
  assert.strictEqual(ing.slugOf('https://www.linkedin.com/in/adalovelace/'), 'adalovelace');
  assert.strictEqual(ing.slugOf('https://www.linkedin.com/in/foo?trk=abc'), 'foo');
  assert.strictEqual(ing.slugOf('not a url'), null);

  assert.strictEqual(ing.dedupeKeyFor({ slug: 'adalovelace' }), 'li:adalovelace');
  // No slug (an Airtable advisor) still merges deterministically.
  assert.strictEqual(
    ing.dedupeKeyFor({ name: 'Ada Lovelace', company: 'Analytical Engines' }),
    ing.dedupeKeyFor({ name: 'ada  lovelace', company: 'Analytical  Engines' }),
    'name+company normalizes before it becomes a key'
  );
});

test('a correspondent with no title gets a readable name from their slug', () => {
  assert.strictEqual(ing.nameFromSlug('haley-sonenthal'), 'Haley Sonenthal');
  assert.strictEqual(ing.nameFromSlug('krish-khanna-46abb122a'), 'Krish Khanna',
    'the trailing LinkedIn disambiguator is not part of a name');
});

test('buildRow never claims a relationship the counts do not support', () => {
  const row = ing.buildRow({
    name: 'Stranger', title: 'General Partner', company: 'Alpha Ventures',
    linkedin_url: 'https://www.linkedin.com/in/stranger',
    is_connection: true, connected_on: '2024-01-01', now: new Date('2026-09-03'),
  });
  assert.strictEqual(row.warmth_tier, 'thin');
  assert.match(row.relationship_receipt, /never messaged/);
  assert.strictEqual(row.msgs_sent, 0);
  assert.ok(JSON.parse(row.personas).includes('investor'), 'the profile still classifies');
});

// ── 3. Merge, not clobber (needs a real DB) ───────────────────────────────
// A child process because db.js runs its migration at require() time and this
// suite has already required it against the dev database.
test('an Airtable row merges into a LinkedIn row without erasing message history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stu-netingest-'));
  const dbPath = path.join(dir, 't.db');
  try {
    const script = `
      process.env.DATABASE_PATH = ${JSON.stringify(dbPath)};
      process.env.JWT_SECRET = 'network-ingest-test';
      const dbp = ${JSON.stringify(path.join(__dirname, '..', 'db.js'))};
      const ingp = ${JSON.stringify(path.join(__dirname, '..', 'pipeline', 'network-ingest.js'))};
      const db = require(dbp); const ing = require(ingp);
      const now = new Date('2026-09-03');
      const url = 'https://www.linkedin.com/in/samiahmed1';

      // 1) The LinkedIn import: a real correspondence, no hand-entered expertise.
      ing.upsert(1, ing.buildRow({
        name: 'Sami Ahmed', title: 'Recruiter', company: 'Hunt Club', linkedin_url: url,
        msg: { sent: 9, received: 7, threads: 2, last_at: '2026-05-01' },
        is_connection: true, sources: ['linkedin_connections'], now,
      }));

      // 2) The Airtable merge, arriving after, knowing nothing about messages.
      ing.upsert(1, ing.buildRow({
        name: 'Sami Ahmed', company: 'Hunt Club', linkedin_url: url,
        expertise: 'Hiring, Fundraising, GTM',
        sources: ['airtable_advisor_network'], airtable_record_id: 'rec3MLseH6nOLLhL4',
        airtable_table: 'advisor_network', now,
      }));

      const r = db.prepare('SELECT * FROM network_people WHERE user_id = 1').all();
      console.log(JSON.stringify({
        rows: r.length, sent: r[0].msgs_sent, received: r[0].msgs_received,
        tier: r[0].warmth_tier, expertise: r[0].expertise, title: r[0].title,
        sources: JSON.parse(r[0].sources), functions: JSON.parse(r[0].functions),
      }));
    `;
    const out = execFileSync(process.execPath, ['-e', script],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());

    assert.strictEqual(d.rows, 1, 'the same person on both sources is ONE row');
    assert.strictEqual(d.sent, 9, 'the Airtable merge must not blank the message history');
    assert.strictEqual(d.received, 7);
    assert.strictEqual(d.tier, 'strong');
    assert.strictEqual(d.title, 'Recruiter', 'a source with no title must not erase the one we had');
    assert.strictEqual(d.expertise, 'Hiring, Fundraising, GTM', 'and it must add what it does know');
    assert.deepStrictEqual(d.sources.sort(), ['airtable_advisor_network', 'linkedin_connections'],
      'provenance accumulates rather than being overwritten');
    assert.ok(d.functions.includes('people'), 'hand-entered expertise feeds the classifier');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The Airtable mapping, against verbatim live records ───────────────────
test('Airtable advisors and investors map with their hand-entered expertise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stu-netat-'));
  const dbPath = path.join(dir, 't.db');
  try {
    const script = `
      process.env.DATABASE_PATH = ${JSON.stringify(dbPath)};
      process.env.JWT_SECRET = 'network-airtable-test';
      process.env.AIRTABLE_API_KEY = 'fixture-key-not-used';
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      const ing = require(${JSON.stringify(path.join(__dirname, '..', 'pipeline', 'network-ingest.js'))});
      const ab = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'airtableBase.js'))});

      // Verbatim rows from the live base, read 2026-09-03.
      const ADVISORS = [
        { id: 'recbhNxjsn9VyTSyT', fields: { 'Advisor Name': 'Nick Cromydas', 'Expertise': 'Hiring, Fundraising, GTM',
          'Company Affiliation': 'Hunt Club', 'LinkedIn': 'https://www.linkedin.com/in/cromydas/', 'Email': 'nick@huntclub.com' } },
        { id: 'recD33j0yADFYEIp8', fields: { 'Advisor Name': 'David Rabie',
          'Company Affiliation': 'Tovala', 'LinkedIn': 'https://www.linkedin.com/in/davidrabie/', 'Email': 'david@tovala.com' } },
        { id: 'recNoName', fields: { 'Expertise': 'orphan row with no name' } },
      ];
      const INVESTORS = [
        { id: 'recInv1', fields: { 'Name': 'Jane Roe', 'Firm': 'Chicago Ventures',
          'Industry Focus': 'healthcare, insurance', 'Stage Focus': [{ name: 'Pre-Seed' }, { name: 'Seed' }],
          'Strength of Relationship': { name: 'Strong' }, 'LinkedIn': 'https://www.linkedin.com/in/janeroe' } },
      ];
      const deps = { fetchAirtableTable: async (t) => (t === ab.TABLE.ADVISOR_NETWORK ? ADVISORS : INVESTORS) };

      ing.importAirtableNetwork({ userId: 1, now: new Date('2026-09-03'), deps }).then(() => {
        const rows = db.prepare('SELECT * FROM network_people WHERE user_id = 1 ORDER BY name').all();
        console.log(JSON.stringify(rows.map(r => ({
          name: r.name, title: r.title, company: r.company, expertise: r.expertise,
          personas: JSON.parse(r.personas), functions: JSON.parse(r.functions),
          sectors: JSON.parse(r.sectors), tier: r.warmth_tier, table: r.airtable_table,
          receipt: r.relationship_receipt,
        }))));
      }).catch(e => { console.error(e); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', script],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    const rows = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('[')).pop());

    assert.strictEqual(rows.length, 3, 'the nameless row is skipped, not imported blank');

    const nick = rows.find((r) => r.name === 'Nick Cromydas');
    assert.ok(nick.functions.includes('people'), 'Expertise "Hiring" is a people function');
    assert.ok(nick.functions.includes('gtm') || nick.functions.includes('sales'),
      'GTM must land somewhere in the function vocabulary');
    assert.strictEqual(nick.table, 'advisor_network');
    assert.strictEqual(nick.tier, 'thin',
      'hand-curation lifts someone off name_only, but it is not a warm relationship');
    assert.match(nick.receipt, /Advisor Network/,
      'and the receipt must say WHY they are here, not imply contact that never happened');

    const jane = rows.find((r) => r.name === 'Jane Roe');
    assert.strictEqual(jane.title, 'Investor',
      'every Investor Network row IS an investor — stating it is what lets the persona read');
    assert.ok(jane.personas.includes('investor'));
    assert.ok(jane.sectors.includes('healthcare'), 'Industry Focus feeds the sector read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
