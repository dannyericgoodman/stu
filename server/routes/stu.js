const express = require('express');
const router = express.Router();
const db = require('../db');
const { anthropicFor, MODEL } = require('../lib/providerKeys');

// ── Tool definitions for Claude ──
const TOOLS = [
  {
    name: 'search_founders',
    description: 'Search the founder pipeline by name, company, status, domain, stage, track, or any combination. Returns matching founders with their key details.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free text search across name, company, domain, bio, one-liner' },
        status: { type: 'string', description: 'Overall status: Sourced, Outreach, Interviewing, Active, Hold, Passed, Not Admitted, Inactive' },
        track: { type: 'string', description: 'Pipeline track filter: "admissions" or "investment"' },
        admissions_status: { type: 'string', description: 'Admissions pipeline stage: Sourced, Outreach, First Call Scheduled, First Call Complete, Second Call Scheduled, Second Call Complete, Admitted, Active Resident, Density Resident, Alumni, Hold/Nurture, Not Admitted' },
        deal_status: { type: 'string', description: 'Investment pipeline stage: Under Consideration, First Meeting, Partner Call, Memo Draft, IC Review, Committed, Passed' },
        domain: { type: 'string', description: 'Filter by domain/sector' },
        stage: { type: 'string', description: 'Filter by stage: Pre-seed, Seed, Series A' },
        limit: { type: 'number', description: 'Max results to return (default 20)' }
      }
    }
  },
  {
    name: 'get_founder_detail',
    description: 'Get full details for a specific founder including notes, calls, assessments, track info, and deal data.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'The founder ID' },
        name: { type: 'string', description: 'Search by name if ID is not known' }
      }
    }
  },
  {
    name: 'create_founder',
    description: 'Add a new founder to the pipeline. Can set pipeline tracks (admissions, investment, or both).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name (required)' },
        company: { type: 'string', description: 'Company name' },
        role: { type: 'string', description: 'Role/title' },
        email: { type: 'string', description: 'Email address' },
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        location_city: { type: 'string', description: 'City' },
        location_state: { type: 'string', description: 'State' },
        stage: { type: 'string', description: 'Pre-seed, Seed, or Series A' },
        domain: { type: 'string', description: 'Sector/domain' },
        source: { type: 'string', description: 'How this founder was sourced' },
        bio: { type: 'string', description: 'Brief bio or background' },
        chicago_connection: { type: 'string', description: 'Connection to Chicago' },
        previous_companies: { type: 'string', description: 'Previous companies' },
        notable_background: { type: 'string', description: 'Notable background info' },
        company_one_liner: { type: 'string', description: 'Company description one-liner' },
        pipeline_tracks: { type: 'string', description: 'Comma-separated tracks: "admissions", "investment", or "admissions,investment"' },
        admissions_status: { type: 'string', description: 'Admissions pipeline stage' },
        deal_status: { type: 'string', description: 'Investment pipeline stage' },
        status: { type: 'string', description: 'Overall status: Sourced, Outreach, Interviewing, Active, Hold, Passed, Not Admitted, Inactive' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_founder',
    description: 'Update a founder\'s information — change status, tracks, deal data, or any field.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID (required if name not given)' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' },
        updates: {
          type: 'object',
          description: 'Fields to update',
          properties: {
            name: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' },
            email: { type: 'string' }, linkedin_url: { type: 'string' },
            location_city: { type: 'string' }, location_state: { type: 'string' },
            stage: { type: 'string' }, domain: { type: 'string' }, status: { type: 'string' },
            source: { type: 'string' }, bio: { type: 'string' },
            chicago_connection: { type: 'string' }, previous_companies: { type: 'string' },
            notable_background: { type: 'string' }, company_one_liner: { type: 'string' },
            next_action: { type: 'string' },
            pipeline_tracks: { type: 'string' },
            admissions_status: { type: 'string' },
            resident_status: { type: 'string' }, desks_needed: { type: 'number' },
            deal_status: { type: 'string' }, deal_lead: { type: 'string' },
            valuation: { type: 'number' }, round_size: { type: 'number' },
            investment_amount: { type: 'number' }, arr: { type: 'number' },
            monthly_burn: { type: 'number' }, runway_months: { type: 'number' },
            security_type: { type: 'string' }, memo_status: { type: 'string' },
            diligence_status: { type: 'string' }, pass_reason: { type: 'string' }
          }
        }
      },
      required: ['updates']
    }
  },
  {
    name: 'delete_founder',
    description: 'Soft-delete a founder from the pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' }
      }
    }
  },
  {
    name: 'add_note',
    description: 'Add a note to a founder\'s profile.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' },
        content: { type: 'string', description: 'The note content' }
      },
      required: ['content']
    }
  },
  {
    name: 'get_pipeline_stats',
    description: 'Get pipeline statistics — total founders, counts by status, by track, by deal status, by domain, etc.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_assessments',
    description: 'List opportunity assessments.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Filter by founder' },
        signal: { type: 'string', description: 'Filter by conviction band: Anchor-grade, Top-quartile, Monitor, Pass with respect, Insufficient evidence. (Invest/Monitor/Pass is the retired ladder and only matches assessments run before 2026-07-14.)' }
      }
    }
  },
  {
    name: 'run_fit_score',
    description: 'Run an AI fit score analysis on a founder.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' }
      }
    }
  },
  {
    name: 'log_call',
    description: 'Log a call transcript for a founder.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' },
        transcript: { type: 'string', description: 'The call transcript text' }
      },
      required: ['transcript']
    }
  },
  {
    name: 'generate_memo',
    description: 'Generate an IC memo for a founder. Pulls all data (notes, calls, assessments, deal info, files) and generates a comprehensive investment committee memo.',
    input_schema: {
      type: 'object',
      properties: {
        founder_id: { type: 'number', description: 'Founder ID' },
        name_search: { type: 'string', description: 'Find founder by name if ID unknown' }
      }
    }
  },
  {
    name: 'search_everything',
    description: 'Search across all data in Stu — founders, notes, calls, assessments, memos. Use this when the user is looking for something specific across the whole platform.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'query_insights',
    description: 'Run custom analytical queries across the platform data. Use for questions like "what percentage of our pipeline is AI", "average fit score", "show me all residents who are also in the investment pipeline", "how many deals are in diligence", etc.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The analytical question to answer' }
      },
      required: ['question']
    }
  },
  {
    name: 'save_thesis_note',
    description: 'Save a thesis reflection or conclusion the investor has worked through — a position, a pattern spotted in deal flow, a decision to widen/narrow a criterion. Use when the conversation reaches a real conclusion worth keeping, not for every message. Saved in Stu (viewable via list_thesis_notes); not yet synced to the Obsidian vault.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Widening real-industries to include prosumer fintech"' },
        content: { type: 'string', description: 'The full reflection/conclusion, in Danny\'s voice — direct, no filler.' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'list_thesis_notes',
    description: 'List previously saved thesis notes, most recent first. Use when the investor asks to see past thesis reflections or wants to build on an earlier one.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Max notes to return, default 10' } } }
  }
];

// ── Tool execution ──
function resolveFounder(params, userId) {
  if (params.founder_id) {
    return db.prepare('SELECT * FROM founders WHERE id = ? AND is_deleted = 0 AND created_by = ?').get(params.founder_id, userId);
  }
  if (params.name_search || params.name) {
    const search = params.name_search || params.name;
    return db.prepare("SELECT * FROM founders WHERE is_deleted = 0 AND created_by = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT 1").get(userId, `%${search}%`);
  }
  return null;
}

function executeTool(toolName, input, userId) {
  switch (toolName) {
    case 'search_founders': {
      let sql = `SELECT id, name, company, role, domain, stage, status, fit_score, location_city, location_state, source, pipeline_tracks, deal_status, admissions_status, resident_status, company_one_liner, deal_lead, valuation, round_size, created_at, updated_at FROM founders WHERE is_deleted = 0 AND created_by = ?`;
      const params = [userId];
      if (input.search) {
        sql += " AND (name LIKE ? OR company LIKE ? OR domain LIKE ? OR bio LIKE ? OR company_one_liner LIKE ?)";
        const s = `%${input.search}%`;
        params.push(s, s, s, s, s);
      }
      if (input.status) { sql += ' AND status = ?'; params.push(input.status); }
      if (input.domain) { sql += ' AND domain LIKE ?'; params.push(`%${input.domain}%`); }
      if (input.stage) { sql += ' AND stage = ?'; params.push(input.stage); }
      if (input.track === 'admissions') { sql += " AND pipeline_tracks LIKE '%admissions%'"; }
      if (input.track === 'investment') { sql += " AND pipeline_tracks LIKE '%investment%'"; }
      if (input.admissions_status) { sql += ' AND admissions_status = ?'; params.push(input.admissions_status); }
      if (input.deal_status) { sql += ' AND deal_status = ?'; params.push(input.deal_status); }
      if (input.resident_status) { sql += ' AND resident_status = ?'; params.push(input.resident_status); }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(input.limit || 20);
      const founders = db.prepare(sql).all(...params);
      return { success: true, count: founders.length, founders };
    }

    case 'get_founder_detail': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      const notes = db.prepare('SELECT id, content, created_at FROM founder_notes WHERE founder_id = ? ORDER BY created_at DESC LIMIT 10').all(founder.id);
      const calls = db.prepare('SELECT id, structured_summary, created_at FROM call_logs WHERE founder_id = ? ORDER BY created_at DESC LIMIT 5').all(founder.id);
      const assessments = db.prepare('SELECT id, overall_signal, status, created_at FROM opportunity_assessments WHERE founder_id = ? ORDER BY created_at DESC').all(founder.id);
      return { success: true, founder, notes, calls, assessments };
    }

    case 'create_founder': {
      const fields = ['name', 'company', 'role', 'email', 'linkedin_url', 'location_city', 'location_state', 'stage', 'domain', 'source', 'bio', 'chicago_connection', 'previous_companies', 'notable_background', 'company_one_liner', 'pipeline_tracks', 'admissions_status', 'resident_status', 'deal_status', 'status'];
      const cols = ['created_by'];
      const vals = [userId];
      for (const f of fields) {
        if (input[f]) { cols.push(f); vals.push(input[f]); }
      }
      // Auto-set deal_entered_at if investment track
      if (input.pipeline_tracks?.includes('investment')) {
        cols.push('deal_entered_at');
        vals.push(new Date().toISOString());
      }
      if (input.admissions_status === 'Admitted' || input.admissions_status === 'Active Resident') {
        cols.push('admitted_at');
        vals.push(new Date().toISOString());
      }
      const placeholders = cols.map(() => '?').join(', ');
      const result = db.prepare(`INSERT INTO founders (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
      const founder = db.prepare('SELECT * FROM founders WHERE id = ?').get(result.lastInsertRowid);
      const trackInfo = [];
      if (founder.pipeline_tracks?.includes('admissions')) trackInfo.push('Admissions');
      if (founder.pipeline_tracks?.includes('investment')) trackInfo.push('Investment');
      return { success: true, message: `Added ${founder.name} to pipeline${trackInfo.length ? ` (${trackInfo.join(' + ')})` : ''}`, founder };
    }

    case 'update_founder': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      const allowed = ['name', 'company', 'role', 'email', 'linkedin_url', 'location_city', 'location_state', 'stage', 'domain', 'status', 'source', 'bio', 'chicago_connection', 'previous_companies', 'notable_background', 'company_one_liner', 'next_action', 'pipeline_tracks', 'admissions_status', 'resident_status', 'deal_status', 'deal_lead', 'valuation', 'round_size', 'investment_amount', 'arr', 'monthly_burn', 'runway_months', 'security_type', 'memo_status', 'diligence_status', 'pass_reason', 'desks_needed'];
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(input.updates || {})) {
        if (allowed.includes(k) && v !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(v);
        }
      }
      if (sets.length === 0) return { success: false, error: 'No valid fields to update' };
      // Auto-set deal_entered_at
      if (input.updates.deal_status && !founder.deal_entered_at) {
        sets.push('deal_entered_at = CURRENT_TIMESTAMP');
      }
      if (input.updates.resident_status === 'Admitted' && !founder.admitted_at) {
        sets.push('admitted_at = CURRENT_TIMESTAMP');
      }
      sets.push('updated_at = CURRENT_TIMESTAMP');
      vals.push(founder.id);
      db.prepare(`UPDATE founders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const updated = db.prepare('SELECT * FROM founders WHERE id = ?').get(founder.id);
      return { success: true, message: `Updated ${updated.name}`, founder: updated, changed: Object.keys(input.updates) };
    }

    case 'delete_founder': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      db.prepare('UPDATE founders SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(founder.id);
      return { success: true, message: `Removed ${founder.name} from pipeline` };
    }

    case 'add_note': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      const result = db.prepare('INSERT INTO founder_notes (founder_id, content, created_by) VALUES (?, ?, ?)').run(founder.id, input.content, userId);
      return { success: true, message: `Note added to ${founder.name}'s profile`, note_id: result.lastInsertRowid, founder_name: founder.name };
    }

    case 'get_pipeline_stats': {
      const total = db.prepare('SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ?').get(userId).count;
      const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? GROUP BY status ORDER BY count DESC').all(userId);
      const byDomain = db.prepare(`SELECT domain, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND domain IS NOT NULL AND domain != '' GROUP BY domain ORDER BY count DESC`).all(userId);
      const byStage = db.prepare('SELECT stage, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? GROUP BY stage ORDER BY count DESC').all(userId);
      const admissions = db.prepare("SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND pipeline_tracks LIKE '%admissions%'").get(userId).count;
      const investments = db.prepare("SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND pipeline_tracks LIKE '%investment%'").get(userId).count;
      const byDealStatus = db.prepare("SELECT deal_status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND deal_status IS NOT NULL GROUP BY deal_status ORDER BY count DESC").all(userId);
      const byAdmissionsStatus = db.prepare("SELECT admissions_status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND admissions_status IS NOT NULL GROUP BY admissions_status ORDER BY count DESC").all(userId);
      const recentlyAdded = db.prepare('SELECT name, company, status, pipeline_tracks, admissions_status, deal_status, created_at FROM founders WHERE is_deleted = 0 AND created_by = ? ORDER BY created_at DESC LIMIT 5').all(userId);
      const avgFitScore = db.prepare('SELECT AVG(fit_score) as avg, COUNT(fit_score) as scored FROM founders WHERE is_deleted = 0 AND created_by = ? AND fit_score IS NOT NULL').get(userId);
      const assessmentCount = db.prepare('SELECT COUNT(*) as count FROM opportunity_assessments WHERE created_by = ?').get(userId).count;
      return { success: true, total, byStatus, byDomain, byStage, admissions, investments, byDealStatus, byAdmissionsStatus, recentlyAdded, avgFitScore, assessmentCount };
    }

    case 'get_assessments': {
      // conviction_score/band/evidence_rung are selected so the model answering over this
      // can tell an unscored assessment ("we haven't learned enough") from a rejection.
      // Without them, "Insufficient evidence" is just a string that reads like a verdict.
      let sql = `SELECT oa.id, oa.overall_signal, oa.conviction_score, oa.conviction_band, oa.evidence_rung, oa.status, oa.created_at,
        f.name as founder_name, f.company as founder_company
        FROM opportunity_assessments oa
        LEFT JOIN founders f ON oa.founder_id = f.id WHERE oa.created_by = ?`;
      const params = [userId];
      if (input.founder_id) { sql += ' AND oa.founder_id = ?'; params.push(input.founder_id); }
      if (input.signal) { sql += ' AND oa.overall_signal = ?'; params.push(input.signal); }
      sql += ' ORDER BY oa.created_at DESC LIMIT 20';
      const assessments = db.prepare(sql).all(...params);
      return { success: true, count: assessments.length, assessments };
    }

    case 'run_fit_score': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      return { success: true, message: 'Fit score will be generated', founder_id: founder.id, founder_name: founder.name, needs_ai_scoring: true };
    }

    case 'log_call': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found. Please specify which founder this call was with.' };
      const result = db.prepare('INSERT INTO call_logs (founder_id, raw_transcript, created_by) VALUES (?, ?, ?)').run(founder.id, input.transcript, userId);
      return { success: true, message: `Call transcript logged for ${founder.name}`, call_id: result.lastInsertRowid, founder_name: founder.name };
    }

    case 'generate_memo': {
      const founder = resolveFounder(input, userId);
      if (!founder) return { success: false, error: 'Founder not found' };
      // Trigger memo generation (async, returns immediately)
      const memoCount = db.prepare('SELECT COUNT(*) as count FROM founder_memos WHERE founder_id = ?').get(founder.id).count;
      const version = memoCount + 1;
      const memoResult = db.prepare('INSERT INTO founder_memos (founder_id, memo_type, content, version, created_by) VALUES (?, ?, ?, ?, ?)').run(founder.id, 'ic_memo', '', version, userId);
      // The actual generation happens async via the memos route logic, but we trigger it here too
      return { success: true, message: `IC memo generation started for ${founder.name} (v${version}). View it on their profile page.`, founder_id: founder.id, founder_name: founder.name, memo_id: memoResult.lastInsertRowid };
    }

    case 'search_everything': {
      const q = input.query;
      const like = `%${q}%`;
      const founders = db.prepare("SELECT id, name, company, domain, status, deal_status FROM founders WHERE is_deleted = 0 AND created_by = ? AND (name LIKE ? OR company LIKE ? OR domain LIKE ?) ORDER BY updated_at DESC LIMIT 5").all(userId, like, like, like);
      const notes = db.prepare("SELECT n.id, n.content, f.name as founder_name FROM founder_notes n JOIN founders f ON n.founder_id = f.id WHERE f.created_by = ? AND n.content LIKE ? ORDER BY n.created_at DESC LIMIT 5").all(userId, like);
      const calls = db.prepare("SELECT c.id, c.structured_summary, f.name as founder_name FROM call_logs c JOIN founders f ON c.founder_id = f.id WHERE f.created_by = ? AND (c.raw_transcript LIKE ? OR c.structured_summary LIKE ?) ORDER BY c.created_at DESC LIMIT 5").all(userId, like, like);
      return { success: true, query: q, founders, notes, calls };
    }

    case 'query_insights': {
      const total = db.prepare('SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ?').get(userId).count;
      const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? GROUP BY status').all(userId);
      const byDomain = db.prepare(`SELECT domain, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND domain IS NOT NULL AND domain != '' GROUP BY domain ORDER BY count DESC LIMIT 15`).all(userId);
      const admissions = db.prepare("SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND pipeline_tracks LIKE '%admissions%'").get(userId).count;
      const investments = db.prepare("SELECT COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND pipeline_tracks LIKE '%investment%'").get(userId).count;
      const byDealStatus = db.prepare("SELECT deal_status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND deal_status IS NOT NULL GROUP BY deal_status").all(userId);
      const byAdmissionsStatus = db.prepare("SELECT admissions_status, COUNT(*) as count FROM founders WHERE is_deleted = 0 AND created_by = ? AND admissions_status IS NOT NULL GROUP BY admissions_status").all(userId);
      const scored = db.prepare('SELECT name, company, domain, fit_score, status, pipeline_tracks, deal_status, admissions_status FROM founders WHERE is_deleted = 0 AND created_by = ? AND fit_score IS NOT NULL ORDER BY fit_score DESC LIMIT 25').all(userId);
      const recent = db.prepare('SELECT name, company, status, domain, stage, pipeline_tracks, deal_status, admissions_status, created_at FROM founders WHERE is_deleted = 0 AND created_by = ? ORDER BY created_at DESC LIMIT 10').all(userId);
      const passed = db.prepare("SELECT name, company, domain, pass_reason FROM founders WHERE is_deleted = 0 AND created_by = ? AND (status = 'Passed' OR deal_status = 'Passed' OR admissions_status = 'Not Admitted') LIMIT 20").all(userId);
      const activeDeals = db.prepare("SELECT name, company, deal_status, deal_lead, valuation, round_size, arr FROM founders WHERE is_deleted = 0 AND created_by = ? AND pipeline_tracks LIKE '%investment%' AND deal_status NOT IN ('Passed', 'Committed') ORDER BY deal_entered_at DESC LIMIT 20").all(userId);
      const assessments = db.prepare(`SELECT oa.overall_signal, f.name, f.company FROM opportunity_assessments oa LEFT JOIN founders f ON oa.founder_id = f.id WHERE oa.status = 'complete' AND oa.created_by = ? ORDER BY oa.created_at DESC LIMIT 10`).all(userId);
      return {
        success: true,
        question: input.question,
        data: { total, byStatus, byDomain, admissions, investments, byDealStatus, byAdmissionsStatus, scored, recent, passed, activeDeals, assessments }
      };
    }

    case 'save_thesis_note': {
      if (!input.title || !input.content) return { success: false, error: 'title and content are required' };
      const result = db.prepare('INSERT INTO thesis_notes (title, content, created_by) VALUES (?, ?, ?)').run(input.title, input.content, userId);
      return { success: true, id: result.lastInsertRowid, title: input.title };
    }

    case 'list_thesis_notes': {
      const limit = Math.min(input.limit || 10, 50);
      const notes = db.prepare('SELECT id, title, content, created_at FROM thesis_notes WHERE created_by = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
      return { success: true, count: notes.length, notes };
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

// Per-user system prompt. The pipeline MODEL (statuses, tracks) is product structure
// and stays for everyone; Danny's fund context (team names, thesis specifics, the
// four-trait doctrine) is owner-only and lives behind isOwner. A non-owner gets a
// neutral investor identity plus their fund name when they've set one in Settings.
function buildStuSystem(userId) {
  const { isOwner } = require('../lib/providerKeys');
  const { getSetting } = require('../lib/aiIdentity');
  const owner = isOwner(userId);
  let user = {};
  try { user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId) || {}; } catch {}
  const name = (user.name || user.email || 'the investor').trim();
  const fundName = getSetting(userId, 'profile_fund_name');

  const identity = owner
    ? `You are Stu, the intelligence layer for Superior Studios — a Chicago-based pre-seed venture fund with a founder community/residency program.`
    : fundName
      ? `You are Stu, the intelligence layer for ${name} at ${fundName}.`
      : `You are Stu, the intelligence layer for ${name}, a venture investor.`;

  const pipelineModel = `You are the primary interface for managing the unified pipeline. Every founder has one record with two activatable tracks: Admissions and Investment.

PIPELINE MODEL:
- Overall status: Sourced, Outreach, Interviewing, Active, Hold, Passed, Not Admitted, Inactive
- Admissions Pipeline (admissions_status): Sourced → Outreach → First Call Scheduled → First Call Complete → Second Call Scheduled → Second Call Complete → Admitted / Not Admitted / Hold/Nurture
  - After admission: Active Resident, Density Resident, Alumni
- Investment Pipeline (deal_status): Under Consideration → First Meeting → Partner Call → Memo Draft → IC Review → Committed / Passed
- A founder can be on NEITHER, ONE, or BOTH tracks simultaneously
- pipeline_tracks field is comma-separated: "admissions", "investment", or "admissions,investment"`;

  const flows = owner ? `
ADMISSIONS FLOW:
1. Danny finds founders (manual research or sourcing tool)
2. Outreach → First Call with Danny
3. Second Call (another team member joins)
4. Decision: Admit as resident, or Hold/Not Admitted
5. If investment interest emerges at any point, activate the investment track too

INVESTMENT FLOW:
1. Under Consideration → First Meeting
2. Partner Call (Eric Hutt looped in)
3. Memo Draft (IC memo written)
4. IC Review (presented to Brandon Cruz)
5. Decision: Committed or Passed` : `
ADMISSIONS FLOW:
1. Find founders (manual research or sourcing tool)
2. Outreach → First Call
3. Second Call
4. Decision: Admit as resident, or Hold/Not Admitted
5. If investment interest emerges at any point, activate the investment track too

INVESTMENT FLOW:
1. Under Consideration → First Meeting
2. Partner Call
3. Memo Draft (IC memo written)
4. IC Review
5. Decision: Committed or Passed`;

  const behavior = `
BEHAVIOR:
- Be direct and concise. Never start with "Great question" or filler.
- When the user gives you information about a founder/meeting/deal, proactively use tools to record it.
- When creating founders, infer the right tracks from context (e.g., "met a founder at the space" → admissions track, "interesting deal" → investment track).
- When the user says "move to diligence" or "start investment process", set pipeline_tracks to include "investment" and set deal_status appropriately.
- When presenting data, format it cleanly with lists and structure.
- For analytical questions, use query_insights then synthesize a clear answer.`;

  const context = owner ? `
INVESTMENT CONTEXT:
- Superior Studios invests pre-seed in Chicago/Midwest founders
- Focus: B2B SaaS, AI Infrastructure, Vertical Software, Fintech, Healthtech, Marketplace
- Four required founder traits: Speed, Storytelling, Salesmanship, Build+Motivate
- Team: Brandon Cruz (Managing Partner), Eric Hutt (VP), Rob Schinske (Senior Associate), Danny Goodman (Strategic Initiatives)
- Signals: Invest, Monitor, Pass` : `
INVESTMENT CONTEXT:
- Pre-seed investor${fundName ? ` at ${fundName}` : ''}
- Focus: the sourcing criteria in Settings (B2B SaaS, AI, fintech, healthtech, marketplace by default)
- Signals: Invest, Monitor, Pass`;

  return [identity, pipelineModel, flows, behavior, context].join('\n');
}

// Thesis Update mode (Ask Stu, ?topic=thesis). Danny's actual vault thesis text isn't
// fetchable here — Stu runs remote and can't read his local Obsidian vault (the same
// one-way limitation the vault-sync bridge works around by having the LOCAL side pull FROM
// Stu, not the reverse). So this grounds in the two things that ARE real and available:
// (1) the confirmed current thesis parameters, and (2) actual deal flow already in Stu's
// own DB — which needs no cross-boundary fetch at all.
// Thesis Update mode (?topic=thesis). Danny's confirmed thesis parameters are
// owner-only; everyone else gets the same thinking-partner posture pointed at
// THEIR deal flow, without the private specifics.
function buildThesisAddendum(userId) {
  const { isOwner } = require('../lib/providerKeys');
  const how = `
HOW TO WORK:
- Lean on query_insights, get_assessments, and search_founders to ground the conversation in REAL deal flow — what's actually been Passed and why (pass_reason), what's converting, what domains keep showing up. Don't theorize in a vacuum when the data is one tool call away.
- Push back. If a widening or narrowing of a criterion is proposed, ask what evidence from recent deal flow supports it, or surface evidence that complicates it.
- When the conversation reaches a real conclusion — a position taken, a pattern confirmed, a criterion changed — offer to save it with save_thesis_note. Don't save every message, only actual conclusions.
- Direct, no filler, no hedging. This is investment judgment, not a status update.`;
  if (isOwner(userId)) {
    return `

── THESIS UPDATE MODE ──
Danny is working through his fund thesis, not managing pipeline records. Be a sharp thinking partner, not a form-filler.

CURRENT THESIS (the starting point, not gospel — the point of this conversation may be to pressure-test or evolve it):
- $10M pre-seed fund. Check size $150K-$400K.
- Real industries — professional services, construction, healthcare, legal, financial services. NOT tech-to-tech / horizontal SaaS.
- Chicago/Midwest first.
- Back the person over the deck.
` + how;
  }
  return `

── THESIS UPDATE MODE ──
The investor is working through their fund thesis, not managing pipeline records. Be a sharp thinking partner, not a form-filler.
` + how;
}

// Truncate tool results to prevent context overflow
function truncateToolResult(result) {
  const json = JSON.stringify(result);
  // If result is small enough, return as-is
  if (json.length < 8000) return json;
  // For large results, summarize to keep within token budget
  if (result.founders && result.founders.length > 10) {
    return JSON.stringify({
      ...result,
      founders: result.founders.slice(0, 10),
      _truncated: true,
      _total: result.count || result.founders.length
    });
  }
  if (result.data) {
    // Truncate nested arrays in query_insights
    const trimmed = { ...result, data: {} };
    for (const [k, v] of Object.entries(result.data)) {
      trimmed.data[k] = Array.isArray(v) ? v.slice(0, 15) : v;
    }
    return JSON.stringify(trimmed);
  }
  // Last resort: truncate raw JSON
  if (json.length > 12000) {
    return json.slice(0, 12000) + '..."}}';
  }
  return json;
}

// POST /api/stu/chat — tool-use powered chat
router.post('/chat', async (req, res) => {
  const client = anthropicFor(req.user.id, 'stu-chat');
  if (!client) return res.status(503).json({ error: 'AI unavailable — add your Anthropic API key in Settings' });

  const { messages, mode } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'Messages required' });

  const userId = req.user?.id;
  const systemPrompt = mode === 'thesis' ? buildStuSystem(userId) + buildThesisAddendum(userId) : buildStuSystem(userId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    let conversationMessages = messages.map(m => {
      if (m.role === 'tool_results') return { role: 'user', content: m.content };
      return { role: m.role, content: m.content };
    });

    let maxIterations = 5;

    while (maxIterations-- > 0) {
      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools: TOOLS,
          messages: conversationMessages
        });
      } catch (apiErr) {
        console.error('Claude API error:', apiErr.message);
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI request failed — try a shorter message or start a new conversation.' })}\n\n`);
        break;
      }

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');

      // Stream text blocks
      for (const block of textBlocks) {
        if (block.text) {
          res.write(`data: ${JSON.stringify({ type: 'text', text: block.text })}\n\n`);
        }
      }

      // If no tool calls, we're done
      if (toolUses.length === 0) break;

      // Execute tool calls
      for (const tu of toolUses) {
        res.write(`data: ${JSON.stringify({ type: 'tool_call', tool: tu.name, input: tu.input })}\n\n`);
      }

      const toolResults = toolUses.map(tu => {
        let result;
        try {
          result = executeTool(tu.name, tu.input, userId);
        } catch (toolErr) {
          console.error(`Tool execution error (${tu.name}):`, toolErr.message);
          result = { success: false, error: `Failed to execute ${tu.name}: ${toolErr.message}` };
        }
        // Send full result to client for rich rendering
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tu.name, result })}\n\n`);
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          // Truncate for Claude context to prevent overflow
          content: truncateToolResult(result)
        };
      });

      conversationMessages.push({ role: 'assistant', content: response.content });
      conversationMessages.push({ role: 'user', content: toolResults });

      // If Claude signaled end_turn despite having tool calls, execute tools but don't loop
      if (response.stop_reason === 'end_turn') break;
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Stu chat error:', err);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    } catch {
      // Response already closed
    }
  }
});

module.exports = router;
