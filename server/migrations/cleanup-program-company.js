'use strict';
// ══════════════════════════════════════════════════════════════════════════
// cleanup-program-company — un-file the fellowships that got saved as companies.
//
// lib/cohortDiscovery fell back to the cohort label when a search hit had no
// headline, the enrichment pass read that label as the person's headline, and
// answered with it as their company. The inbox filled with rows like:
//
//   Ayush Kale     | Emergent Ventures | Emergent Ventures
//   Piyush Jha     | Emergent Ventures | Emergent Ventures
//   Cory Levy      | Z Fellows         | Z Fellows      ← he runs Z Fellows
//
// The code path is fixed in two places (cohortDiscovery no longer falls back;
// sources/index.js scrubs a program name before persist). PRODUCTION HAS ITS OWN
// DATABASE, so neither fix touches the rows already sitting in Danny's inbox. This
// does.
//
// It only ever NULLS the COMPANY. Nothing is deleted, no row moves, and the program
// is still recorded in `source` and in the tie evidence — so if this is wrong about a
// company, the cost is an empty cell on a row that already told you where it came from.
//
// The HEADLINE is deliberately left alone even when it is only "Thiel Fellow". That
// is a true statement about the person and it is the one thing the row can honestly
// say; deleting it would trade a misfiled fact for no fact at all. The re-pollution
// risk it used to carry is now handled upstream — sources/index.js scrubs a program
// name out of `company` before persist, whatever the headline says.
// ══════════════════════════════════════════════════════════════════════════

const db = require('../db');

const PROGRAM_NAMES = [
  'y combinator', 'yc', 'a16z speedrun', 'speedrun', 'thiel fellowship', 'thiel fellows',
  'thiel fellow', 'z fellows', 'zfellows', 'z fellow', 'neo', 'neo scholars', 'neo scholar',
  'the residency', 'emergent ventures', 'techstars', 'on deck', 'entrepreneur first',
  'antler', 'south park commons',
];

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const isProgram = (v) => PROGRAM_NAMES.includes(norm(v));

function cleanup({ apply = true } = {}) {
  const rows = db.prepare(
    `SELECT id, name, company, headline FROM sourced_founders
     WHERE company IS NOT NULL`
  ).all();

  const hits = rows.filter((r) => isProgram(r.company));

  if (apply && hits.length) {
    const clearCo = db.prepare('UPDATE sourced_founders SET company = NULL WHERE id = ?');
    db.transaction(() => { for (const h of hits) clearCo.run(h.id); })();
  }

  return {
    scanned: rows.length,
    cleared: hits.length,
    sample: hits.slice(0, 5).map((h) => `${h.name}: ${h.company}`),
  };
}

module.exports = { cleanup, isProgram, PROGRAM_NAMES };

if (require.main === module) {
  const apply = !process.argv.includes('--dry');
  console.log(JSON.stringify(cleanup({ apply }), null, 2));
}
