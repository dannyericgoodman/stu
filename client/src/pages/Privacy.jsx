import { Link } from 'react-router-dom';
import StuLogo from '../components/StuLogo';

const sections = [
  {
    h: 'What we collect',
    p: 'Account information (your name and email), the contents of your workspace (sourced founders, pipeline entries, notes, assessments), the API keys you choose to connect (encrypted at rest), and basic payment records via Stripe. We also keep minimal technical logs needed to operate the service.',
  },
  {
    h: 'What we never do',
    p: 'We never sell your personal data. Your API keys are used only to run your workspace against the providers you configured — they are never pooled across users and never leave your workspace except to call those providers on your behalf. Your workspace contents are never shown to other users.',
  },
  {
    h: 'Payments',
    p: 'Checkout and billing are handled by Stripe. Your card details go directly to Stripe under their privacy policy — we never see or store card numbers, and only keep records of completed purchases.',
  },
  {
    h: 'Cookies and sessions',
    p: 'We use the minimum needed to keep you signed in and the product working: an authentication session and basic preferences. No advertising trackers, no third-party analytics beacons.',
  },
  {
    h: 'Data retention and deletion',
    p: 'Your workspace data is kept while your account is active. If you want your account and data deleted, email support@stu.vc and we will delete it — including your stored API keys.',
  },
  {
    h: 'Security',
    p: 'Connections are encrypted in transit. API keys and secrets are encrypted at rest. No system is perfect, but we treat your sourcing data like the competitive asset it is.',
  },
  {
    h: 'Changes',
    p: 'If we change this policy in a way that matters, we will say so plainly on this page and update the date below.',
  },
];

export default function Privacy() {
  return (
    <div className="legal-page">
      <style>{`
        .legal-page {
          --bg: #FBFBFA; --surface: #FFFFFF; --border: #E9E7E2;
          --text-primary: #1A1A1A; --text-secondary: #6E6E6E; --accent: #2563EB;
          background: var(--bg); color: var(--text-primary);
          min-height: 100vh; font-family: 'DM Sans', system-ui, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .legal-page a { color: var(--accent); text-decoration: none; }
        .legal-nav { max-width: 760px; margin: 0 auto; padding: 28px 24px 0;
          display: flex; justify-content: space-between; align-items: center; }
        .legal-back { color: var(--text-secondary) !important; font-size: 14px; font-weight: 500; }
        .legal-back:hover { color: var(--text-primary) !important; }
        .legal-body { max-width: 760px; margin: 0 auto; padding: 64px 24px 100px; }
        .legal-body h1 { font-size: 38px; font-weight: 700; letter-spacing: -0.03em; margin: 0 0 12px; }
        .legal-updated { font-size: 14px; color: var(--text-secondary); margin-bottom: 48px; }
        .legal-body h2 { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; margin: 36px 0 10px; }
        .legal-body p { font-size: 15.5px; color: var(--text-secondary); line-height: 1.7; margin: 0; }
        .legal-foot { border-top: 1px solid var(--border); max-width: 760px; margin: 0 auto;
          padding: 28px 24px 40px; font-size: 13px; color: var(--text-secondary); }
      `}</style>
      <nav className="legal-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StuLogo size={24} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>Stu</span>
        </div>
        <Link to="/" className="legal-back">← Back to home</Link>
      </nav>
      <div className="legal-body">
        <h1>Privacy Policy</h1>
        <div className="legal-updated">Last updated September 16, 2026. Plain English, on purpose.</div>
        {sections.map(s => (
          <div key={s.h}>
            <h2>{s.h}</h2>
            <p>{s.p}</p>
          </div>
        ))}
      </div>
      <div className="legal-foot">© {new Date().getFullYear()} Stu · <Link to="/terms">Terms of Service</Link></div>
    </div>
  );
}
