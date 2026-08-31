/**
 * Backfill caliber_* for sourced_founders rows with no caliber verdict yet — originally
 * rows from before the caliber axis existed, and (STU-36) every connector row
 * (yc_directory, pre_program, il_school_discovery, cohort-rosters, uspto, ...), whose
 * shared ingest() persists without ever computing caliber. Uses the deterministic
 * detector over the text we already stored in raw_data ({ headline, text }), plus
 * elite-school and red-flag signals already on the row. Does NOT call the LLM — this
 * is a free, idempotent first pass; it re-runs safely (only touches caliber_tier IS
 * NULL rows) and is also invoked once at boot as migration 'caliber_backfill_v1'.
 *
 * Run standalone: node server/migrations/backfill-caliber.js
 */
const db = require('../db');
const { computeCaliber, hasDisqualifyingFlag } = require('../pipeline/sourcing-engine');

function safeParse(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function run() {
  const rows = db.prepare(
    "SELECT id, raw_data, headline, elite_schools_national, red_flags, caliber_tier FROM sourced_founders WHERE caliber_tier IS NULL"
  ).all();

  console.log(`[backfill-caliber] ${rows.length} rows missing caliber`);
  const update = db.prepare(
    "UPDATE sourced_founders SET caliber_tier = ?, caliber_score = ?, caliber_rationale = ?, caliber_signals = ? WHERE id = ?"
  );

  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const raw = safeParse(r.raw_data, {});
      const text = raw.text || '';
      const headline = r.headline || raw.headline || '';
      const elite = safeParse(r.elite_schools_national, []);
      const redFlags = safeParse(r.red_flags, []);

      const det = computeCaliber(text, headline, elite);
      let { tier, score, signals, rationale } = det;

      if (hasDisqualifyingFlag(redFlags)) {
        tier = 'C';
        score = Math.min(3, score);
        rationale = `Red-flagged. ${rationale}`;
      }

      update.run(tier, score, rationale, JSON.stringify(signals), r.id);
      updated++;
    }
  });
  tx();

  const byTier = db.prepare(
    "SELECT COALESCE(caliber_tier,'?') t, COUNT(*) c FROM sourced_founders GROUP BY t"
  ).all();
  console.log(`[backfill-caliber] updated ${updated} rows. Distribution:`,
    byTier.map(x => `${x.t}:${x.c}`).join(' '));
  return updated;
}

if (require.main === module) run();
module.exports = run;
