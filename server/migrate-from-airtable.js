/**
 * Migrate all founder data from Airtable into Stu.
 *
 * 1. Soft-deletes ALL existing founders in Stu
 * 2. Imports all 112 founders from "Superior Founder Ecosystem" table
 * 3. Cross-references 44 deals from "Investment Pipeline" table to enrich records
 * 4. Maps Airtable stages to Stu pipeline stages
 *
 * Airtable Admission Statuses → Stu mapping:
 *   Stage 0: Legacy (Density)                    → admissions: Density Resident, status: Active
 *   Stage 1: Sourced / Applied                   → varies by Next Step Description
 *   Stage 2: Initial Interview (Deal Lead)       → admissions: First Call Complete, status: Interviewing
 *   Stage 3: Internal Evaluation (Deal Lead + Partner) → admissions: Second Call Scheduled, status: Interviewing
 *   Stage 4: Final Admissions Decision            → admissions: Second Call Complete, status: Interviewing
 *   Stage 5a: Admitted / Onboarding              → admissions: Active Resident, status: Active
 *   Stage 5b: Hold / Nurture                     → admissions: Hold/Nurture, status: Hold
 *   Stage 5c: Not Admitted                       → admissions: Not Admitted, status: Not Admitted
 *   Stage 5d: Legacy Density Not Admitted SSFI   → admissions: Not Admitted (legacy Density), status: Not Admitted
 */

const db = require('./db');
const fs = require('fs');
const path = require('path');
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

// Load Airtable data - try from files first (local dev), then fetch from API
let founders, deals;
try {
  founders = JSON.parse(fs.readFileSync('/tmp/airtable_founders.json', 'utf8'));
  deals = JSON.parse(fs.readFileSync('/tmp/airtable_deals.json', 'utf8'));
} catch (err) {
  // Files not available (production) - will fetch from API
  founders = null;
  deals = null;
}

async function runMigration() {
if (!founders || !deals) {
  console.log('Fetching data from Airtable API...');
  founders = await fetchAirtable(TABLE.FOUNDERS);
  deals = await fetchAirtable(TABLE.DEALS);
}

console.log(`Loaded ${founders.length} founders and ${deals.length} deals from Airtable.\n`);
// rest of migration continues below...

// Build deal lookup by company name (lowercase)
const dealsByCompany = {};
for (const d of deals) {
  const f = d.fields || {};
  const name = (f['Deal Name'] || '').toLowerCase().trim();
  if (name) dealsByCompany[name] = f;
}

// ── Step 1: Soft-delete ALL existing founders ──
const deleteCount = db.prepare("UPDATE founders SET is_deleted = 1 WHERE is_deleted = 0").run();
console.log(`Step 1: Soft-deleted ${deleteCount.changes} existing founders.\n`);

// Also clear sourced_founders queue
db.prepare("DELETE FROM sourced_founders").run();
console.log('Cleared sourced_founders queue.\n');

// ── Step 2: Map and import each Airtable founder ──

function mapNextStepToAdmissions(nextStep, admissionStatus) {
  if (!nextStep) return 'Sourced';
  const ns = nextStep.toLowerCase().trim();

  if (ns === 'hold') return 'Hold/Nurture';
  if (ns === 'admitted') return 'Admitted';
  if (ns === 'met') return 'First Call Complete';
  if (ns === 'convert to ssfi applicant') return 'Sourced';
  if (ns === 'support action items') return 'Hold/Nurture';
  if (ns.includes('scheduling 1st') || ns.includes('1st mtg scheduling')) return 'Outreach';
  if (ns.includes('1st mtg scheduled')) return 'First Call Scheduled';
  if (ns.includes('scheduling 2nd') || ns.includes('2nd mtg scheduling')) return 'First Call Complete';
  if (ns.includes('2nd mtg scheduled')) return 'Second Call Scheduled';
  if (ns.includes('scheduling 3rd') || ns.includes('3rd mtg')) return 'Second Call Complete';

  return 'Sourced';
}

function mapAdmissionStatus(airtableStatus, nextStep) {
  if (!airtableStatus) return { admissions_status: 'Sourced', status: 'Sourced' };

  const s = airtableStatus.trim().toLowerCase();

  // Stage 0: Density legacy
  if (s.includes('stage 0') || s.includes('legacy (density)') || s.includes('legacy density')) {
    return { admissions_status: 'Density Resident', status: 'Active' };
  }

  // Stage 1: Sourced / Applied / Identified
  if (s.includes('stage 1')) {
    const admStatus = mapNextStepToAdmissions(nextStep, airtableStatus);
    let overallStatus = 'Sourced';
    if (['Outreach', 'First Call Scheduled'].includes(admStatus)) overallStatus = 'Outreach';
    if (['First Call Complete', 'Second Call Scheduled', 'Second Call Complete'].includes(admStatus)) overallStatus = 'Interviewing';
    if (admStatus === 'Hold/Nurture') overallStatus = 'Hold';
    return { admissions_status: admStatus, status: overallStatus };
  }

  // Stage 2: Initial Interview / Interviewed
  if (s.includes('stage 2')) {
    const admStatus = mapNextStepToAdmissions(nextStep, airtableStatus);
    let mapped = admStatus;
    if (mapped === 'Sourced') mapped = 'First Call Complete';
    return { admissions_status: mapped, status: 'Interviewing' };
  }

  // Stage 3: Internal Evaluation
  if (s.includes('stage 3')) {
    const admStatus = mapNextStepToAdmissions(nextStep, airtableStatus);
    let mapped = admStatus;
    if (mapped === 'Sourced') mapped = 'Second Call Scheduled';
    return { admissions_status: mapped, status: 'Interviewing' };
  }

  // Stage 4: Final Decision / Admitted
  if (s.includes('stage 4')) {
    // Check if it says "Admitted" explicitly
    if (s.includes('admitted')) {
      return { admissions_status: 'Active Resident', status: 'Active' };
    }
    const admStatus = mapNextStepToAdmissions(nextStep, airtableStatus);
    let mapped = admStatus;
    if (mapped === 'Sourced') mapped = 'Second Call Complete';
    return { admissions_status: mapped, status: 'Interviewing' };
  }

  // Stage 5: Various outcomes
  if (s.includes('stage 5')) {
    // Legacy Density — check before "not admitted" since it contains that substring
    if (s.includes('legacy density') || s.includes('legacy (density)')) {
      return { admissions_status: 'Density Resident', status: 'Active' };
    }
    // Not Admitted MUST be checked before "admitted" (since "not admitted" contains "admitted")
    if (s.includes('not admitted')) {
      return { admissions_status: 'Not Admitted', status: 'Not Admitted' };
    }
    // Admitted / Onboarding
    if (s.includes('admitted') || s.includes('onboarding')) {
      return { admissions_status: 'Active Resident', status: 'Active' };
    }
    // Hold / Nurture
    if (s.includes('hold') || s.includes('nurture')) {
      return { admissions_status: 'Hold/Nurture', status: 'Hold' };
    }
    // Default for stage 5
    return { admissions_status: 'Hold/Nurture', status: 'Hold' };
  }

  // Fallback — check keywords (not admitted before admitted)
  if (s.includes('not admitted')) return { admissions_status: 'Not Admitted', status: 'Not Admitted' };
  if (s.includes('admitted')) return { admissions_status: 'Active Resident', status: 'Active' };
  if (s.includes('hold') || s.includes('nurture')) return { admissions_status: 'Hold/Nurture', status: 'Hold' };
  if (s.includes('not admitted') || s.includes('rejected')) return { admissions_status: 'Not Admitted', status: 'Not Admitted' };

  return { admissions_status: 'Sourced', status: 'Sourced' };
}

function mapDealStatus(airtableStatus) {
  if (!airtableStatus) return null;
  const s = airtableStatus.trim();
  if (s === 'Active') return 'Under Consideration';
  if (s === 'Under Consideration') return 'Under Consideration';
  if (s === 'Not Started') return 'Under Consideration';
  if (s === 'Passed') return 'Passed';
  return 'Under Consideration';
}

let created = 0, errors = 0;

for (const record of founders) {
  const f = record.fields || {};
  const name = (f['Founder Name'] || '').trim();
  if (!name || name === '?') continue;

  try {
    const pipelines = f['Pipeline'] || [];
    const isAdmissions = true; // all founders go through admissions pipeline
    const isInvestment = Array.isArray(pipelines) && pipelines.includes('Investment');

    const rawAdmStatus = f['Admission Status'];
    const rawNextStep = f['Next Step Description'];
    const { admissions_status, status } = mapAdmissionStatus(rawAdmStatus, rawNextStep);

    // Build pipeline_tracks
    let tracks = ['admissions'];
    if (isInvestment) tracks.push('investment');
    const pipeline_tracks = tracks.join(',');

    // Cross-reference with investment pipeline for deal data
    const companyName = (f['Company Name'] || '').trim();
    const dealData = companyName ? dealsByCompany[companyName.toLowerCase()] : null;

    let deal_status = null;
    let deal_lead = null;
    let valuation = null;
    let round_size = null;
    let investment_amount = null;
    let arr = null;
    let security_type = null;
    let pass_reason = null;
    let domain = null;
    let diligence_status = null;
    let memo_status = null;

    if (dealData) {
      deal_status = mapDealStatus(dealData['Status']);
      valuation = dealData['Post-Money Valuation'] || null;
      round_size = dealData['Round Size'] || null;
      investment_amount = dealData['Investment Total'] || null;
      arr = dealData['ARR'] || null;
      security_type = dealData['Security Type'] || null;
      pass_reason = dealData['Reason for Pass'] || null;
      domain = dealData['Industry'] || null;
      diligence_status = dealData['Diligence'] === 'Yes' ? 'Complete' : dealData['Diligence'] === 'In Progress' ? 'In Progress' : null;
      memo_status = dealData['Memo'] === 'Yes' ? 'Complete' : dealData['Memo'] === 'In Progress' ? 'In Progress' : null;

      // If deal exists and founder isn't already on investment track, add it
      if (!isInvestment && deal_status) {
        tracks.push('investment');
      }
    } else if (isInvestment) {
      deal_status = 'Under Consideration';
    }

    // Location
    const hq = f['HQ'] || [];
    let location_city = null;
    let location_state = null;
    if (Array.isArray(hq) && hq.length > 0) {
      const loc = hq[0];
      if (loc === 'Chicago') { location_city = 'Chicago'; location_state = 'IL'; }
      else if (loc === 'Bay Area') { location_city = 'Bay Area'; location_state = 'CA'; }
      else if (loc === 'New York') { location_city = 'New York'; location_state = 'NY'; }
      else if (loc === 'Boston') { location_city = 'Boston'; location_state = 'MA'; }
      else if (loc === 'Seattle') { location_city = 'Seattle'; location_state = 'WA'; }
      else if (loc === 'Los Angeles') { location_city = 'Los Angeles'; location_state = 'CA'; }
      else if (loc === 'Evanston') { location_city = 'Evanston'; location_state = 'IL'; }
      else if (loc === 'Ann Arbor') { location_city = 'Ann Arbor'; location_state = 'MI'; }
      else if (loc === 'Milwaukee') { location_city = 'Milwaukee'; location_state = 'WI'; }
      else if (loc === 'Orlando') { location_city = 'Orlando'; location_state = 'FL'; }
      else if (loc === 'Chattanooga') { location_city = 'Chattanooga'; location_state = 'TN'; }
      else if (loc === 'Boulder') { location_city = 'Boulder'; location_state = 'CO'; }
      else if (loc === 'Houston') { location_city = 'Houston'; location_state = 'TX'; }
      else if (loc.includes(',')) {
        const parts = loc.split(',');
        location_city = parts[0].trim();
        location_state = parts[1]?.trim();
      }
      else { location_city = loc; }
    }

    const stage = f['Current Stage'] || 'Pre-seed';

    const result = db.prepare(`
      INSERT INTO founders (
        name, company, email, linkedin_url, website_url,
        location_city, location_state, stage, domain,
        status, source, bio, company_one_liner, next_action,
        pipeline_tracks, admissions_status, deal_status, deal_lead,
        valuation, round_size, investment_amount, arr,
        security_type, pass_reason, diligence_status, memo_status,
        previous_companies, deal_entered_at, admitted_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      name,
      companyName || null,
      f['Email'] || null,
      f['LinkedIn'] || null,
      f['Company Website'] || null,
      location_city,
      location_state,
      stage === 'Service' ? 'Pre-seed' : stage || 'Pre-seed',
      domain || (dealData ? dealData['Sector'] : null) || null,
      status,
      f['Source'] || null,
      null, // bio
      f['Company One-Liner'] || null,
      f['Next Action / Notes'] || null,
      tracks.join(','),
      admissions_status,
      deal_status,
      deal_lead,
      valuation,
      round_size,
      investment_amount,
      arr,
      security_type,
      pass_reason,
      diligence_status,
      memo_status,
      f['Previous Companies'] || null,
      deal_status ? new Date().toISOString() : null,
      admissions_status === 'Active Resident' || admissions_status === 'Admitted' ? new Date().toISOString() : null
    );

    created++;
    console.log(`  + ${name} | ${companyName || '(stealth)'} → ${admissions_status} [raw: ${rawAdmStatus || 'NONE'}]${deal_status ? ' | invest:' + deal_status : ''}`);

    // Add Granola notes if available
    if (f['Granola']) {
      db.prepare('INSERT INTO founder_notes (founder_id, content, created_by) VALUES (?, ?, 1)')
        .run(result.lastInsertRowid, `[Granola Notes]\n${f['Granola']}`);
    }

    // Add next action notes
    if (f['Next Action / Notes']) {
      db.prepare('INSERT INTO founder_notes (founder_id, content, created_by) VALUES (?, ?, 1)')
        .run(result.lastInsertRowid, f['Next Action / Notes']);
    }

  } catch (err) {
    errors++;
    console.error(`  ! ERROR: ${name}: ${err.message}`);
  }
}

// ── Step 3: Import investment pipeline deals that don't have a matching founder ──
console.log('\n--- Checking for investment-only deals not in Founder Ecosystem ---');
let dealOnlyCount = 0;

for (const record of deals) {
  const d = record.fields || {};
  const dealName = (d['Deal Name'] || '').trim();
  if (!dealName) continue;

  // Check if this deal's company already has a founder record
  const existingFounder = db.prepare("SELECT id FROM founders WHERE is_deleted = 0 AND LOWER(company) = LOWER(?)").get(dealName);
  if (existingFounder) continue; // Already imported via founder ecosystem

  try {
    const deal_status = mapDealStatus(d['Status']);
    const domain = d['Industry'] || null;

    const result = db.prepare(`
      INSERT INTO founders (
        name, company, status, domain, stage,
        pipeline_tracks, deal_status, deal_lead,
        valuation, round_size, investment_amount, arr,
        security_type, pass_reason, diligence_status, memo_status,
        source, company_one_liner, deal_entered_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      dealName + ' (Company)', // Use company name as placeholder
      dealName,
      deal_status === 'Passed' ? 'Passed' : 'Sourced',
      domain,
      d['Stage'] || 'Pre-seed',
      'investment',
      deal_status,
      null, // deal_lead - would need to resolve linked record IDs
      d['Post-Money Valuation'] || null,
      d['Round Size'] || null,
      d['Investment Total'] || null,
      d['ARR'] || null,
      d['Security Type'] || null,
      d['Reason for Pass'] || null,
      d['Diligence'] === 'Yes' ? 'Complete' : d['Diligence'] === 'In Progress' ? 'In Progress' : null,
      d['Memo'] === 'Yes' ? 'Complete' : d['Memo'] === 'In Progress' ? 'In Progress' : null,
      d['Source'] || null,
      d['Sector'] || null,
      new Date().toISOString()
    );

    dealOnlyCount++;
    console.log(`  + ${dealName} → invest:${deal_status}`);
  } catch (err) {
    console.error(`  ! DEAL ERROR: ${dealName}: ${err.message}`);
  }
}

console.log(`\n✅ Migration complete!`);
console.log(`   Founders imported from Ecosystem: ${created}`);
console.log(`   Deal-only records imported: ${dealOnlyCount}`);
console.log(`   Errors: ${errors}`);
console.log(`   Previous records soft-deleted: ${deleteCount.changes}`);
} // end runMigration

module.exports = runMigration;

// If run directly (node migrate-from-airtable.js)
if (require.main === module) {
  runMigration().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
