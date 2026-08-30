# Build: Stu's Opportunity Assessment — the "expert panel" investment evaluator

You are working in **Stu**, Danny Goodman's personal Harmonic/Affinity-style VC workflow tool for **Superior Studios** (a ~$10M Chicago pre-seed fund). Repo: `~/Documents/Claude Workspace/superior-os/` — Node/Express + better-sqlite3 backend (`server/`), React/Vite frontend (`client/`), deployed on Railway (a `git push origin main` deploys). Live at www.stu.vc.

Your job: **revive and rescope the Opportunity Assessment feature** so Danny can plug in a founder/company's inputs and get back a panel of distinct expert-investor opinions, a diligence agenda, and a methodical invest/watch/pass decision.

**Read this whole document before writing any code.** Then explore the existing code (Phase 0) before building.

---

## The most important fact: this mostly already exists

The assessment engine was **built and then fell off the product surface** during a sourcing rebuild — it was NOT deleted. Do not greenfield it. Read and build on:

- `server/agents/prompts.js` — the agent panel (Team, Product, Market [runs a Bill Gurley lens], **The Bear** = adversarial risk, **Founder Rubric** scorer, **Synthesis** agent, Steward-Operator overlay, Meeting Prep). Study the existing prompt style — it's disciplined and honest.
- `server/agents/runManager.js` — orchestrates the multi-agent run.
- `server/lib/conviction.js` — the **deterministic** conviction engine: evidence rungs (0–4), a GATE that never scores above what the evidence supports, and four bands (Anchor-grade → Top-quartile → Monitor → Pass). This is already Danny's invest/watch/pass. **Keep it. Do not replace it with an LLM score.**
- `server/routes/assessments.js` — the assessment endpoint; note the Team/Product/Market column-mapping (`founder_agent_output`=Team, `market_agent_output`=Product, `economics_agent_output`=Market — a real landmine; preserve the mapping and its comments).
- `server/lib/ingest.js` + `server/routes/companySources.js` + the `company_sources`/`company_signals` tables — the honesty-gated ingestion (deck via pdf-parse, URL via Exa, notes, Granola). Assessment inputs flow through here.
- `server/routes/vaultSync.js` — how assessments export to Danny's Obsidian vault.
- `client/src/pages/Assess.jsx`, `Read.jsx`, `AssessmentDetail.jsx` — the existing UI (routed at `/assess`, `/assess/:id`, `/assess/:id/full`). The nav link was intentionally removed (`client/src/components/Layout.jsx` says "Assess is reachable from a company card…").
- The Founder Rubric (canonical 4-movement framework) lives in Danny's Obsidian vault: `~/Documents/Claude Workspace/Brain/02 Frameworks/` — read the Founder Rubric and the Deal Operating System notes. The `deal` and `prep` skills also encode house standards.

**Deliverable of Phase 0: a short written map of what exists, what runs, and what's broken/stale — before you change anything.**

---

## The rescope (what Danny wants that's different)

### 1. A real expert *panel* of NAMED LENSES

Today the evaluators are functional (Team/Product/Market/Bear). Danny wants the felt experience of *a room of great investors weighing in*, with distinct, differentiated worldviews that sometimes **disagree** (disagreement is signal). Each lens weighs in on **team, product, and/or market**.

**Naming decision (locked): use NAMED LENSES, not the real people.** Label each voice as its lens *in the tradition of* the investor — e.g. **"The Monopoly Test (in the Thiel tradition)"** — never *"Peter Thiel says."* Rationale: putting fabricated opinions in a real person's mouth violates the honesty line this whole product holds; the lens is the reusable, sharper abstraction. Encode each investor's *actual investing philosophy* faithfully (research it in the prompt) so the lens is genuinely differentiated — but the output attributes to the LENS.

**The room (always the same panel):**

| Lens (tradition) | Primarily weighs on | The question it forces |
|---|---|---|
| The Monopoly / Secret test — *Thiel* | Product, Market | "What secret do they know? Is this 10x or 10%? Is there a path to monopoly?" |
| The Unit-Economics Skeptic — *Gurley* | Market | "Does the math work at scale, or is growth a subsidy? TAM honesty, competitive structure." |
| Founder Edge — *Rabois* | Team | "Why *this* founder? What's the unfair, earned edge? Barrels vs. ammunition." |
| Hard Problems & Execution — *Lonsdale* | Team, Product | "Is this a hard, real, defensible problem — and can they execute it against inertia?" |
| The Long Game & Risk — *Housel* | Team, Market | "What must be true for 10 years? What's the behavioral/temperament read? What quietly kills it?" |
| Deep-Tech Moat — *Josh Wolfe* | Product, Market | "Where's the technical/scientific edge and the 'directed evolution' toward an inevitable? Contrarian and right?" |
| Networks & Blitzscale — *Reid Hoffman* | Product, Market | "Are there network effects / a path to escape velocity? What breaks at scale?" |
| Inflection & Why-Now — *Mike Maples* | Market | "What non-obvious inflection makes this the right idea at the right time? Is this a 'thunder lizard' backing into a big shift?" |
| **The Bear** (keep as-is) | Risk | "Every material risk, attacked. No credit for narrative." |

**Always-same-room, with explicit abstention.** Run all lenses every time. BUT if a lens genuinely has **no useful perspective on this specific deal** (e.g., the Networks lens on a single-player deep-tech tool), it must **abstain and say so** — a one-line "sat this one out because ___" — rather than manufacture a generic take. Abstention is a first-class, honest output, not a failure. Never pad the room with empty opinions.

### 2. The honesty gate is the spine — this is non-negotiable

A persona panel is where hallucination risk is highest: pundits pontificate past the evidence. **Every claim a lens makes must be grounded in the provided inputs (cite the source: "deck slide 4", "founder call", "their site") OR explicitly flagged as an assumption/gap.** A gap does not become a confident assertion — **it becomes a research question.** The existing prompts already do this ("say you can't see it"; nulls → questions). Preserve and strengthen it. The conviction score stays **gated by evidence rung**: if the inputs are too thin to score honestly, there is **no score — just a question list.**

### 3. Research questions → a real diligence agenda, bucketed by owner

Today questions come out as flat lists. Restructure every question into a bucket by *who answers it*:
- **Founder follow-up** — ask in the next call.
- **SME / expert call** — needs a subject-matter expert.
- **Desktop research** — Danny or an analyst can find it.

Each question carries *why it matters* and *what a good vs. bad answer looks like*. The synthesis produces one deduped, prioritized agenda across all lenses. This is the actionable output Danny will actually use.

### 4. The decision: invest / watch / pass, methodically

Use the existing conviction engine's bands, surfaced plainly:
- **Anchor-grade** (highest conviction) → first call this week.
- **Top-quartile** → write a memo.
- **Monitor / Watch** → track the next data point.
- **Pass with respect.**
- **Not yet scorable** (evidence too thin) → the agenda IS the output.

Lead with the decision, then the panel, then the agenda. Show the evidence rung so Danny sees *how much the score can be trusted*.

### 5. Inputs & resurfacing

- **Inputs** (mostly plumbed already via `company_sources`): Danny's own notes, call notes / Granola, the deck (PDF), the website (Exa), LinkedIn, and a **data room** — the one real new input: support **multi-file bulk upload**.
- **Resurface as first-class**: a clear "Run assessment" entry from every company card, an inputs panel, and the panel + decision + agenda as the output — exportable to the Obsidian vault. Re-add a discoverable entry point (card CTA; nav is optional).

---

## Engineering discipline (this is why the codebase works — hold the line)

1. **Honesty over polish, always.** No fabricated facts, logos, metrics, or quotes. Every assessment claim cites its evidence or is flagged as a gap/question. A leaked memo must contain nothing Stu invented. This is Danny's #1 value — the entire codebase is built around a "no hallucinations, 100% honest" gate. Read `server/lib/signals.js` and `server/agents/verify.js` to see the verbatim-quote verification pattern and reuse its spirit.
2. **Verify against real behavior, not just tests.** After building, RUN a real assessment end-to-end on an actual deal in the DB (there are real founders with decks/notes/Granola — e.g. Cadrian AI, Permute), read the panel output yourself, and confirm: (a) every claim is grounded or flagged, (b) abstentions fire when appropriate, (c) the score respects the evidence rung, (d) the agenda is bucketed and useful. Screenshot / paste the real output. Do not report "done" from green tests alone.
3. **Incremental, committed, deployed.** Small commits with messages that explain WHY. `npm test` (from `server/`, with `DATABASE_PATH="$PWD/superior-os.db"`) must stay green. Deploy via `git push origin main`; verify live on www.stu.vc.
4. **Match the codebase's commenting style** — comments explain the *why* and the scars (e.g. the Team/Product/Market column mapping landmine). Write code that reads like the surrounding code.
5. **The narrow-column trap** — several bugs came from a SQL SELECT that omitted a column a downstream reader needed. When you widen what the assessment reads, make sure the query selects it.
6. **Don't break the sourcing engine.** A large GitHub-slope sourcing system was just completed and verified (founderFit, github-source, github-resolve, the weekly builder-radar cron). Do not touch it. Assessment is a separate surface.
7. **Cost framing (opposite of sourcing).** Sourcing runs over ~1,900 founders, so it was kept LLM-free. Assessment is **low-volume, high-value** — Danny runs it on a handful of serious deals. Use **strong models (Claude Opus/Sonnet, temperature 0 for grounded extraction)** for real analytical depth here; a few dollars per deal is the right spend. LLM keys are BYOK via `user_settings` (`server/lib/providerKeys.js`) — reuse the existing `anthropicFor(userId, feature)` pattern.
8. **Deterministic where it should be.** The conviction SCORE is deterministic (conviction.js), not an LLM guess. Keep it. The LLM produces grounded analysis and questions; the engine adjudicates the number.

---

## Suggested build phases

- **Phase 0 — Map.** Read the files above. Write a short map: what exists, what runs today (try running an assessment on a real founder), what's stale/broken, what the current panel + conviction + export actually produce. Confirm the plan against reality before changing anything.
- **Phase 1 — Revive.** Re-surface the existing engine from a company card, confirm end-to-end (inputs → panel → conviction → export) runs on a real deal. Fix whatever broke.
- **Phase 2 — The panel.** Expand the evaluators into the nine named lenses above (faithful, differentiated worldviews; grounded output; abstention supported). Keep the Bear + Founder Rubric + Synthesis. Define one shared per-lens output schema: `{ applies, abstain_reason, verdict, read (grounded, cites sources), strengths[], risks[], questions[{q, owner, why}], confidence }`.
- **Phase 3 — Diligence agenda.** Synthesis buckets/dedupes questions by owner (founder/SME/desktop), prioritized.
- **Phase 4 — Decision & UI.** Lead with the conviction decision + evidence rung; render the panel (with visible abstentions and per-claim grounding); show the agenda; export to vault. Make it feel like reading a room of sharp, honest experts.
- **Phase 5 — Inputs.** Data-room multi-file upload; confirm notes/deck/site/LinkedIn/Granola all flow in.
- **Phase 6 — Verify & ship.** Run on 2–3 real deals, eyeball for honesty/abstention/grounding, confirm the score gating, deploy, confirm live.

---

## Definition of done

Danny opens a company card, clicks "Run assessment," and gets: a clear **invest/watch/pass decision** with its conviction band and evidence rung; a **panel of nine named-lens opinions** on team/product/market (each grounded in his actual inputs, disagreeing where they should, abstaining honestly where a lens has nothing useful); and a **bucketed diligence agenda** (founder / SME / desktop) — all exportable to his Obsidian vault, with **zero fabricated claims**. Verified live on a real deal, not just green tests.
