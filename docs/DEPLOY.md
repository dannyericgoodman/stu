# Deploying Stu

> ## ⚠️ SUPERSEDED IN PART — 2026-08-31: Stu is moving off Railway
>
> The Railway account that owns production is tied to an email address nobody can sign
> into. There is no dashboard, no CLI (the token is expired and cannot be renewed), and
> therefore **no way to deploy to production at all.** Pushing to `origin/main` no longer
> deploys the live site; it has not since ~2026-08-30.
>
> **Decision: Stu moves to Render** (`stu-psnj`, which already auto-deploys this repo).
> The ordered migration plan lives on issue **STU-30**, document `host-migration-decision`.
>
> Two claims in this file are actively dangerous to trust right now:
> * *"Pushing to `origin/main` IS a production deploy"* — **false today.** It deploys Render
>   only. Verify per host, per deploy.
> * *"There is one host"* — **false.** `render.yaml` was deleted but the Render service was
>   created in the dashboard, so it survived and still builds every push.
>
> **Before any DNS change:** production data is reachable *only* through the `www.stu.vc`
> CNAME (the generated `*.up.railway.app` host 404s). Repointing that record makes the only
> copy of the database unreachable, with no undo. Run `server/scripts/snapshot-prod.js` and
> verify its output first. `/data/backups` does not help — those backups sit on the same
> unreachable volume.
>
> Everything below about **the disk, sleep, and `PIPELINE_ENABLED`** remains correct and is
> host-independent. That is why this file is amended rather than replaced.

**Stu ran on Railway. There is one host, and this file is the reason it is that one.**

Until 2026-08-30 the repo carried two hosting blueprints at once — `railway.json`
and `render.yaml`, the second with `autoDeploy: true`. Production was Railway the
whole time; the Render blueprint was a half-finished migration nobody finished.

Two live blueprints is not a harmless leftover. Stu keeps *everything* in one
SQLite file. Whichever host boots the app decides where that file lives, and a host
that boots it without a mounted disk gets a working app writing to a container
filesystem that is erased on the next deploy. That is not hypothetical here — it is
how the founder inbox was lost once already. `render.yaml` has been removed so there
is exactly one answer to "where does Stu deploy."

The knowledge that was encoded in that file is real, though, and it is not
Render-specific. It is preserved below, because the next person to move Stu will
need it and the blueprint that carried it is gone.

---

## How a deploy happens

Railway watches `origin/main`. **Pushing to `origin/main` IS a production deploy** —
there is no separate promote step and no staging environment. Build config lives in
`railway.json` (Dockerfile builder, healthcheck `/api/health`, restart on failure).

```
git push origin main     # ← this deploys
```

Verify afterwards:

```
curl -s https://www.stu.vc/api/health
# {"status":"ok","app":"Stu","version":"5.1.0","pipeline":{"sourcing_armed":true,...}}
```

The `server: railway-hikari` response header is how you confirm which host actually
served you, if that is ever in doubt again.

---

## The three things that are fatal to get wrong

### 1. The disk must be mounted before first boot

Stu stores everything in SQLite at `DATABASE_PATH`. `db.js` refuses to boot in
production without it. The disk has to exist and be mounted *before* the app first
starts — otherwise there is a window where the app comes up, writes to an ephemeral
path, and looks perfectly healthy right up until the next deploy erases it.

| Setting | Value |
|---|---|
| Mount path | `/data` |
| `DATABASE_PATH` | `/data/superior-os.db` |
| Size | 5 GB — the live DB is ~30 MB; the rest is headroom for the 14 nightly backups |

### 2. The instance must not sleep

Stu runs ten `node-cron` jobs **inside the web process** — the 4:30am scout *is* the
morning list. A sleeping instance runs no crons, so a free/scale-to-zero tier
silently stops sourcing. Any host must be on a plan that stays awake. (On Render
that meant `starter`, not `free`; the equivalent applies wherever Stu lands.)

This is also why moving the crons out of the web process is on the roadmap — right
now a deploy or a sleep kills sourcing, and it is invisible when it happens.

### 3. `PIPELINE_ENABLED` must be `true`

It has silently disarmed the scout before. `/api/health` reports
`pipeline.sourcing_armed`, which is the fastest way to catch it.

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

Secrets — set in the host dashboard, **never committed** (this repo is public):

`JWT_SECRET` · `ANTHROPIC_API_KEY` · `AIRTABLE_API_KEY` · `EXA_API_KEY` ·
`ENRICHLAYER_API_KEY` · `GITHUB_TOKEN`

`AIRTABLE_BASE_ID` is optional and defaults to the base in `server/lib/airtableBase.js`.
Setting it repoints every Airtable reader and writer at once — that is the entire
migration path if the team moves bases.

---

## DNS

- `www.stu.vc` → Railway → **200 OK**
- `stu.vc` (apex) → `162.255.119.160` (Namecheap parking) → **times out**

The apex is dead, and `docs/USING-STU.md` tells people to "create an account at
stu.vc" — that link hangs. Fixing it needs registrar access: point the apex at
Railway with an ALIAS/CNAME-flattened record, or a redirect to `www`. Requires
Danny; it cannot be done from the repo.

---

## Restoring from a snapshot

`server/scripts/restore-snapshot.js` is **manual-only** — nothing invokes it at boot,
and it must stay that way. Read its header before running it: it deliberately does
not restore the sourcing inbox, and the reasoning matters.
