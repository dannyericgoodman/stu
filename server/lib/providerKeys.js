/**
 * providerKeys.js — single source of truth for "whose key pays for this call".
 *
 * RULE (the cost-shifting contract):
 *   1. If the user has saved their own provider key in Settings, use it.
 *   2. Otherwise, fall back to the platform env key ONLY if the user is the owner
 *      (role 'admin', or the original user_id=1). Everyone else gets null — the
 *      feature must surface a "configure your key" error rather than silently
 *      billing the platform key.
 *
 * This used to be reimplemented inconsistently across routes, engines and services
 * (some correctly owner-gated, some leaking the env key to every user). Centralizing
 * it here closes those leaks and gives us one place to add metering + spend caps.
 */
const db = require('../db');
const secrets = require('./secrets');

const SETTING_BY_PROVIDER = {
  anthropic: 'api_key_anthropic',
  exa: 'api_key_exa',
  github: 'api_key_github',
  enrichlayer: 'api_key_enrichlayer',
};
const ENV_BY_PROVIDER = {
  anthropic: 'ANTHROPIC_API_KEY',
  exa: 'EXA_API_KEY',
  github: 'GITHUB_TOKEN',
  enrichlayer: 'ENRICHLAYER_API_KEY',
};

// The model, in one place. It was hardcoded at 19 call sites, which is how commit
// 8e232a5 ("replace retired model ID everywhere") happened — and how it would have
// happened again on the next retirement.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Approx claude-sonnet-4 list price (USD/token). Used only for soft spend caps and
// usage transparency — NOT an invoice. Cheap to keep roughly current.
const PRICE = { input: 3 / 1e6, output: 15 / 1e6 };
// $25/day. Measured headroom, not a guess: a normal day is ~$2.30 of crons plus
// ~$0.42 per assessment, so this clears real usage by ~10x while stopping a
// runaway fan-out before it becomes an invoice. A cap that fires on legitimate
// work gets disabled, which is precisely how the old one ended up at Infinity.
const DEFAULT_DAILY_CAP_USD = Number(process.env.DEFAULT_DAILY_SPEND_CAP_USD || 25);

class SpendCapError extends Error {
  constructor(message) { super(message); this.name = 'SpendCapError'; this.code = 'spend_cap_exceeded'; this.status = 402; }
}

function isOwner(userId) {
  if (userId == null) return false;
  if (Number(userId) === 1) return true; // original single-operator admin (back-compat)
  try {
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    return !!u && u.role === 'admin';
  } catch { return false; }
}

// Decrypt + strip legacy JSON-quote wrapping + reject placeholders/empties.
function normalize(value) {
  if (value == null) return null;
  let s = secrets.decrypt(value);
  if (s == null) return null;
  s = String(s).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (!s || s === 'your-api-key-here') return null;
  return s;
}

function readSetting(userId, settingKey) {
  if (userId == null) return null;
  try {
    const row = db.prepare('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?').get(userId, settingKey);
    return row ? row.setting_value : null;
  } catch { return null; }
}

function readUserKey(userId, settingKey) {
  return normalize(readSetting(userId, settingKey));
}

function resolveKey(userId, provider) {
  const settingKey = SETTING_BY_PROVIDER[provider];
  if (!settingKey) throw new Error(`Unknown provider: ${provider}`);
  const userKey = readUserKey(userId, settingKey);
  if (userKey) return userKey;
  if (isOwner(userId)) {
    const env = process.env[ENV_BY_PROVIDER[provider]];
    return env && env.trim() ? env.trim() : null;
  }
  return null; // non-owner with no saved key → no silent fallback to the platform key
}

// Shape compatible with the engines' previous loadUserApiKeys() return value.
function loadUserApiKeys(userId) {
  return {
    exa: resolveKey(userId, 'exa'),
    anthropic: resolveKey(userId, 'anthropic'),
    enrichlayer: resolveKey(userId, 'enrichlayer'),
    github: resolveKey(userId, 'github'),
  };
}

// ── Usage metering + soft daily spend cap (protects the user from runaway loops) ──

function spentTodayUsd(userId) {
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(est_cost_usd), 0) AS c FROM usage_events WHERE user_id = ? AND created_at >= datetime('now', 'start of day')"
    ).get(userId);
    return row ? row.c : 0;
  } catch { return 0; }
}

// ══════════════════════════════════════════════════════════════════════════
// THE CAP WAS INVERTED — it exempted the only person who pays.
//
// This read:
//     if (isOwner(userId)) return Infinity;  // the owner is uncapped — it's his
//                                            // platform key
//
// `users` has exactly one row: id=1, Danny, role=admin. He IS the owner. So
// dailyCapUsd returned Infinity for the only account that exists, which made
// every assertWithinBudget() call in the codebase a no-op, and DEFAULT_DAILY_CAP
// of $10 has never applied to a single request in the product's life.
//
// The comment's logic is exactly backwards. BYOK's whole premise is that the key
// is Danny's and every call is on his card — that's the argument for capping him,
// not exempting him. The cap was protecting hypothetical future tenants from
// spending his money while leaving him unprotected from spending it himself.
//
// He now gets the same cap as everyone, settable in Settings, and it's the one
// thing standing between a runaway fan-out and his credit card. Raised to $25
// because a legitimate day (one assessment ~$0.42 + the crons ~$2.30) must never
// trip it — a cap that fires on normal use gets raised to Infinity within a week,
// which is how we got here.
// ══════════════════════════════════════════════════════════════════════════
function dailyCapUsd(userId) {
  const raw = readUserKey(userId, 'spend_cap_daily_usd');
  const n = raw == null ? NaN : Number(raw);
  // Allow 0 (a hard stop). Only fall back to the default when unset/invalid.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP_USD;
}

function assertWithinBudget(userId) {
  const cap = dailyCapUsd(userId);
  if (cap === Infinity) return;
  if (spentTodayUsd(userId) >= cap) {
    throw new SpendCapError(`Daily spend cap reached ($${cap.toFixed(2)}). Raise it in Settings or wait until tomorrow.`);
  }
}

// Record a flat-cost event for non-token providers (Exa, EnrichLayer) so their spend
// counts toward the daily cap too. estCostUsd is a rough per-call estimate.
function recordCost(userId, { provider, feature = null, estCostUsd = 0, count = 1 } = {}) {
  try {
    db.prepare(
      'INSERT INTO usage_events (user_id, provider, feature, input_tokens, output_tokens, est_cost_usd) VALUES (?, ?, ?, 0, 0, ?)'
    ).run(userId == null ? null : userId, provider, feature, estCostUsd * count);
  } catch { /* metering must never break a request */ }
}

function recordUsage(userId, { provider = 'anthropic', feature = null, usage = null } = {}) {
  try {
    const inTok = (usage && usage.input_tokens) || 0;
    const outTok = (usage && usage.output_tokens) || 0;
    const cost = inTok * PRICE.input + outTok * PRICE.output;
    db.prepare(
      'INSERT INTO usage_events (user_id, provider, feature, input_tokens, output_tokens, est_cost_usd) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId == null ? null : userId, provider, feature, inTok, outTok, cost);
  } catch { /* metering must never break a request */ }
}

// Wrap an Anthropic client so every call checks the caller's budget first and records
// usage after. Each client is freshly constructed per call site, so mutating its
// `messages` methods is safe (not shared across users).
function meterClient(client, userId, feature) {
  if (!client || !client.messages) return client;
  const m = client.messages;
  if (typeof m.create === 'function') {
    const origCreate = m.create.bind(m);
    m.create = async (...args) => {
      assertWithinBudget(userId);
      const res = await origCreate(...args);
      recordUsage(userId, { feature, usage: res && res.usage });
      return res;
    };
  }
  if (typeof m.stream === 'function') {
    const origStream = m.stream.bind(m);
    m.stream = (...args) => {
      assertWithinBudget(userId);
      const stream = origStream(...args);
      if (stream && typeof stream.finalMessage === 'function') {
        stream.finalMessage()
          .then(msg => recordUsage(userId, { feature, usage: msg && msg.usage }))
          .catch(() => {});
      }
      return stream;
    };
  }
  return client;
}

// Build a metered Anthropic client billed to `userId`. Returns null when no key is
// available for this user (callers already handle null with a 503 / "configure key").
function meteredClient(apiKey, userId, feature = null) {
  if (!apiKey) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    // timeout: the SDK default is generous but not explicit, and an assessment agent
    // carries a long system prompt plus up to 150K chars of context. Be explicit.
    //
    // maxRetries: 0 is deliberate and load-bearing. The SDK retries twice by default,
    // and routes/assessments.js has its OWN retry wrapper (3 attempts, exponential
    // backoff). Compounded, a single struggling agent fired up to SIX requests — times
    // five agents running in parallel. That is self-inflicted rate-limit pressure, and
    // a live end-to-end run showed exactly its signature: the rubric agent timing out
    // under fan-out despite completing in ~60s when run alone. One retry layer, ours.
    return meterClient(new Anthropic({ apiKey, timeout: 240000, maxRetries: 0 }), userId, feature);
  } catch { return null; }
}

function anthropicFor(userId, feature = null) {
  return meteredClient(resolveKey(userId, 'anthropic'), userId, feature);
}

// ══════════════════════════════════════════════════════════════════════════
// AN EXPIRED KEY SHOULD READ AS AN EXPIRED KEY.
//
// Every LLM call site here does `catch (e) { return { error: '... failed: ' +
// e.message } }`, and the SDK's `e.message` for an auth failure is the raw response
// body. So the JD-ingest toast in the Hiring UI said, verbatim:
//
//   JD parse failed: 401 {"type":"error","error":{"type":"authentication_error",
//   "message":"API key is invalid."},"request_id":null}
//
// which is how "Stu wouldn't parse my job description" gets reported. The JD was
// fine, the parser was fine, the key was dead — and nothing on screen said so or
// pointed at Settings. `has_anthropic: true` on /api/health agreed with the UI that
// everything was configured, because it only ever checked that a string exists.
//
// One translator, at the layer that owns the key, so the fix lands everywhere a key
// can fail rather than once per call site.
// ══════════════════════════════════════════════════════════════════════════
function describeLlmError(e, what = 'That call') {
  const status = e && (e.status || e.statusCode);
  const raw = String((e && e.message) || 'unknown error');
  if (e instanceof SpendCapError || e?.code === 'spend_cap_exceeded') return { message: raw, code: 'spend_cap_exceeded' };
  if (status === 401 || status === 403 || /authentication_error|API key is invalid|invalid x-api-key|permission_error/i.test(raw)) {
    return {
      message: 'Your Anthropic API key is invalid or expired. Update it in Settings (or set ANTHROPIC_API_KEY) and try again.',
      code: 'bad_key',
    };
  }
  if (status === 429 || /rate_limit/i.test(raw)) return { message: 'Anthropic rate-limited this request. Wait a moment and retry.', code: 'rate_limited' };
  if (status === 529 || /overloaded/i.test(raw)) return { message: 'Anthropic is overloaded right now. Retry in a minute.', code: 'overloaded' };
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|timeout|aborted/i.test(raw)) return { message: `${what} timed out reaching Anthropic. Retry.`, code: 'timeout' };
  if (status === 404 || /model.*not.*found|invalid.*model/i.test(raw)) {
    return { message: `The configured model (${MODEL}) was rejected by the API. Set ANTHROPIC_MODEL to a current model id.`, code: 'bad_model' };
  }
  return { message: `${what} failed: ${raw}`, code: 'llm_error' };
}

// Does the configured Anthropic key actually WORK? A presence check cannot answer
// that, which is the whole bug above. One cheap authenticated GET, cached, so a
// health board can say "verified" instead of "a string is set".
const KEY_CHECK_TTL_MS = 5 * 60 * 1000;
const keyCheckCache = new Map(); // key-fingerprint -> { at, ok, detail }

async function verifyAnthropicKey(userId) {
  const key = resolveKey(userId, 'anthropic');
  if (!key) return { configured: false, ok: false, detail: 'No Anthropic key configured.' };
  // Fingerprint by hash, never by prefix. Every Anthropic key begins "sk-ant-a"
  // and rotated keys share a length, so a prefix+length fingerprint made a FRESH
  // key inherit the dead key's cached verdict for five minutes — health stayed
  // red at exactly the moment someone had just fixed it.
  const fp = require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 16);
  const hit = keyCheckCache.get(fp);
  if (hit && Date.now() - hit.at < KEY_CHECK_TTL_MS) return { configured: true, ok: hit.ok, detail: hit.detail, cached: true };
  let ok = false;
  let detail = '';
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key, timeout: 15000, maxRetries: 0 });
    await client.models.list({ limit: 1 });
    ok = true; detail = 'Key verified against the Anthropic API.';
  } catch (e) {
    ok = false; detail = describeLlmError(e, 'Key check').message;
  }
  keyCheckCache.set(fp, { at: Date.now(), ok, detail });
  return { configured: true, ok, detail };
}

module.exports = {
  MODEL,
  isOwner,
  resolveKey,
  readUserKey,
  loadUserApiKeys,
  anthropicFor,
  meteredClient,
  recordUsage,
  recordCost,
  assertWithinBudget,
  spentTodayUsd,
  dailyCapUsd,
  SpendCapError,
  SETTING_BY_PROVIDER,
  describeLlmError,
  verifyAnthropicKey,
};
