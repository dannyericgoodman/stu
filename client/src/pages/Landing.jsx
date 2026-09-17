import { Link } from 'react-router-dom';
import StuLogo from '../components/StuLogo';

// ──────────────────────────────────────────────────────────────────────────
// Illustrative sample data for the product mock below. Obviously-sample
// names — this is a static illustration, not real founder data.
// ──────────────────────────────────────────────────────────────────────────
const inboxTiers = [
  {
    name: 'Must-meet',
    accent: '#2563EB',
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
    accent: '#6B7280',
    rows: [
      {
        name: 'Alan Turing',
        company: 'Enigma Systems',
        score: 81,
        chips: ['Z Fellows', 'ML research'],
        note: 'Published on efficient inference. Former lab lead, first-time founder.',
      },
    ],
  },
  {
    name: 'Watch',
    accent: '#9CA3AF',
    rows: [
      {
        name: 'Katherine Johnson',
        company: 'Orbital',
        score: 76,
        chips: ['Thiel Fellows', 'Chicago'],
        note: 'Built trajectory tooling now used by two launch providers.',
      },
    ],
  },
];

const stats = [
  { value: '2,700+', label: 'founder profiles sourced and scored' },
  { value: '307', label: 'opportunities tracked in pipeline' },
  { value: '10', label: 'scout signals, running nightly' },
];

const steps = [
  {
    n: '01',
    title: 'Connect your keys',
    body: 'Guided onboarding connects your API keys in minutes. Your keys, your data, your spend.',
  },
  {
    n: '02',
    title: 'Scouts run nightly',
    body: 'Stu sweeps YC, a16z Speedrun, Z Fellows, Thiel Fellows, GitHub builders and the open web while you sleep.',
  },
  {
    n: '03',
    title: 'Wake up to the inbox',
    body: 'A ranked list of founders with AI memos attached. Triage with t and x, move the real ones to pipeline.',
  },
];

const faqs = [
  {
    q: 'Who is this for?',
    a: 'Pre-seed, seed, and angel investors who run their own ground game. If your best deals come from work instead of warm intros, Stu is built for you.',
  },
  {
    q: 'Do I need my own API keys?',
    a: 'Yes. Stu runs on your keys for sourcing and AI — onboarding walks you through connecting them in minutes. API usage is billed to your own provider accounts, so your spend and your data stay entirely yours. We never pool keys across users.',
  },
  {
    q: 'Is my data separate from other investors?',
    a: 'Completely. Your workspace — founders, pipeline, assessments, keys — is fully isolated. Nobody else sees your sourcing, and you never see theirs.',
  },
  {
    q: 'What do the nightly scouts cover?',
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
          <div className="inbox-sub">Scored overnight · 4 new</div>
        </div>
        <div className="inbox-counts">
          <span className="inbox-count"><b>2</b> must-meet</span>
          <span className="inbox-count"><b>1</b> strong</span>
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
          --bg: #FBFBFA;
          --surface: #FFFFFF;
          --border: #E9E7E2;
          --text-primary: #1A1A1A;
          --text-secondary: #6E6E6E;
          --accent: #2563EB;
          --accent-soft: rgba(37, 99, 235, 0.08);
          background: var(--bg);
          color: var(--text-primary);
          min-height: 100vh;
          font-family: 'DM Sans', system-ui, sans-serif;
          overflow-x: hidden;
          -webkit-font-smoothing: antialiased;
        }
        .landing-page *::selection { background: rgba(37, 99, 235, 0.15); }
        .landing-page a { text-decoration: none; }

        .lp-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
        .lp-section { padding: 96px 0; }

        /* entrance */
        .landing-fade { opacity: 0; transform: translateY(20px); animation: landingReveal 0.6s ease forwards; }
        .landing-fade-d1 { animation-delay: 0.08s; }
        .landing-fade-d2 { animation-delay: 0.16s; }
        .landing-fade-d3 { animation-delay: 0.26s; }
        .landing-fade-d4 { animation-delay: 0.36s; }
        @keyframes landingReveal { to { opacity: 1; transform: translateY(0); } }

        /* sticky nav — one primary CTA always visible */
        .lp-nav {
          position: sticky; top: 0; z-index: 50;
          background: rgba(251, 251, 250, 0.88);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border-bottom: 1px solid var(--border);
        }
        .lp-nav-inner {
          display: flex; justify-content: space-between; align-items: center;
          max-width: 1120px; margin: 0 auto; padding: 14px 24px;
        }
        .lp-brand { display: flex; align-items: center; gap: 10px; }
        .lp-brand span { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; color: var(--text-primary); }
        .lp-nav-actions { display: flex; align-items: center; gap: 20px; }
        .lp-signin { color: var(--text-secondary); font-size: 14px; font-weight: 500; transition: color 0.15s ease; }
        .lp-signin:hover { color: var(--text-primary); }
        .lp-nav-cta {
          background: var(--text-primary); color: #fff;
          font-size: 14px; font-weight: 600; padding: 10px 20px; border-radius: 8px;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .lp-nav-cta:hover { background: #000; transform: translateY(-1px); }

        /* hero */
        .lp-hero { text-align: center; padding: 88px 24px 56px; }
        .lp-eyebrow {
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 13px; font-weight: 500; color: var(--text-secondary);
          border: 1px solid var(--border); border-radius: 999px;
          padding: 7px 16px; margin-bottom: 26px; background: var(--surface);
        }
        .lp-eyebrow .dot {
          width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .lp-h1 {
          font-size: clamp(38px, 5.6vw, 60px); font-weight: 700;
          letter-spacing: -0.04em; line-height: 1.06; margin: 0 0 20px;
        }
        .lp-sub {
          font-size: clamp(16px, 2vw, 18px); color: var(--text-secondary);
          line-height: 1.6; max-width: 600px; margin: 0 auto 36px;
        }
        .lp-ctas { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
        .lp-cta {
          display: inline-flex; align-items: center; gap: 8px;
          background: var(--accent); color: #fff; font-weight: 600; font-size: 15px;
          padding: 14px 30px; border-radius: 10px;
          transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
          box-shadow: 0 10px 28px rgba(37, 99, 235, 0.28);
        }
        .lp-cta:hover { background: #1D4ED8; transform: translateY(-1px); }
        /* ── inbox mock ── */
        .inbox-shell { max-width: 880px; margin: 0 auto; }
        .inbox-caption { text-align: center; font-size: 13px; color: var(--text-secondary); margin-top: 16px; }
        .inbox-mock {
          background: var(--surface);
          border: 1px solid var(--border); border-radius: 16px;
          overflow: hidden; text-align: left;
          box-shadow: 0 24px 70px rgba(26, 26, 26, 0.10), 0 2px 6px rgba(26, 26, 26, 0.06);
        }
        .inbox-chrome {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 16px; border-bottom: 1px solid var(--border);
          background: #F5F4F1;
        }
        .inbox-dots { display: flex; gap: 6px; }
        .inbox-dots span { width: 10px; height: 10px; border-radius: 50%; background: #D8D5CE; }
        .inbox-url {
          flex: 1; font-size: 12px; color: var(--text-secondary);
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 6px; padding: 5px 12px; max-width: 280px;
        }
        .inbox-badge {
          font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--text-secondary); border: 1px dashed var(--border);
          border-radius: 6px; padding: 4px 8px;
        }
        .inbox-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 20px 24px 14px; flex-wrap: wrap; gap: 12px;
        }
        .inbox-title { font-size: 17px; font-weight: 600; letter-spacing: -0.02em; }
        .inbox-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
        .inbox-counts { display: flex; gap: 8px; }
        .inbox-count {
          font-size: 12px; color: var(--text-secondary);
          background: #F5F4F1; border: 1px solid var(--border);
          border-radius: 999px; padding: 5px 12px;
        }
        .inbox-count b { color: var(--text-primary); font-weight: 600; }
        .inbox-body { padding: 4px 16px 8px; }
        .inbox-tier { margin-bottom: 12px; }
        .inbox-tier-label {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
          margin: 10px 8px 8px;
        }
        .inbox-tier-dot { width: 7px; height: 7px; border-radius: 50%; }
        .inbox-row {
          display: flex; gap: 16px; align-items: flex-start;
          background: #FAF9F7; border: 1px solid var(--border);
          border-radius: 12px; padding: 16px 18px; margin-bottom: 8px;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }
        .inbox-row:hover { border-color: rgba(37, 99, 235, 0.4); box-shadow: 0 4px 14px rgba(37, 99, 235, 0.08); }
        .inbox-score { min-width: 60px; }
        .inbox-score-num { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
        .inbox-score-bar { height: 4px; background: #E9E7E2; border-radius: 4px; margin-top: 6px; overflow: hidden; }
        .inbox-score-fill { height: 100%; background: linear-gradient(90deg, #1D4ED8, #60A5FA); border-radius: 4px; }
        .inbox-main { flex: 1; min-width: 0; }
        .inbox-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
        .inbox-company { font-weight: 400; color: var(--text-secondary); }
        .inbox-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
        .inbox-chip {
          font-size: 11px; font-weight: 500; color: #1D4ED8;
          background: var(--accent-soft); border: 1px solid rgba(37, 99, 235, 0.2);
          border-radius: 6px; padding: 3px 8px; white-space: nowrap;
        }
        .inbox-note { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
        .inbox-keys { display: flex; gap: 6px; padding-top: 2px; }
        .inbox-key {
          font-size: 11px; font-weight: 600; color: var(--text-secondary);
          border: 1px solid var(--border); border-radius: 6px;
          width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
          background: var(--surface); box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .inbox-foot {
          display: flex; gap: 20px; justify-content: center;
          padding: 13px; border-top: 1px solid var(--border);
          font-size: 12px; color: var(--text-secondary); background: #F5F4F1;
        }
        .inbox-foot b {
          display: inline-block; min-width: 18px; text-align: center;
          border: 1px solid var(--border); border-radius: 4px;
          padding: 1px 5px; margin-right: 5px; color: var(--text-primary); font-weight: 600;
          background: var(--surface);
        }

        /* stats band */
        .lp-stats { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface); }
        .lp-stats-grid {
          display: grid; grid-template-columns: repeat(4, 1fr);
          max-width: 1120px; margin: 0 auto; padding: 0 24px;
        }
        .lp-stat { padding: 36px 20px; text-align: center; border-left: 1px solid var(--border); }
        .lp-stat:first-child { border-left: none; }
        .lp-stat-value { font-size: 32px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 4px; }
        .lp-stat-label { font-size: 13px; color: var(--text-secondary); line-height: 1.45; }
        .lp-band-note {
          text-align: center; font-size: 12.5px; color: var(--text-secondary);
          max-width: 1120px; margin: 0 auto; padding: 16px 24px 0;
        }

        /* section headers */
        .lp-kicker {
          font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--accent); margin-bottom: 14px;
        }
        .lp-h2 {
          font-size: clamp(28px, 4vw, 40px); font-weight: 700;
          letter-spacing: -0.035em; line-height: 1.12; margin: 0 0 14px;
        }
        .lp-lede { font-size: 16.5px; color: var(--text-secondary); line-height: 1.6; max-width: 600px; margin: 0; }
        .lp-center { text-align: center; }
        .lp-center .lp-lede { margin: 0 auto; }

        /* how it works */
        .lp-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 48px; }
        .lp-step {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 14px; padding: 28px 26px;
        }
        .lp-step-n { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); margin-bottom: 14px; }
        .lp-step h3 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 8px; }
        .lp-step p { font-size: 14.5px; color: var(--text-secondary); line-height: 1.6; margin: 0; }

        /* faq */
        .lp-faq { max-width: 700px; margin: 40px auto 0; }
        .lp-faq-item {
          border: 1px solid var(--border); border-radius: 12px;
          margin-bottom: 10px; background: var(--surface); overflow: hidden;
        }
        .lp-faq-item summary {
          cursor: pointer; padding: 18px 22px; font-size: 15.5px; font-weight: 600;
          letter-spacing: -0.01em; list-style: none;
          display: flex; justify-content: space-between; align-items: center; gap: 16px;
        }
        .lp-faq-item summary::-webkit-details-marker { display: none; }
        .lp-faq-item summary .plus { color: var(--accent); font-size: 20px; font-weight: 400; flex-shrink: 0; transition: transform 0.2s ease; }
        .lp-faq-item[open] summary .plus { transform: rotate(45deg); }
        .lp-faq-item .lp-faq-a { padding: 0 22px 20px; font-size: 14.5px; color: var(--text-secondary); line-height: 1.65; }

        /* final cta */
        .lp-final { text-align: center; padding: 40px 24px 96px; }
        .lp-final h2 { font-size: clamp(26px, 3.6vw, 36px); font-weight: 700; letter-spacing: -0.03em; margin: 0 0 12px; }
        .lp-final p { font-size: 15.5px; color: var(--text-secondary); margin: 0 0 28px; }

        /* footer */
        .lp-footer { border-top: 1px solid var(--border); padding: 44px 0 36px; background: var(--surface); }
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
          .lp-stat { padding: 24px 14px; }
          .lp-stat:nth-child(3) { border-left: none; }
          .lp-stat-value { font-size: 26px; }
          .lp-steps { grid-template-columns: 1fr; }
          .lp-section { padding: 64px 0; }
          .lp-hero { padding: 64px 24px 40px; }
          .inbox-head { padding: 16px; }
          .inbox-body { padding: 4px 10px 8px; }
          .inbox-row { padding: 14px; gap: 12px; }
          .inbox-keys { display: none; }
          .inbox-foot { gap: 14px; font-size: 11px; }
          .lp-nav-cta { padding: 9px 16px; }
        }
      `}</style>

      {/* ── STICKY NAV ── */}
      <nav className="lp-nav">
        <div className="lp-nav-inner">
          <div className="lp-brand">
            <StuLogo size={28} />
            <span>Stu</span>
          </div>
          <div className="lp-nav-actions">
            <Link to="/login" className="lp-signin">Sign in</Link>
            <Link to="/signup" className="lp-nav-cta">Get access</Link>
          </div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="lp-hero">
        <div className="landing-fade landing-fade-d1">
          <span className="lp-eyebrow">
            <span className="dot" />
            Now open
          </span>
        </div>
        <h1 className="lp-h1 landing-fade landing-fade-d2">
          Wake up to a ranked inbox<br />of founders.
        </h1>
        <p className="lp-sub landing-fade landing-fade-d3">
          Stu watches the founder sources every night — YC, a16z Speedrun,
          Z&nbsp;Fellows, Thiel Fellows, GitHub builders and the open web. Every profile scored,
          tiered, and memo&rsquo;d before your first coffee.
        </p>
        <div className="lp-ctas landing-fade landing-fade-d4">
          <Link to="/signup" className="lp-cta">
            Get access
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      </section>

      {/* ── PRODUCT VISUAL ── */}
      <section style={{ padding: '16px 24px 96px' }}>
        <div className="inbox-shell landing-fade landing-fade-d4">
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
            <div className="lp-kicker">Why Stu</div>
            <h2 className="lp-h2">Built by an investor,<br />not a data vendor.</h2>
            <p className="lp-lede">
              The established platforms charge five figures a year. I built the version
              I wanted to use every morning — the nightly sweep, the ranked inbox, memos
              that show their work — and ran it daily for the better part of a year.
              Now it&rsquo;s yours.
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

      {/* ── FAQ ── */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <div className="lp-center landing-fade">
            <div className="lp-kicker">FAQ</div>
            <h2 className="lp-h2">Straight answers.</h2>
          </div>
          <div className="lp-faq">
            {faqs.map((f, i) => (
              <details key={f.q} className={`lp-faq-item landing-fade landing-fade-d${Math.min(i + 1, 4)}`}>
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

      {/* ── FINAL CTA ── */}
      <section className="lp-final">
        <div className="landing-fade">
          <h2>Your inbox could be full by tomorrow.</h2>
          <Link to="/signup" className="lp-cta">
            Get access
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
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
            <div className="lp-copy">© {new Date().getFullYear()} Stu. The AI sourcing OS for early-stage investors.</div>
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
