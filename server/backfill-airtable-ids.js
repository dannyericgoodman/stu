/**
 * Backfill Airtable record IDs onto existing Stu founders.
 *
 * Matches founders by (name, company) and deals by company name.
 * Safe to run multiple times — only updates rows where the ID is null.
 *
 * Usage: node server/backfill-airtable-ids.js
 * Or called from index.js as a one-time migration.
 */

const db = require('./db');
const https = require('https');

const { TABLE, recordsUrl, authHeaders } = require('./lib/airtableBase');

function fetchAirtable(tableId) {
  return new Promise((resolve, reject) => {
    const records = [];
    function fetchPage(offset) {
      const url = recordsUrl(tableId, { pageSize: 100, offset: offset || undefined });
      const req = https.get(url, { headers: authHeaders() }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            records.push(...(data.records || []));
            if (data.offset) fetchPage(data.offset);
            else resolve(records);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
    }
    fetchPage(null);
  });
}

async function backfillIds() {
  console.log('[Backfill] Fetching Airtable records...');

  const [founders, deals] = await Promise.all([
    fetchAirtable(TABLE.FOUNDERS),
    fetchAirtable(TABLE.DEALS),
  ]);

  console.log(`[Backfill] Fetched ${founders.length} founders and ${deals.length} deals from Airtable`);

  // Backfill founder record IDs
  let founderMatched = 0;
  let founderSkipped = 0;

  const updateFounder = db.prepare(
    'UPDATE founders SET airtable_founder_record_id = ? WHERE id = ?'
  );

  for (const record of founders) {
    const f = record.fields || {};
    const name = (f['Founder Name'] || '').trim();
    const company = (f['Company Name'] || '').trim();
    if (!name) continue;

    // Find matching Stu founder (active, no Airtable ID yet)
    let stuFounder;
    if (company) {
      stuFounder = db.prepare(
        "SELECT id FROM founders WHERE is_deleted = 0 AND airtable_founder_record_id IS NULL AND LOWER(TRIM(name)) = LOWER(?) AND LOWER(TRIM(company)) = LOWER(?)"
      ).get(name, company);
    }
    // Fall back to name-only match if company didn't work
    if (!stuFounder) {
      stuFounder = db.prepare(
        "SELECT id FROM founders WHERE is_deleted = 0 AND airtable_founder_record_id IS NULL AND LOWER(TRIM(name)) = LOWER(?)"
      ).get(name);
    }

    if (stuFounder) {
      updateFounder.run(record.id, stuFounder.id);
      founderMatched++;
    } else {
      founderSkipped++;
    }
  }

  console.log(`[Backfill] Founder IDs: ${founderMatched} matched, ${founderSkipped} skipped`);

  // Backfill deal record IDs
  let dealMatched = 0;
  let dealSkipped = 0;

  const updateDeal = db.prepare(
    'UPDATE founders SET airtable_deal_record_id = ? WHERE id = ?'
  );

  for (const record of deals) {
    const d = record.fields || {};
    const dealName = (d['Deal Name'] || '').trim();
    if (!dealName) continue;

    // Match by company name
    const stuFounder = db.prepare(
      "SELECT id FROM founders WHERE is_deleted = 0 AND airtable_deal_record_id IS NULL AND LOWER(TRIM(company)) = LOWER(?)"
    ).get(dealName);

    if (stuFounder) {
      updateDeal.run(record.id, stuFounder.id);
      dealMatched++;
    } else {
      dealSkipped++;
    }
  }

  console.log(`[Backfill] Deal IDs: ${dealMatched} matched, ${dealSkipped} skipped`);
  console.log('[Backfill] Complete!');

  return { founderMatched, founderSkipped, dealMatched, dealSkipped };
}

module.exports = backfillIds;

if (require.main === module) {
  backfillIds().catch(err => {
    console.error('[Backfill] Failed:', err);
    process.exit(1);
  });
}
