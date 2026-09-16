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
  { name: 'discover_builders', desc: 'Go FIND new unicorn-builders from the live web by signal (e.g. YC founders who just left). Best first call — fills your account.' },
  { name: 'list_builder_signals', desc: 'The filterable unicorn-builder signal types.' },
  { name: 'search_talent_candidates', desc: 'Search your talent candidates; filter by builder signals.' },
  { name: 'get_talent_candidate', desc: 'Full detail on one candidate + matched signals.' },
  { name: 'list_talent_roles', desc: 'Your open portfolio-company roles.' },
  { name: 'get_role_matches', desc: 'Ranked candidate matches for a role.' },
  { name: 'search_sourced_founders', desc: 'Search your sourced-founder queue; filter by builder signals.' },
  { name: 'list_monitor_types / create_monitor / list_monitors / list_monitor_hits / run_monitors_now', desc: 'Set up and read "X just happened" alerts (e.g. YC founder just left).' },
];

// GET /api/mcp/info — everything a new user needs to connect their agent.
router.get('/info', (req, res) => {
  const url = `${baseUrl(req)}/mcp`;
  res.json({
    mcpUrl: url,
    transport: 'streamable-http (stateless)',
    auth: 'Send your Stu MCP token as a Bearer credential: `Authorization: Bearer stu_mcp_…`',
    howToConnect: [
      'Stu is free with an account — no payment, just bring your own API keys.',
      '1. In Settings, add your Exa key (powers web discovery) and Anthropic key — your usage bills your key, never the platform.',
      '2. Create an MCP token below (POST /api/mcp/tokens). Copy it now — it is shown once.',
      `3. Point your MCP client (Claude Desktop, Cursor, etc.) at ${url} with that token as a Bearer header.`,
      '4. Even with an empty account, ask: "find me YC founders who just left" → your agent calls discover_builders and pulls fresh people from the web in seconds.',
    ],
    quickStart: [
      'Find me YC founders who just left their company.',
      'Find founding engineers who recently left OpenAI or Stripe.',
      'Set up a daily alert for YC founders who just left, and make it actively discover new ones.',
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
