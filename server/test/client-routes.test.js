'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Every in-app navigation must land on a route that exists.
//
// The bug that bought this file: the morning shortlist's "Open" button called
// nav('/source'). There is no '/source' route — the inbox is '/sourcing'. React
// Router matched the catch-all, redirected to '/', and the home page re-rendered
// underneath the click. Nothing threw, nothing logged, no 404 was ever shown. The
// button simply did nothing, on the one screen whose whole job is getting Danny
// from a name to a conversation, and it stayed that way until he reported it by hand.
//
// That is the failure mode worth a test: a dead link in this app is SILENT. The
// catch-all that makes a typo'd URL friendly for a human typing in the address bar
// is the same catch-all that swallows a typo'd nav() in our own code.
//
// So: parse the real route table out of App.jsx, parse every literal nav()/navigate()
// target out of client/src, and require each one to match. Not a mock of the route
// table — the route table.
// ══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readClient = (rel) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8');

// JSX comments hide DISABLED routes (the /payment block is commented out). A route
// that is commented out is not a route, so strip comments before parsing — otherwise
// this test would bless a nav() to a screen that cannot render.
const stripJsxComments = (src) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

// ── The route table, read from App.jsx ──────────────────────────────────
function registeredRoutes() {
  const src = stripJsxComments(readClient('App.jsx'));
  const routes = [];
  let nestedParent = null;

  for (const line of src.split('\n')) {
    const m = line.match(/<Route\s+path="([^"]+)"/);
    const isIndex = /<Route\s+index\b/.test(line);

    if (isIndex && nestedParent) routes.push(nestedParent);

    if (m) {
      const p = m[1];
      // The catch-all is not a destination — it is what SWALLOWS bad destinations,
      // so it must never be allowed to satisfy a nav() target.
      if (p === '*') { routes.push('*'); continue; }
      if (p.startsWith('/')) {
        routes.push(p);
        // A <Route> tag that is not self-closed opens a nested block. Test the END of
        // the line, not `includes('/>')` — the element prop holds self-closing tags of
        // its own (`<TalentLayout />`) that would otherwise read as a closed Route.
        if (!line.trim().endsWith('/>')) nestedParent = p;
      } else {
        // Relative child path — only meaningful inside a nested block.
        assert.ok(nestedParent, `relative route "${p}" outside any nested <Route> block`);
        routes.push(`${nestedParent.replace(/\/$/, '')}/${p}`);
      }
    }
    if (line.includes('</Route>')) nestedParent = null;
  }
  return routes;
}

// A route pattern -> matcher. ":param" consumes exactly one segment.
function matcher(pattern) {
  const rx = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${rx}$`);
}

// ── Every literal nav target in the client ──────────────────────────────
// Both quoted paths and template literals; `${expr}` stands in for one segment.
function navTargets() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(jsx?|tsx?)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      const rel = path.relative(CLIENT_SRC, full);

      const re = /\b(?:nav|navigate)\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g;
      let m;
      while ((m = re.exec(src))) {
        const raw = m[1] || m[2] || m[3];
        if (!raw.startsWith('/')) continue;            // relative/external — not ours to check
        // Drop query/hash, and collapse `${...}` into a single-segment placeholder.
        const clean = raw.split('?')[0].split('#')[0].replace(/\$\{[^}]*\}/g, ':param');
        out.push({ target: clean, file: rel, raw });
      }
    }
  };
  walk(CLIENT_SRC);
  return out;
}

test('every nav() target in the client matches a registered route', () => {
  const routes = registeredRoutes();
  // Sanity: if the parser silently found nothing, the rest of this test is vacuous.
  assert.ok(routes.length > 15, `parsed only ${routes.length} routes from App.jsx — parser is broken`);
  assert.ok(routes.includes('/sourcing'), 'expected /sourcing in the route table');
  assert.ok(routes.includes('/talent/roles'), 'expected nested talent routes to resolve');

  const matchers = routes.filter((r) => r !== '*').map(matcher);
  const targets = navTargets();
  assert.ok(targets.length > 5, `found only ${targets.length} nav() targets — the walker is broken`);

  const dead = targets.filter(({ target }) => !matchers.some((rx) => rx.test(target)));
  assert.deepStrictEqual(
    dead, [],
    `dead in-app link(s) — these redirect to "/" via the catch-all and look like a broken button:\n` +
      dead.map((d) => `  ${d.file}: nav('${d.raw}')`).join('\n')
  );
});

// ── The shortlist's promise, pinned ─────────────────────────────────────
// Danny: "when I click Open it does nothing... I want it to take me to their
// LinkedIn." The morning list is the top of the sourcing funnel; its one action has
// to work and has to go where he said.
test('the morning shortlist opens a founder LinkedIn in a new tab', () => {
  const src = readClient('pages/Home.jsx');
  const shortlist = src.slice(src.indexOf('function Shortlist('), src.indexOf('function Agents('));
  assert.ok(shortlist.length > 200, 'could not isolate the Shortlist component');

  assert.ok(/href=\{externalUrl\(f\.linkedin_url\)\}/.test(shortlist),
    'the shortlist row must link to the founder LinkedIn URL');
  assert.ok(/target="_blank"/.test(shortlist) && /rel="noopener noreferrer"/.test(shortlist),
    'LinkedIn opens in a new tab, safely — the inbox must survive the jump-off');
  assert.ok(!/nav\('\/source'\)/.test(src),
    "'/source' is not a route; the inbox is '/sourcing'");
});

// A scheme-less href is a RELATIVE path — React Router would swallow it and the
// catch-all would bounce to "/", which is the exact dead click this file exists for.
test('externalUrl forces an absolute scheme so LinkedIn never re-enters the SPA', () => {
  const src = readClient('pages/Home.jsx');
  const fn = src.slice(src.indexOf('function externalUrl('), src.indexOf('function Shortlist('));
  // eslint-disable-next-line no-new-func
  const externalUrl = new Function(`${fn}; return externalUrl;`)();

  assert.strictEqual(externalUrl('https://www.linkedin.com/in/x'), 'https://www.linkedin.com/in/x');
  assert.strictEqual(externalUrl('http://linkedin.com/in/x'), 'http://linkedin.com/in/x');
  assert.strictEqual(externalUrl('www.linkedin.com/in/x'), 'https://www.linkedin.com/in/x');
  assert.strictEqual(externalUrl('/in/x'), 'https://in/x');
  assert.strictEqual(externalUrl(null), null);
  assert.strictEqual(externalUrl('   '), null);
});
