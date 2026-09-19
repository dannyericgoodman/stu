const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

// ── JWT_SECRET fails closed ──
// There used to be a hardcoded dev fallback ('superior-os-dev-secret-change-me').
// A known secret means anyone can forge a token for any user — including the owner,
// which unlocks the platform provider keys. So:
//   · production without JWT_SECRET → refuse to boot (loud, immediate);
//   · dev/test without JWT_SECRET → a random EPHEMERAL secret (tokens die with the
//     process; nothing to leak, nothing to remember, and no shared default).
// index.js keeps its own production guard as the first line of defense; this is
// the second, for anything that requires auth.js without booting the server
// (scripts, tests, one-off jobs).
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET must be set in production. Refusing to start.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[Auth] JWT_SECRET not set — using an ephemeral dev secret (sessions die on restart). Set JWT_SECRET in production.');
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.split(' ')[1];
  // Long-lived MCP/API token (stu_mcp_…) — revocable, per-user. Lets a user's own
  // agent call the API directly (e.g. the daily founder-list job) without a browser
  // session. Verified against the mcp_tokens table; carries the owner's user_id.
  if (token.startsWith('stu_mcp_')) {
    const { verifyToken } = require('./lib/mcpAuth');
    const v = verifyToken(token);
    if (!v) return res.status(401).json({ error: 'Invalid or revoked token' });
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(v.userId);
    if (!user) return res.status(401).json({ error: 'Invalid or revoked token' });
    req.user = user;
    req.tokenScopes = v.scopes;
    req.apiTokenId = v.tokenId;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Seed the team if no users exist. Normally a no-op now — db.js already ensures the
// owner (user_id=1) exists at init so the user_id=1 seeds don't FK-crash on a fresh DB.
// Kept as a safety net; uses the same env-overridable default password.
function seedTeam() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count === 0) {
    const pw = process.env.SEED_ADMIN_PASSWORD || 'Murphy1!';
    const insert = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
    insert.run('danny.eric.goodman@gmail.com', 'Danny Goodman', 'admin', hashPassword(pw));
    console.log('Seeded admin account');
  }
}

module.exports = { hashPassword, verifyPassword, generateToken, requireAuth, requirePaid, requireMcpScope, mcpScopeFor, denyMcpToken, denyMcpRest, seedTeam };

/**
 * requirePaid — the paywall. Mounted on /api/* (after the public mounts for
 * /api/health, /api/auth, /api/payments and /api/vault-sync, which must stay
 * open). Runs BEFORE the per-route requireAuth, so it tolerates a missing
 * req.user and lets requireAuth produce the 401 — it only answers the payment
 * question for requests that are actually authenticated.
 *
 * has_paid is the single source of truth; the owner bypass lives in the data
 * (db.js payment_v1 migration sets has_paid=1 for user 1 and all pre-payment
 * users), not in a role check here, so there is exactly one rule to audit.
 */
function requirePaid(req, res, next) {
  if (!req.user) return next();
  let paid = false;
  try {
    const row = db.prepare('SELECT has_paid FROM users WHERE id = ?').get(req.user.id);
    paid = !!(row && row.has_paid);
  } catch (e) {
    return res.status(500).json({ error: 'Payment check failed' });
  }
  if (paid) return next();
  return res.status(402).json({
    error: 'An active Stu account is required.',
    code: 'payment_required',
  });
}

/**
 * requireMcpScope(...scopes) — enforce MCP token scopes on the REST surface.
 * Web JWT sessions (interactive users) pass through untouched; a request
 * authenticated with a long-lived stu_mcp_ token must hold one of the listed
 * scopes. Without this, a read-only token could call any write endpoint the
 * web app can — the scopes would be decoration.
 */
function requireMcpScope(...scopes) {
  return (req, res, next) => {
    if (!req.apiTokenId) return next(); // web session — full user access
    const { hasScope } = require('./lib/mcpAuth');
    if (scopes.some((s) => hasScope(req.tokenScopes, s))) return next();
    return res.status(403).json({
      error: `This API token lacks the required scope (${scopes.join(' or ')}).`,
      code: 'insufficient_scope',
    });
  };
}

/**
 * mcpScopeFor(area) — mount-level scope policy for one API area, so individual
 * route files don't each re-derive it. Web sessions pass through; API-token
 * callers get the read scope on GET and the write scope on anything else.
 *
 *   talent   → talent:read / talent:write
 *   sourcing → sourcing:read on GET; token callers may NOT write via REST
 *              (sourcing writes go through the scope-checked MCP protocol
 *              endpoint, e.g. discover_builders — one enforcement point)
 *   monitors → monitors (the scope covers read + manage, mirroring the MCP tools)
 */
function mcpScopeFor(area) {
  const READ = { talent: 'talent:read', sourcing: 'sourcing:read', monitors: 'monitors' };
  const WRITE = { talent: 'talent:write', sourcing: null, monitors: 'monitors' };
  return (req, res, next) => {
    if (!req.apiTokenId) return next(); // web session — full user access
    const need = req.method === 'GET' ? READ[area] : WRITE[area];
    if (!need) {
      return res.status(403).json({
        error: 'API tokens cannot perform this action — use a web session, or the MCP endpoint for discovery.',
        code: 'insufficient_scope',
      });
    }
    return requireMcpScope(need)(req, res, next);
  };
}

/**
 * denyMcpRest — default-deny for long-lived API tokens on the REST surface.
 *
 * Mount-level scope policies (mcpScopeFor) exist for a handful of areas where
 * token access is a deliberate product choice (sourcing/talent/monitors reads,
 * the MCP protocol's own tool surface). Every OTHER /api route mounts this:
 * an stu_mcp_ token there is almost certainly a confused or abused credential,
 * and the pre-existing behavior — full user access via generic requireAuth —
 * made token scopes decoration. Web sessions pass through untouched.
 */
function denyMcpRest(req, res, next) {
  if (req.apiTokenId) {
    return res.status(403).json({
      error: 'API tokens are for the MCP endpoint and explicitly scoped routes only — use a web session for the REST API.',
      code: 'mcp_token_denied',
    });
  }
  next();
}
/**
 * denyMcpToken — some endpoints must never be reachable with a long-lived API
 * token, no matter its scopes. Token management is the sharp one: a token that
 * could mint new tokens (possibly with wider scopes than its own) would be a
 * privilege-escalation primitive. Only interactive web sessions may touch these.
 */
function denyMcpToken(req, res, next) {
  if (req.apiTokenId) {
    return res.status(403).json({
      error: 'API tokens cannot manage API tokens — use a web session.',
      code: 'mcp_token_denied',
    });
  }
  next();
}
