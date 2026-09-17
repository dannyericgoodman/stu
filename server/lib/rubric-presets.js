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
    extras: { drive_lens: true, yellow_flags: true },
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
    extras: { drive_lens: false, yellow_flags: true },
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
    extras: { drive_lens: false, yellow_flags: true },
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
    extras: { drive_lens: false, yellow_flags: true },
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
];

module.exports = { PRESETS };
