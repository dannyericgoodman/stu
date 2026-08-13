# Phase 0 — Assessment Rebuild: Map of What Exists

_Written 2026-08-13, before any code change. Pairs with `ASSESSMENT_REBUILD_PROMPT.md`._

## Verdict up front

The engine is intact and healthy. **This is a resurface + a panel swap, not a rebuild.** The
conviction engine, the honesty gate, quote verification, the orchestrator, the input plumbing, the
Read UI, the vault export, and even a **"Assess this company" button on every company card** all
exist and run. What's missing is (1) the *felt room of named investors*, (2) the *diligence agenda
bucketed by owner*, and (3) *data-room multi-file upload*.

---

## The spine (keep, build on — do not greenfield)

### `server/lib/conviction.js` — the deterministic decision. **KEEP AS-IS.**
- Evidence rungs 0–4 computed **from inputs, never the model** (`computeEvidenceRung`).
- Gate-then-differentiate: Earned Insight + Execution set the score; Nonconsensus + Talent move it ±1 only. Load-bearing pair must be scorable or there is **no score, just a question list**.
- Four bands: Anchor-grade ≥9 / Top-quartile ≥7 / Monitor ≥5 / Pass. Docks (bear, dead-market, flags) capped at −1.5. This is already Danny's invest/watch/pass.
- Inputs it needs (must preserve these feeds): `rubric.movements`, `rubric.flags`, `market.structurally_dead` + `market.kill_shot_risk`, `bear.bear_adjustment`.

### `server/routes/assessments.js` — the orchestrator (`runAssessmentAgents`, line 723).
- Order: **Founder Rubric runs first, alone** (it IS the score; isolated so it wins the rate-limit fight) → then **team / product / market / bear fan out in parallel** → `correctPillarScores` → `verifyAllAgents` → persist → `computeConviction` (in code, before synthesis) → `runSynthesis` (explains, cannot move the number).
- **The column landmine (3rd re-derivation in the file):** `founder_agent_output = Team`, `market_agent_output = Product`, `economics_agent_output = Market`, `bear_agent_output = Bear`. `pattern_agent_output` is written NULL (dead column). Same mapping repeated in `buildMemo7M`, `buildDefensibility` (assessments.js) and `mapAgentOutputs` (vaultSync.js). **Any drift silently corrupts the vault export;** `vault-sync.test.js` guards it.
- `runAgent` temp pinned **0**, retry wrapper, per-owner BYOK client.

### `server/agents/prompts.js` — the panel. Disciplined, honest, HOUSE-framed.
- `founderRubric` (scores 4 movements → the only LLM output that reaches conviction), `team`, `product`, `market` (already a **Gurley** lens, owns `structurally_dead`), `bear` (adversarial, owns `bear_adjustment`), `synthesis`, `meetingPrep`. `stewardOperator` = ARCHIVED (historical render only).
- Every prompt carries HOUSE + JSON_RULES + hard "never fabricate / abstain-instead-of-guess" rules. **This is the voice the nine lenses must match.**

### `server/agents/verify.js` — the honesty gate as mechanism, not prompt. **REUSE.**
- `buildContextIndex` → `classifyQuote` (verbatim / paraphrased-by-bigram-adjacency / unverified) + `unsupportedNumbers` (invented figures, mantissa-tolerant). Deterministic, no second LLM call. This is the "spirit" the brief says to reuse for grounding each lens's claims.
- `signals.js` applies the stricter card-side rule (drop `unverified`, don't badge).

### Conviction/run status columns (`opportunity_assessments`, `server/db.js:152`)
`conviction_score`, `conviction_band`, `conviction_output`, `evidence_rung`, `evidence_output`, `rubric_output`, `context_notes`, `assessment_type`, plus the four mis-named agent columns + `pattern_agent_output` (free/dead).

### Inputs (mostly plumbed)
- **Card path:** `ingest.js` (Exa URL / pdf-parse deck / Granola / notes, all honesty-gated) → `company_sources`/`company_signals` → **`POST /api/companies/:id/read`** (companySources.js:111) maps sources→inputs and kicks a run. Decks→decks, granola→transcripts, note→notes, url→notes(PUBLIC).
- **Intake path:** `Assess.jsx` form → `POST /api/assessments` → `deck-ingest.js` + `urlFetcher.js` (multi-page crawl w/ Exa fallback) → `assessment_inputs`.
- **New input needed (Phase 5):** data-room **multi-file bulk upload**.

### UI (routed, live)
- `/assess/:id` → **`Read.jsx`** (current view): Your Call | The Read; renders conviction score states, Defensibility, Movements, Docks, 7-M memo. **Does NOT render a depth-layer panel today** — this is where the nine lenses surface.
- `/assess/:id/full` → `AssessmentDetail.jsx` (legacy; renders old Team/Product/Market/Bear collapsibles).
- **`CompanyCard.jsx` already has "Assess this company"** → `/companies/:id/read` → navigates to `/assess/:id`. Nav link intentionally removed (assessment is something you do *to* a company).

### Vault export
- `vaultSync.js` is a **read channel** — Danny's local cron pulls JSON (`GET /api/vault-sync/assessments/:id`) and writes the `.md`. To export the panel + agenda, they must be added to that endpoint's JSON.

### Tests / models
- `node --test test/*.test.js`; run from `server/` with `DATABASE_PATH="$PWD/superior-os.db"`. Guardrails: `conviction.test.js`, `verify.test.js`, `assess-wiring.test.js`, `vault-sync.test.js`.
- `MODEL = 'claude-sonnet-4-6'` (single source; `feature` is only a metering label). BYOK via `anthropicFor(userId,'assessment')`; daily spend cap $25.

---

## What's stale / dead
- `pattern_agent_output` column — always NULL (retired 6-agent schema).
- `stewardOperator` prompt + `steward_operator_evaluations` table — archived, historical render only.
- `opportunity_assessments.inputs` TEXT blob coexists with normalized `assessment_inputs` — likely legacy.
- Two URL fetchers (ingest.js single-URL vs urlFetcher.js crawl) duplicate Exa logic — not a bug.
- Some header comments assert "installed and never used" for pdf-parse/cheerio — now false (both used).

---

## The build (phases)
- **1 Revive** — confirm the card→read→Read.jsx path end-to-end on a real deal.
- **2 Panel** — nine named lenses in `prompts.js`, shared schema `{applies, abstain_reason, verdict, read(cites sources), strengths[], risks[], questions[{q,owner,why}], confidence}`; wire into orchestrator; ground each with verify.js; preserve conviction feeds (rubric untouched; Gurley lens owns `structurally_dead`; Bear owns `bear_adjustment`).
- **3 Agenda** — dedupe + bucket questions by owner (Founder / SME / expert call / Desktop), each with why + good-vs-bad answer.
- **4 Decision & UI** — Read.jsx: lead with conviction+rung, render panel with visible abstentions + per-claim grounding, then agenda; add panel+agenda to vault JSON.
- **5 Inputs** — data-room multi-file bulk upload.
- **6 Verify & ship** — 2–3 real deals, eyeball honesty/abstention/grounding, deploy, confirm live.
