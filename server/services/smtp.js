// Gmail SMTP transport, pinned to IPv4.
//
// Railway's container has no routable IPv6, but it does report a non-internal IPv6
// interface — and that combination defeats every obvious workaround:
//
//   * `family: 4` on the transport is silently ignored. Nodemailer never passes it to
//     DNS; it resolves the hostname itself in lib/shared (resolveHostname).
//   * That resolver calls its own `resolve(4, ...)`, which first checks
//     `os.networkInterfaces()` for a non-internal IPv4 interface. On Railway there
//     isn't one, so it returns [] WITHOUT EVER ISSUING AN A QUERY. Only the AAAA
//     records survive.
//   * Nodemailer 8's connect-failure fallback then can't help either: the fallback
//     list is whatever the resolver returned, which is IPv6-only. It walks Gmail's
//     other IPv6 addresses and fails on each.
//
// Net effect was `connect ENETUNREACH 2607:f8b0:...:465` on every send — the Daily
// Brief and the 8am founder digest both went out through here, so both were dead.
//
// The fix is to resolve the A record ourselves with `dns.resolve4` (c-ares direct —
// it does not consult the local interface list) and hand nodemailer a literal IP.
// `resolveHostname` short-circuits on `net.isIP(host)` and uses it as-is.
//
// Passing a literal costs us TLS SNI and certificate validation, because that same
// short-circuit sets `servername: options.servername || false`. So `tls.servername`
// is set explicitly and is NOT optional — without it the cert check fails against a
// bare IP. Keep them together.
const dns = require('dns').promises;

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
const DNS_TTL_MS = 5 * 60 * 1000;

let cache = null; // { address, expires }

// Resolve smtp.gmail.com to a single IPv4 literal. Cached briefly so a batch of
// per-user sends in one cron pass doesn't re-query for every recipient.
async function resolveIpv4(now = Date.now()) {
  if (cache && cache.expires > now) return cache.address;
  const addresses = await dns.resolve4(SMTP_HOST);
  if (!addresses || !addresses.length) throw new Error(`no A record for ${SMTP_HOST}`);
  cache = { address: addresses[0], expires: now + DNS_TTL_MS };
  return cache.address;
}

// Build a transport for a Gmail address + app password.
//
// If the A lookup itself fails we fall back to the hostname rather than refusing to
// send: that path is no worse than the old behaviour, and a DNS blip shouldn't be
// the reason a morning brief goes missing.
async function createTransport({ address, appPassword }) {
  const nodemailer = require('nodemailer');
  let host = SMTP_HOST;
  try {
    host = await resolveIpv4();
  } catch (e) {
    console.error('[smtp] IPv4 resolve failed, falling back to hostname:', e.message);
  }
  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: true,
    tls: { servername: SMTP_HOST }, // required: `host` is a literal IP, see above
    auth: { user: address, pass: appPassword },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
}

module.exports = { createTransport, resolveIpv4, SMTP_HOST, SMTP_PORT, _resetCache: () => { cache = null; } };
