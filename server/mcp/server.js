/**
 * server.js — builds a per-request MCP server bound to one authenticated user.
 *
 * Tools are scoped to the caller (every query filters by their user_id) and registered
 * only if the caller's token carries the required scope — so a `talent:read` token's
 * tools/list never even shows the monitor tools. Each call is audited to job_runs.
 *
 * The Talent/Sourcing data here is the CALLER'S OWN. The MCP surface has no code path to
 * founders / assessments / notes / memos — those stay private to Stu's owner.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const db = require('./../db');

const { listSignals, VALID_SIGNAL_KEYS } = require('../lib/builderSignals');
const talent = require('./talentData');
const monitors = require('./monitorData');
const { listMonitorTypes, runUserMonitors } = require('../pipeline/monitor-engine');
const { discover } = require('../pipeline/discovery-engine');
const { enrichProfiles } = require('../pipeline/enrichment');
const { draftOutreach } = require('../pipeline/outreach');
const { hasScope } = require('../lib/mcpAuth');

const loadPerson = (userId, args) => talent.getPerson(userId, args);

function audit(userId, tool, status, detail) {
  try {
    db.prepare('INSERT INTO job_runs (user_id, job, status, detail) VALUES (?, ?, ?, ?)')
      .run(userId, `mcp:${tool}`, status, detail ? String(detail).slice(0, 500) : null);
  } catch { /* audit must never break a tool call */ }
}

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function fail(message) { return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }; }

const signalEnum = z.enum(VALID_SIGNAL_KEYS);

function buildMcpServer({ userId, scopes = [] }) {
  const server = new McpServer({ name: 'stu-talent', version: '1.0.0' });

  // Register a tool with audit + uniform error handling.
  const tool = (name, requiredScope, config, handler) => {
    if (requiredScope && !hasScope(scopes, requiredScope)) return; // omit from tools/list
    server.registerTool(name, config, async (args) => {
      try {
        const result = await handler(args || {});
        audit(userId, name, 'ok', Array.isArray(result) ? `${result.length} rows` : null);
        return ok(result);
      } catch (e) {
        audit(userId, name, 'error', e.message);
        return fail(e.message);
      }
    });
  };

  // ── Catalog (no scope required) ──
  tool('list_builder_signals', null, {
    title: 'List builder signals',
    description: 'The filterable "unicorn builder" signal types (e.g. just_departed, stealth_building, founder_factory_alum) usable on talent and sourcing searches. Returns each signal\'s key, label, description, and which products it applies to.',
    inputSchema: { product: z.enum(['talent', 'sourcing']).optional() },
  }, async ({ product }) => listSignals(product));

  tool('list_monitor_types', 'monitors', {
    title: 'List monitor types',
    description: 'The monitor types you can create (e.g. yc_departure = "YC founder just left", factory_departure, stealth, repeat_founder, formation).',
    inputSchema: {},
  }, async () => listMonitorTypes());

  // ── Talent (talent:read) ──
  tool('search_talent_candidates', 'talent:read', {
    title: 'Search talent candidates',
    description: 'Search YOUR talent candidates. Optionally filter by builder signals (e.g. ["just_departed"]) — pass signals to surface, say, people who just left a top company. mode "all" requires every signal; "any" (default) requires one.',
    inputSchema: {
      query: z.string().optional(),
      signals: z.array(signalEnum).optional(),
      mode: z.enum(['any', 'all']).optional(),
      roleId: z.number().optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      limit: z.number().min(1).max(100).optional(),
    },
  }, async (a) => {
    const results = talent.searchTalentCandidates(userId, a);
    const out = { count: results.length, results };
    if (!results.length && a.signals && a.signals.length) {
      out.hint = 'No saved candidates match these signals. Call discover_builders (target:"talent") to find new people from the web — uses your Exa key.';
    }
    return out;
  });

  tool('get_talent_candidate', 'talent:read', {
    title: 'Get a talent candidate',
    description: 'Full detail on one of your talent candidates, including which builder signals they match.',
    inputSchema: { id: z.number() },
  }, async ({ id }) => {
    const c = talent.getTalentCandidate(userId, id);
    if (!c) throw new Error('Candidate not found');
    return c;
  });

  tool('list_talent_roles', 'talent:read', {
    title: 'List open roles',
    description: 'Your portfolio-company roles you are hiring for.',
    inputSchema: {},
  }, async () => talent.listTalentRoles(userId));

  tool('get_role_matches', 'talent:read', {
    title: 'Get candidate matches for a role',
    description: 'Ranked candidate↔role matches for one of your roles.',
    inputSchema: { roleId: z.number() },
  }, async ({ roleId }) => talent.getRoleMatches(userId, roleId));

  // ── Active discovery (sourcing:read) — go FIND new people from the live web ──
  tool('discover_builders', 'sourcing:read', {
    title: 'Discover new builders from the web',
    description: 'Go find NEW unicorn-builder profiles from the live web by signal — use this when your saved data is empty or you want fresh people (e.g. "find YC founders who just left"). Discovered people are saved to your account. Uses your Exa key for search, and (unless enrich:false) your Anthropic key to score + rank them — both billed to you. target:"talent" requires the talent:write scope.',
    inputSchema: {
      signals: z.array(signalEnum).optional(),
      query: z.string().optional(),
      target: z.enum(['sourcing', 'talent']).optional(),
      enrich: z.boolean().optional(),
      limit: z.number().min(1).max(50).optional(),
    },
  }, async ({ signals, query, target, enrich, limit }) => {
    if (target === 'talent' && !hasScope(scopes, 'talent:write')) throw new Error('Saving to talent requires the talent:write scope.');
    const r = await discover({ userId, signals: signals || ['just_departed'], query: query || '', target: target || 'sourcing', enrich: enrich !== false, limit: limit || 25 });
    return { found: r.matched.length, saved: r.persisted, enriched: r.enriched, results: r.matched };
  });

  // ── Draft outreach (talent:read) — close the loop: find → personalized message ──
  tool('draft_outreach', 'talent:read', {
    title: 'Draft a personalized outreach message',
    description: 'Write a warm, short, personalized outreach to a person — pass candidateId or founderId (one of yours) or raw person fields. intent: recruit | invest | connect. Uses your Anthropic key.',
    inputSchema: {
      candidateId: z.number().optional(),
      founderId: z.number().optional(),
      person: z.object({ name: z.string().optional(), headline: z.string().optional(), company: z.string().optional(), role: z.string().optional(), why: z.string().optional() }).optional(),
      intent: z.enum(['recruit', 'invest', 'connect']).optional(),
      context: z.string().optional(),
      channel: z.enum(['email', 'linkedin', 'dm']).optional(),
      voice: z.string().optional(),
    },
  }, async (a) => {
    const person = (a.candidateId || a.founderId) ? loadPerson(userId, a) : (a.person || {});
    if (!person) throw new Error('Person not found');
    return draftOutreach(userId, { person, intent: a.intent, context: a.context, channel: a.channel, voice: a.voice });
  });

  // ── Deep-dive enrich one saved person (sourcing:read) ──
  tool('enrich_profile', 'sourcing:read', {
    title: 'Enrich a saved profile',
    description: 'Run the analyst pass on one saved person (candidateId or founderId): clean fields, a trajectory summary, a one-line "why", and a 0-100 unicorn score. Saves the result. Uses your Anthropic key.',
    inputSchema: { candidateId: z.number().optional(), founderId: z.number().optional() },
  }, async (a) => {
    if (a.candidateId && !hasScope(scopes, 'talent:write')) throw new Error('Updating a talent candidate requires the talent:write scope.');
    const person = loadPerson(userId, a);
    if (!person) throw new Error('Person not found');
    const [enriched] = (await enrichProfiles(userId, [person], { feature: 'enrich-profile' })) || [];
    if (!enriched) throw new Error('Enrichment unavailable — add your Anthropic key in Settings.');
    const enrichment = JSON.stringify({ summary: enriched.summary, why: enriched.why, contactability: enriched.contactability });
    if (a.candidateId) db.prepare('UPDATE talent_candidates SET unicorn_score = ?, enrichment = ? WHERE id = ? AND user_id = ?').run(enriched.unicorn_score, enrichment, a.candidateId, userId);
    else if (a.founderId) db.prepare('UPDATE sourced_founders SET unicorn_score = ?, enrichment = ? WHERE id = ? AND user_id = ?').run(enriched.unicorn_score, enrichment, a.founderId, userId);
    return enriched;
  });

  // ── Sourcing (sourcing:read) ──
  tool('search_sourced_founders', 'sourcing:read', {
    title: 'Search sourced founders',
    description: 'Search YOUR sourced-founder queue. Filter by builder signals — e.g. signals ["just_departed"] with the yc tier, or ["stealth_building"], to find unicorn-builder founder profiles.',
    inputSchema: {
      query: z.string().optional(),
      signals: z.array(signalEnum).optional(),
      mode: z.enum(['any', 'all']).optional(),
      status: z.enum(['pending', 'starred', 'approved', 'watching', 'dismissed']).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      limit: z.number().min(1).max(100).optional(),
    },
  }, async (a) => {
    const results = talent.searchSourcedFounders(userId, a);
    const out = { count: results.length, results };
    if (!results.length && a.signals && a.signals.length) {
      out.hint = 'No saved founders match these signals. Call discover_builders to find new people from the web — uses your Exa key.';
    }
    return out;
  });

  // ── Monitors (monitors) ──
  tool('create_monitor', 'monitors', {
    title: 'Create a signal monitor',
    description: 'Create an alert that watches for a builder signal (e.g. type "yc_departure" alerts when a YC founder just left). Use list_monitor_types for valid types.',
    inputSchema: {
      type: z.string(),
      label: z.string().optional(),
      config: z.record(z.any()).optional(),
    },
  }, async ({ type, label, config }) => monitors.createMonitor(userId, { type, label, config }));

  tool('list_monitors', 'monitors', {
    title: 'List monitors',
    description: 'Your configured monitors, each with a count of new (unseen) hits.',
    inputSchema: {},
  }, async () => monitors.listMonitors(userId));

  tool('list_monitor_hits', 'monitors', {
    title: 'List monitor hits',
    description: 'Recent alerts from your monitors — who was surfaced, the matched signal, and inferred intent. Optionally scope to one monitor or a recent window.',
    inputSchema: {
      monitorId: z.number().optional(),
      sinceDays: z.number().optional(),
      limit: z.number().min(1).max(200).optional(),
    },
  }, async (a) => monitors.listHits(userId, a));

  tool('run_monitors_now', 'monitors', {
    title: 'Run my monitors now',
    description: 'Evaluate all your enabled monitors immediately against your current data and return how many new hits were found.',
    inputSchema: {},
  }, async () => await runUserMonitors(userId));

  return server;
}

module.exports = { buildMcpServer };
