const express = require('express');
const router = express.Router();
const db = require('../db');
const secrets = require('../lib/secrets');
const { resolveKey, readUserKey, MODEL } = require('../lib/providerKeys');
const ledgerStages = require('../lib/ledgerStages');

// Credentials that must be encrypted at rest (never echoed back to the client).
function isSensitiveSettingKey(key) {
  return /^api_key_/.test(key) || /_token$/.test(key) || /_app_password$/.test(key) || /_secret$/.test(key);
}

const DEFAULT_SETTINGS = {
  // The user's own pipeline steps, stored per-user. Default = the five ledger
  // stages (server/lib/ledgerStages.js). Nothing in the app speaks the old
  // Admissions/Deal stage vocabulary anymore, so those settings are gone.
  pipeline_stages: JSON.stringify(ledgerStages.defaultStages()),
  sourcing_locations: JSON.stringify([]),
  sourcing_schools: JSON.stringify([]),
  sourcing_companies: JSON.stringify([]),
  sourcing_builder_signals: JSON.stringify([]),
  sourcing_domains: JSON.stringify([]),
  sourcing_stage_filter: 'Any',
  sourcing_custom_queries: JSON.stringify([]),
};

// Helper: parse JSON values safely
function parseValue(val) {
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

// GET /api/settings/sourcing-criteria — convenience endpoint for sourcing config
// NOTE: Defined BEFORE /:key to prevent Express param matching
router.get('/sourcing-criteria', (req, res) => {
  const sourcingKeys = [
    'sourcing_locations', 'sourcing_schools', 'sourcing_companies',
    'sourcing_builder_signals', 'sourcing_domains', 'sourcing_stage_filter',
    'sourcing_custom_queries',
  ];

  const rows = db.prepare(
    `SELECT setting_key, setting_value FROM user_settings WHERE user_id = ? AND setting_key IN (${sourcingKeys.map(() => '?').join(',')})`
  ).all(req.user.id, ...sourcingKeys);

  const userSettings = {};
  for (const row of rows) {
    userSettings[row.setting_key] = row.setting_value;
  }

  res.json({
    locations: parseValue(userSettings.sourcing_locations || DEFAULT_SETTINGS.sourcing_locations),
    schools: parseValue(userSettings.sourcing_schools || DEFAULT_SETTINGS.sourcing_schools),
    companies: parseValue(userSettings.sourcing_companies || DEFAULT_SETTINGS.sourcing_companies),
    builder_signals: parseValue(userSettings.sourcing_builder_signals || DEFAULT_SETTINGS.sourcing_builder_signals),
    domains: parseValue(userSettings.sourcing_domains || DEFAULT_SETTINGS.sourcing_domains),
    stage_filter: parseValue(userSettings.sourcing_stage_filter || DEFAULT_SETTINGS.sourcing_stage_filter),
    custom_queries: parseValue(userSettings.sourcing_custom_queries || DEFAULT_SETTINGS.sourcing_custom_queries),
  });
});

// GET /api/settings — all settings for authenticated user
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?').all(req.user.id);

  // Start with defaults, overlay user overrides
  const settings = {};
  for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
    settings[key] = parseValue(val);
  }
  for (const row of rows) {
    // Never send stored credentials to the client — expose only "configured: true".
    if (isSensitiveSettingKey(row.setting_key)) {
      settings[row.setting_key] = row.setting_value ? { configured: true } : null;
    } else {
      settings[row.setting_key] = parseValue(row.setting_value);
    }
  }

  res.json(settings);
});

// POST /api/settings/complete-onboarding — mark onboarding as done
// NOTE: Defined BEFORE /:key to prevent Express param matching
router.post('/complete-onboarding', (req, res) => {
  // All criteria are optional — users configure what matters to them
  db.prepare('UPDATE users SET onboarding_complete = 1 WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

// PUT /api/settings/:key — upsert a single setting
router.put('/:key', (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === undefined) {
    return res.status(400).json({ error: 'Missing value' });
  }

  let serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const sensitive = isSensitiveSettingKey(key);
  if (sensitive) serialized = secrets.encrypt(serialized);

  db.prepare(`
    INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, setting_key)
    DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `).run(req.user.id, key, serialized);

  // Never echo a stored secret back — confirm with a masked hint only.
  if (sensitive) {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    const hint = raw.length > 8 ? `${raw.slice(0, 4)}…${raw.slice(-4)}` : 'saved';
    return res.json({ key, saved: true, hint });
  }
  res.json({ key, value: parseValue(serialized) });
});

// GET /api/settings/test-anthropic — ping Anthropic with the key the app ACTUALLY uses
// (the user's stored key, or the env key for user 1) so we can tell, definitively, whether
// that key's account is funded — independent of what any console balance view shows.
router.get('/test-anthropic', async (req, res) => {
  try {
    const stored = readUserKey(req.user.id, 'api_key_anthropic');
    const apiKey = resolveKey(req.user.id, 'anthropic');
    const source = stored ? 'your saved key (Settings)' : 'the server key';
    if (!apiKey) return res.json({ ok: false, source, reason: 'no_key', message: 'No Anthropic API key is configured.' });
    const keyHint = `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      await client.messages.create({ model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      return res.json({ ok: true, source, keyHint, message: 'Working — this key can reach the Anthropic API.' });
    } catch (e) {
      const msg = e.message || String(e);
      const reason = /credit balance is too low/i.test(msg) ? 'no_credits'
        : /authentication|invalid x-api-key|401/i.test(msg) ? 'invalid_key'
        : /rate/i.test(msg) ? 'rate_limited' : 'error';
      const friendly = reason === 'no_credits'
        ? `This key's Anthropic account is out of credits. The $ balance you see in the console is on a DIFFERENT account or workspace than this key (${keyHint}). Create a key in the funded workspace and paste it above.`
        : reason === 'invalid_key' ? `This key (${keyHint}) is invalid or revoked. Paste a fresh key from your funded Anthropic workspace.`
        : msg;
      return res.json({ ok: false, source, keyHint, reason, message: friendly });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
