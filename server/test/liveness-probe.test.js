'use strict';
// ══════════════════════════════════════════════════════════════════════════
// The rate limiter must never be able to kill the server.
//
// On 2026-08-31 Render replaced two healthy instances (`jrljz` 9:13, `wtlc8` 9:29)
// with "HTTP health check failed with status code 429". Nothing was wrong with the
// app. Two config facts combined into an outage:
//
//   1. no `trust proxy`, so behind Render's TLS-terminating proxy every request
//      on earth shared ONE rate-limit bucket keyed on the proxy's address; and
//   2. `/api/health` sits under the `/api` mount, so when that shared bucket
//      emptied, the liveness probe got a 429 like everything else.
//
// The consequence of throttling a liveness probe is not a slow response — it is a
// terminated instance. So this pins both halves.
//
// Verified behaviourally before this test was written: booted on :3999, sent 205
// requests to /api/pipeline (200 → 401 from auth, 201-205 → 429 from the limiter),
// then 15 consecutive /api/health probes ALL returned 200 while /api/pipeline kept
// returning 429. The limiter still limits; it just cannot take the process down.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the proxy is trusted, so rate limits are keyed per client and not globally', () => {
  const src = read('index.js');
  assert.ok(/app\.set\('trust proxy', 1\)/.test(src),
    'without trust proxy, req.ip is the platform proxy and the whole internet shares one bucket');
  assert.ok(!/app\.set\('trust proxy', true\)/.test(src),
    'blanket-true lets a client-supplied X-Forwarded-For spoof its way to a private bucket');
});

test('the liveness probe is exempt from the global rate limiter', () => {
  const src = read('index.js');

  // The exemption must be wired INTO the global /api limiter, not merely defined.
  const limiter = src.slice(src.indexOf("app.use('/api', rateLimit("));
  const globalLimiter = limiter.slice(0, limiter.indexOf('\n'));
  assert.ok(/skip: isLivenessProbe/.test(globalLimiter),
    'the global /api limiter must skip the health probe, or a traffic burst kills the instance');

  assert.ok(/const isLivenessProbe = \(req\) => req\.originalUrl\.split\('\?'\)\[0\] === '\/api\/health'/.test(src),
    'matched on originalUrl so the predicate is correct regardless of mount path');
});

test('the exemption covers ONLY the unauthenticated probe', () => {
  // /api/health/full and /api/health/drift are authenticated and comparatively
  // expensive. An exemption written as a prefix (startsWith) would hand an
  // attacker two unthrottled routes; exact-match keeps them inside the bucket.
  const src = read('index.js');
  assert.ok(!/originalUrl.*startsWith\('\/api\/health'\)/.test(src),
    'a prefix match would also exempt /api/health/full and /api/health/drift');
  assert.ok(/=== '\/api\/health'/.test(src), 'exact match on the bare probe');
});
