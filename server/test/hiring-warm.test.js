'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The warm pool must never launder a machine's guess into a personal connection.
// The Talent Database's ~460 "Talent Engine" rows are the old engine's own output
// written back to Airtable — importing them as "warm network" is the exact
// dishonesty this product refuses. These tests pin: (1) provenance gating, and
// (2) an IL tie is attached only when verifyIlTie confirms it, never guessed.
//
// Fixtures are the real record shapes pulled from the Superior base on 2026-08-14.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const { mapTalentRow, mapMasterRow, mapFunctions, normLinkedIn } = require('../pipeline/hiring-warm');

const rec = (fields, id = 'rec1') => ({ id, fields });

test('provenance gating: "Talent Engine" rows are NOT warm (return null)', () => {
  const engineRow = rec({ 'First Name': 'Ghost', 'Last Name': 'Engine', 'One Line Bio': 'sourced by machine', 'Joined Database Via': 'Talent Engine' });
  assert.strictEqual(mapTalentRow(engineRow), null);
  const noProvenance = rec({ 'First Name': 'No', 'Last Name': 'Source', 'Joined Database Via': '' });
  assert.strictEqual(mapTalentRow(noProvenance), null);
});

test('a real event row imports as warm with a stripped source label', () => {
  const row = mapTalentRow(rec({ 'First Name': 'John', 'Last Name': 'Agan', 'One Line Bio': 'Ex Postman, Glean, Replit', 'Function(s)': ['Eng'], 'Joined Database Via': 'Event - Permute Hackathon' }));
  assert.strictEqual(row.tier, 'warm');
  assert.strictEqual(row.warm_source, 'Permute Hackathon');
  assert.strictEqual(row.name, 'John Agan');
  // No Illinois evidence in the bio → tie stays blank, NOT guessed.
  assert.strictEqual(row.il_tie_type, null);
});

test('an IL tie is attached only when verifyIlTie confirms it', () => {
  const rosca = mapTalentRow(rec({ 'First Name': 'Brian', 'Last Name': 'Rosca', 'One Line Bio': 'Graduate Student, University of Illinois at Chicago', 'Function(s)': ['Eng'], 'Joined Database Via': 'Event - Permute Hackathon' }));
  assert.strictEqual(rosca.il_tie_type, 'school');
  assert.match(rosca.il_tie_place, /Illinois/i);
  assert.ok(rosca.il_tie_evidence, 'a verified tie carries its receipt');
});

test('Function(s) map to the canonical matcher vocabulary', () => {
  assert.deepStrictEqual(mapFunctions(['Eng']), ['engineering']);
  assert.deepStrictEqual(mapFunctions(['Data/AI', 'Sales/BD']), ['data', 'gtm']);
  assert.deepStrictEqual(mapFunctions(['Finance/BizOps']), ['finance']);
  assert.deepStrictEqual(mapFunctions([]), []);
  assert.deepStrictEqual(mapFunctions(['Nonsense']), ['other']);
});

test('LinkedIn is normalized (scheme added, trailing space trimmed)', () => {
  assert.strictEqual(normLinkedIn('linkedin.com/brianrosca '), 'https://linkedin.com/brianrosca');
  assert.strictEqual(normLinkedIn('https://www.linkedin.com/in/x/'), 'https://www.linkedin.com/in/x/');
  assert.strictEqual(normLinkedIn(''), null);
});

test('Master Contacts rows are warm by existence', () => {
  const row = mapMasterRow(rec({ 'Full Name': 'Jane Doe', 'Bio': 'Chicago-based operator', 'LinkedIn': 'linkedin.com/in/jane' }));
  assert.strictEqual(row.tier, 'warm');
  assert.strictEqual(row.source, 'airtable_master_contacts');
  assert.strictEqual(row.warm_source, 'Master Contact');
  assert.strictEqual(mapMasterRow(rec({ 'Bio': 'no name' })), null);
});
