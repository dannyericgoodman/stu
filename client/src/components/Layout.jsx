import { useState, useEffect } from 'react';
import { NavLink, useMatch, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import DannyAI from './DannyAI';
import SearchPalette from './SearchPalette';
import StuLogo from './StuLogo';
import { api, fetchAppVersion } from '../utils/api';

// Four lenses + the assistant. Everything operational lives in the utility menu.
// Four destinations, not twelve.
//
// Cut: Ask Stu (0 conversations, ever), Daily Brief (0 rows since it was built in
// June — and it owned the top of the old Home, rendering "No newsletter items yet"
// every morning, which is a daily lesson that the tool doesn't work). Discover stays
// but folds into Pipeline; its engine has never once run.
//
// Every dead door is a reason not to open the building.
// Four destinations, each one job.
//
// Danny: "we're conflating two actions here: 1) I need an inbox to study and
// triage new founders (true sourcing) and 2) the ability to manage a pipeline
// (like a kanban)... right now, this screen is a jumble." He was right — I'd
// applied the one-record insight to the SCREENS when it only ever applied to the
// data. Triaging a stranger and managing a company you know are different jobs.
//
//   Home      what needs you today, and where the funnel stands
//   Sourcing  the inbox — study, triage, Track promotes onto the board
//   Pipeline  the kanban — move companies you know through your deal stages
//   Talent    genuinely separate: different people, inverted lens, and the
//             customer is Danny's founders rather than Danny
//
const navConfig = [
  // ── The doors Danny opens every morning. ──
  //
  // ASSESS is back in the nav (Danny's call, 2026-08-13). It came out on the theory
  // that "an assessment is something you do TO a company, not a destination", and that
  // a nav item would just open a company picker you have to already know the answer to.
  // But with assessment rescoped to the nine-lens expert panel it IS a product worth a
  // front door, and the /assess hub is a real destination: it lists every past read AND
  // its intake lets you pick any sourced founder OR type a brand-new one and run a read
  // — the picker concern is answered by supporting create-new inline. You can still
  // assess from a company card; this is the fast path in.
  //
  // TALENT came out. 304 candidates and 57 matches against ONE role and ONE
  // portfolio company. It's a different product for a different customer — his
  // founders, not him — and it doesn't belong beside the screens he opens every
  // morning. Moved to the utility menu until there's a second req.
  { to: '/', label: 'Home' },
  { to: '/sourcing', label: 'Sourcing' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/assess', label: 'Assess' },
];
const utilityConfig = [
  { to: '/talent', label: 'Talent' },
  { to: '/settings', label: 'Settings' },
  { to: '/health', label: 'Health' },
  { to: '/releases', label: 'Releases' }, // Danny likes the changelog — it stays.
];

// Screens rebuilt on the design system: they own their own padding, so Layout
// must not wrap them in the legacy centered column. Sourcing and Pipeline run to
// the glass (dense tables — whitespace at the edges reads as absence). Home sets
// its own modest gutter, because a card grid isn't a table.
const BLEED_ROUTES = ['/', '/sourcing', '/pipeline'];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const bleed = BLEED_ROUTES.includes(pathname);
  const navItems = navConfig;
  const utilityItems = user?.role === 'admin'
    ? [...utilityConfig, { to: '/admin', label: 'Admin' }]
    : utilityConfig;
  const [utilOpen, setUtilOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [founderData, setFounderData] = useState(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Detect new deploys: capture the version this tab loaded with, then re-check on
  // an interval and whenever the tab regains focus. If the server version changed,
  // a new build shipped — prompt a refresh so the user never sits on stale UI.
  useEffect(() => {
    let loadedVersion = null;
    let cancelled = false;
    async function check() {
      const v = await fetchAppVersion();
      if (cancelled || !v) return;
      if (loadedVersion == null) { loadedVersion = v; return; }
      if (v !== loadedVersion) setUpdateAvailable(true);
    }
    check();
    const interval = setInterval(check, 60000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, []);

  // Detect founder detail page and load context for AI sidebar
  const founderMatch = useMatch('/founders/:id');
  useEffect(() => {
    if (founderMatch?.params?.id) {
      api.getFounder(founderMatch.params.id)
        .then(f => setFounderData(f))
        .catch(() => setFounderData(null));
    } else {
      setFounderData(null);
    }
  }, [founderMatch?.params?.id]);

  // Cmd+K listener
  useEffect(() => {
    function handleKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {updateAvailable && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-full shadow-lg">
          <span>A new version of Stu is available.</span>
          <button onClick={() => window.location.reload()} className="font-semibold underline underline-offset-2 hover:text-gray-200">
            Refresh
          </button>
        </div>
      )}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/10 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[220px] bg-white border-r border-gray-200 flex flex-col transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-4 py-4 flex items-center gap-2">
          <StuLogo size={22} />
          <span className="text-[15px] font-semibold text-gray-900 tracking-tight">Stu</span>
        </div>

        {/* Search trigger */}
        <div className="px-3 mb-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-400 hover:border-gray-300 hover:text-gray-500 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <span className="flex-1 text-left">Search...</span>
            <kbd className="text-[10px] bg-gray-100 px-1 py-0.5 rounded font-mono">{typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K</kbd>
          </button>
        </div>

        <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.placeholder ? '#' : item.to}
              end={item.to === '/'}
              onClick={(e) => { if (item.placeholder) e.preventDefault(); setMobileOpen(false); }}
              className={({ isActive }) =>
                `flex items-center justify-between px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors ${
                  item.accent
                    ? isActive
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                    : isActive && !item.placeholder
                    ? 'bg-gray-100 text-gray-900'
                    : item.placeholder
                    ? 'text-gray-400 cursor-default'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`
              }
            >
              <span className="flex items-center gap-2">
                {item.accent && (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                )}
                {item.label}
              </span>
              {item.placeholder && (
                <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">Soon</span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Utility menu — Settings / Health / Releases / sign out, tucked away */}
        <div className="px-3 py-3 border-t border-gray-100 relative">
          <button onClick={() => setUtilOpen(o => !o)} className="w-full flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-gray-50 transition-colors">
            <div className="w-7 h-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-[10px] font-semibold">
              {user?.name?.split(' ').map(n => n[0]).join('') || '?'}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-[13px] font-medium text-gray-900 truncate">{user?.name}</p>
            </div>
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" /></svg>
          </button>
          {utilOpen && (
            <div className="absolute bottom-full left-3 right-3 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
              {utilityItems.map(item => (
                <NavLink key={item.to} to={item.to} onClick={() => { setUtilOpen(false); setMobileOpen(false); }}
                  className="block px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 hover:text-gray-900">
                  {item.label}
                </NavLink>
              ))}
              <button onClick={logout} className="w-full text-left px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-t border-gray-100 mt-1 pt-1.5">
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
          <button onClick={() => setMobileOpen(true)} className="p-1 text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-1.5">
            <StuLogo size={20} />
            <span className="text-sm font-semibold text-gray-900">Stu</span>
          </div>
          <button onClick={() => setAiOpen(!aiOpen)} className={`p-1 transition-colors ${aiOpen ? 'text-blue-600' : 'text-gray-400'}`}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </button>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {/* FULL BLEED, for the screens that have been rebuilt on the design system.
              This wrapper used to be `max-w-5xl mx-auto px-5 py-8` for EVERY page,
              which centered each screen in a narrow column inside a wide frame — the
              single strongest "this app is empty" signal there is. Whitespace at the
              EDGES reads as absence; whitespace BETWEEN dense elements reads as calm.

              Bleed is opt-in per route rather than global only because the not-yet-
              rebuilt pages still assume the old padded column. Each one drops off this
              list as it gets rebuilt, and then this whole branch goes away. */}
          <main className="flex-1 overflow-y-auto bg-ground-2">
            {bleed ? children : <div className="max-w-5xl mx-auto px-5 py-8 md:px-8">{children}</div>}
          </main>

          {/* Stu AI toggle */}
          <button
            onClick={() => setAiOpen(!aiOpen)}
            className={`hidden md:flex items-center justify-center w-10 flex-shrink-0 border-l transition-colors ${
              aiOpen ? 'bg-blue-50 border-gray-200 text-blue-600' : 'bg-white border-gray-200 text-gray-400 hover:text-blue-600'
            }`}
            title={founderData ? `Stu AI (${founderData.name})` : 'Toggle Stu AI'}
          >
            <div className="flex flex-col items-center gap-1">
              <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              {founderData && (
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              )}
            </div>
          </button>

          {aiOpen && <DannyAI onClose={() => setAiOpen(false)} founderData={founderData} />}
        </div>
      </div>

      {/* Global search */}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
