import { Link } from 'react-router-dom';
import StuLogo from '../components/StuLogo';

// ──────────────────────────────────────────────────────────────────────────
// Illustrative sample data for the product mock below. Obviously-sample
// names — this is a static illustration, not real founder data.
// ──────────────────────────────────────────────────────────────────────────
const inboxTiers = [
  {
    name: 'Must-meet',
    accent: '#3B82F6',
    rows: [
      {
        name: 'Ada Lovelace',
        company: 'Protocol Labs',
        score: 94,
        chips: ['YC S26', 'Ex-Stripe', 'Chicago'],
        note: 'Shipped distributed storage at planetary scale. Second-time founder.',
      },
      {
        name: 'Grace Hopper',
        company: 'Compiler Co',
        score: 88,
        chips: ['a16z Speedrun', 'OSS maintainer'],
        note: 'Author of a compiler toolchain with 40k GitHub stars.',
      },
    ],
  },
  {
    name: 'Strong',
    accent: '#8A8A9B',
    rows: [
      {
        name: 'Alan Turing',
        company: 'Enigma Systems',
        score: 81,
        chips: ['Z Fellows', 'ML research'],
        note: 'Published on efficient inference. Former lab lead, first-time founder.',
      },
      {
        name: 'Katherine Johnson',
        company: 'Orbital',
        score: 76,
        chips: ['Thiel Fellows', 'Chicago'],
        note: 'Built trajectory tooling now used by two launch providers.',
      },
    ],
  },
  {
    name: 'Watch',
    accent: '#5A5A6B',
    rows: [
      {
        name: 'Radia Perlman',
        company: 'Meshnet',
        score: 72,
        chips: ['GitHub builders'],
        note: 'Prolific protocol contributor. Early, worth tracking.',
      },
    ],
  },
];

const stats = [
  { value: '2,700+', label: 'founder profiles sourced and scored' },
  { value: '307', label: 'opportunities tracked in pipeline' },
  { value: '10', label: 'scout signals, running every night' },
  { value: '10', label: 'founding seats, total' },
];

const steps = [
  {
    n: '01',
    title: 'Bring your own keys',
    body: 'Connect your API keys during onboarding with guided setup. Your keys, your data, your spend — Stu runs on infrastructure you control.',
  },
  {
    n: '02',
    title: 'Nightly AI scout',
    body: 'While you sleep, Stu sweeps YC, a16z Speedrun, Z Fellows, Thiel Fellows, Emergent, The Residency, GitHub builders and the open web — then scores and tiers every founder by morning.',
  },
  {
    n: '03',
    title: 'Triage & assess',
    body: 'Work a keyboard-driven inbox, read structured AI memos on every prospect, and move the real ones into a pipeline built for pre-seed.',
  },
];

const pricingIncludes = [
  'The full sourcing OS — inbox, pipeline, assessments',
  'Nightly scout sweeps running on your own API keys',
  'AI founder memos and structured evaluations',
  'Keyboard-driven triage built for speed',
  'Guided onboarding and setup',
];

const faqs = [
  {
    q: 'Who is this for?',
    a: 'Pre-seed and angel investors who source outside their personal network — people who want a systematic top of funnel without hiring a team of analysts. If your best deals come from work, not warm intros, Stu is built for you.',
  },
  {
    q: 'Do I need my own API keys?',
    a: 'Yes. Stu runs on your keys for sourcing and AI, and onboarding walks you through connecting them in a few minutes. That keeps your data, your spend, and your control entirely yours — we never pool keys across users.',
  },
  {
    q: 'What happens after the 10 founding seats are claimed?',
    a: 'Founding pricing closes permanently. Founding members keep full access at the founding price — a single $349 payment, never a subscription.',
  },
  {
    q: 'Is my data separate from other investors?',
    a: 'Completely. Your workspace — founders, pipeline, assessments, keys — is fully isolated per user. Nobody else sees your sourcing, and you never see theirs.',
  },
  {
    q: 'What do the nightly scouts actually cover?',
    a: 'YC, a16z Speedrun, Z Fellows, Thiel Fellows, Emergent, The Residency, GitHub builders, Illinois schools and companies, and the open web. Every profile is AI-scored and tiered before it hits your inbox.',
  },
];

function InboxMock() {
  return (
    <div className="inbox-mock" aria-hidden="true">
      {/* browser chrome */}
      <div className="inbox-chrome">
        <div className="inbox-dots">
          <span /><span /><span />
        </div>
        <div className="inbox-url">stu.vc/sourcing</div>
        <div className="inbox-badge">sample</div>
      </div>

      {/* inbox header */}
      <div className="inbox-head">
        <div>
          <div className="inbox-title">Source inbox</div>
          <div className="inbox-sub">Scored overnight · 5 new</div>
        </div>
        <div className="inbox-counts">
          <span className="inbox-count"><b>2</b> must-meet</span>
          <span className="inbox-count"><b>2</b> strong</span>
          <span className="inbox-count"><b>1</b> watch</span>
        </div>
      </div>

      {/* tiered rows */}
      <div className="inbox-body">
        {inboxTiers.map(tier => (
          <div key={tier.name} className="inbox-tier">
            <div className="inbox-tier-label" style={{ color: tier.accent }}>
              <span className="inbox-tier-dot" style={{ background: tier.accent }} />
              {tier.name}
            </div>
            {tier.rows.map(r => (
              <div key={r.name} className="inbox-row">
                <div className="inbox-score">
                  <span className="inbox-score-num">{r.score}</span>
                  <div className="inbox-score-bar">
                    <div className="inbox-score-fill" style={{ width: `${r.score}%` }} />
                  </div>
                </div>
                <div className="inbox-main">
                  <div className="inbox-name">
                    {r.name} <span className="inbox-company">— {r.company}</span>
                  </div>
                  <div className="inbox-chips">
                    {r.chips.map(c => (
                      <span key={c} className="inbox-chip">{c}</span>
                    ))}
                  </div>
                  <div className="inbox-note">{r.note}</div>
                </div>
                <div className="inbox-keys">
                  <span className="inbox-key">t</span>
                  <span className="inbox-key">x</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* keyboard footer */}
      <div className="inbox-foot">
        <span><b>t</b> add to pipeline</span>
        <span><b>x</b> pass</span>
        <span><b>↑↓</b> navigate</span>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="landing-page">
      <style>{`
        .landing-page {
          --bg: #0D0D10;
          --surface: #16161C;
          --surface-2: #1B1B23;
          --border: #23232D;
          --text-primary: #F0F0F3;
          --text-secondary: #8A8A9B;
          --accent: #3B82F6;
          --accent-soft: rgba(59, 130, 246, 0.12);
          background: var(--bg);
          color: var(--text-primary);
          min-height: 100vh;
          font-family: 'DM Sans', system-ui, sans-serif;
          overflow-x: hidden;
          -webkit-font-smoothing: antialiased;
        }
        .landing-page *::selection { background: rgba(59, 130, 246, 0.25); }
        .landing-page a { text-decoration: none; }

        .lp-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
        .lp-section { padding: 110px 0; position: relative; }

        /* entrance */
        .landing-fade { opacity: 0; transform: translateY(24px); animation: landingReveal 0.7s ease forwards; }
        .landing-fade-d1 { animation-delay: 0.08s; }
        .landing-fade-d2 { animation-delay: 0.18s; }
        .landing-fade-d3 { animation-delay: 0.3s; }
        .landing-fade-d4 { animation-delay: 0.42s; }
        .landing-fade-d5 { animation-delay: 0.54s; }
        @keyframes landingReveal { to { opacity: 1; transform: translateY(0); } }

        /* nav */
        .lp-nav {
          display: flex; justify-content: space-between; align-items: center;
          max-width: 1120px; margin: 0 auto; padding: 22px 24px 0;
        }
        .lp-brand { display: flex; align-items: center; gap: 10px; }
        .lp-brand span { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
        .lp-signin {
          color: var(--text-secondary); font-size: 14px; font-weight: 500;
          transition: color 0.15s ease;
        }
        .lp-signin:hover { color: var(--text-primary); }

        /* hero */
        .lp-hero { text-align: center; padding: 110px 24px 70px; position: relative; }
        .lp-hero::before {
          content: ''; position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(600px 300px at 50% -60px, rgba(59,130,246,0.14), transparent 70%),
            radial-gradient(400px 200px at 85% 40%, rgba(59,130,246,0.05), transparent 70%);
        }
        .lp-eyebrow {
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 13px; font-weight: 500; color: var(--text-secondary);
          border: 1px solid var(--border); border-radius: 999px;
          padding: 7px 16px; margin-bottom: 28px; background: rgba(22,22,28,0.6);
        }
        .lp-eyebrow .dot {
          width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .lp-h1 {
          font-size: clamp(40px, 6vw, 68px); font-weight: 700;
          letter-spacing: -0.04em; line-height: 1.04; margin: 0 0 22px;
        }
        .lp-sub {
          font-size: clamp(16px, 2.2vw, 19px); color: var(--text-secondary);
          line-height: 1.65; max-width: 640px; margin: 0 auto 42px;
        }
        .lp-ctas { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; position: relative; }
        .lp-cta {
          display: inline-flex; align-items: center; gap: 8px;
          background: var(--accent); color: #fff; font-weight: 600; font-size: 15px;
          padding: 14px 30px; border-radius: 10px;
          transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
          box-shadow: 0 8px 30px rgba(59,130,246,0.25);
        }
        .lp-cta:hover { background: #2563EB; transform: translateY(-1px); }
        .lp-cta-ghost {
          display: inline-flex; align-items: center; gap: 8px;
          background: transparent; border: 1px solid var(--border);
          color: var(--text-secondary); font-weight: 500; font-size: 15px;
          padding: 14px 30px; border-radius: 10px; transition: all 0.2s ease;
        }
        .lp-cta-ghost:hover { border-color: rgba(59,130,246,0.4); color: var(--text-primary); }

        /* ── inbox mock ── */
        .inbox-shell { max-width: 880px; margin: 0 auto; position: relative; }
        .inbox-shell::before {
          content: ''; position: absolute; inset: -40px -60px; pointer-events: none;
          background: radial-gradient(500px 260px at 50% 0%, rgba(59,130,246,0.10), transparent 70%);
        }
        .inbox-caption {
          text-align: center; font-size: 13px; color: var(--text-secondary);
          margin-top: 18px;
        }
        .inbox-mock {
          position: relative; background: var(--surface);
          border: 1px solid var(--border); border-radius: 16px;
          overflow: hidden; text-align: left;
          box-shadow: 0 30px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset;
        }
        .inbox-chrome {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 16px; border-bottom: 1px solid var(--border);
          background: rgba(0,0,0,0.25);
        }
        .inbox-dots { display: flex; gap: 6px; }
        .inbox-dots span { width: 10px; height: 10px; border-radius: 50%; background: #3A3A46; }
        .inbox-dots span:first-child { background: #4A4A58; }
        .inbox-url {
          flex: 1; font-size: 12px; color: var(--text-secondary);
          background: rgba(0,0,0,0.3); border: 1px solid var(--border);
          border-radius: 6px; padding: 5px 12px; max-width: 280px;
        }
        .inbox-badge {
          font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--text-secondary); border: 1px dashed var(--border);
          border-radius: 6px; padding: 4px 8px;
        }
        .inbox-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 20px 24px 16px; flex-wrap: wrap; gap: 12px;
        }
        .inbox-title { font-size: 17px; font-weight: 600; letter-spacing: -0.02em; }
        .inbox-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
        .inbox-counts { display: flex; gap: 8px; }
        .inbox-count {
          font-size: 12px; color: var(--text-secondary);
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 999px; padding: 5px 12px;
        }
        .inbox-count b { color: var(--text-primary); font-weight: 600; }
        .inbox-body { padding: 4px 16px 8px; }
        .inbox-tier { margin-bottom: 14px; }
        .inbox-tier-label {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
          margin: 10px 8px 8px;
        }
        .inbox-tier-dot { width: 7px; height: 7px; border-radius: 50%; }
        .inbox-row {
          display: flex; gap: 16px; align-items: flex-start;
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 12px; padding: 16px 18px; margin-bottom: 8px;
          transition: border-color 0.2s ease;
        }
        .inbox-row:hover { border-color: rgba(59,130,246,0.35); }
        .inbox-score { min-width: 64px; }
        .inbox-score-num { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
        .inbox-score-bar { height: 4px; background: #2A2A36; border-radius: 4px; margin-top: 6px; overflow: hidden; }
        .inbox-score-fill { height: 100%; background: linear-gradient(90deg, #2563EB, #60A5FA); border-radius: 4px; }
        .inbox-main { flex: 1; min-width: 0; }
        .inbox-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
        .inbox-company { font-weight: 400; color: var(--text-secondary); }
        .inbox-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
        .inbox-chip {
          font-size: 11px; font-weight: 500; color: #9DB9E8;
          background: var(--accent-soft); border: 1px solid rgba(59,130,246,0.25);
          border-radius: 6px; padding: 3px 8px; white-space: nowrap;
        }
        .inbox-note { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
        .inbox-keys { display: flex; gap: 6px; padding-top: 2px; }
        .inbox-key {
          font-size: 11px; font-weight: 600; color: var(--text-secondary);
          border: 1px solid var(--border); border-radius: 6px;
          width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,0.25);
        }
        .inbox-foot {
          display: flex; gap: 20px; justify-content: center;
          padding: 14px; border-top: 1px solid var(--border);
          font-size: 12px; color: var(--text-secondary); background: rgba(0,0,0,0.2);
        }
        .inbox-foot b {
          display: inline-block; min-width: 18px; text-align: center;
          border: 1px solid var(--border); border-radius: 4px;
          padding: 1px 5px; margin-right: 5px; color: var(--text-primary); font-weight: 600;
          background: rgba(255,255,255,0.03);
        }

        /* stats band */
        .lp-stats {
          border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
          background: rgba(22,22,28,0.5);
        }
        .lp-stats-grid {
          display: grid; grid-template-columns: repeat(4, 1fr);
          max-width: 1120px; margin: 0 auto; padding: 0 24px;
        }
        .lp-stat { padding: 40px 24px; text-align: center; border-left: 1px solid var(--border); }
        .lp-stat:first-child { border-left: none; }
        .lp-stat-value { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 6px; }
        .lp-stat-label { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
        .lp-band-note {
          text-align: center; font-size: 13px; color: var(--text-secondary);
          max-width: 1120px; margin: 0 auto; padding: 18px 24px 0;
        }

        /* section headers */
        .lp-kicker {
          font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--accent); margin-bottom: 16px;
        }
        .lp-h2 {
          font-size: clamp(28px, 4vw, 42px); font-weight: 700;
          letter-spacing: -0.035em; line-height: 1.1; margin: 0 0 16px;
        }
        .lp-lede { font-size: 17px; color: var(--text-secondary); line-height: 1.65; max-width: 620px; margin: 0; }
        .lp-center { text-align: center; }
        .lp-center .lp-lede { margin: 0 auto; }

        /* how it works */
        .lp-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 56px; }
        .lp-step {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 16px; padding: 32px 28px;
        }
        .lp-step-n {
          font-size: 13px; font-weight: 700; letter-spacing: 0.1em;
          color: var(--accent); margin-bottom: 18px;
        }
        .lp-step h3 { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 10px; }
        .lp-step p { font-size: 14.5px; color: var(--text-secondary); line-height: 1.65; margin: 0; }

        /* pricing */
        .lp-price-card {
          max-width: 560px; margin: 56px auto 0;
          background: linear-gradient(180deg, rgba(59,130,246,0.08), rgba(59,130,246,0.02));
          border: 1px solid rgba(59,130,246,0.35); border-radius: 20px;
          padding: 48px 44px; text-align: center; position: relative;
          box-shadow: 0 24px 70px rgba(59,130,246,0.12);
        }
        .lp-price-flag {
          position: absolute; top: -14px; left: 50%; transform: translateX(-50%);
          background: var(--accent); color: #fff; font-size: 12px; font-weight: 600;
          letter-spacing: 0.06em; text-transform: uppercase;
          padding: 6px 16px; border-radius: 999px; white-space: nowrap;
        }
        .lp-price-name { font-size: 15px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; }
        .lp-price { font-size: 56px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; }
        .lp-price-once { font-size: 14px; color: var(--text-secondary); margin-top: 10px; }
        .lp-price-once b { color: var(--text-primary); font-weight: 600; }
        .lp-price-list { list-style: none; margin: 32px 0; padding: 0; text-align: left; }
        .lp-price-list li {
          display: flex; gap: 12px; align-items: flex-start;
          font-size: 15px; color: var(--text-primary); padding: 9px 0;
          border-bottom: 1px solid rgba(35,35,45,0.6);
        }
        .lp-price-list li:last-child { border-bottom: none; }
        .lp-check { color: var(--accent); flex-shrink: 0; margin-top: 2px; }
        .lp-seats-note { font-size: 13px; color: var(--text-secondary); margin-top: 20px; line-height: 1.6; }

        /* faq */
        .lp-faq { max-width: 720px; margin: 48px auto 0; }
        .lp-faq-item {
          border: 1px solid var(--border); border-radius: 12px;
          margin-bottom: 12px; background: var(--surface); overflow: hidden;
        }
        .lp-faq-item summary {
          cursor: pointer; padding: 20px 24px; font-size: 16px; font-weight: 600;
          letter-spacing: -0.01em; list-style: none;
          display: flex; justify-content: space-between; align-items: center; gap: 16px;
        }
        .lp-faq-item summary::-webkit-details-marker { display: none; }
        .lp-faq-item summary .plus { color: var(--accent); font-size: 20px; font-weight: 400; flex-shrink: 0; transition: transform 0.2s ease; }
        .lp-faq-item[open] summary .plus { transform: rotate(45deg); }
        .lp-faq-item .lp-faq-a { padding: 0 24px 22px; font-size: 15px; color: var(--text-secondary); line-height: 1.7; }

        /* footer */
        .lp-footer { border-top: 1px solid var(--border); padding: 48px 0 40px; }
        .lp-footer-inner {
          max-width: 1120px; margin: 0 auto; padding: 0 24px;
          display: flex; justify-content: space-between; align-items: flex-start;
          flex-wrap: wrap; gap: 24px;
        }
        .lp-footer-links { display: flex; gap: 24px; }
        .lp-footer-links a { font-size: 14px; color: var(--text-secondary); transition: color 0.15s ease; }
        .lp-footer-links a:hover { color: var(--text-primary); }
        .lp-copy { font-size: 13px; color: var(--text-secondary); margin-top: 8px; }

        @media (max-width: 860px) {
          .lp-stats-grid { grid-template-columns: repeat(2, 1fr); }
          .lp-stat { padding: 28px 16px; }
          .lp-stat:nth-child(3) { border-left: none; }
          .lp-stat-value { font-size: 28px; }
          .lp-steps { grid-template-columns: 1fr; }
          .lp-section { padding: 72px 0; }
          .lp-hero { padding: 72px 24px 48px; }
          .inbox-head { padding: 16px; }
          .inbox-body { padding: 4px 10px 8px; }
          .inbox-row { padding: 14px; gap: 12px; }
          .inbox-keys { display: none; }
          .inbox-foot { gap: 14px; font-size: 11px; }
          .lp-price-card { padding: 40px 28px; }
        }
      `}</style>

      {/* ── NAV ── */}
      <nav className="lp-nav landing-fade">
        <div className="lp-brand">
          <StuLogo size={28} />
          <span>Stu</span>
        </div>
        <Link to="/login" className="lp-signin">Sign in</Link>
      </nav>

      {/* ── HERO ── */}
      <section className="lp-hero">
        <div className="landing-fade landing-fade-d1">
          <span className="lp-eyebrow">
            <span className="dot" />
            Founding seats now open — 10 available
          </span>
        </div>
        <h1 className="lp-h1 landing-fade landing-fade-d2">
          The AI sourcing OS<br />for pre-seed investors.
        </h1>
        <p className="lp-sub landing-fade landing-fade-d3">
          Stu runs nightly AI scout sweeps across YC, a16z Speedrun, Z&nbsp;Fellows,
          Thiel Fellows, Emergent, The Residency, GitHub builders and the open web —
          then scores every founder, tiers your inbox, and drafts the memo before
          your first coffee.
        </p>
        <div className="lp-ctas landing-fade landing-fade-d4">
          <Link to="/signup" className="lp-cta">
            Claim a founding seat
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <Link to="/login" className="lp-cta-ghost">Sign in</Link>
        </div>
      </section>

      {/* ── PRODUCT VISUAL ── */}
      <section style={{ padding: '20px 24px 110px' }}>
        <div className="inbox-shell landing-fade landing-fade-d5">
          <InboxMock />
          <div className="inbox-caption">
            Illustrative sample — your inbox fills overnight with real founders from your scouts.
          </div>
        </div>
      </section>

      {/* ── STATS BAND ── */}
      <section className="lp-stats">
        <div className="lp-band-note landing-fade">
          The engine behind Stu, by the numbers — real figures from the system it was built on.
        </div>
        <div className="lp-stats-grid">
          {stats.map((s, i) => (
            <div key={s.label} className={`lp-stat landing-fade landing-fade-d${i + 1}`}>
              <div className="lp-stat-value">{s.value}</div>
              <div className="lp-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="lp-section">
        <div className="lp-wrap">
          <div className="landing-fade">
            <div className="lp-kicker">How it works</div>
            <h2 className="lp-h2">Set it up once.<br />Wake up to deal flow.</h2>
            <p className="lp-lede">
              No analysts, no scrapers to babysit, no tabs open at midnight.
              Three steps and the machine runs itself.
            </p>
          </div>
          <div className="lp-steps">
            {steps.map((s, i) => (
              <div key={s.n} className={`lp-step landing-fade landing-fade-d${i + 2}`}>
                <div className="lp-step-n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <div className="lp-center landing-fade">
            <div className="lp-kicker">Pricing</div>
            <h2 className="lp-h2">One seat. One payment.<br />Yours for good.</h2>
            <p className="lp-lede">
              Founding members get the full product at the founding price —
              a single payment, not a subscription.
            </p>
          </div>
          <div className="lp-price-card landing-fade landing-fade-d2">
            <div className="lp-price-flag">Founding seat</div>
            <div className="lp-price-name">Stu — full sourcing OS</div>
            <div className="lp-price">$349</div>
            <div className="lp-price-once">
              <b>One-time payment.</b> Not a subscription — you pay once, you keep access.
            </div>
            <ul className="lp-price-list">
              {pricingIncludes.map(item => (
                <li key={item}>
                  <svg className="lp-check" width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path d="M3.5 9.5L7.5 13.5L14.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
            <Link to="/signup" className="lp-cta" style={{ width: '100%', justifyContent: 'center' }}>
              Claim your seat
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <div className="lp-seats-note">
              10 founding seats, total. When they're claimed, founding pricing closes permanently.
              No countdown timers — just a real cap.
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <div className="lp-center landing-fade">
            <div className="lp-kicker">FAQ</div>
            <h2 className="lp-h2">Straight answers.</h2>
          </div>
          <div className="lp-faq">
            {faqs.map((f, i) => (
              <details key={f.q} className={`lp-faq-item landing-fade landing-fade-d${Math.min(i + 1, 5)}`}>
                <summary>
                  {f.q}
                  <span className="plus">+</span>
                </summary>
                <div className="lp-faq-a">{f.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div>
            <div className="lp-brand" style={{ marginBottom: 4 }}>
              <StuLogo size={20} />
              <span style={{ fontSize: 15 }}>Stu</span>
            </div>
            <div className="lp-copy">© {new Date().getFullYear()} Stu. The AI sourcing OS for pre-seed investors.</div>
          </div>
          <div className="lp-footer-links">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/login">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
