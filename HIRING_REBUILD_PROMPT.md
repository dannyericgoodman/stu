# Build: Stu's Hiring — help portfolio founders make first hires of top talent

You are working in **Stu**, Danny Goodman's personal VC workflow tool for **Superior Studios** (a ~$10M Chicago pre-seed fund). Repo: `~/Documents/Claude Workspace/superior-os/` — Node/Express + better-sqlite3 (`server/`), React/Vite (`client/`), deployed on Railway (a `git push origin main` deploys). Live at www.stu.vc.

Your job: **take a fresh pass at the Hiring product.** When a portfolio founder asks Danny "do you know anyone good for this role?", Danny should paste/upload the job description and Stu returns a **ranked shortlist of the best matches — warm network first, with a strong preference for Chicago/Illinois-tied builders** — that he can hand to the founder or make intros from. Roles are **linked to the portfolio company/founder** so Danny can see every role he's sourcing for a given portco (e.g. Hale, Perspectives Health) in one place.

**North star: mimic how a top-decile VC helps a portco founder make first hires — elegantly.** That means: fast, high-signal (a few great matches with a clear "why," not a resume dump), **warm intros over cold outreach**, tracked per company so nothing drops, and the VC *facilitates* — Stu never contacts anyone; Danny makes the intro.

**Read this whole document before writing code.** Then explore the existing code (Phase 0) before building.

---

## The most important facts about the current state

**1. A Talent wing already exists — and it's stale.** It's the "frozen since April" part of Stu. Read it, then decide what to keep vs. replace:
- Tables: `talent_candidates` (rich: name, `github_url`/`linkedin_url`, `location_city`/`location_state`, `tech_stack`, builder signals, scores for build-caliber/leap-readiness/domain-fit/**geography**, `role_function`), `talent_roles`, `talent_criteria`, `talent_matches`, `talent_portfolio_companies`, `talent_sourcing_runs`.
- Code: `server/pipeline/talent-engine.js`, `server/pipeline/match-engine.js`, `server/routes/talent.js`.
- Client: `client/src/pages/talent/*` (TalentHome, TalentCriteria, TalentPortfolio, TalentRoles, TalentRoleDetail…), `client/src/components/TalentLayout.jsx`. Routed under `/talent`; currently a **top-level nav item** (`client/src/components/Layout.jsx` line ~54).

**2. It predates — and should be rebuilt on — the new sourcing infrastructure.** Since April, a much stronger, hardened, honesty-gated builder-sourcing engine was built for founders. Finding "the best IL-tied builders matching a role" is the *same machinery*, and it's better than the April-era `match-engine.js`. **Reuse it; rip out the old scoring/match-engine:**
- `server/lib/ilTie.js` — verified Chicago/IL tie (living/lived/works/worked/**school in-state**). This is exactly Danny's geography preference, already battle-tested (it once caught 55/85 fabricated ties). Use it verbatim for the candidate IL-tie gate/boost.
- `server/pipeline/github-source.js` — GitHub-native IL builder discovery (location-filtered, ranked by real building activity). For hiring this is *even more* apt than for founders: find IL **engineers** by tech stack + location + activity, where the GitHub account *is* the person. Study `discoverGithubBuilders`, `assess`, and the name-consistency guards.
- `server/pipeline/github-activity.js` — `computeGithubSlope` (velocity/inflection) and the content-repo exclusions. A builder's slope is a strong "can they build" signal for a hire.
- `server/lib/builderSignals.js` — the "unicorn builder" signal taxonomy (just-departed, founding-team-at-a-factory, credentialed outlier, etc.), designed to power BOTH sourcing and **talent**.
- `server/lib/githubClient.js` — the shared rate-limit-backoff GitHub client. Use it for all GitHub calls.
- The honesty gates: `server/lib/signals.js`, `server/agents/verify.js` — verbatim-quote verification. Every "why this match" claim must be grounded, never invented.

**Phase 0 deliverable: a short written map — what the old Talent wing does, what runs, what's stale, and precisely which pieces you'll keep vs. replace with the new infra.**

---

## The product

### The workflow (make it dead simple)

Danny gets a role three ways: a **PDF**, a **link** (Greenhouse/Lever/Notion/company site), or he **describes it in a sentence or two**. All three must work.

1. **Ingest the JD** → parse to a structured role: title, function (eng/design/GTM/ops), seniority, must-have skills/stack, domain, location/remote policy. Reuse `server/lib/ingest.js` (PDF via pdf-parse, URL via Exa) — the same ingestion the company card uses. A described role can be parsed by a single LLM call (temperature 0, grounded — do not invent requirements the JD doesn't state; leave unknowns blank).
2. **Link the role to a portfolio company/founder.** Roles belong to a company in Danny's universe (the `founders` table is Stu's list of every company/founder; the invested set maps to Airtable *Superior Portfolio* `tblc2FECMK5wzFr8f`). Danny picks the portco when creating the role. He can then view **all roles for a given portco** (Hale, Perspectives Health, …) on that company's card and on a Hiring home.
3. **Match** → a ranked shortlist, **warm before cold** (see below), IL-tied builders preferred, each with a grounded role-fit rationale, an IL-tie receipt, and a jump-to-LinkedIn/GitHub.
4. **Track** → a lightweight per-candidate status on the role: `sourced → shortlisted → shared with founder → intro made → hired/passed`. This is the "am I actually helping?" loop a good VC keeps.
5. **Hand off** → export/share the shortlist for the founder. **Stu never emails a candidate.** Danny makes the intro. (Hard rule across Stu: agents never send anything externally; never write to Airtable; Dropbox is read-only.)

### Warm before cold — the VC's real edge

The best first-hire matches come from people Danny already knows. Rank in tiers:
- **Warm (highest signal):** Danny's Airtable **Talent Database** (`tblyt6dR0VIVuk5yg` — First/Last, LinkedIn, One-Line Bio, **Superior Connection**, **Function(s)**), **Master Contacts** (`tblN8XIy0s5oOqWAL`), and portfolio-network alumni. Base `appfE9DVrSUOrkkpu`. **Read-only** — pull these into Stu's candidate pool, never write back. Match the role against them first.
- **Cold (broaden the net):** IL-tied GitHub builders (GitHub-native discovery by function/stack + IL location) and the existing sourced pool. Only after the warm tier.

A warm candidate who fits should always outrank an equally-fitting cold one. Show *why they're warm* ("in your Talent DB — connection: introduced by X").

### Ranking (reuse, don't reinvent)

Compose the match score from: **role-fit** (function/stack/seniority/domain overlap with the parsed JD — grounded in the candidate's real signals), **IL tie** (via `ilTie.js` — a boost, or a hard filter if Danny sets "IL only"), **builder quality** (slope + builderSignals), and **warmth** (warm tier dominates). Every surfaced match shows a plain "why this match" that cites the actual evidence (their real stack, their real employer, their verified IL tie) — no fabrication; a gap is stated, not guessed.

### Placement & feel

- **Nav: rename "Talent" → "Hiring", nested UNDER "Assess"** in the left nav (`client/src/components/Layout.jsx`). Keep `/talent` routes working or migrate to `/hiring` cleanly.
- **Elegant, not busy:** the founder-facing experience of a great VC is *a few excellent, warm, well-explained matches, fast* — not a filterable database dump. Lead with the shortlist and the "why." One role → its shortlist → its status. A Hiring home listing open roles grouped by portco.

---

## Engineering discipline (this is why the codebase works — hold the line)

1. **Honesty over polish.** No fabricated candidates, skills, ties, or connections. Every match's rationale cites real evidence or flags the gap. A verified IL tie means `ilTie.verifyIlTie` returned true on real text — never a guess. Reuse the verbatim-verification spirit of `lib/signals.js` / `agents/verify.js`.
2. **Never contact anyone; never write to Airtable; Dropbox read-only.** Stu surfaces and Danny acts. Airtable Talent DB / Master Contacts are read-only sources.
3. **Verify against real behavior, not just tests.** After building, RUN it end-to-end on a real role for a real portco (use an actual portfolio company in the DB), read the shortlist yourself, and confirm: warm candidates surface and outrank cold; IL ties are real (spot-check 2-3 against LinkedIn/GitHub); every rationale is grounded; nobody is fabricated; role↔company linking works. Do not report "done" from green tests alone.
4. **Incremental, committed, deployed.** Small commits explaining WHY. `npm test` (from `server/`, `DATABASE_PATH="$PWD/superior-os.db"`) stays green. Deploy via `git push origin main`; verify live on www.stu.vc.
5. **The narrow-column trap** — when a reader needs a column, make sure the SQL SELECT includes it (this bit the sourcing build repeatedly).
6. **Don't break the sourcing or assessment surfaces.** The founder-sourcing engine (founderFit, github-source, github-resolve, the weekly builder-radar cron) was just completed and verified — reuse its libs, don't modify them. Assessment may be under active rebuild in parallel; stay in the Hiring/Talent files.
7. **Cost framing.** Hiring runs per-role, low-volume — LLM JD-parsing and match-explanation are fine (a few cents/role). But candidate *discovery* over GitHub is free (the shared client); don't LLM-score thousands of candidates. Match cheaply (signals + ilTie), explain with an LLM only for the shortlist. LLM keys are BYOK via `server/lib/providerKeys.js` (`anthropicFor(userId, feature)`), Exa/GitHub tokens likewise.
8. **Match the codebase's commenting style** — comments explain the *why* and the scars.

---

## Suggested build phases

- **Phase 0 — Map.** Read the old Talent wing + the new sourcing infra. Write the keep/replace plan. Try running the old talent flow to see what works.
- **Phase 1 — Role model + linking.** Roles ingested three ways (PDF/link/described) → structured role, linked to a `founders`/portco record. "All roles for a portco" views (Hiring home grouped by company; roles section on the company card).
- **Phase 2 — Warm pool.** Pull the Airtable Talent Database + Master Contacts (read-only) into Stu's candidate pool with their warmth/connection provenance. Wire the existing sourced/GitHub pool as the cold tier.
- **Phase 3 — Match engine (new).** Replace `match-engine.js` scoring with: role-fit + `ilTie` + slope/builderSignals + warmth. Warm-first ranking. Grounded per-match rationale (LLM only for the shortlist).
- **Phase 4 — Discovery.** For roles with too few warm matches, run GitHub-native IL-builder discovery by function/stack (reuse `github-source.js`) to broaden the cold tier.
- **Phase 5 — Tracking + handoff.** Per-candidate status on the role; a clean shareable shortlist export; jump-to-LinkedIn/GitHub. No external send.
- **Phase 6 — UI + nav.** "Hiring" under "Assess"; the elegant role → shortlist → status experience; grouped-by-portco home.
- **Phase 7 — Verify & ship.** Real role on a real portco, eyeball warmth/IL/grounding, deploy, confirm live.

---

## Definition of done

Danny pastes or uploads a JD, links it to a portco (Hale, Perspectives Health), and gets a **short, ranked shortlist of the best matches — warm network first, IL-tied builders preferred** — each with a grounded "why this match," a real IL-tie receipt, and a link, tracked per candidate, exportable to hand the founder. He can see **every role he's sourcing for each portco** in one place. **Zero fabricated candidates or ties. Stu never contacts anyone.** "Hiring" lives under "Assess" in the nav. Verified live on a real role, not just green tests.
