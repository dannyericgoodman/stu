/**
 * routes/mcp.js — /api/mcp (web-session authed): connection info + MCP token management.
 * This is how a user discovers how to connect their agent and mints/revokes tokens.
 * The MCP protocol endpoint itself is POST /mcp (token-authed) — see mcp/http.js.
 */
const express = require('express');
const router = express.Router();
const { issueToken, listTokens, revokeToken, VALID_SCOPES, DEFAULT_SCOPES } = require('../lib/mcpAuth');
const { denyMcpToken } = require('../auth');
const { resolveKey } = require('../lib/providerKeys');
const { listSignals } = require('../lib/builderSignals');
const { listMonitorTypes } = require('../pipeline/monitor-engine');

function baseUrl(req) {
  if (process.env.STU_BASE_URL) return process.env.STU_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const TOOL_CATALOG = [
  { name: 'get_outreach_list', desc: 'YOUR ranked founder outreach list — the flagship. Defaults to unfiltered national scope (stealth→growth, any sector/region) at S/A caliber; filter by stage, sector, region, tier, or use the illinois-preseed preset for the Chicago pre-seed lens.' },
  { name: 'search_sourced_founders', desc: 'Search your sourced-founder queue; filter by builder signals, minimum caliber tier ("A" means S+A), illinois_tie for verified Illinois ties, and best-effort stage / region / sector.' },
  { name: 'get_sourced_founder', desc: 'Full detail on one of your sourced founders: every field, enrichment, signals, and the fit evaluation.' },
  { name: 'discover_builders', desc: 'Go FIND new unicorn-builders from the live web by signal (e.g. YC founders who just left). Best first call — fills your account.' },
  { name: 'list_builder_signals', desc: 'The filterable unicorn-builder signal types.' },
  { name: 'enrich_profile', desc: 'Run the analyst pass on one saved founder: trajectory summary, one-line "why", 0-100 unicorn score.' },
  { name: 'draft_outreach', desc: 'Write a warm, short, personalized investor outreach message to a founder.' },
  { name: 'search_talent_candidates', desc: 'Search your talent candidates; filter by builder signals.' },
  { name: 'get_talent_candidate', desc: 'Full detail on one candidate + matched signals.' },
  { name: 'list_talent_roles', desc: 'Your open portfolio-company roles.' },
  { name: 'get_role_matches', desc: 'Ranked candidate matches for a role.' },
  { name: 'list_monitor_types / create_monitor / list_monitors / list_monitor_hits / run_monitors_now', desc: 'Set up and read "X just happened" alerts (e.g. YC founder just left).' },
];

// GET /api/mcp/info — everything a new user needs to connect their agent.
router.get('/info', (req, res) => {
  const url = `${baseUrl(req)}/mcp`;
  res.json({
    name: 'Stu for Muse',
    tagline: 'Sourcing for every VC — filter stealth→growth founders by stage, sector, region, and builder signals.',
    mcpUrl: url,
    transport: 'streamable-http (stateless)',
    auth: 'Send your Stu MCP token as a Bearer credential: `Authorization: Bearer stu_mcp_…`',
    howToConnect: [
      'Stu for Muse requires a founding seat, then bring your own API keys.',
      '1. Claim your seat and create an MCP token below (POST /api/mcp/tokens). Copy it now — it is shown once.',
      '2. In Settings, add your Exa key (powers web discovery) and Anthropic key — your usage bills your key, never the platform.',
      `3. Point your MCP client (Claude Desktop, Cursor, Muse, etc.) at ${url} with that token as a Bearer header.`,
      '4. Ask: "give me my morning founder outreach list" → your agent calls get_outreach_list and returns your ranked founders. Try "seed-stage AI founders in the Bay Area" or the illinois-preseed preset for a Chicago pre-seed lens.',
    ],
    quickStart: [
      'Give me my morning founder outreach list.',
      'Find me seed-stage AI founders in the Bay Area.',
      'Show me fintech founders raising Series A.',
      'Who should I meet this week?',
      'Find YC founders who just left their company.',
      'Draft an investor outreach message to this founder.',
    ],
    scopes: { available: VALID_SCOPES, default: DEFAULT_SCOPES },
    tools: TOOL_CATALOG,
    builderSignals: listSignals(),
    monitorTypes: listMonitorTypes(),
    // Surface BYOK readiness so the UI can nudge the user to add keys first.
    byok: {
      anthropic_configured: !!resolveKey(req.user.id, 'anthropic'),
      exa_configured: !!resolveKey(req.user.id, 'exa'),
      note: 'Talent/Sourcing search via MCP is deterministic and needs no key. Keys are only needed for sourcing runs and AI features — and are billed to you.',
    },
  });
});

// GET /api/mcp/tokens — list (never returns the token value)
router.get('/tokens', denyMcpToken, (req, res) => {
  res.json(listTokens(req.user.id));
});

// POST /api/mcp/tokens — issue. Returns the plaintext token ONCE.
// denyMcpToken: a token that could mint new tokens — possibly with wider scopes
// than its own — would be a privilege-escalation primitive. Web sessions only.
router.post('/tokens', denyMcpToken, (req, res) => {
  const { label, scopes } = req.body || {};
  const t = issueToken(req.user.id, label || null, scopes);
  res.status(201).json({
    ...t,
    warning: 'Copy this token now — it is shown only once and cannot be retrieved later.',
  });
});

// DELETE /api/mcp/tokens/:id — revoke
router.delete('/tokens/:id', denyMcpToken, (req, res) => {
  const okDel = revokeToken(req.user.id, parseInt(req.params.id));
  if (!okDel) return res.status(404).json({ error: 'Token not found or already revoked' });
  res.json({ success: true });
});

module.exports = router;
