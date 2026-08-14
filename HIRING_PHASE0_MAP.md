# Hiring rebuild — Phase 0 keep/replace map

_The Talent wing, mapped against the new sourcing infra. What survives, what gets ripped out, what's net-new. Written before any code so the rebuild is a decision, not a drift._

## The one-line finding

The Talent wing already models the exact shape the Hiring brief asks for — `portfolio_company → roles → matches → candidates`, role-scoped runs, a full client scaffold. It's **the schema and the UI that are worth keeping**; it's **the scoring that's dead weight**. So this is a transplant, not a teardown: keep the tables and the React tree, rip out both scoring engines, and rebuild the middle on `ilTie` / `github-source` / `builderSignals` / the honesty gate. Frozen since spring; the whole `talent/*` tree (~250KB) is already lazy-loaded out of the main bundle, so it costs nothing to carry while we rebuild it in place.

---

## KEEP (reuse verbatim or near-verbatim)

### Schema — the talent_* tables
The relationships are already right. Extend, don't replace.

| Table | Verdict | Why |
|---|---|---|
| `talent_roles` | **Keep + extend** | Already has `portfolio_company_id`, `title`, `band`, `role_function`, `stack_requirements`, `domain_requirements`, `must_haves`, `jd_content`, comp/equity bands, `status`. This *is* the role model. Add: `founder_id` (link to the real portco universe), `ingest_source`/`ingest_ref`, `location_only_il` flag. |
| `talent_candidates` | **Keep + extend** | Rich already: github/linkedin, `location_city/state`, `tech_stack`, builder/pedigree/leap signals, `github_url`, `role_function`, `departure_recency_months`. Add: `tier` (warm/cold), `warm_source`, `superior_connection`, `github_slope_score`/`github_slope_data` (mirror sourced_founders), `il_tie_type`/`il_tie_evidence`. |
| `talent_matches` | **Keep + extend** | The candidate↔role join with `match_score`, `match_rationale`, `strengths`, `gaps`, `status`, `UNIQUE(candidate_id, role_id)`. Add the handoff status enum (`sourced→shortlisted→shared→intro_made→hired/passed`) and `warm` denormalized for tier sort. |
| `talent_sourcing_runs` | **Keep** | Already role-scoped (`role_id`), already the run log. Reuse as-is. |
| `talent_portfolio_companies` | **Demote, don't delete** | Superseded by linking roles to `founders` (see decisions). Keep the table for back-compat; stop driving the picker from it. |
| `talent_criteria` | **Keep, lightly used** | Global sourcing config (stacks/locations). Still useful as defaults for cold discovery. |

### Client — the `talent/*` React tree
Keep the scaffold, re-skin and re-wire. `TalentRoles`, `TalentRoleDetail`, `TalentCandidates`, `TalentMatches`, `TalentHome`, `TalentTrash`, `TalentLayout` all stay. They get renamed to Hiring, re-pointed at the new endpoints, and the role→shortlist→status flow gets tightened (Phase 6). No reason to rebuild list/detail/trash plumbing from scratch.

### Routes — `server/routes/talent/*`
Keep the REST surface (`/roles`, `/candidates`, `/matches`, `/criteria`, `/sourcing`, `/trash`, `/portfolio`) and the mount at `server/index.js:456`. The CRUD is fine. What changes is what `/sourcing/run` and `/sourcing/match` *call* (new engine, Phase 3) and new ingest + handoff endpoints.

### The sourcing infra — reuse, do NOT modify
Verified by reading each one; all are exactly as the brief describes.

- **`lib/ilTie.js`** — `verifyIlTie(text)` → `{verified, type, place, evidence, matched}`; `propagateCofounderTies`. Use verbatim. This is Danny's geography rule as code, with the scars documented. Cold discovery and warm-tie receipts both call it.
- **`pipeline/github-source.js`** — `discoverGithubBuilders`, `assess`, name-consistency guards (`handleMatchesName`, `pickPersonalHandle`). **Study, don't call directly** for hiring: its `assess` gates on a *founder* "building" signal (`BUILDING_RE`) and inserts into `sourced_founders`. Hiring wants employed engineers by stack, so Phase 4 writes a sibling discovery that reuses the same three-gate shape (IL tie → building/quality → slope) minus the founder gate, and captures repo languages for stack matching.
- **`pipeline/github-activity.js`** — `computeGithubSlope(ghUrl, token)` → `{slope_score, data:{login, star_velocity, top_repo, inflection, …}, evidence}`. Reuse verbatim for "can they build."
- **`lib/builderSignals.js`** — the taxonomy explicitly built for both products (`appliesTo: ['sourcing','talent']`). `detectSignals`/`filterBySignals`/`normalizeProfile` already tolerate a `talent_candidates` row. Reuse verbatim.
- **`lib/githubClient.js`** — `ghGet` with rate-limit backoff. All GitHub calls go through it.
- **Honesty gate — `agents/verify.js` + `lib/signals.js`** — `buildContextIndex`, `classifyQuote`, `unsupportedNumbers`. Every "why this match" line gets checked against real candidate text before it renders. Drop, don't badge.
- **`lib/ingest.js`** — `ingestDeck` (pdf-parse) and `ingestUrl` (Exa, with the login-wall guards). Reuse the text-extraction for JD PDFs and JD links; JD parsing does NOT record a `company_source` (that's founder-scoped) — it extracts text, then one temp-0 LLM call structures the role.
- **`lib/providerKeys.js`** — `anthropicFor(userId, feature)` → metered client; `MODEL`. Every LLM call (JD parse, shortlist explanation) routes through it. Per-role cost is cents.

---

## REPLACE (rip out)

### `pipeline/match-engine.js` — the old heuristic scorer
Deterministic 0–100 weighted sum (band 25 / stack 25 / caliber 20 / leap 15 / domain 10 / location 5, must-have penalty). No IL tie as a first-class axis, no warmth, no slope, no grounded rationale. **Replaced** by the new match engine (Phase 3). Still wired to `/sourcing/match`; re-point that route.

### `pipeline/talent-engine.js` — the old LLM sourcing+scoring (64KB)
`runTalentEngine` sources via Exa/GitHub with its own query derivation and LLM-scores every candidate into `overall_score`. This is the "predates and is worse than the sourcing infra" code. **Replaced**: warm pool comes from Airtable (Phase 2), cold pool from the GitHub-native discovery (Phase 4), scoring from the new engine (Phase 3). The daily 6:30am cron that calls `runTalentEngine` per open role gets re-pointed or retired.

### The dual-score mess
`overall_score` (LLM) + `match_score` (heuristic) + `unicorn_score` (bolted-on) coexist. Collapse to: cheap match signals (role-fit + ilTie + slope + warmth) computed for all, one LLM call to *explain* the shortlist. No thousands-of-candidates LLM scoring.

---

## NET-NEW

1. **JD ingest, 3-way** — PDF (pdf-parse), link (Exa), sentence (LLM). One temp-0 grounded parse → structured role. Leave unstated requirements blank; never invent must-haves the JD doesn't state.
2. **Warm-pool import** — read-only pull of Airtable Talent Database + Master Contacts into `talent_candidates` with provenance. Same `AIRTABLE_API_KEY` + base `appfE9DVrSUOrkkpu` already wired in `services/airtable-import.js`.
3. **Warm/cold tiering + warm-first ranking** — a warm fit always outranks an equal cold fit, with the "why warm" shown.
4. **Hiring-specific GitHub discovery** — Phase 4 sibling to `github-source` (stack+location, no founder gate, repo-language capture).
5. **Per-candidate handoff status + shareable export** — the tracking spine. Stu never contacts anyone.
6. **Founders↔role link + "open roles for this portco"** on `CompanyCard.jsx` and a Hiring home grouped by portco.

---

## Decisions (locked with Danny, 2026-08-14)

1. **Greenfield `hiring_*` tables.** _(Danny's call.)_ New clean tables — `hiring_roles`, `hiring_candidates`, `hiring_matches`, `hiring_runs` — under a new `/api/hiring` surface and a new `client/src/pages/hiring/` tree (React patterns copied from `talent/*`, wired to the new endpoints). The `talent_*` tables and `/talent` routes are left dead-but-intact; "Talent" comes out of the nav, "Hiring" goes under "Assess." No legacy columns to carry.

2. **Company linking → the `founders` table.** Roles belong to a company in Danny's universe (`founders`; invested = `investment_amount > 0`). `hiring_roles.founder_id` links there; the portco picker pulls invested founders; "open roles" renders on the real `CompanyCard.jsx` (`/founders/:id`). No separate hiring portco table — `founders` is the single source of truth. _(The Airtable "Superior Portfolio" table `tblc2FECMK5wzFr8f` is not integrated in Stu; `founders` (synced from "Superior Founder Ecosystem") is the only coherent portco universe today.)_

3. **Warm pool = genuinely warm only.** _(Danny's call: skip the old-engine rows entirely.)_ Import only `Joined Database Via = "Event - Permute Hackathon"` from the Talent Database, plus Master Contacts (empty today), plus portfolio-network alumni. The ~460 `"Talent Engine"` write-back rows are **not imported at all** — the warm pool contains only real relationships. Cold inventory comes from GitHub-native discovery (Phase 4), not the frozen database.

4. **Scope of the daily cron.** Retire the per-role `runTalentEngine` cron (it drives the old engine). Re-introduce a warm-refresh + thin-results discovery cron only after the new engine is verified live.
