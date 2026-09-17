// ══════════════════════════════════════════════════════════════════════════
// Assessment rubric presets — pure data, no requires (safe to load from db.js).
//
// A rubric is what an investor is ASSESSING — the dimensions they score, phrased
// as questions, with weights. The conviction engine (lib/conviction.js) does the
// arithmetic generically over any rubric's dimensions; the rubric agent prompt
// (agents/prompts.js buildRubricPrompt) is generated from the same data.
//
// Dimension fields:
//   key          stable slug — the wire key in the agent's JSON ("movements" map)
//   label        display name
//   question     THE BUILDER GUIDANCE: phrase dimensions as questions, not labels.
//                "What is the non-obvious insight?" forces judgment;
//                "Product: 8/10" invites box-ticking.
//   guidance     scoring guidance carried into the agent prompt — the tests, the
//                bars for high scores, and when to abstain (null) instead of guess.
//   weight       relative weight (load-bearing dimensions should carry ~50%+)
//   min_rung     evidence rung below which the dimension is not honestly scorable
//                0 none · 1 public (website) · 2 stated (deck) ·
//                3 observed (founder met) · 4 corroborated (multiple conversations)
//   load_bearing the gate: these dimensions SET the score, the rest differentiate
//                it ±1. Mark 1-3. If every load-bearing dimension is unscorable,
//                there is no conviction score — there is a question list.
//
// extras:
//   drive_lens   include the "chip on shoulder" read (a variance amplifier, not a
//                score) — Danny's instrument, off by default for others.
//   yellow_flags include the dock-on-evidence flags (charisma over substance,
//                grievance/grandiose) — on for all presets; a user can toggle off.
// ══════════════════════════════════════════════════════════════════════════

const PRESETS = [
  {
    preset_key: 'founder-preseed',
    name: 'Founder Rubric — Pre-seed',
    description:
      'When it goes sideways — not IF, but WHEN — will this founder see it early, adapt, and still win? ' +
      'Pre-seed is a bet on the founder\u2019s next 18 months of LEARNING, not today\u2019s snapshot.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: {
      // Danny's drive lens, lifted verbatim from the legacy Founder Rubric prompt.
      // Not a score — a read the agent carries across all dimensions.
      drive_lens: {
        title: 'Chip on shoulder',
        body:
          'Not a score. A read you carry across all dimensions. It is a VARIANCE AMPLIFIER, not a\n' +
          'quality filter — hold it honestly rather than treating it as a plus.\n' +
          '- PLUS: chip channeled into the WORK. "I\'ll show them by making the thing."\n' +
          '- FLAG: chip channeled into PEOPLE. Grievance, dominating, status-seeking. Predicts blowups and\n' +
          '  an inability to keep A-players.',
      },
      yellow_flags: [
        {
          key: 'charisma_over_substance',
          label: 'Charisma over substance',
          why: 'Storytelling outrunning substance. This predicts GETTING FUNDED, not winning. A great pitch with thin operating detail underneath is this flag. Note the trap: a polished deck is designed to trigger the opposite reaction in you. Dock it.',
          amount: 0.5,
        },
        {
          key: 'grievance_grandiosity',
          label: 'Grievance / grandiosity',
          why: 'The chip aimed at people rather than the work. Predicts blowups and an inability to keep A-players.',
          amount: 0.5,
        },
      ],
    },
    dimensions: [
      {
        key: 'earned_insight',
        label: 'Earned Insight',
        question: 'Did they live the problem, or did they research it?',
        guidance:
          'They lived the problem. Obsessed with the problem, not the solution. Discovered it from operating or lived ' +
          'exposure, not a market map — holds private knowledge a smart outsider could not get from reports. Outsider ' +
          'vantage counts: an outsider with a specific, non-obvious observation is not automatically weaker than an insider.\n' +
          'Tests: "How did you arrive at this problem?" · "What do smart people in this space still get wrong?"\n' +
          '8+ requires a specific piece of private knowledge you can point at — not "10 years in healthcare" but what ' +
          'those 10 years taught them that a smart outsider could not read. A founder who researched a space and spotted ' +
          'an opportunity but never lived the pain is a 6\u20137 at best, absent exceptional demonstrated customer empathy.\n' +
          'NULL if the materials never establish how they came to the problem. A website almost never does. ' +
          'Do not infer earned insight from a job title.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'execution_velocity',
        label: 'Execution & Learning Velocity',
        question: 'How fast do they move — and how fast do they update?',
        guidance:
          'The slope, not the intercept. Speed, resourcefulness, decisiveness under ambiguity. Ships imperfect things ' +
          'and learns from real feedback. Holds conviction on the thesis, genuinely open on tactics. ' +
          'NAMES THEIR OWN GAPS UNPROMPTED.\n' +
          'Tests: "Fastest you\u2019ve shipped something real?" · "What did you do with $1k and two weeks?" · ' +
          'push back hard and watch — rigid defense vs. instant capitulation vs. a genuinely new thought · ' +
          '"What did you believe 6 months ago that you no longer believe?"\n' +
          'The learning half is the unfakeable signal and it is only visible in conversation. If you have shipping ' +
          'evidence but no evidence of updating, say so in the evidence field and score conservatively — do not average ' +
          'the two into a confident middle.\n' +
          'NULL if you have neither shipping evidence nor any read on how they update.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'nonconsensus_vision',
        label: 'Nonconsensus Vision & Market POV',
        question: 'What\u2019s the non-obvious thing they believe — and what changed to make now the moment?',
        guidance:
          'A distinct, arguably-wrong thesis — and a clear view of how the market changes. A specific contrarian secret ' +
          'they believe deeply, tied to a real WHY-NOW / inflection. Walks the IDEA MAZE: why prior attempts failed, ' +
          'why incumbents can\u2019t, what is structurally different now. Score the QUALITY OF THEIR MARKET THINKING, ' +
          'not today\u2019s market — great founders navigate and pivot into the right market.\n' +
          'Tests: "What important truth do very few people agree with you on?" (Thiel) · ' +
          '"What changed in the world that makes this possible now?" (Maples) · "Where is this market in 5 years, and why?"\n' +
          'CRITICAL — a claimed secret is not a secret. "AI will replace [incumbent workflow]" is the most consensus ' +
          'statement in the market right now; thousands of companies say it. If their thesis is something most of their ' +
          'competitors would also assert, that is a 4\u20135 no matter how confidently delivered. A real 8+ is a belief ' +
          'that would make a smart person in the category argue with them.\n' +
          'This is the ONE dimension a deck or a website can partially evidence, because they assert their thesis in public. ' +
          'The quality of the idea-maze walk still needs a conversation.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'talent_magnetism',
        label: 'Talent Magnetism',
        question: 'Can they get great people to bet on them before there\u2019s proof?',
        guidance:
          'Recruits people better than themselves, below market, pre-traction. Early co-conspirators — a movement, ' +
          'not just a product. A co-founder re-up — someone who worked with them before, has full information about ' +
          'their strengths and weaknesses, and CHOSE to do it again — is among the strongest available signals.\n' +
          'Tests: "Who committed before there was evidence, and why?" · "Who have you recruited who shouldn\u2019t have said yes?"\n' +
          'NULL if you cannot see who joined and why. A team page with headshots is not evidence of magnetism — ' +
          'it tells you people work there, not why they came.',
        weight: 2,
        min_rung: 3,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'deep-tech',
    name: 'Deep Tech',
    description:
      'Can it be built, can it be defended, and is this the team to build it? ' +
      'In deep tech, market timing is secondary to the technical question — diligence starts with physics, not TAM.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'paper_breakthrough',
          label: 'A breakthrough on paper',
          why: 'The physics works in a lab and the economics never will — no path from demonstration to manufactured cost. Ask what it costs at scale, not whether it is possible.',
          amount: 0.5,
        },
        {
          key: 'no_one_ships',
          label: 'No one who ships',
          why: 'Brilliant researchers, nobody who has ever shipped a product on a deadline. Research excellence predicts papers, not companies.',
          amount: 0.5,
        },
        {
          key: 'grant_forever',
          label: 'A grant proposal, not a company',
          why: 'Progress measured in grants won and papers published, with no commercial milestone in sight. Grants fund research; they do not create urgency.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'technical_feasibility',
        label: 'Technical Risk & Feasibility',
        question: 'What has to be true technically — and what\u2019s already been de-risked?',
        guidance:
          'Separate engineering risk ("can anyone build this?") from execution risk ("can this team ship it?"). ' +
          'Look for technical artifacts: prototypes, published results, benchmarks, technical milestones hit on schedule. ' +
          'A beautiful deck with no technical artifact is a 5 at best. Name the single hardest technical unknown explicitly — ' +
          'if you can\u2019t name it, you haven\u2019t done the diligence.\n' +
          'NULL if the materials contain no technical substance to judge (pure vision decks).',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'founder_technical_depth',
        label: 'Founder Technical Depth',
        question: 'Is this the person who can solve the hard technical problems?',
        guidance:
          'Deep tech is won by people who have lived inside the problem technically — research background, prior ' +
          'technical achievements, publications or patents that matter, years in the specific discipline. A brilliant ' +
          'generalist CEO with hired-gun scientists is a real pattern but a weaker one: score the technical core of the ' +
          'team, not the pitch.\n' +
          'NULL if you have no read on the technical caliber of the people doing the work.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'defensibility',
        label: 'Defensibility Path',
        question: 'What compounds — IP, physics, data, talent density?',
        guidance:
          'Defensibility in deep tech comes from things that are hard to replicate: granted patents (filed is weaker), ' +
          'trade secrets embedded in process, performance advantages rooted in physics rather than features, or a talent ' +
          'cluster competitors can\u2019t reassemble. "First mover" is not defensibility.\n' +
          'NULL if the materials never address why a well-funded incumbent couldn\u2019t replicate this.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'why_now',
        label: 'Why Now',
        question: 'What changed in the world that makes this possible now?',
        guidance:
          'The enabling inflection: a cost curve that bent, a new capability (compute, models, materials, instruments), ' +
          'a platform shift. "We had the idea" is not a why-now. The best answers point at something that was impossible ' +
          'or uneconomical 3 years ago and inevitable today.\n' +
          'NULL only if timing is genuinely irrelevant to the thesis (rare — say so explicitly).',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'market_structure',
        label: 'Market Size & Structure',
        question: 'Who pays, and is the market real?',
        guidance:
          'Secondary to "can it be built" but the market must exist. Who is the buyer, what budget does this come from, ' +
          'and what do they pay for the status quo? Be skeptical of TAM slides built by multiplying two large numbers.\n' +
          'NULL if the materials never identify a buyer.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'commercialization_path',
        label: 'Path to Commercialization',
        question: 'How does this reach customers?',
        guidance:
          'Pilot partners, design partners, channel strategy, regulatory path if applicable. At pre-seed you\u2019re scoring ' +
          'whether they\u2019ve thought seriously about the path — named partners and a credible sequence beat a generic ' +
          '"land and expand" slide.\n' +
          'NULL if commercialization is entirely unaddressed.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'fintech',
    name: 'Fintech',
    description:
      'Can they navigate the regulation, reach the customer, and make the unit economics work? ' +
      'In fintech, distribution partnerships matter as much as product — "who lets you reach the customer" is a diligence question, not a GTM footnote.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'compliance_later',
          label: '“We will figure out compliance later”',
          why: 'A team moving money with no counsel, no license path, and no BSA/AML posture. In fintech this is not a risk, it is a shutdown notice.',
          amount: 0.5,
        },
        {
          key: 'partner_theater',
          label: 'Partnership theater',
          why: 'A logo slide of banks and networks with no signed agreement and no economic terms. An LOI is not distribution.',
          amount: 0.5,
        },
        {
          key: 'borrowed_spread',
          label: 'A spread that is not theirs',
          why: 'Unit economics built on interchange, float, or a regulatory arbitrage that reprices against them. If the margin depends on someone else’s pricing, it is not a margin.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'regulatory_path',
        label: 'Regulatory Path & Risk',
        question: 'What\u2019s the regulatory path — and what kills this?',
        guidance:
          'Licenses needed vs. partner-bank / sponsor-bank dependency, money-transmitter exposure, BSA/AML posture. ' +
          'A regulatory dead-end is a VETO, not a low score — surface it as one. "We\u2019ll figure out compliance later" ' +
          'from a team moving money is a 3.\n' +
          'NULL if the materials never address regulation in a regulated wedge (that absence is itself a finding — say so).',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'distribution',
        label: 'Distribution & Partnerships',
        question: 'Who lets them reach the customer?',
        guidance:
          'Fintech distribution is partnerships: sponsor banks, networks, employers, platforms, embedded channels. ' +
          'Score signed or credibly in-progress partnerships over "partnership strategy" slides. A direct-to-consumer ' +
          'fintech plan with no acquisition edge and no partner is a 4.\n' +
          'NULL if distribution is entirely unaddressed.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'economics_edge',
        label: 'Unit Economics / Underwriting Edge',
        question: 'Where\u2019s the durable economic advantage?',
        guidance:
          'Underwriting data edge, cost advantage (automated vs. manual), pricing power, interchange or float dynamics. ' +
          'Fintech dies on unit economics more often than on product — look for evidence they\u2019ve modeled the per-unit ' +
          'truth, not just the growth story.\n' +
          'NULL if the materials contain no economic substance.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'founder_market_fit',
        label: 'Founder-Market Fit',
        question: 'Why do THESE people win THIS market?',
        guidance:
          'Domain depth in financial services, regulatory relationships, distribution relationships, lived experience of ' +
          'the problem. Fintech rewards insiders more than most categories — an outsider needs a specific, credible ' +
          'theory of their edge.\n' +
          'NULL if the materials never establish why this team for this wedge.',
        weight: 2,
        min_rung: 3,
        load_bearing: false,
      },
      {
        key: 'why_now',
        label: 'Why Now',
        question: 'What changed — regulation, infrastructure, or consumer behavior?',
        guidance:
          'Fintech why-nows are often regulatory (open banking, new charters) or infrastructural (new rails, embedded ' +
          'finance APIs, stablecoins). Name the specific change. "Consumers want better banking" is not a why-now.\n' +
          'NULL only if timing is genuinely irrelevant (rare — say so explicitly).',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'defensibility',
        label: 'Defensibility',
        question: 'What compounds — licenses, data, network, switching costs?',
        guidance:
          'Banking licenses and regulatory moats are real but slow; data network effects in underwriting/fraud compound ' +
          'faster. Switching costs in financial workflows are high once embedded. Score what actually accumulates with scale.\n' +
          'NULL if moat is unaddressed.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'consumer',
    name: 'Consumer',
    description:
      'Will people love it, tell their friends, and keep coming back? ' +
      'Consumer is won on loops and retention — acquisition without retention is a leak, not a business.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'paid_leak',
          label: 'Paying for a leak',
          why: 'Growth bought with paid acquisition while retention is flat or unmeasured. Acquisition without retention is a leak, not a business.',
          amount: 0.5,
        },
        {
          key: 'viral_handwave',
          label: '“It will go viral”',
          why: 'No loop, no mechanism — just a hope that people share. If you cannot name what gets shared and why, there is no viral loop.',
          amount: 0.5,
        },
        {
          key: 'engagement_theater',
          label: 'Engagement theater',
          why: 'Metrics that flatter — registered users, downloads, page views — with no cohort retention underneath. Ask for D30 of a real cohort.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'growth_retention',
        label: 'Growth Loops & Retention',
        question: 'What makes this grow — and what makes people stay?',
        guidance:
          'Loops, not funnels: does usage itself create distribution (invites, sharing, UGC, network invites)? And the ' +
          'retention truth: what brings someone back on day 30 unprompted? At pre-seed you\u2019re scoring the LOOP DESIGN ' +
          'and early retention signals, not scale metrics. A paid-acquisition plan with no loop and no retention story is a 4.\n' +
          'NULL if the materials never address how users come back.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'product_instinct',
        label: 'Founder Product Instinct',
        question: 'Does this team have consumer taste?',
        guidance:
          'Consumer instincts: craft, speed of iteration on user feedback, opinionated product choices, evidence they ' +
          'use and obsess over consumer products. Look at what they\u2019ve shipped before and how they talk about users — ' +
          'specifics ("our D7 went from 12% to 31% when we changed X") over adjectives ("delightful").\n' +
          'NULL if you have no read on the team\u2019s product sensibility.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'network_effects',
        label: 'Network Effects Potential',
        question: 'Does the product get better with more users?',
        guidance:
          'The USV lens: large networks of engaged users, differentiated through user experience, defensible through ' +
          'network effects. Score the MECHANISM (marketplace liquidity, social graph density, data flywheel), not the ' +
          'claim. Most consumer pitches claim network effects; few have a mechanism.\n' +
          'NULL if the product has no plausible network mechanism (fine — say so; not every consumer company needs one).',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'why_now',
        label: 'Why Now',
        question: 'What behavior or platform shift makes this the moment?',
        guidance:
          'Consumer why-nows are behavior or platform shifts: a new device surface, a demographic coming of age, a ' +
          'behavior that tipped (short video, AI companions, live shopping). Name the shift and why incumbents are ' +
          'slow to it.\n' +
          'NULL only if timing is genuinely irrelevant (rare — say so explicitly).',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'velocity',
        label: 'Execution Velocity',
        question: 'How fast do they ship and learn?',
        guidance:
          'Consumer is the fastest-learning category — weekly iteration is table stakes. Evidence: shipping cadence, ' +
          'experiments run, speed from feedback to change. A team that spent 9 months in stealth on a consumer app ' +
          'without user contact is a 4.\n' +
          'NULL if you have no shipping or iteration evidence.',
        weight: 2,
        min_rung: 3,
        load_bearing: false,
      },
      {
        key: 'monetization_path',
        label: 'Path to Monetization',
        question: 'How does love become revenue?',
        guidance:
          'You don\u2019t need the answer at pre-seed — you need evidence they\u2019ve thought about it seriously. ' +
          'Subscriptions, marketplace take rate, advertising (needs scale — be skeptical early), premium tiers. ' +
          '"We\u2019ll figure out monetization after scale" with no hypothesis is a 4.\n' +
          'NULL if monetization is entirely unaddressed.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'applied-ai',
    name: 'Applied AI',
    description:
      'Most AI startups are a demo and a prayer. This asks whether the system does real work end-to-end, ' +
      'whether it gets smarter with every customer, and what happens when the base model gets better. ' +
      'The model is not the moat — the workflow is.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'demo_magic',
          label: 'Demo magic',
          why: 'The pitch runs on a scripted golden path — perfect inputs, no errors, no real users. Ask to see it fail. If there is no live product with real usage behind the demo, dock it.',
          amount: 0.5,
        },
        {
          key: 'prompt_in_a_deck',
          label: 'A prompt in a pitch deck',
          why: 'The entire company is a system prompt over someone else’s model — no workflow, no data, no distribution. The next model release is an extinction event.',
          amount: 0.5,
        },
        {
          key: 'logo_farming',
          label: 'Design partners with no usage',
          why: 'A logo slide of ‘design partners’ where nobody runs the thing weekly. Partnership theater predicts a pipeline full of maybes.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'owns_workflow',
        label: 'Owns the Workflow',
        question: 'What job does the AI actually do end-to-end — and who gets fired if it works?',
        guidance:
          'A copilot that drafts is not an agent that completes. Score the loop the system owns: trigger, action, verification, and what happens when it is wrong. ‘A human reviews everything’ means the human still does the job — that is a 5 ceiling. Tests: ‘Walk me through the last 10 runs — how many needed a human to fix them?’ ‘What does the system do when it is uncertain?’ NULL if there is no working product, only a demo — a scripted golden path is not evidence of autonomy.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'evals_edge',
        label: 'Evals & the Data Flywheel',
        question: 'How do they know it works — and does the system get better with every customer?',
        guidance:
          'In applied AI, evals are the moat: the team that measures quality best improves fastest. Look for an eval harness, not vibes — graded tasks, a failure taxonomy, regression sets. The compounding question: does usage generate labels, corrections, or traces that make the next version better? Tests: ‘Show me the eval.’ ‘What did the 100th customer teach the system that the 10th did not?’ NULL if quality is asserted but never measured — ‘it just works’ is not an eval.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'model_risk',
        label: 'Model Dependency',
        question: 'What happens to this company when the base model gets 10x better or 10x cheaper?',
        guidance:
          'Every applied AI company rents its core capability from a lab. Score what is durable when the model improves: workflow integration, proprietary data, distribution, switching costs. If the entire product is a prompt the next model release absorbs, that is a 3. Tests: ‘Which model release would kill you?’ ‘What do you own that the labs cannot ship in six months?’ NULL only if the product does not depend on foundation models at all — say so explicitly.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'distribution',
        label: 'Distribution',
        question: 'How do they reach the user — and why do they win that slot?',
        guidance:
          'AI features are being bundled into every platform; the winner owns the workflow surface. Score an actual path: embedded in tools people already open, a channel with leverage, or a wedge user who brings the team. ‘PLG’ with no motion behind it is a 4. Tests: ‘Where does the user meet this product on day one?’ ‘Who else is fighting for that same slot?’ NULL if distribution is unaddressed.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'unit_economics',
        label: 'Token Economics',
        question: 'Does the token math work?',
        guidance:
          'Inference is a COGS line that scales with usage — the opposite of software margins. Score whether they have done the per-task math: cost per run versus price per run, and what happens at 10x volume. A great demo that loses money on every heavy user is a 4. Tests: ‘What does one task cost you in tokens?’ ‘Who is your most expensive user?’ NULL if there is no pricing and no cost model — but note the absence.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'why_now',
        label: 'Why Now',
        question: 'Why is this buildable now and not 18 months ago?',
        guidance:
          'The honest answer is almost always a capability or cost curve: reasoning, tool use, long context, agents that do not fall over. ‘AI is hot’ is not a why-now. Score specificity — the capability, the release, the price point that unlocked it. NULL only if timing is genuinely irrelevant (rare).',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'b2b-saas',
    name: 'B2B SaaS / Workflow',
    description:
      'At pre-seed, B2B is founder-led sales into a painful problem. This asks whether the pain has a budget ' +
      'behind it, whether this founder can sell, and whether the wedge opens into something bigger. ' +
      'No pain, no purchase order, no company.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'feature_not_product',
          label: 'A feature, not a product',
          why: 'One integration away from being a checkbox in someone else’s suite. If the whole company is a feature request for the incumbent platform, dock it.',
          amount: 0.5,
        },
        {
          key: 'champion_no_budget',
          label: 'A champion who cannot buy',
          why: 'Enthusiastic users, zero economic buyers. Love from people without budget predicts a pipeline that never closes.',
          amount: 0.5,
        },
        {
          key: 'pilot_purgatory',
          label: 'Pilots that never convert',
          why: '‘Strong interest’ and free pilots with no paid conversion, no timeline, no decision-maker. A pilot without a paid next step is a hobby.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'pain_budget',
        label: 'Pain with a Budget',
        question: 'Whose painful problem is this — and whose budget fixes it?',
        guidance:
          'Vitamins die in procurement. Score the pain: who feels it weekly, what it costs them today, and whether the economic buyer has a budget line for it. The user and the buyer are often different people — if the founder cannot name the buyer, that is a 4. Tests: ‘What do they do today, and what does it cost?’ ‘Whose budget does this come from?’ ‘What got cut last quarter — and why was not it this?’ NULL if the materials never identify who pays.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'founder_sales',
        label: 'Founder-Led Sales',
        question: 'Can this founder sell — and have they started?',
        guidance:
          'Pre-seed B2B lives or dies on founder-led sales. Score evidence, not confidence: customer conversations per week, pilots signed, LOIs, paid pilots, prior sales experience. A founder who ‘does not like sales’ at pre-seed B2B is a 4. Tests: ‘How many customer conversations last week?’ ‘What is in the pipeline, and what is the next step on each?’ ‘Tell me about a deal you lost.’ NULL if there is no sales motion at all — that absence is the finding.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'wedge_expansion',
        label: 'Wedge & Expansion',
        question: 'What is the wedge — and what does it open?',
        guidance:
          'The wedge is the thin edge: one painful workflow, one team, one use case that gets you in the door. Score whether the wedge is real (a buyer will pay for the thin thing alone) and whether it expands — land-and-expand motion, a multi-product path, bigger budgets upstairs. A wedge that is actually just a small TAM is a 4. Tests: ‘Why do they buy the thin version?’ ‘What do you sell them in year two?’ NULL if there is no wedge thesis, just a platform vision.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'stickiness',
        label: 'Stickiness',
        question: 'Once it is in, why does it not get ripped out?',
        guidance:
          'B2B retention comes from workflow embedding, data accumulation, integrations, and multi-user adoption — not contracts alone. Score what accumulates: the longer they use it, the harder it is to leave. A tool one person uses lightly is a 4. Tests: ‘What breaks if they cancel?’ ‘How many people touch it daily?’ NULL if stickiness is unaddressed.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'ship_velocity',
        label: 'Ship Velocity',
        question: 'How fast do they turn customer asks into shipped product?',
        guidance:
          'B2B product-market fit is built in the room with customers. Score cadence: how fast feedback becomes product, and whether the founder is personally in the feedback loop. A roadmap built without customers is a 4. Tests: ‘What did a customer ask for last month, and when did it ship?’ NULL if there is no shipping evidence.',
        weight: 2,
        min_rung: 3,
        load_bearing: false,
      },
      {
        key: 'buying_friction',
        label: 'Buying Friction',
        question: 'How many people have to say yes?',
        guidance:
          'Buying committees kill startups slowly. Score the path to ‘yes’: single buyer versus committee, security review burden, procurement cycles. A product needing six sign-offs and a SOC 2 at pre-seed is a long road — price that in. Tests: ‘Who signs, and how long did the last one take?’ NULL if the buying process is unaddressed.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'marketplace',
    name: 'Marketplace',
    description:
      'Marketplaces live or die on liquidity — everything else is commentary. This asks how supply gets on and ' +
      'stays on, whether the transaction happens often enough to matter, and what stops both sides from going around you.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'bypass_built_in',
          label: 'Built to be bypassed',
          why: 'Both sides have every incentive to take the relationship off-platform after the first match, and nothing in the product stops them. The platform taxes a transaction it does not control.',
          amount: 0.5,
        },
        {
          key: 'fake_supply',
          label: 'Supply that is not really supply',
          why: 'Scraped listings, non-exclusive inventory, or ‘partners’ who will not actually transact. Liquidity theater — count the suppliers who would notice if you shut down tomorrow.',
          amount: 0.5,
        },
        {
          key: 'both_sides_at_once',
          label: '“We will launch both sides at once”',
          why: 'No sequenced plan for the cold start — just a launch date and hope. Marketplaces are sequenced or they are dead.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'supply_liquidity',
        label: 'Supply & Liquidity',
        question: 'How does supply get on — and what keeps it here?',
        guidance:
          'The cold start is the whole game. Score the supply acquisition playbook: is it repeatable, or does it depend on the founder’s personal network forever? And retention — why does supply stay: earnings, tools, demand? A marketplace with a demand-side story and no supply plan is a 4. Tests: ‘Walk me through the first 100 suppliers.’ ‘What does a supplier earn here versus their next best option?’ NULL if supply acquisition is hand-waved.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'transaction_profile',
        label: 'Transaction Frequency & Value',
        question: 'How often does the transaction happen — and how much is each one worth?',
        guidance:
          'Frequency times take rate equals the business. High-frequency, low-value needs enormous liquidity; low-frequency, high-value needs trust and a take rate that justifies CAC. Score whether the math works: transactions per user per year, and what the platform keeps. A beautiful marketplace for something people buy twice a decade is a 4. Tests: ‘How often does a user transact?’ ‘What do you keep per transaction?’ NULL if the transaction economics are unaddressed.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'trust_mechanism',
        label: 'Trust Between Strangers',
        question: 'How do strangers trust each other enough to transact?',
        guidance:
          'Every marketplace is a trust business wearing a tech costume. Score the mechanism — reviews that actually correlate with quality, guarantees, insurance, escrow, identity — not the claim of trust. ‘We will have ratings’ is a 4. Tests: ‘What happens when a transaction goes bad?’ ‘How do you bootstrap trust on day one?’ NULL if trust is unaddressed.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'disintermediation',
        label: 'Disintermediation Risk',
        question: 'What stops both sides from going around you?',
        guidance:
          'If the platform’s job is introduction, the platform gets cut out. Score what keeps the transaction on-platform: ongoing value (scheduling, payments, discovery, guarantees), contracts, or workflow embedding. A pure lead-gen marketplace with no hold on the transaction is a 4. Tests: ‘Why does not the second transaction happen over text?’ NULL if this is unaddressed — the absence is the finding.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'density_playbook',
        label: 'Density Playbook',
        question: 'What is the geographic or category sequencing?',
        guidance:
          'Liquidity is local or categorical — you win zip code by zip code or niche by niche. Score whether they have a sequencing plan: first market, what ‘liquidity’ means there in numbers, and the trigger to expand. ‘Launch nationally’ at pre-seed is a 4. Tests: ‘What does liquidity look like in market one, in numbers?’ NULL if there is no sequencing.',
        weight: 1,
        min_rung: 2,
        load_bearing: false,
      },
    ],
  },

  {
    preset_key: 'devtools',
    name: 'Dev Tools & Infra',
    description:
      'Developers choose tools; companies pay for them. This asks whether developers genuinely love it, whether it is ' +
      'meaningfully better on the thing they measure, and how free usage turns into revenue. In devtools, taste is distribution.',
    scoring: 'gate',
    gate_threshold: 6,
    extras: { yellow_flags: [
        {
          key: 'star_farming',
          label: 'Stars without users',
          why: 'GitHub stars from launch-day hype with dead issues, no external PRs, and no sustained usage. Stars are marketing; contributors are traction.',
          amount: 0.5,
        },
        {
          key: 'science_project',
          label: 'A science project, not a product',
          why: 'Technically impressive, solves no workflow pain anyone will pay to fix. Admiration from engineers is not demand.',
          amount: 0.5,
        },
        {
          key: 'platform_hostage',
          label: 'One API change away from death',
          why: 'The entire product depends on a single platform’s API, marketplace, or roadmap goodwill. The platform is a landlord, not a partner.',
          amount: 0.25,
        },
      ] },
    dimensions: [
      {
        key: 'developer_love',
        label: 'Developer Love',
        question: 'Do developers genuinely love using this?',
        guidance:
          'Taste is the distribution channel in devtools. Score real affection: community activity, issues and PRs from non-employees, word-of-mouth, people building on it unprompted. Stars alone are gameable — a star spike from a launch post with dead issues is a 5. Tests: ‘Show me someone using this who you did not recruit.’ ‘What do developers complain about?’ NULL if there is no community or usage evidence at all.',
        weight: 3,
        min_rung: 3,
        load_bearing: true,
      },
      {
        key: 'technical_edge',
        label: '10x Technical Edge',
        question: 'Is it 10x better on the thing developers actually measure?',
        guidance:
          'Developers switch tools for order-of-magnitude wins on their own benchmarks: latency, throughput, time saved, lines deleted. Score the number, not the adjective — ‘blazing fast’ without a benchmark is a 4. Twenty percent better does not move anyone. Tests: ‘What is the benchmark, and who ran it?’ ‘What does the developer stop doing because this exists?’ NULL if the advantage is asserted but never measured.',
        weight: 3,
        min_rung: 2,
        load_bearing: true,
      },
      {
        key: 'bottom_up_motion',
        label: 'Bottom-Up Motion',
        question: 'Can it spread without a sales call?',
        guidance:
          'Devtools win bottom-up: one developer tries it, the team adopts it, the company pays. Score the motion — self-serve signup, time-to-first-value in minutes, docs that sell. A devtool that needs an enterprise sales cycle to get its first ten users is a 4. Tests: ‘How long from signup to first value?’ ‘How did your last five users find you?’ NULL if go-to-market is unaddressed.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'monetization_path',
        label: 'Path to Revenue',
        question: 'How does free usage become paid revenue?',
        guidance:
          'The open-source-to-revenue question, or the free-tier-to-paid question. Score whether they have thought seriously about the conversion: what is free forever, what triggers payment (seats, usage, features, support), and who has paid for comparable tools before. ‘We will figure out monetization later’ with no hypothesis is a 4. Tests: ‘What makes a team start paying?’ ‘Who pays for the comparable tool today?’ NULL if monetization is entirely unaddressed.',
        weight: 2,
        min_rung: 2,
        load_bearing: false,
      },
      {
        key: 'founder_cred',
        label: 'Founder Credibility',
        question: 'Has this team earned developers’ trust before?',
        guidance:
          'Devtools is a credibility market — maintainership, prior infra work, open-source reputation, or deep scars from the problem. Score earned trust, not resumes: what have they built that developers used? A team with no visible standing in the community they sell to starts at a disadvantage. Tests: ‘What have you built that developers used?’ NULL if you have no read on their standing.',
        weight: 1,
        min_rung: 3,
        load_bearing: false,
      },
    ],
  },
];

module.exports = { PRESETS };
