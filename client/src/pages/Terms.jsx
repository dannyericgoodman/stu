import { Link } from 'react-router-dom';
import StuLogo from '../components/StuLogo';

const sections = [
  {
    h: 'What Stu is',
    p: 'Stu is AI-powered founder-sourcing software for pre-seed and angel investors: nightly scout sweeps, an AI-scored triage inbox, structured founder assessments, and pipeline tracking. Stu is a research and workflow tool — it is not investment advice, and nothing in the product should be treated as a recommendation to invest.',
  },
  {
    h: 'The founding seat',
    p: 'A founding seat costs $349 as a single, one-time payment. It is not a subscription: there are no recurring charges, ever. Your payment buys ongoing access to the product at the founding terms. Only 10 founding seats exist; when they are claimed, founding pricing closes permanently.',
  },
  {
    h: 'Your account and API keys',
    p: 'You need an account to use Stu, and you bring your own third-party API keys (for sourcing and AI providers). You are responsible for keeping your keys and credentials safe, and for any usage costs those providers bill you directly. API keys you connect are encrypted at rest and used only to run your workspace.',
  },
  {
    h: 'Acceptable use',
    p: 'Use Stu for lawful investment research. Do not attempt to break, overload, or scrape the service, do not share or resell your access, and do not use sourced founder data for spam or harassment. We may suspend accounts that abuse the service.',
  },
  {
    h: 'Your data',
    p: 'The founders, notes, pipeline entries, and assessments in your workspace are yours. Workspaces are fully isolated per user. We do not sell your data, and we do not share your workspace contents with other users.',
  },
  {
    h: 'Payments',
    p: 'Payments are processed securely by Stripe. We never see or store your card number. Founding seat purchases are final — but if the product materially does not work as described, contact us at support@stu.vc and we will make it right.',
  },
  {
    h: 'Changes',
    p: 'We may update these terms as the product evolves. Continued use of Stu after changes take effect counts as acceptance. If a change materially affects founding members, we will say so plainly.',
  },
];

export default function Terms() {
  return (
    <div className="legal-page">
      <style>{`
        .legal-page {
          --bg: #0D0D10; --surface: #16161C; --border: #23232D;
          --text-primary: #F0F0F3; --text-secondary: #8A8A9B; --accent: #3B82F6;
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
        <h1>Terms of Service</h1>
        <div className="legal-updated">Last updated September 16, 2026. Plain English, on purpose.</div>
        {sections.map(s => (
          <div key={s.h}>
            <h2>{s.h}</h2>
            <p>{s.p}</p>
          </div>
        ))}
      </div>
      <div className="legal-foot">© {new Date().getFullYear()} Stu · <Link to="/privacy">Privacy Policy</Link></div>
    </div>
  );
}
