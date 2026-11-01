# Stu Sourcing Inspection — parity-plus against Harmonic

*2026-11-01 · branch `sourcing-inspection-parity-plus` · not deployed*

**Target founder** (fixed for everything below): pre-seed, seed, or stealth/pre-founding; lives in Chicago/Illinois or has a real tie to it; venture-scale ambition.

---

## Summary: the three biggest ways Stu was going to miss or misrank target founders

**1. The scheduled scout was not running the way the ledger implied. Most of what it skipped, it skipped silently.**
- **The roster arm never fired.** The scout is a 10 PM CT cron on Mon and Fri. It runs the roster arm (YC, Speedrun, Thiel/Z/Neo/Residency/Emergent, IL schools, Breakout Radar) only when `new Date().getDay() === 1`. The container runs in UTC, so at 10 PM CT Monday it is already Tuesday. The roster arm therefore never ran on schedule; it only ran when the investor clicked Run.
- **Scorer outages were counted as rejections.** When the Claude spend cap or credit balance ran out, every remaining candidate was recorded as "filtered". The run then logged `+0 · ok`.
- **The curated query banks were dead code.** The 40 day-themed vectors (ex-OpenAI/Stripe/Anthropic Chicago, Argonne/Fermilab spinouts, "just left Google", Citadel/DRW alumni) and the 16 evergreen stealth vectors were never called. Daily mode also cut the investor's own custom queries.
- **The cohort tokens were a year stale.** They were hard-coded to `YC W25/S25/W26` and "2025".
- **The GitHub arm of the sweep admitted almost nobody.** It wrote `Location: Chicago`, which no tie pattern matches.
- **Net effect:** the queue sat unchanged for nights at a time. Part of that is by design (the sweep runs only twice a week, to stay under a $50/mo API cap). The rest was these bugs.

**What changed:**
- The weekday is now computed in Chicago time.
- The run aborts loudly on a scorer outage and records `SCORING STOPPED (reason)`.
- The spend cap is checked before the run starts.
- The curated banks and custom queries run in daily mode.
- Cohort and year tokens are computed from the clock.
- GitHub locations are read as residence.
- A per-run scoring cap (`SOURCING_MAX_SCORED_PER_RUN`, default 80) spends on the strongest pre-signals first, so the extra recall stays inside the budget.

**2. Weak Illinois ties were scored as the strongest kind, and tie strength never affected rank.**
- **Past jobs and passing mentions counted as "lives here".** `lib/ilTie` typed any "<word>, IL" as *current*, including a past-job line ("Previously PM at Motorola, Schaumburg, IL" for someone now in Austin). It also typed a bare "Illinois" ("we sell to hospitals in Illinois") as *current*.
- **Common words counted as Illinois employers.** "the amount of" matched the employer Amount; "cameo" and "avant-garde" behaved the same way.
- **The order was wrong.** *Worked here* was checked and ranked above *went to school here* and *from here*.
- **The sweep used a different gate.** The Exa sweep used the config-driven `verifyLocation()` path (the one that once made Stanford a Chicago tie) rather than the canonical gate.
- **Tie type had no effect on ranking.** Once a founder was on the IL board, "lives in Chicago" and "a co-founder's UChicago degree" ranked identically.

**What changed:**
- The hierarchy is now lives here (4) > from here or school here (3) > worked here (2) > via co-founder (1) > mention (0).
- Past-tense clauses demote ", IL" to *worked*.
- Ambiguous employer names need an employment cue.
- The sweep uses the same gate as every connector.
- Tie strength now adds a small ordered bonus (+4/+2/+1/0). A co-founder or mention tie cannot carry anyone to Must-meet.
- The Pipeline base supports this. Illinois-HQ rows are 6 of 7 investments and advance at 57%, against 36% for non-IL rows.

**3. The criteria excluded seed, over-rewarded prestige, and missed the cheapest early signal.**
- **Seed was excluded.** "Seed raise + traction" was a hard exclusion (the Cargado rule). Your own ledger contradicts it: all **7 of 7** investments in the Pipeline base are at **Seed**.
- **Fellowships were weighted like accelerators.** Z Fellows had the same core weight as Speedrun, and Thiel/Z/Neo were S-tier-eligible "top programs". Two program badges (YC + SPC) counted as "two independent signals" and alone made someone Must-meet.
- **Lab pedigree was not separated.** Frontier-lab experience (OpenAI, Anthropic, DeepMind) and technical roles were not distinguished from any other big-tech job.
- **IL Form D filings never created leads.** These are sworn, free, and filed within 15 days of first sale. They were used only to bump rows Stu already had.

**What changed:**
- Seed is now its own stage. It stays eligible and ranks below an otherwise-equal earliest-stage founder (×0.75).
- Fellowships are a 3-point modifier and never qualify anyone on their own. SPC drops from 6 to 4. National elite school drops from 3 to 2.
- Frontier lab = 8, technical hyperscaler role = 7, other hyperscaler role = 6.
- Program badges count as one corroborating class.
- A new free SEC Form D connector turns new Illinois raises into founder leads, one per executive officer.

**Also added:**
- **The five judgment patterns** (persistence, lived problem, self-taught, frontline, trusted complement). They are structured, quote-backed fields, extracted at sweep time and in Assess, and left null when the record is silent.
- **They are recorded and shown, not scored.** The internal data is too thin to weight them; see Part 3.

---

## Evidence sources used, and their limits

| Source | What it is | Limit |
|---|---|---|
| `server/seed-data.json.gz` | 5,084 founders from Stu's Feb-2026 sourced lists. Statuses: Identified 4,746 / Contacted 118 / Meeting Scheduled 6 / Passed 214. Includes the list each came from. | Bios average 162 characters, so many markers and patterns cannot fire on this text. These lists came from one-off list builds, not the current scout. |
| Airtable `Pipeline` (appxd2l3BXJAdTWSQ), **read-only** | 242 deals: Source Channel, Investment Status, Resident Status, HQ, Stage. | 44 of the 242 join to the seed ledger (by LinkedIn slug or name). No Airtable writes were made or added. |
| Production `sourced_founders` (~2,232 pending rows) | The live queue. | **Not reachable from this sandbox** (Render disk, no credentials used). The re-score below uses the seed ledger as the queue. After merge and deploy, the `RUBRIC_VERSION` bump makes boot (`index.js` → `fitIndex.rescoreStale`, limit 20,000) re-score every production row automatically (see Validation). |
| SEC EDGAR, harmonic.ai | — | Both blocked by this sandbox's network policy. The Form D connector is unit-tested against fixtures, **not live-verified**. Harmonic features come from search results and are marked unverified where needed. |

---

## Part 1 — Sourcing architecture map

### 1.1 End-to-end flow

```
                      ┌────────────────────── SCHEDULE (server/index.js, node-cron in the web process) ─────────────────────┐
                      │ 03:00 backup · 03:45 SEC Form D (filings-source + NEW sec_form_d leads) · 05:45 Airtable→Stu READ   │
                      │ 07:00 monitors · 12:00 LinkedIn enrich (40/run) · Sun 06:00 builder radar (GitHub slope)            │
                      │ Mon+Fri 22:00 SCOUT: Arm1 Exa sweep · Arm2 rosters (Mon only — weekday bug fixed) · Arm3 enrich ·   │
                      │                      Arm4 fitIndex.rescoreStale  → ONE job_runs row 'nightly_scout'                 │
                      └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
DISCOVERY                                 GATES                                 SCORE / STORE                     SURFACE
──────────                                ─────                                 ─────────────                     ───────
Exa sweep  pipeline/sourcing-engine.js ─┐  name gate (isPlausiblePersonName)     Claude scoreFounder (verbatim-     /api/pipeline/inbox
  cohort + curated + generic + custom   │  tie: checkTie → geoFilter → ilTie     evidence prompt, red flags,        (Source tab, Sourcing.jsx)
GitHub (sweep arm, + builder radar)  ───┤  founderGate (no VCs/recruiters)      caliber S/A/B/C reconciled)        ORDER: fit_tier, earliest,
Connectors pipeline/sources/*  ─────────┤  isTooFarAlong (Series B+ etc.)       → sourced_founders INSERT          fit_priority, created_at
  yc_directory (Algolia+YC pages)       │  dedup: isDuplicate (LinkedIn slug,   ↓                                  /api/pipeline/shortlist
  a16z_speedrun (REST API)              │    email, name±company; ANY status    lib/fitIndex.rescoreStale          (homepage, lib/morningList:
  thiel/z/neo/residency/emergent (Exa)  │    blocks re-add); connectors: same   → lib/founderFit.evaluate          reserved slots for arrivals)
  il_school_discovery (Exa)             │    3 lookups BEFORE enrichment        → fit_meet/tier/priority/why/      /api/sourcing/queue + MCP
  pre_program "Breakout Radar" (Exa)    │  geoPartition → list_scope            stage/patterns/tie (cached,        (TIE_CLAUSE on location_type)
  uspto_trademark (dormant w/o key)     │    pipeline (IL) | watchlist          RUBRIC_VERSION-keyed)
  sec_form_d  ← NEW                     │    (national Frontier Watch)
SEC Form D (filings-source) → entity_filings → fuzzy match → +1 confidence & "Filed Form D" tag on existing rows
Monitors (pipeline/monitor-engine) → signal detectors over rows ALREADY held; optional active Exa discovery
LinkedIn enrich (EnrichLayer) → linkedin_data; promotes watchlist→pipeline when LinkedIn shows an IL tie
```

### 1.2 Sweep sources: what actually runs

Cadence is shown as it was before this branch, then after.

| Source | Code | Cadence before → after | Notes |
|---|---|---|---|
| Exa web sweep | `pipeline/sourcing-engine.js` `runSourcingEngine` | Mon+Fri 22:00 CT; manual Run = full sweep | Daily mode was 7 cohort queries + the first 20 generic ones. **Now** it runs custom → cohort → today's themed group + 16 evergreen stealth queries → 12 generic. |
| GitHub builders | `searchGitHub` in the sweep; `pipeline/github-source.js` via `services/builder-radar.js` | Sweep arm Mon+Fri; radar Sun 06:00 | Sweep arm text fixed. The radar requires slope ≥ 5 and a building signal. |
| YC | `sources/yc-directory.js` | Rosters: **never on schedule** (UTC weekday) → Mondays | Algolia `chicago…` text query + the 200 newest launches; batch ≥ 2025; resolves ≤ 120 company pages per run. |
| a16z Speedrun | `sources/a16z-speedrun.js` | same | Was hard-coded to SR004–006. **Now** the latest 3 cohorts the API reports. |
| Thiel / Z / Neo / Residency / Emergent | `sources/cohort-rosters.js` | same | Exa people search; marker-confirmed. Per the code comments, they produce ~99 people per run and ~0 Illinois ties. |
| Illinois schools | `sources/il-school-discovery.js` | same | Five school-anchored Exa queries; "the highest-yield IL source". |
| Breakout Radar (pre-program) | `sources/pre-program-discovery.js` | same | Elite pedigree without a program tag. |
| USPTO trademarks | `sources/uspto-trademark.js` | dormant without `USPTO_API_KEY` | — |
| **SEC Form D leads** | **`sources/sec-form-d.js` (new)** | **daily 03:45** (no LLM) + Mondays/manual | IL filers, original D only, incorporated ≤ 3 yrs ago, ≤ $5M, not a fund, real-estate or extraction vehicle. Emits one record per executive officer. |

### 1.3 Scoring path

There are **three layers**, and the inbox reads only the last one:

1. **Sweep LLM score** (`scoreFounder`): `confidence_score` (fit, 1–10), `caliber_tier` S/A/B/C reconciled with deterministic `computeCaliber` (S needs a hard signal), and `red_flags`. Connector rows never get this LLM pass; they get `computeCaliber` only.
2. **Taste affinity** (`pipeline/taste.js`): ±5 nudge from approve/star/dismiss history. Used only in `/sourcing/queue` and the MCP ordering, **not** in the inbox or homepage.
3. **The rubric** (`lib/founderFit.evaluate`, cached by `lib/fitIndex`). This decides the Source inbox and the homepage.
   - **Gates:** stage (not past earliest), venture-scale (no lifestyle businesses), academic-without-operating-evidence, disqualifying red flags. All must pass, plus at least one *core* marker, for `fit_meet = 1`.
   - **Markers** (weight; each needs a verbatim quote or structured LinkedIn evidence). The weights below are after this branch.

| Marker | Weight (after) | Kind |
|---|---|---|
| `prior_exit` | 10 | core |
| `builder_slope` (GitHub) | 9, or 5 if identity is weak | core |
| `yc` | 8 | core |
| `hyperscale` | **8 frontier lab / 7 technical / 6 other** | core |
| `speedrun_zfellows` (now Speedrun only) | 6 | core |
| `prior_raise` | 6 | core |
| `prior_founding` | 6 | core |
| `founder_market_fit` | 6 | core |
| `recently_departed` | 5 | modifier, timing |
| `il_elite_school` | 5 | modifier, graduation |
| `spc` | **4** | core |
| **`fellowship`** (Z / Thiel / Neo / Emergent) | **3** | modifier, graduation |
| `nat_elite_school` | **2** | modifier |
| **IL tie bonus** | **+4 / +2 / +1 / 0** | — |

   - **Tiers:**
     - **Must-meet:** strong slope with a trusted identity, OR a prior exit, OR prior founding + pedigree, OR **≥ 2 independent signal classes** (program badges now count as one class). It is capped to Strong when the tie is co-founder or mention.
     - **Strong:** one core marker.
   - **Priority:** (marker sum + tie bonus) × 0.75 if seed stage; × 0.1 if past the target stage or disqualified.

**Where factors were computed inconsistently** (all fixed except the last):

| Factor | Sweep | Queue / API | Assess | Fix |
|---|---|---|---|---|
| Illinois tie | `verifyLocation(criteria)`: config-driven, legacy vocabulary | `lib/ilTie` via geoFilter (connectors, repartition); `/sourcing/queue` and MCP filtered on a 5-type list that **hid** `worked/school/cofounder` connector rows | not used | One gate (`checkTie` → ilTie); `VALID_TIE_TYPES` covers both vocabularies; the rubric re-derives the tie from the profile |
| Hyperscaler list | `HYPERSCALE_COMPANIES` (incl. Citadel, DRW, Grubhub, Groupon, Notion, Linear) | `founderFit.HYPERSCALERS` (incl. Uber, Airbnb, LinkedIn; no Chicago firms) | prompt prose | Documented; the rubric is authoritative. Chicago firms count as an IL **work tie**, not pedigree. |
| Programs | Thiel/Z/Neo were S-capable "top programs" | Z Fellows weighted = Speedrun | — | Both down-weighted |
| Stage | `isTooFarAlong`: Series B+ / own-company raise | rubric excluded seed + traction | — | Rubric: seed is ranked, not excluded |
| IIT | bare `iit` was an IL school in `extractSignals` | ilTie treats IIT Bombay etc. as traps | — | Bare `iit` removed |
| Taste affinity | written at insert | ignored by the inbox | — | Documented (not changed) |

### 1.4 Illinois tie logic (after this branch)

`lib/ilTie.verifyIlTie(text)`: strip false geography ("Chicago Bears", "Chicago-style"), strip school traps (IIT Bombay, Northwestern Mutual, Columbia University, Loyola Marymount…), then:

1. **current (4)**
   - "<place>, IL" not in a past-tense clause
   - "based / living / located in …"
   - "moved (back) to …"
   - "greater Chicago area"
   - "Normal, IL" style ambiguous places
2. **school (3)**: one of about 50 IL institutions, Argonne, or Fermilab. **hometown (3)**: "grew up in / from / native of".
3. **worked (2)**
   - a role within 40 characters of an IL place
   - one of about 90 Chicago-anchored employers, where common-word names need an employment cue
   - a demoted past-tense ", IL"
4. **cofounder (1)**: `propagateCofounderTies`. **Gap:** this runs only in the one-time `repartition-il-ties` migration, not at ingest.
5. **mention (0)**: a bare "Illinois". It is verified but weak, never a `VALID_TIE_TYPE`, and the sweep rejects it.

The rubric reads `tieOf(row)`. It re-verifies from profile text plus structured location (LinkedIn city/state, `location_state`) and never reads `chicago_connection`, the field the gate writes. It falls back to the stored type when the text is silent.

### 1.5 Stealth and pre-founding detection: what exists, and the blind spots

| Signal | Exists | Blind spot |
|---|---|---|
| Stealth headline / "building something new" | Regexes in `extractSignals`, `classifyStage`, founderGate; the stealth Exa queries now run daily | Needs the word on a public page Exa indexes; LinkedIn snippets are truncated |
| Departures from hyperscalers and labs | `recently_departed` marker (phrase match); `detectCaliberSignals` senior departure; "just left Google/Stripe/OpenAI Chicago" queries (now live) | **No re-check of known people.** A departure is caught only if a sweep query happens to return the person after they post it. Harmonic's core alert is "person X left company Y" (see 2.1). |
| GitHub activity shifts | `github-activity.js` slope (inflection repo, star velocity) weekly; weekly snapshots make week-over-week deltas | Only for people with a resolved GitHub; the discovery queries are IL location strings only |
| New company formation | Form D, previously match-only; **now creates leads** | Delaware-incorporated companies without an IL filing address; companies that file no Form D at all (pure SAFEs often skip it) |
| Stealth LinkedIn employer ("Stealth Startup") | Matched only as text | No structured "current employer = Stealth" signal without LinkedIn enrichment |
| Community presence (1871, mHUB, Polsky, hackathons, Discord) | 1871 / mHUB / Polsky are IL **employers** in ilTie | **No source ingests them.** This is the largest blind spot in the Illinois ground game. |

### 1.6 Supporting surface (as it touches sourcing quality)

- **Exemplars (`is_exemplar = 1`).** Set only by manual add (`lib/manualAdd.js:78`). Exemplars are excluded from the starred list, stats and MCP outreach; nothing else.
  - **They do not influence scoring:** no lookalike search and no prompt injection.
  - **Bug:** comments say exemplars "stay starred for learning", but `insertManualAdd` writes `status = 'pending'` (`manualAdd.js:112`). Exemplars therefore never enter the taste "liked" set, and they still appear in the inbox and morning list. *Not changed; listed as a gap.*
- **Network graph** (`pipeline/network-ingest.js`, `lib/networkMatch.js`). Ingests the LinkedIn export (connections, messages, invitations) plus Airtable advisor and investor tables, read-only. It is used only to match portfolio asks and hiring.
  - **No path ranks or discovers sourced founders.** There is no "warm path" chip, no second-degree discovery, and no "your contact just started a company". *Gap; design in Part 4.*
- **Assess** (`agents/prompts.js`, `routes/assessments.js`).
  - The founder rubric has four movements: earned_insight 3, execution_velocity 3, nonconsensus_vision 2, talent_magnetism 2. There is also a drive lens, two yellow flags and nine lenses.
  - Coverage of the five patterns before this branch: *lived problem* was covered ("They lived the problem…"); *trusted co-founder* was partly covered ("A co-founder re-up…"); *persistence*, *self-taught* and *frontline* were not asked for explicitly.
  - Assess writes nothing back to `sourced_founders`.
  - **Now:** the rubric also returns `founder_patterns`, verified verbatim against the context in code, with a deterministic extractor as fallback. They are stored in `rubric_output.founder_patterns` and are not scored.
- **Sweep reliability.** These causes explain why the queue sat unchanged:
  1. The sweep runs only Mon and Fri (cost decision, d0af31c).
  2. The roster arm never ran (UTC weekday) — **fixed**.
  3. Scorer outages under the $25/day user cap or the $50/mo API cap made a run `+0 · ok` — **fixed**: preflight check, abort on outage, recorded reason.
  4. The 03:45 filings job threw `ReferenceError: recordJobRun` on every success, so `sec_filings` never wrote a ledger row — **fixed**.
  5. Error objects rendered as `[object Object]` in the ledger — **fixed**.
  6. **Not fixed (deploy topology):** crons run inside the Render web process. A push to `main` auto-deploys and kills an in-flight scout with no ledger row. Moving the crons to a Render Cron Job or background worker is the structural fix; it is a deploy change, so it is left to you. `railway.json` is stale and was ignored, as instructed.

---

## Part 2 — The Harmonic benchmark

**Verification note.** harmonic.ai could not be fetched from this sandbox (network policy). The following Harmonic capabilities are **verified from public sources found via search**:
- a 30M+ company / 190M+ people database
- saved searches with recurring "Scouts" and alerts
- a stealth-founder workflow, with an alert when someone leaves a top AI lab to start something in stealth
- network mapping, investor profiles, a console
- firmographics, team data, funding history and headcount trends

Sources: [Harmonic site](https://harmonic.ai), [Harmonic corporate-innovation page](https://harmonic.ai/solutions/corporate-innovation), [Flybridge case study](https://www.casestudies.com/company/harmonic-ai/case-study/flybridge-leverages-harmonic-to-uncover-high-quality-investment-opportunities-in-ai), [Harmonic search agent support article](https://support.harmonic.ai/en/articles/10707447-search-agent-v1-0-alpha), [TechCrunch 2022](https://techcrunch.com/2022/11/07/harmonic-helps-investors-query-the-startup-searches-of-their-wildest-dreams), [Drio listing](https://www.getdrio.com/app-tracker/harmonic).

Anything else attributed to Harmonic below is marked **(unverified)**.

### 2.1 Capability matrix

| # | Harmonic capability | What it does for an investor | Stu status | Stu quality vs Harmonic | Verdict |
|---|---|---|---|---|---|
| **Discovery coverage** |
| D1 | Company + people universe (30M+ / 190M+) | Anyone with a LinkedIn profile is findable | **Partial.** Exa people search plus 10 connectors, about 2,200 rows | Far smaller universe, but it is pre-filtered to the IL tie | **Accept the gap** on breadth. The target is a few hundred people a year, not 190M. Stu must match Harmonic *on the IL slice*, which the sources below aim at. |
| D2 | Accelerator cohorts (YC, etc.) | New batches appear with founders | **Covered** (YC directory, Speedrun API, 5 cohort rosters) | Parity-plus: founder-level resolution and an IL tie read from the founder's bio, not the HQ. Was broken on schedule (weekday bug) and stale (Speedrun cohorts, YC tokens), now fixed. | **Match** |
| D3 | Funding announcements | New raises surface the week they land | **Partial → covered for IL.** New `sec_form_d` connector. Press and Crunchbase-style announcements are not ingested. | Form D usually lands *before* the announcement and covers SAFE rounds with no press; it misses companies that never file | **Exceed for IL pre-seed** (pending a live check of the EDGAR fetch); **accept the gap** for press-only announcements |
| D4 | Product launches (PH/HN-style) (unverified for Harmonic) | Launch = live product | **Missing** | — | **Accept the gap** for now; design in Part 4 |
| D5 | Open web | Semantic search over the web | **Covered** (Exa, ~60 queries now live in daily mode) | Comparable mechanism, narrower index | **Match** |
| **Enrichment** |
| E1 | Funding history | Stage gating, round sizes | **Partial.** Form D amounts via `lib/edgar.js` for companies already on the board; LLM-read from bios | No priced-round history, no investor list | **Accept the gap** (paid data); Form D covers the stages that matter |
| E2 | Headcount and growth | Kills mature companies, flags momentum | **Missing** | The "Jason Fried / Basecamp" false positive in the after list is exactly this | **Accept the gap → design** (paid; Part 4) |
| E3 | Technographics / web traffic (unverified for Harmonic) | Traction proxy | **Missing** | — | **Accept the gap** (paid) |
| E4 | Founder backgrounds (employment, education) | Pedigree, domain fit | **Covered** (EnrichLayer LinkedIn, 40/run drain; structured experiences[]) | Same source class as Harmonic. Stu's markers require **verbatim evidence**; Harmonic's "highlights" do not show receipts (unverified). | **Match; exceed on precision** |
| E5 | Contact data / LinkedIn URL | Outreach | **Partial.** LinkedIn URL ~100%; email rarely | — | **Accept the gap** (no outreach here by design) |
| **Change and intent signals** |
| S1 | Job departures (incl. "left a top AI lab to start something in stealth") | Reach founders the week they leave | **Partial.** Phrase-matched only when a sweep happens to return the person; no re-check of known people | Harmonic monitors *people*; Stu monitors *queries* | **Must match.** Design for re-enriching a watchlist (Part 4); uses the existing EnrichLayer key, so it is not built here pending a spend decision |
| S2 | New roles / "founder" title change (unverified detail) | First founder title = formation | **Partial.** Same mechanism as S1 | — | Same as S1 |
| S3 | Stealth companies | Pre-announcement teams | **Covered** (stealth queries now daily; stage gate; "Stealth" text) | Harmonic has a structured "Stealth" employer; Stu text-matches | **Match** |
| S4 | Funding events | Momentum | **Covered for IL** (Form D, now leads) | Earlier than press | **Exceed** (IL) |
| S5 | Hiring surges (unverified for Harmonic) | Momentum | **Missing** | — | **Accept the gap** (not a pre-seed signal) |
| **Search and filtering** |
| F1 | Cut by stage / geography / sector / background / signals | Ad-hoc lists | **Partial.** The inbox filters by tier, new, and hide-late; MCP tools filter by stage, region, sector and caliber; no UI query builder | The inbox is already the target cut. Ad-hoc cuts exist only via MCP. | **Accept the gap** in UI; **match** via MCP |
| F2 | Natural-language search agent | Ask in prose | **Partial** (MCP + Claude) | Comparable | **Match** |
| **Monitoring and alerts** |
| M1 | Saved searches / Scouts on a schedule | The alert *is* the product | **Covered.** The scout is one saved search (the IL target) twice weekly + monitors daily | Fixed so it actually runs and fails loudly | **Match** |
| M2 | Watchlists | Track named people / companies | **Partial.** `watching` status in the ledger; nothing re-checks them | — | **Must match** (S1 design) |
| M3 | Notifications on movement | Push | **Partial.** Homepage arrivals; digest email deliberately off | Your stated preference | **Match** (by choice) |
| M4 | Network mapping / warm paths | Who can introduce me | **Partial.** The network graph exists (LinkedIn export) but is not joined to sourced founders | — | **Must match**: cheap, internal data; design in Part 4 |

### 2.2 Where Stu must beat Harmonic, and whether it does today

| Structural blind spot of a national database | Does Stu exploit it today? | Evidence |
|---|---|---|
| **Pre-founding and stealth builders who appear in no database yet** (departure signals, GitHub, community) | **Partly.** GitHub slope (weekly radar) is the one real pre-database signal. Stealth / "just left" queries were dead code until this branch. There is no community ingestion, and no re-check of watched people. | In the after top 50, **9 of 50** are IL-school-tied hyperscaler engineers with no founder title who do not live in Illinois. A Harmonic location + title search would not return them; Stu's school-anchored search does. |
| **Illinois ground game** (local schools, communities, regional sources) | **Partly → better.** IL-school discovery, ~90 Chicago-anchored employers, IL Form D leads (new). **Missing:** 1871 / mHUB / Polsky / university-venture cohorts, IL hackathons, local newsletters. | The Airtable base shows Density (local) at 81% advance and 3 investments, and "Danny Goodman" (own network) at 67% and 2 investments. Outbound: 49% and 0 investments. Local and network channels convert best. |
| **Judgment signals a database cannot carry** (Part 3) | **Now recorded, not yet useful.** The five patterns are extracted with receipts, but bios average 162 characters, so they fire on 7 of 5,084 ledger records. The Assess pass (deck, notes, transcripts) is where they will populate. | See Part 3. |

**Parity-plus verdict.**
- **Mechanism:** after this branch, Stu's mechanism catches the categories a Harmonic IL saved search would return: IL-resident founders with a founder title, YC/Speedrun founders, stealth headlines, new IL raises.
- **Exceptions:** two Harmonic catch paths remain open, and both cost target founders every quarter:
  - **(S1/M2)** people Harmonic would flag from a job change on a profile Stu has seen before;
  - **(E2)** headcount-based stage gating.
- **Top tier:** on the ledger data, the after top 50 is better targeted. It is all IL ties, two-thirds lives-here (33 of 50), technical and lab pedigree ranked up, fellowship-only and weak-tie founders demoted. It is not yet measurably *better than Harmonic's list*, because the net-new count (below) is modest. On this data, Stu's edge is the school-anchored pre-founding slice.

---

## Part 3 — Calibrating the criteria

### 3.1 Internal base rates

**Seed ledger** (5,084 sourced founders, Feb-2026 lists). "Engaged" means Contacted, Meeting Scheduled, or present in the Airtable Pipeline. "Advanced" means Airtable Invested / Under Consideration / Watching / Graduated, or Resident Admitted / Interviewed / Hold / Density.

| Outcome | Count | Rate |
|---|---|---|
| Engaged | 153 | 3.0% |
| In Airtable pipeline | 44 | 0.9% |
| Advanced | 28 | 0.6% |
| Invested | 2 | 0.04% |

**Airtable Pipeline** (242 deals, all channels):

| Outcome | Count | Note |
|---|---|---|
| Advanced | 108 | 45% |
| Invested | 7 | all 7 at **Seed** stage |
| Passed | 130 | — |

**By Airtable source channel:**

| Channel | n | Advanced | Invested |
|---|---|---|---|
| Outbound (incl. Stu-sourced) | 120 | 49% | **0** |
| Investor referral | 31 | 39% | 1 |
| Density (local) | 21 | **81%** | **3** |
| Danny's own network | 15 | **67%** | 2 |
| Founder referral | 7 | 71% | 0 |
| Website / Inbound / Ecosystem | 35 | 0–25% | 0 |

**By HQ:** Illinois 87 rows, 57% advanced, **6 of the 7 investments**. Non-IL 86 rows, 36% advanced, 1 investment.

**By seed-ledger list** (engaged / in pipeline / advanced):

| List | n | Engaged | In pipeline | Advanced |
|---|---|---|---|---|
| illinois_founders | 472 | **7.2%** | 1.3% | 0.6% |
| coast_il_search | 83 | **7.2%** | 2.4% | 1.2% |
| pipeline_v2 | 790 | 3.8% | 1.3% | 0.6% |
| campus_builders | 812 | 3.4% | 0.5% | 0.4% |
| unicorn_candidates | 1,009 | 2.9% | 0.5% | 0.2% |
| il_diamonds | 659 | 2.1% | 1.4% | **1.2%** |
| hidden_gems | 461 | 0.7% | 0.2% | 0.2% |
| unicorn_spinouts | 674 | **0.1%** | 0.1% | 0.1% |

**By rubric tier**, applied post hoc to the ledger text:

| Tier | n | Engaged | Advanced |
|---|---|---|---|
| Must-meet | 37 | 10.8% | **0/37** |
| Strong | 660 | 6.4% | 1.1% |
| Untiered | 4,387 | 2.4% | 0.5% |

**Caveats**, in order of importance:
- **(a) Circularity.** These lists were ranked when shown to you. The legacy `fit_score` is monotonic in engagement (fit 9 → 86%, fit 1 → 0.5%) partly because you contacted what was flagged.
- **(b) Thin text.** Bios average 162 characters, so most markers cannot fire.
- **(c) Tiny outcome counts.** 28 advanced and 2 invested. No signal-level conclusion below is statistically strong. "Thin" means *do not change the investor's stated preference on this evidence*.

### 3.2 Signal-by-signal criteria table

| Signal | Weight before → after | Internal evidence (engaged with vs without; n) | External evidence | Verdict |
|---|---|---|---|---|
| YC | 8 → 8 | **16.7% vs 2.7%** (n = 114); 3.5% advanced vs 0.6% base. The strongest lift in the data. | Published outcome lift (in-code citation: ~4.5% vs ~2.5% unicorn rate) | **Keep.** Supported by both sources. |
| Prior exit | 10 → 10 | 5.9% vs 3.0% (n = 17); 0 in pipeline | Modest-exit founders over-represented among unicorn founders (in-code citation) | **Thin.** No internal support either way. Kept at your stated #1 because 17 rows cannot overturn a stated preference. Re-test in two quarters. |
| Prior founding | 6 → 6 | 1.7% vs 3.0% (n = 60) | Survivor patterns include persistence after failure, which overlaps | **Thin, slightly negative.** Kept; flagged for re-test. |
| Prior raise | 6 → 6 | n = 1 | — | **Too thin.** Unchanged. |
| Hyperscaler | 6 → **8 lab / 7 technical / 6 other** | **5.5% vs 2.7%** (n = 523), ~2× lift | Your calibration note: weight hard technical pedigree (hyperscalers, AI labs) | **Raise for technical and lab pedigree.** Both sources agree. |
| a16z Speedrun | 6 → 6 (split from Z) | n = 11 for Speedrun + Z combined, 0 engaged | No published outcomes | **Unchanged.** It comes with a venture check. |
| Fellowships (Z / Thiel / Neo / Emergent) | Z 6 core; Thiel/Neo S-capable in caliber → **3 modifier; caliber B-level** | Same n = 11, 0 engaged; cohort rosters yield ~0 IL ties (code comment) | Your note: down-weight fellowships, scholarships and press | **Down-weight.** No counter-evidence. |
| SPC | 6 → **4** | 1 of 7 engaged | Community and fellowship, not capital | **Down-weight** (prestige) |
| Two program badges as must-meet | auto must-meet → **one class** | must-meet 0 of 37 advanced | — | **Tighten** |
| IL elite school | 5 → 5 | **7.0% vs 1.7%** (n = 1,292), ~4× engaged; 1.2% advanced vs 0.6% base | School predicts the next round, not the company (in-code citation); survivor set: pedigree did not distinguish | **Keep.** The internal lift is real. It is likely partly the IL network effect, not prestige. It stays a modifier. |
| National elite school | 3 → **2** | not measurable (no structured education in ledger) | Survivor set: elite pedigree did not distinguish; your note | **Down-weight slightly** |
| Recently departed | 5 → 5 | n = 1 | — | **Too thin.** Unchanged. |
| Builder slope | 9 → 9 | no GitHub data in the ledger | Self-taught / building-young pattern overlaps | **Untestable here.** Unchanged. |
| Founder-market fit | 6 → 6 | did not fire (needs structured employment) | Lived-problem pattern overlaps | **Untestable here.** Unchanged. |
| **IL tie type** | gate only → **ranked +4 / +2 / +1 / 0** | Airtable: IL-HQ 57% vs 36% advanced, 6 of 7 investments. Ledger: current 0.9% advanced, school-only 0.3%, worked 0/39, mention 0/6. | Thesis: "the best we can be first to" | **Rank by tie strength** |
| **Seed stage** | excluded (seed + traction) → **eligible, ×0.75** | **7 of 7 investments at Seed**; Seed rows 50% advanced vs Pre-seed 47% | Target definition includes seed | **Un-exclude** |
| **Five judgment patterns** | none → **recorded, weight 0** | Fire on **7 of 5,084** ledger records (self-taught 6, frontline 1); 0 engaged. **Internal data is too thin to conclude anything.** | Survivor patterns, with survivorship bias | **Record and show, do not weight.** Re-test once Assess and LinkedIn enrichment have populated them for ~100 met founders. |

**Prestige signals left as they were, and why:**
- **Forbes 30u30 queries** remain a *recall* query, which only finds people; no ranking weight is attached.
- **Press** has no marker.
- **Elite school** stays a modifier; IL elite school keeps its 5 because the internal lift supports it. This is the one place the internal data argues *against* a blanket prestige down-weight. My read is that it is the local-network effect, not prestige.

---

## Part 4 — Ranked gap list, fixes, validation

### 4.1 Ranked gap list (by likely target founders lost or misranked per quarter)

**These estimates are order-of-magnitude, not measurements.** They come from production's reported yield (≈12 saves per run across all sources, per `routes/sourcing.js`), one manual run that added 167 connector rows, ~26 scheduled scout runs per quarter, the 0.6% advance rate above, and the IL share of each source. Treat them as a ranking.

| Rank | Gap | Est. target founders / qtr | Status |
|---|---|---|---|
| 1 | Roster arm (YC, Speedrun, cohorts, IL schools, Breakout Radar) never ran on schedule (UTC weekday) | 20–60 missed or late (manual clicks partly mitigated) | **Fixed** |
| 2 | Scorer outage (spend cap, credit, rate limit) silently turned runs into `+0 · ok` | 10–30 missed, plus wrong trust in an empty queue | **Fixed** (preflight + abort + reason in ledger) |
| 3 | Curated stealth/departure banks dead; custom queries cut; 2025 tokens | 10–25 missed (the pre-database slice) | **Fixed** (+ per-run scoring cap) |
| 4 | No person re-check: departures / founder-title changes on people already seen (Harmonic's core alert) | 10–20 missed or late | **Design** (4.3a); uses the existing paid EnrichLayer key, so not enabled without your spend call |
| 5 | Seed + traction excluded, against the target and 7/7 investments | 5–15 misranked out of view | **Fixed** (ranked ×0.75) |
| 6 | No new-company-formation leads from IL Form D | 5–20 missed (unverified live) | **Fixed** (connector; live EDGAR fetch untested from sandbox) |
| 7 | Weak ties scored as strong (past ", IL", bare "Illinois", common-word employers, worked > school); tie unused in rank; sweep on a config-driven gate | ~10–30 misranked; ~2–5 false ties admitted | **Fixed** |
| 8 | Prestige over technical pedigree (fellowship = core / S-capable; YC + SPC auto must-meet; labs undistinguished) | ~5–15 misranked in the top 50 | **Fixed** |
| 9 | GitHub sweep arm admitted ~nobody (`Location:` format) | 3–10 missed | **Fixed** |
| 10 | No headcount / maturity data: mature companies with thin bios slip the stage gate (e.g. Jason Fried, Basecamp, at #50 after) | 0 missed; ~2–5 false positives per top 50 | **Design** (4.3b, paid) |
| 11 | Community / ground-game sources not ingested (1871, mHUB, Polsky, university venture programs, IL hackathons, Density-style programs) | 5–15 missed: the highest-converting channels in Airtable are local | **Design** (4.3c, free) |
| 12 | Network graph not joined to sourcing (warm paths, contacts who just founded) | 3–10 missed; slower intros | **Design** (4.3d, free) |
| 13 | Speedrun cohorts hard-coded to SR004–006 | 2–8 missed | **Fixed** |
| 14 | Co-founder tie propagation only in a one-time migration | 2–5 missed | **Design** (4.3e) |
| 15 | Exemplars land as `pending`, never teach taste, no lookalike search | indirect | **Documented**, not changed (semantics are yours) |
| 16 | 03:45 filings job never wrote its ledger row (ReferenceError) | 0 founders; observability | **Fixed** |
| 17 | Crons in the web process: a deploy kills an in-flight scout silently | occasional whole run | **Not changed** (Render topology; your call) |
| 18 | Thin bios (avg 162 characters) starve markers and patterns | broad | Mitigated by LinkedIn enrichment (40/run); raising the drain rate is a spend call |

### 4.2 Changes on the branch

| File | Change | Evidence |
|---|---|---|
| `server/lib/ilTie.js` | Hierarchy current > school/hometown > worked > cofounder > mention; `TIE_STRENGTH`/`tieStrength()`; past-clause demotion of ", IL"; employment cue for common-word employers; bare "Illinois" → `mention` (weak); `cityOf` clause/"lives in" fixes | Part 1.4; tests |
| `server/lib/founderFit.js` | Tie bonus in priority and weak-tie must-meet cap; seed stage ranked ×0.75 instead of excluded; frontier lab 8 / technical 7 / other 6; Z/Thiel/Neo/Emergent → `fellowship` modifier 3; SPC 4; national school 2; program badges = one corroboration class; five patterns attached (sweep LLM quotes merged only if verbatim); `RUBRIC_VERSION` bumped so `rescoreStale` re-scores every row on the next run | Part 3.2 |
| `server/lib/founderPatterns.js` (new) | Deterministic, quote-backed extractor for the five patterns; null when silent; investor/client veto | Part 3 |
| `server/lib/fitIndex.js`, `server/db.js` | Store `fit_patterns`, `fit_pattern_count`, `fit_tie_type`, `fit_tie_strength` (additive columns); score `evidence_map` | — |
| `server/routes/pipeline.js` | Inbox returns `fit.patterns` and `fit.tie`; shortlist returns `il_tie_rank`, `patterns`, `pattern_labels` | — |
| `client/src/pages/Sourcing.jsx` | Inbox detail shows the tie rank ("lives here now" … "mention only") and "Judgment patterns (shown, not scored)" with the founder's own words | — |
| `server/pipeline/sourcing-engine.js` | `checkTie` → canonical ilTie for IL users; `VALID_TIE_TYPES` covers both vocabularies; curated banks + custom queries in daily mode; `recentYcBatches`/`freshenQuery`; GitHub "Based in"; spend-cap preflight; outage abort with recorded reason; `MAX_SCORED_PER_RUN` (default 80) with pre-score ordering; fellowships out of TOP_PROGRAMS; prompt: fellowships/press ≤ B, labs explicit, `founder_patterns` output; bare `iit` removed | Part 1 |
| `server/pipeline/sources/sec-form-d.js` (new) + `sources/index.js` | IL Form D → founder leads (exec officers; ≤ 3 yrs, ≤ $5M, no funds) | Gap 6 |
| `server/pipeline/sources/a16z-speedrun.js` | Latest 3 cohorts from the API by default | Gap 13 |
| `server/index.js` | Chicago-time weekday for the roster arm; readable sweep errors and SCORING STOPPED in the scout ledger line; 03:45 job requires `recordJobRun`, writes its row, and runs `sec_form_d` ingest without LLM enrichment | Gaps 1, 2, 16 |
| `server/agents/prompts.js`, `server/routes/assessments.js` | Founder rubric returns `founder_patterns`; code keeps only verbatim quotes, falls back to the extractor, and stores them in `rubric_output.founder_patterns` (not scored) | Part 3 |
| Tests | New `test/sourcing-parity-plus.test.js` (21 tests); updated the Cargado test and the VALID_TIE_TYPES test to the new intended behaviour | — |

**Guardrails held:**
- No Airtable write path; Airtable was read once, read-only, for analysis.
- No change to Stripe, seats or pricing.
- No credential read, printed or rotated; `SETTINGS_ENC_KEY` untouched.
- No purchases or signups.
- No deploy; not merged to `main`.

**Test suite:** 787 / 804 pass. The 17 failures are the **identical set** that fails on `main` (Airtable-push, cron-schedule, digest, SMTP and other environmental tests; see TESTING.md). The client production build succeeds.

### 4.3 Designs for gaps not closed

**(a) Person re-check: departures and founder-title changes (Harmonic S1/M2).**
- **Schedule:** a weekly job.
- **Who it re-reads:** rows with `status IN ('watching','starred')`, or founders at the ledger's Identified/Contacted stages, whose `linkedin_enriched_at` is older than 45 days. Limit 25.
- **How:** re-enrich through the existing EnrichLayer client.
- **What it compares:** the newest `experiences[0]` and the headline before and after.
- **What it records:** an ended role at a hyperscaler or lab, a new "Founder/Stealth" title, or a city change into or out of IL. Each becomes a `builder_signals` entry (`just_departed`, `new_founder_title`) with dates. That fires the `recently_departed` marker and resets `fit_scored_at`.
- **Cost:** about $0.25/week at ~$0.01/profile on your existing key.
- **Why it isn't enabled:** it adds recurring spend, which needs your call. Flip it on by adding the job to the Sunday radar.

**(b) Headcount / maturity (Harmonic E2): paid.**
- **Options:** EnrichLayer's company endpoint (same vendor and key, per-call cost) or a firmographics vendor. *Not purchased.*
- **Design:** for Strong and above only, fetch the company's LinkedIn page once, then set `company_headcount` and `company_founded`.
- **Gate:** `classifyStage` treats headcount > 50 or founded > 6 years ago with no "new venture" cue as past-earliest.
- **Value:** this kills the Basecamp-style false positive.

**(c) Illinois ground-game sources: free.**
- **New connectors, same SourceConnector shape:**
  - 1871 / mHUB / Polsky / Northwestern The Garage / UIUC Research Park and iVenture / UChicago Polsky Accelerator: public cohort and member pages through Exa or the page fetcher, with markers for the program name.
  - IL hackathon winner pages: HackIllinois, WildHacks, UChicago hackathons.
  - Density-style residency rosters.
- **Tie:** each is an IL tie by construction (type `school` or `worked`).
- **Why it matters:** the Airtable channel data says local channels convert best.

**(d) Warm-path join: free, internal.**
- **Join:** at score time, match `sourced_founders` to `network_people` by LinkedIn slug, then by company + name.
- **Output:** a `warm_path` chip (strength from `lib/relationshipStrength`). No weight in the rubric; it is shown only.
- **Second-degree discovery:** when a `network_people` contact's headline changes to Founder/Stealth (via (a)), insert them as a lead with source `network`.

**(e) Co-founder ties at ingest.** After each scout, run `propagateCofounderTies` over pending rows sharing a non-generic company, and write `location_type = 'cofounder'` with the evidence naming the person. It ranks last (strength 1) and is capped at Strong.

**(f) Product-launch signal (Harmonic D4).** A free connector over Product Hunt / Show HN for makers whose profile verifies an IL tie. Low expected yield; build after (c).

### 4.4 Validation: before/after top 50

**What was re-scored.**
- **The queue:** the seed ledger's 4,870 non-passed founders, with the Illinois-tie gate applied (2,618 before, 2,616 after).
- **"Before":** the rubric and tie gate from `main` (`git show main:server/lib/{founderFit,ilTie}.js`).
- **"After":** this branch.
- **Ordering:** the Source inbox's own ORDER BY (tier, earliest stage, priority, newest).
- **Not the production queue:** that lives on the Render disk and was not reachable. Production re-scores itself on the first boot after deploy, because `RUBRIC_VERSION` changed. The comparison scripts are not committed: they read a local, read-only export of the Airtable Pipeline, and that export should not live in the repo. They re-run `lib/founderFit` and `lib/ilTie` from `main` and from this branch over the seed ledger.

**The source-path rule.** The after list may only contain founders with a plausible path through a source **Stu actually runs**:
- **YC directory:** a YC batch ≥ 2025 in the text.
- **Speedrun / cohort rosters:** program named in the text.
- **IL-school discovery:** IL school + founder or building words.
- **Exa sweep:** LinkedIn + lives-here or worked-here tie + founder or building words.
- **GitHub builders:** GitHub URL + tie.

Applied to the queue:
- **1,814 of 2,616** Illinois-tied founders in the queue have **no such path**. They came from one-off Feb-2026 list builds that Stu does not run.
- **22 of the old top 50** are among them, e.g. Ayush Gupta, Jeff Kleban, Pete Koomen, Erik Nomitch. They are excluded from the after list, as required.
- **This is itself a finding:** on today's sources, Stu would not re-find most of its own Feb-2026 queue. Gaps 4 and 11 are the cheapest ways to win that back.

**Biggest movers.** These are criteria-only: same population, no source-path filter.

| Founder | Rank before → after | Plain-language reason |
|---|---|---|
| Royden Onishi | #79 → #44 | Lives in Illinois (+4 vs a school-only tie's +2) and the Stripe role is engineering (technical hyperscaler 7, not 6) |
| Jamie Rollison, Abdul Bagasra | #82 → #45, #86 → #46 | Same: Chicago resident + technical Stripe role |
| Bo T., Brian Kapustka | #91 → #47, #92 → #48 | Same: Chicago resident + technical Airbnb / Uber role |
| Greg McLain, Qi Chen | #94 → #49, #103 → #50 | Same: Chicago resident + technical Google role |
| Nik Spirin, Tony Chang, Zach Tratar | #37 → #104, #38 → #105, #41 → #106 | Identical markers, but the only tie is having gone to school in Illinois. They don't live here, so they rank below residents |
| Vatsal Bhargava, Raymond Li | #46 → #107, #47 → #108 | Same: school-only tie |
| Nishant Patni, Aurangzeb Agha | #48 → #109, #49 → #110 | Same: school-only tie (Northwestern); "Founded before" unchanged |

**Other effects:**
- The top 7 must-meets keep their order. Each gains the +4 lives-here bonus or the +2 school bonus.
- 5 founders moved from *current* to *mention*. The only Illinois evidence was a bare state name; they no longer rank as residents.
- 7 moved from *worked* to *school*: they had both, and school now ranks higher.

**Before: top 50** (rubric on `main`)

| # | Founder | Tier | Priority | Tie | Was # | Why (verified markers) |
|---|---|---|---|---|---|---|
| 1 | Ayush Gupta | must-meet | 17 | school | — | Raised VC previously, Hyperscaler: Google, University Of Illinois |
| 2 | Jeff Kleban | must-meet | 16 | school | — | Exited a startup, Founded before |
| 3 | Pete Koomen | must-meet | 19 | school | — | YC, Hyperscaler: Google, University Of Illinois |
| 4 | JD Hartley | must-meet | 16 | current | — | Exited a startup, Founded before |
| 5 | Gina Park | must-meet | 15 | current | — | Exited a startup, Northwestern |
| 6 | Nathaniel Whittemore | must-meet | 15 | school | — | Exited a startup, Northwestern |
| 7 | Vagish Shastri | must-meet | 12 | current | — | Founded before, Hyperscaler: Google |
| 8 | Shashank Sharma | must-meet | 10 | current | — | Exited a startup |
| 9 | Shirley Yang Crutchfield | must-meet | 10 | current | — | Exited a startup |
| 10 | Marvin Russell | must-meet | 10 | current | — | Exited a startup |
| 11 | Sheridan Clayborne | strong | 13 | school | — | YC, Northwestern |
| 12 | Joseph Yang | strong | 11 | school | — | Hyperscaler: Amazon, University Of Illinois |
| 13 | Joseph Yang | strong | 11 | school | — | Hyperscaler: Amazon, University Of Illinois |
| 14 | Adrian Petrykiw - Stealth Startup - LinkedIn | strong | 11 | current | — | Hyperscaler: Amazon, University Of Illinois |
| 15 | Erik Nomitch | strong | 11 | current | — | Hyperscaler: Meta, Illinois Institute Of Technology |
| 16 | Pritish Jetley | strong | 11 | school | — | Hyperscaler: Google, University Of Illinois |
| 17 | Leena Abdelrahman | strong | 11 | current | — | Hyperscaler: Amazon, University Of Illinois |
| 18 | Victor Shao | strong | 11 | school | — | Hyperscaler: Amazon, Northwestern |
| 19 | Satinder Pal Singh | strong | 11 | school | — | Hyperscaler: Amazon, University Of Illinois |
| 20 | Sarthak Handa | strong | 11 | school | — | Hyperscaler: Amazon, Northwestern |
| 21 | Marc Malizia | strong | 11 | current | — | Founded before, University Of Illinois |
| 22 | George Ruan | strong | 11 | school | — | Hyperscaler: Facebook, University Of Illinois |
| 23 | Abhived Pulapaka | strong | 8 | current | — | YC |
| 24 | Joseph Ayalew | strong | 8 | current | — | YC |
| 25 | Puja Kamath | strong | 6 | current | — | Hyperscaler: Google |
| 26 | Connor Owens | strong | 6 | current | — | Hyperscaler: Google |
| 27 | David Hong Kyun Kim | strong | 6 | current | — | Hyperscaler: Google |
| 28 | Pete Tiwari | strong | 6 | current | — | Hyperscaler: Amazon |
| 29 | Steve Merritt | strong | 6 | current | — | Hyperscaler: Google |
| 30 | Shannon Smith | strong | 6 | current | — | Hyperscaler: Facebook |
| 31 | Fernando DeLeón | strong | 6 | current | — | Hyperscaler: Google |
| 32 | Jesse Peterson | strong | 6 | current | — | Hyperscaler: Amazon |
| 33 | Evan Meyer | strong | 13 | current | — | YC, University Of Illinois |
| 34 | Pranav Manpuria | strong | 13 | current | — | YC, Illinois Institute Of Technology |
| 35 | Geoff Segal | strong | 13 | current | — | YC, University Of Illinois |
| 36 | Reuben Balik | strong | 13 | current | — | YC, University Of Illinois |
| 37 | Nik Spirin | strong | 11 | school | — | Hyperscaler: Meta, Uiuc |
| 38 | Tony Chang | strong | 11 | school | — | Hyperscaler: Databricks, University Of Illinois |
| 39 | Shikhar Sehgal | strong | 11 | current | — | Hyperscaler: Apple, Uchicago |
| 40 | Mohammad El-Jawhari | strong | 11 | current | — | Hyperscaler: Google, University Of Illinois |
| 41 | Zach Tratar | strong | 11 | school | — | Hyperscaler: Stripe, University Of Illinois |
| 42 | Neal Miller | strong | 11 | current | — | Founded before, University Of Illinois |
| 43 | Folasade Runcie | strong | 11 | current | — | Hyperscaler: Doordash, Booth |
| 44 | Ibraheem Alinur | strong | 11 | current | — | Founded before, Northwestern |
| 45 | Adam Jeffries | strong | 11 | current | — | Hyperscaler: Google, University Of Illinois |
| 46 | Vatsal Bhargava | strong | 11 | school | — | Hyperscaler: Google, Northwestern |
| 47 | Raymond Li | strong | 11 | school | — | Hyperscaler: Google, University Of Illinois |
| 48 | Nishant Patni | strong | 11 | school | — | Founded before, Northwestern |
| 49 | Aurangzeb Agha | strong | 11 | school | — | Founded before, Northwestern |
| 50 | Ping-Bang Hu | strong | 11 | current | — | Hyperscaler: Amazon, University Of Illinois |

**After: top 50** (this branch, source-path rule applied). Every row names the Stu source(s) that would surface the person. The last column says whether a Harmonic-style database would plausibly put them in front of this investor (method in 4.5).

| # | Founder | Tier | Priority | Tie (ranked) | Was # | Why (verified markers) | Surfaced by (sources Stu runs) | Harmonic-style DB would catch? |
|---|---|---|---|---|---|---|---|---|
| 1 | JD Hartley | must-meet | 20 | current | 4 | Exited a startup, Founded before | Exa sweep | likely |
| 2 | Gina Park | must-meet | 19 | current | 5 | Exited a startup, Northwestern | IL schools, Exa sweep | likely |
| 3 | Nathaniel Whittemore | must-meet | 17 | school | 6 | Exited a startup, Northwestern | IL schools | possible |
| 4 | Vagish Shastri | must-meet | 16 | current | 7 | Founded before, Hyperscaler: Google | Exa sweep | likely |
| 5 | Shashank Sharma | must-meet | 14 | current | 8 | Exited a startup | Exa sweep | likely |
| 6 | Shirley Yang Crutchfield | must-meet | 14 | current | 9 | Exited a startup | Exa sweep | likely |
| 7 | Marvin Russell | must-meet | 14 | current | 10 | Exited a startup | Exa sweep | likely |
| 8 | Sheridan Clayborne | strong | 15 | school | 11 | YC, Northwestern | IL schools | possible |
| 9 | Pritish Jetley | strong | 13 | school | 16 | Hyperscaler: Google, University Of Illinois | IL schools | unlikely |
| 10 | Victor Shao | strong | 13 | school | 18 | Hyperscaler: Amazon, Northwestern | IL schools | unlikely |
| 11 | Satinder Pal Singh | strong | 13 | school | 19 | Hyperscaler: Amazon, University Of Illinois | IL schools | possible |
| 12 | Sarthak Handa | strong | 13 | school | 20 | Hyperscaler: Amazon, Northwestern | IL schools | unlikely |
| 13 | Shannon Smith | strong | 11 | current | 30 | Hyperscaler: Facebook (technical) | Exa sweep | likely |
| 14 | Puja Kamath | strong | 10 | current | 25 | Hyperscaler: Google | Exa sweep | likely |
| 15 | David Hong Kyun Kim | strong | 10 | current | 27 | Hyperscaler: Google | Exa sweep | likely |
| 16 | Steve Merritt | strong | 10 | current | 29 | Hyperscaler: Google | Exa sweep | likely |
| 17 | Fernando DeLeón | strong | 10 | current | 31 | Hyperscaler: Google | Exa sweep | possible |
| 18 | Jesse Peterson | strong | 10 | current | 32 | Hyperscaler: Amazon | Exa sweep | likely |
| 19 | Evan Meyer | strong | 17 | current | 33 | YC, University Of Illinois | YC directory, IL schools, Exa sweep | likely |
| 20 | Pranav Manpuria | strong | 17 | current | 34 | YC, Illinois Institute Of Technology | IL schools, Exa sweep | likely |
| 21 | Geoff Segal | strong | 17 | current | 35 | YC, University Of Illinois | YC directory, IL schools, Exa sweep | likely |
| 22 | Reuben Balik | strong | 17 | current | 36 | YC, University Of Illinois | IL schools, Exa sweep | likely |
| 23 | Neal Miller | strong | 15 | current | 42 | Founded before, University Of Illinois | IL schools, Exa sweep | possible |
| 24 | Folasade Runcie | strong | 15 | current | 43 | Hyperscaler: Doordash, Booth | Exa sweep | possible |
| 25 | Ibraheem Alinur | strong | 15 | current | 44 | Founded before, Northwestern | IL schools, Exa sweep | possible |
| 26 | Rahul Mansharamani | strong | 15 | current | 57 | Hyperscaler: Google, Illinois Institute Of Technology | IL schools, Exa sweep | possible |
| 27 | Aaron Lichtman | strong | 15 | current | 60 | Hyperscaler: Meta, University Of Illinois | IL schools, Exa sweep | possible |
| 28 | Pete Mannix | strong | 15 | current | 109 | Hyperscaler: Meta, University Of Illinois | IL schools, Exa sweep | possible |
| 29 | Tony Chang | strong | 13 | school | 38 | Hyperscaler: Databricks, University Of Illinois | IL schools | possible |
| 30 | Vatsal Bhargava | strong | 13 | school | 46 | Hyperscaler: Google, Northwestern | IL schools | possible |
| 31 | Raymond Li | strong | 13 | school | 47 | Hyperscaler: Google, University Of Illinois | IL schools | unlikely |
| 32 | Ram Srinivasan | strong | 13 | school | 71 | Hyperscaler: Meta, University Of Illinois | IL schools | unlikely |
| 33 | Apoorva Uppin Rajashekar | strong | 13 | school | 118 | Hyperscaler: Amazon, University Of Illinois | IL schools | unlikely |
| 34 | Dipro Ray | strong | 13 | school | 124 | Hyperscaler: Meta, University Of Illinois | IL schools | unlikely |
| 35 | Hung Duong | strong | 13 | school | 128 | Hyperscaler: Meta, University Of Illinois | IL schools | unlikely |
| 36 | Eden Hirschfield | strong | 13 | school | 135 | Hyperscaler: Google, Northwestern | IL schools | unlikely |
| 37 | Nikhil Reddy | strong | 12 | current | 136 | YC | YC directory, IL schools, Exa sweep | likely |
| 38 | Eshan Dosani | strong | 12 | current | 139 | YC | YC directory, IL schools, Exa sweep | likely |
| 39 | Robert J. Salvador | strong | 12 | current | 141 | YC | Exa sweep | likely |
| 40 | Aaron Letzeiser | strong | 12 | current | 142 | YC | Exa sweep | likely |
| 41 | Aron Frishberg | strong | 10 | school | 137 | YC | YC directory | possible |
| 42 | Yifei Xu | strong | 10 | school | 138 | YC | YC directory, IL schools | possible |
| 43 | Alyshah K. | strong | 10 | current | 145 | Founded before | Exa sweep | likely |
| 44 | Yehya Almattary | strong | 10 | current | 147 | Hyperscaler: Aws | Exa sweep | likely |
| 45 | Rayan Ghandour | strong | 10 | school | 140 | YC | YC directory, IL schools | possible |
| 46 | Mark Dronen | strong | 10 | current | 153 | Founded before | Exa sweep | likely |
| 47 | Omar Moreno | strong | 10 | current | 154 | Founded before | Exa sweep | likely |
| 48 | Emily Tsitrian | strong | 10 | current | 156 | Hyperscaler: Stripe | Exa sweep | likely |
| 49 | Michael Lucy | strong | 10 | current | 160 | Hyperscaler: Stripe | Exa sweep | likely |
| 50 | Andrew Rowland | strong | 10 | current | 162 | Hyperscaler: Google | Exa sweep | possible |

### 4.5 Harmonic-catch annotation and the net-new count

**Method.** This models how a Harmonic saved search for this target would work: people indexed from LinkedIn, filtered by current location, title and education, plus the company graph (accelerator and funding data).
- **likely:** lives in IL now, LinkedIn present, and either a founder/CEO/CTO/stealth title or a YC/Speedrun/funding signal.
- **possible:** LinkedIn present, but the person surfaces only with an education or past-employer filter, or only through a departure alert (an IL school or worked tie with a founder title, or IL-resident with no founder title yet).
- **unlikely:** no founder title and no current IL location. A location + title search returns nothing, so finding them would need an IL-alumni filter on non-founders.

**Result for the after top 50:**

| Annotation | Count | Who |
|---|---|---|
| likely | **25** | — |
| possible | **16** | — |
| unlikely | **9** | Pritish Jetley, Victor Shao, Sarthak Handa, Raymond Li, Ram Srinivasan, Apoorva Uppin Rajashekar, Dipro Ray, Hung Duong, Eden Hirschfield |

- **Who the 9 are:** IL-school alumni at Google / Amazon / Meta who do not live in Illinois and do not yet carry a founder title. They are surfaced by Stu's IL-school discovery. They are pre-founding, and whether any of them is building is unknown.
- **Net-new versus Harmonic: 9 of 50** clearly net-new; 16 more depend on whether the investor configured the matching Harmonic filter.
- **Already in Airtable:** 4 of the 50. Eshan Dosani is **Invested**, Vatsal Bhargava is Watching, Nikhil Reddy is Passed/Resident-Hold, and Aron Frishberg is Passed. The after list still contains the one ledger founder the fund invested in.
- **Honest read:** on this LinkedIn-sourced queue, Stu's top 50 is mostly a better-ordered version of what Harmonic would also show. The structural edge, pre-founding and pre-database founders, is real but small here: 9 of 50. Growing it depends on gaps 4, 11 and 12, plus the new Form D and GitHub paths, which this ledger cannot exercise. It has no GitHub URLs and no filings.

**Known false positive in the after list.** #50 is Jason Fried, Basecamp's founder (Chicago). His bio is too thin for the stage gate to see a 20-year-old company. That is gap 10 (headcount and maturity data) in one example.

### 4.6 What to check after merge (no deploy was done)

1. After deploy, `/api/health` shows the boot re-score. The first Monday scout's `nightly_scout` ledger line should read `rosters +N (…)`; until now that part never appeared on a scheduled run.
2. The `sec_filings` ledger row appears daily with `Form D leads +N of M`. If M is 0 for a week, EDGAR's search response shape differs from the fixture. Check `normalizeHit` against a live response (the sandbox couldn't).
3. If a ledger line shows `SCORING STOPPED`, raise the daily cap in Settings or wait. Nothing is lost: deferred candidates are not marked as seen.
4. `SOURCING_MAX_SCORED_PER_RUN` (default 80) is the cost dial for the revived query banks. At roughly 1–2¢ per scored candidate, 80 per run × 2 runs a week stays inside the $50/mo cap with room for Assess.
