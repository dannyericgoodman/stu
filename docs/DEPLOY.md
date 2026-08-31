# Deploying Stu

**Stu runs on Render. There is one host, and this file is the reason it is that one.**

| | |
|---|---|
| Host | Render — web service `stu` (`srv-da9fk5lg1s2s73a9af2g`), region Ohio (US East) |
| Plan | **Starter** — paid, always-on. This is load-bearing; see §2 |
| Build | Dockerfile (`railway.json` is a dead file kept only so nothing re-adds a second blueprint) |
| Repo | `dannyericgoodman/stu`, branch `main`, auto-deploy on push |
| Generated URL | `https://stu-psnj.onrender.com` |
| Public URL | `https://www.stu.vc` (primary); `https://stu.vc` 301s to it |
| DNS | Namecheap. `www` CNAME → `stu-psnj.onrender.com`; apex ALIAS → same |

## How a deploy happens

Render watches `origin/main`. **Pushing to `origin/main` IS a production deploy** — no
promote step, no staging environment.

```
git push origin main     # ← this deploys
```

Verify afterwards:

```
curl -s https://www.stu.vc/api/health
# {"status":"ok","app":"Stu","version":"5.1.0","pipeline":{"sourcing_armed":true,...}}
```

`x-render-origin-server: Render` in the response headers is how you confirm which host
actually served you, if that is ever in doubt again. It was in doubt once, and the
header is how it got settled.

---

## The four things that are fatal to get wrong

### 1. The disk must be mounted before first boot

Stu stores everything in one SQLite file at `DATABASE_PATH`. `db.js` refuses to boot in
production without it. The disk has to exist and be mounted *before* the app first
starts — otherwise there is a window where the app comes up, writes to an ephemeral
path, and looks perfectly healthy right up until the next deploy erases it.

| Setting | Value |
|---|---|
| Mount path | `/data` |
| `DATABASE_PATH` | `/data/superior-os.db` |
| Size | 5 GB — the live DB is ~30 MB; the rest is headroom for the nightly backups |

This is not hypothetical. It is how the founder inbox was lost once already.

### 2. The instance must not sleep

Stu runs ten `node-cron` jobs **inside the web process** — the 4:30am scout *is* the
morning list. A sleeping instance runs no crons, so a free/scale-to-zero tier silently
stops sourcing. On Render that means `Starter`, never `Free`.

This is also why moving the crons out of the web process is on the roadmap: right now a
deploy or a sleep kills sourcing, and it is invisible when it happens.

### 3. `PIPELINE_ENABLED` must be `true`

It has silently disarmed the scout before. `/api/health` reports
`pipeline.sourcing_armed`, which is the fastest way to catch it.

### 4. The app must accept its own origin

`index.html` loads its bundle via `<script crossorigin>`, which makes the browser send an
`Origin` header on a request the page makes to *itself*. The CORS check used to treat
"same-origin" as "sent no Origin header", so on any host not literally `stu.vc` the app
rejected its own JavaScript, the rejection surfaced as a 500, and the site rendered as a
blank white page **while `/api/health` returned a cheerful 200**.

Fixed in `index.js` by comparing the Origin's host to the request's own Host. Do not
"simplify" that back into a static allow-list — the allow-list is what hid the bug for as
long as there was only ever one hostname.

---

## Environment

Non-secret, safe to declare in host config:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_PATH` | `/data/superior-os.db` |
| `PIPELINE_ENABLED` | `true` |
| `STU_BASE_URL` | `https://www.stu.vc` |
| `ALLOWED_ORIGINS` | `https://www.stu.vc,https://stu.vc` |

Secrets — set in the Render dashboard, **never committed**:

`JWT_SECRET` · `ANTHROPIC_API_KEY` · `AIRTABLE_API_KEY` · `EXA_API_KEY` ·
`ENRICHLAYER_API_KEY` · `GITHUB_TOKEN`

`SEED_ADMIN_PASSWORD` seeds the owner account, but **only when the users table is empty**.
On a database that has already booted it does nothing, which is a real trap: the owner is
seeded with a random password that is never printed, so an already-booted host has an
owner account nobody can sign into. Set it before first boot, or reset the existing row.

`AIRTABLE_BASE_ID` is optional and defaults to the base in `server/lib/airtableBase.js`.
Setting it repoints every Airtable reader and writer at once — that is the entire
migration path if the team moves bases.

---

## Snapshots and restores

- `server/scripts/snapshot-prod.js` — pulls a running Stu through its own authenticated
  read API. Written for the case where the database cannot be reached as a file. Spends a
  request budget in priority order, stops cleanly on 429, and resumes.
- `server/scripts/restore-snapshot.js` — loads a snapshot into a database **on the same
  machine**. Manual-only; nothing invokes it at boot and it must stay that way.
- `server/scripts/push-snapshot.js` — loads a snapshot into a **remote** host over HTTP,
  for when there is no shell on the target. Requires a `RESTORE_TOKEN` route that is only
  mounted while that env var is set. Set it, push, then delete the variable.

Both restore paths cover founders, assessments + inputs, notes, memos and call logs.
`push-snapshot.js` additionally restores the **sourcing inbox** (`sourced_founders`);
`restore-snapshot.js` still skips it.

The inbox is a judgement call, not an oversight. The API crawl could not capture
`raw_data`, `enriched_data` or `linkedin_data` — the blobs `lib/founderFit` reads to
compute markers — so a re-score of restored rows will mis-rank them until LinkedIn
enrichment backfills those blobs. What it *does* capture is 26 of 28 fields, including
`caliber_tier`, `caliber_score`, the signal sets and `chicago_connection`: everything the
Source board reads to render and filter. An inbox that is read-only-accurate beats an
empty one, which is why this changed on 2026-08-31.

**If you restore the inbox, stamp `user_id`.** The snapshot has no such field (the read
API never exposed it) and the inbox query is
`WHERE user_id = ? AND status IN ('pending','starred') AND list_scope = ?`. Rows inserted
without it are invisible to every user — which is indistinguishable from the restore
having silently done nothing. `push-snapshot.js --owner=<id>` handles this, defaulting to 1.

---

## History: why this file exists

Until 2026-08-30 the repo carried two hosting blueprints at once, `railway.json` and
`render.yaml`, the second with `autoDeploy: true`. Production was Railway the whole time;
the Render blueprint was a half-finished migration nobody finished.

Two live blueprints is not a harmless leftover. Stu keeps *everything* in one SQLite file.
Whichever host boots the app decides where that file lives, and a host that boots it
without a mounted disk gets a working app writing to a container filesystem that is erased
on the next deploy.

**2026-08-31 — the move to Render.** The Railway account that owned production was tied to
an email address nobody could sign into: no dashboard, no CLI, no volume download, and
`/data/backups` sat on that same unreachable volume, so the nightly backups were exactly
as unreachable as the database. The only remaining route to the data was the running app's
own read API, reachable only through the `www.stu.vc` CNAME — which made the DNS record
the sole path to the only copy, and repointing it irreversible for data purposes.

Order of operations that day, which is the order to repeat if this ever happens again:

1. Snapshot production through its API and **verify the counts** against the live site.
2. Stand the new host up on its generated URL, with the disk mounted first.
3. Load the data and check it — *before* touching DNS.
4. Move DNS last. Certificates follow verification; expect a short window where cached
   resolvers still reach the old host.
5. **Rotate every API key.** The old box keeps running its crons even after it is
   unreachable — crons are outbound and do not care that nobody can reach the server. Two
   hosts running the same ten jobs means duplicate newsletters, double spend, and
   conflicting writes to the team's Airtable. Rotating the keys is the only way to stop a
   host you cannot log into. Done 2026-08-31 for Anthropic, Airtable and Exa.

The Railway container is presumably still running. It is unreachable and its keys are
dead, so it is inert — but it was never deliberately shut down, because it could not be.
