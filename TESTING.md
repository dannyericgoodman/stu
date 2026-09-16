# Testing

## Node version for tests

Run the server test suite under **Node 22**, not the system Node 24.

`better-sqlite3@11` intermittently crashes test workers on Node 24 during
process teardown (`Assertion '(env) != nullptr' failed` in
`RemoveEnvironmentCleanupHook`). Rebuilding the native binding does not fix
it — it's a v11/Node 24 incompatibility. Production runs Node 20
(`Dockerfile`), which is unaffected.

A portable Node 22 lives at `~/workspace/node22/node-v22.18.0-linux-x64/`.
Run tests with it first on `PATH`:

```sh
cd server
export PATH=~/workspace/node22/node-v22.18.0-linux-x64/bin:$PATH
node --test 'test/*.test.js'
```

The `better-sqlite3` binding in `server/node_modules` is built for the
system Node 24 (the dev-server runtime). Switching the binding between Node
ABIs requires a rebuild:

```sh
# for Node 22 tests:
cd server && npm rebuild better-sqlite3 --nodedir=~/workspace/node22/node-v22.18.0-linux-x64
# back to system Node 24 afterwards:
cd server/node_modules/better-sqlite3 && npx --yes node-gyp@11 rebuild
```

## Known suite state (2026-09-16, Node 22)

Full suite: **733/745 pass**. The 12 failures are not regressions:

- `test/airtable-create.test.js` (3), `test/airtable-vocab.test.js` (4):
  pre-date the Airtable owner gate — they call the sync layer without owner
  context and now get `skipped: 'not_owner'` before reaching the old
  assertions. They need updating to pass explicit owner context.
- `test/source-scout.test.js` (1): asserts `scoutArmed()` reads
  `loadUserApiKeys(1)`; the scheduler now enumerates paid users and resolves
  per-user keys instead. Test needs updating to the new design.
- `test/vault-sync-commitments.test.js` (3), `test/ingest.test.js` (1):
  depend on founders existing in the local dev DB
  (`server/superior-os.db`); the local DB has none. Environmental, also fail
  on the base commit.
