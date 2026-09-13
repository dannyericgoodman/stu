import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';

// ══════════════════════════════════════════════════════════════════════════
// Network — match a founder's ask against the people Danny actually knows.
//
// The screen is built around one honesty rule that the engine enforces and the
// UI must not undo: relevance qualifies a person, warmth only orders them. So
// every row shows THREE things and never fewer — why this person fits, how
// Danny actually knows them (message counts, dates), and what the ask asked for
// that they do NOT have. A shortlist that hides its gaps is how a tool like this
// loses trust the first time Danny forwards a bad intro.
//
// The asks themselves come from Airtable's Founder Asks table rather than a new
// form: Danny's team already types real asks there, typed by kind. Inventing a
// second place to record a need would guarantee the two disagree.
// ══════════════════════════════════════════════════════════════════════════

const TYPES = [
  ['capital', 'Capital', 'investors, angels, family offices'],
  ['intro', 'Intro', 'a door into a named company or category'],
  ['advice', 'Advice', 'an operator who has solved this before'],
  ['hire', 'Hire', 'someone who could do the job'],
  ['customer', 'Customer', 'a buyer, or a path to one'],
];

const TIER_STYLE = {
  strong: 'bg-ink text-white border-ink',
  real: 'bg-white text-ink border-gray-400',
  light: 'bg-white text-gray-500 border-gray-200',
  thin: 'bg-white text-gray-400 border-gray-200',
  name_only: 'bg-white text-gray-400 border-gray-200',
};
const TIER_LABEL = {
  strong: 'strong', real: 'real', light: 'light', thin: 'thin', name_only: 'no contact',
};

export default function Network() {
  const [tab, setTab] = useState('match');
  const [status, setStatus] = useState(null);
  const { toast } = useToast();

  useEffect(() => { refreshStatus(); }, []);
  async function refreshStatus() {
    try { setStatus(await api.getNetworkStatus()); } catch { /* status is decoration */ }
  }

  const empty = status && status.total === 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold text-gray-900 tracking-tight">Network</h1>
        {status && (
          <span className="text-xs text-gray-500 tabular-nums">
            {status.total.toLocaleString()} people · {status.reachable.toLocaleString()} you actually talk to
          </span>
        )}
      </div>
      <p className="text-[13px] text-gray-500 mb-6">
        A founder&rsquo;s ask in, the people you know who can answer it out — each one with why they fit
        and how you know them.
      </p>

      {status && status.export_stale && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          Your LinkedIn export is from <strong>{status.export_dated}</strong> ({status.export_age_days} days old).
          Titles and employers are frozen at that date — people who have changed jobs since will match on the old one.
          Re-export and re-import below to refresh.
        </div>
      )}

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {[['match', 'Match'], ['book', 'The book'], ['setup', 'Import']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2 text-[13px] -mb-px border-b-2 transition-colors ${
              tab === k ? 'border-ink text-ink font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {label}
          </button>
        ))}
      </div>

      {empty && tab !== 'setup' ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-8 text-center">
          <p className="text-sm text-gray-700 font-medium">No network imported yet.</p>
          <p className="text-[13px] text-gray-500 mt-1 mb-4">
            Upload a LinkedIn data export to build the book.
          </p>
          <button onClick={() => setTab('setup')} className="btn-primary">Go to import</button>
        </div>
      ) : tab === 'match' ? (
        <MatchTab toast={toast} />
      ) : tab === 'book' ? (
        <BookTab status={status} />
      ) : (
        <SetupTab status={status} onDone={refreshStatus} toast={toast} />
      )}
    </div>
  );
}

// ── Match ─────────────────────────────────────────────────────────────────

function MatchTab({ toast }) {
  const [needs, setNeeds] = useState([]);
  const [companies, setCompanies] = useState({ portfolio: [], pipeline: [] });
  const [type, setType] = useState('advice');
  const [text, setText] = useState('');
  const [company, setCompany] = useState('');
  const [askId, setAskId] = useState(null);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    api.getNetworkNeeds().then((d) => setNeeds(d.needs || [])).catch(() => {});
    api.getNetworkCompanies().then(setCompanies).catch(() => {});
    loadRuns();
  }, []);

  function loadRuns() { api.getNetworkRuns().then(setRuns).catch(() => {}); }

  // Reopen a stored run rather than recomputing it. The distinction matters:
  // a saved run is what the book said ON THAT DATE, and after a fresh import the
  // same ask can legitimately return different people. Re-running would quietly
  // overwrite the answer Danny may already have acted on.
  async function openRun(id) {
    try {
      const r = await api.getNetworkRun(id);
      setResult({
        need: { type: r.need_type, label: r.need_type, text: r.need_text, read_as: {} },
        results: r.results || [], considered: r.considered, qualified: r.qualified,
        coverage: r.coverage || {}, unmet: r.unmet || [],
        unmet_orgs: [], unmet_attributes: r.unmet || [],
        viewed_at: r.created_at,
      });
      setText(r.need_text); setType(r.need_type); setCompany(r.company_name || '');
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
  }

  const allCompanies = [
    ...companies.portfolio.map((c) => ({ ...c, group: 'Portfolio' })),
    ...companies.pipeline.map((c) => ({ ...c, group: 'Pipeline' })),
  ];

  function loadAsk(n) {
    setType(n.type); setText(n.ask); setCompany(n.company || ''); setAskId(n.airtable_ask_id);
    setResult(null);
  }

  async function run() {
    if (!text.trim()) return;
    setRunning(true);
    try {
      const co = allCompanies.find((c) => c.name === company);
      setResult(await api.matchNetwork({
        type, text, company_name: company || null,
        company_context: co ? co.context : null,
        airtable_ask_id: askId, limit: 12,
      }));
      loadRuns();
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setRunning(false); }
  }

  const openAsks = needs.filter((n) => n.status === 'Open');

  return (
    <div>
      {openAsks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">
            Open founder asks · from Airtable
          </h2>
          <div className="space-y-1.5">
            {openAsks.map((n) => (
              <button key={n.airtable_ask_id} onClick={() => loadAsk(n)}
                className={`w-full text-left rounded-lg border px-3.5 py-2.5 transition-colors ${
                  askId === n.airtable_ask_id ? 'border-ink bg-gray-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-gray-400 shrink-0">{n.type}</span>
                  <span className="text-[13px] text-gray-900">{n.ask}</span>
                </div>
                {n.company && <div className="text-xs text-gray-500 mt-0.5">{n.company}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 p-4 mb-6">
        <h2 className="text-[11px] uppercase tracking-wide text-gray-400 mb-3">Or describe an ask</h2>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {TYPES.map(([k, label, hint]) => (
            <button key={k} onClick={() => setType(k)} title={hint}
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                type === k ? 'bg-ink text-white border-ink' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
              {label}
            </button>
          ))}
        </div>

        <textarea value={text} onChange={(e) => { setText(e.target.value); setAskId(null); }}
          rows={2} placeholder="e.g. Intros to tech-enabled RIAs like Compound, Savvy and Facet"
          className="w-full text-[13px] border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:border-gray-400 resize-none" />

        <div className="flex items-center gap-2 mt-3">
          <select value={company} onChange={(e) => setCompany(e.target.value)}
            className="text-[13px] border border-gray-200 rounded-md px-2 py-1.5 bg-white text-gray-700 max-w-[260px]">
            <option value="">No company context</option>
            {['Portfolio', 'Pipeline'].map((g) => (
              <optgroup key={g} label={g}>
                {allCompanies.filter((c) => c.group === g).map((c) => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button onClick={run} disabled={running || !text.trim()} className="btn-primary">
            {running ? 'Matching…' : 'Find people'}
          </button>
        </div>
      </div>

      {result && <Results result={result} />}

      {runs.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">Earlier asks</h2>
          <div className="divide-y divide-gray-100 border-y border-gray-100">
            {runs.slice(0, 8).map((r) => (
              <button key={r.id} onClick={() => openRun(r.id)}
                className="w-full text-left py-2 flex items-baseline gap-3 hover:bg-gray-50 px-1 -mx-1">
                <span className="text-[11px] uppercase tracking-wide text-gray-400 w-14 shrink-0">{r.need_type}</span>
                <span className="text-[13px] text-gray-700 truncate flex-1">{r.need_text}</span>
                <span className="text-xs text-gray-400 tabular-nums shrink-0">
                  {r.qualified} · {String(r.created_at || '').slice(0, 10)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// "a, b and c" — a list a person would read out loud.
function joinList(xs) {
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function Results({ result }) {
  const { results, need, considered, qualified } = result;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-[11px] uppercase tracking-wide text-gray-400">
          {results.length} of {qualified.toLocaleString()} who qualify · {considered.toLocaleString()} considered
          {result.viewed_at && (
            <span className="normal-case tracking-normal text-gray-400">
              {' '}· saved {String(result.viewed_at).slice(0, 10)}, not re-run
            </span>
          )}
        </h2>
        <ReadAs readAs={need.read_as} />
      </div>

      {/* The honest headline. A shortlist can look plausible and still miss the
          point of the ask; when nothing in the book meets a dimension, say it
          before showing the near-misses. Orgs and attributes read differently to
          a human, so they get different sentences. */}
      {((result.unmet_orgs || []).length > 0 || (result.unmet_attributes || []).length > 0) && (
        <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-[13px] text-gray-700 space-y-1">
          {(result.unmet_orgs || []).length > 0 && (
            <div>You know nobody at <strong>{joinList(result.unmet_orgs)}</strong>.</div>
          )}
          {(result.unmet_attributes || []).length > 0 && (
            <div>Nobody in your network shows <strong>{joinList(result.unmet_attributes)}</strong>.</div>
          )}
          <div className="text-gray-500">
            The people below match the rest of the ask — the closest thing you have, not the thing you asked for.
          </div>
        </div>
      )}

      {!results.length ? (
        <div className="rounded-lg border border-gray-200 px-4 py-6 text-center text-[13px] text-gray-500">
          Nobody in the book clears the bar for this ask. That is a real answer — it means the intro has to
          come from outside your network.
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((p, i) => <PersonRow key={p.person_id} p={p} rank={i + 1} />)}
        </div>
      )}
    </div>
  );
}

function ReadAs({ readAs }) {
  const bits = [
    ...(readAs.orgs || []).map((o) => `“${o}”`),
    ...(readAs.personas || []),
    ...(readAs.sectors || []),
    ...(readAs.functions || []),
  ];
  if (!bits.length) return null;
  return (
    <span className="text-xs text-gray-400" title="How the ask was interpreted">
      read as: {bits.slice(0, 6).join(' · ')}
    </span>
  );
}

// Last resort for browsers or contexts where the async clipboard API is unavailable.
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function PersonRow({ p, rank }) {
  const [copied, setCopied] = useState(false);

  // What Danny pastes into a message to whoever is making the intro. It carries
  // the receipts, so the claim travels with its evidence.
  function copyBrief() {
    const lines = [
      `${p.name}${p.title ? ` — ${p.title}` : ''}${p.company ? ` @ ${p.company}` : ''}`,
      p.linkedin_url,
      `How you know them: ${p.how_you_know_them}`,
      `Why they fit: ${p.why.join('; ')}`,
      p.gaps && p.gaps.length ? `Gaps: ${p.gaps.join('; ')}` : null,
    ].filter(Boolean);
    const text = lines.join('\n');
    // clipboard.writeText rejects outside a secure context and when permission is
    // denied. Failing silently looks like a dead button, so fall back and only
    // claim success when something actually copied.
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1400); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done());
    } else if (legacyCopy(text)) {
      done();
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3 hover:border-gray-300 transition-colors">
      <div className="flex items-start gap-3">
        <span className="text-xs text-gray-300 tabular-nums w-4 shrink-0 pt-0.5">{rank}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900">{p.name}</span>
            <span className={`text-2xs px-1.5 py-0.5 rounded border ${TIER_STYLE[p.warmth_tier] || TIER_STYLE.thin}`}>
              {TIER_LABEL[p.warmth_tier] || p.warmth_tier}
            </span>
            {p.staleness && p.staleness !== 'active' && (
              <span className="text-2xs text-gray-400">{p.staleness}</span>
            )}
          </div>

          <div className="text-[13px] text-gray-600 mt-0.5">
            {p.title || <em className="text-gray-400">no title on the record</em>}
            {p.company && <span className="text-gray-400"> · {p.company}</span>}
          </div>

          {/* How you know them — the part no contact database can produce. */}
          <div className="text-xs text-gray-500 mt-1.5">{p.how_you_know_them}</div>

          {p.why.map((w, i) => (
            <div key={i} className="text-xs text-gray-600 mt-0.5">— {w}</div>
          ))}

          {p.gaps && p.gaps.length > 0 && (
            <div className="text-xs text-gray-400 mt-0.5">— {p.gaps.join('; ')}</div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="text-sm tabular-nums font-semibold text-ink">{p.score}</div>
          <div className="flex gap-2">
            {p.linkedin_url && (
              <a href={p.linkedin_url} target="_blank" rel="noreferrer"
                className="text-xs text-gray-400 hover:text-gray-800">LinkedIn</a>
            )}
            <button onClick={copyBrief} className="text-xs text-gray-400 hover:text-gray-800">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The book ──────────────────────────────────────────────────────────────

function BookTab({ status }) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [data, setData] = useState({ people: [], total: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try { setData(await api.getNetworkPeople({ q, tier, limit: 60 })); }
      catch { /* browse failures are not worth a toast */ }
      finally { setLoading(false); }
    }, 220);
    return () => clearTimeout(t);
  }, [q, tier]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, title or company…"
          className="flex-1 text-[13px] border border-gray-200 rounded-md px-3 py-1.5 focus:outline-none focus:border-gray-400" />
        <select value={tier} onChange={(e) => setTier(e.target.value)}
          className="text-[13px] border border-gray-200 rounded-md px-2 py-1.5 bg-white text-gray-700">
          <option value="">All warmth</option>
          <option value="strong">Strong</option>
          <option value="real">Real</option>
          <option value="light">Light</option>
          <option value="thin">Thin</option>
        </select>
      </div>

      {status && (
        <p className="text-xs text-gray-400 mb-3">
          {status.tiers.strong || 0} strong · {status.tiers.real || 0} real · {status.tiers.light || 0} light
          · {status.tiers.thin || 0} never messaged.
          {' '}{status.signal && status.signal.none ? `${status.signal.none} have no title on record and cannot be matched.` : ''}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Searching…</p>
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-2 tabular-nums">{data.total.toLocaleString()} match</p>
          <div className="divide-y divide-gray-100 border-y border-gray-100">
            {data.people.map((p) => (
              <div key={p.id} className="py-2.5 flex items-baseline gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-gray-900">{p.name}</span>
                    <span className={`text-2xs px-1.5 py-0.5 rounded border ${TIER_STYLE[p.warmth_tier] || TIER_STYLE.thin}`}>
                      {TIER_LABEL[p.warmth_tier] || p.warmth_tier}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {p.title || 'no title'}{p.company ? ` · ${p.company}` : ''}
                  </div>
                  <div className="text-2xs text-gray-400">{p.relationship_receipt}</div>
                </div>
                <div className="text-xs tabular-nums text-gray-400 shrink-0">{p.warmth}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Import ────────────────────────────────────────────────────────────────

function SetupTab({ status, onDone, toast }) {
  const [busy, setBusy] = useState(false);

  async function uploadExport(files) {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      const r = await api.importNetworkLinkedIn(files);
      toast({
        message: `${r.inserted} new, ${r.updated} refreshed — ${r.connections} connections plus ${r.messaged_only} correspondents`
          + (r.has_messages ? '' : '. No messages.csv, so relationship strength was not updated — add it to measure how well you know each person.'),
      });
      onDone();
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function mergeAirtable() {
    setBusy(true);
    try {
      const r = await api.importNetworkAirtable();
      toast({ message: `Merged ${r.advisors} advisors and ${r.investors} investors from Airtable` });
      onDone();
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-900 mb-1">LinkedIn export</h2>
        <p className="text-[13px] text-gray-500 mb-3">
          LinkedIn has no API for your connections, and the official export is richer than anything
          scraping could reach — it includes your message history, which is what separates a real
          relationship from a badge scan. On LinkedIn: <strong>Settings → Data privacy → Get a copy
          of your data → Download larger data archive</strong>. Upload the .zip here.
        </p>
        <p className="text-[12px] text-gray-400 mb-3">
          If your Mac already unzipped it into a folder, open that folder and select{' '}
          <strong className="font-medium text-gray-500">Connections.csv</strong> and{' '}
          <strong className="font-medium text-gray-500">messages.csv</strong> together (hold ⌘ to pick both).
        </p>
        <input type="file" accept=".zip,.csv" multiple disabled={busy}
          onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; uploadExport(fs); }}
          className="text-[13px] text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-gray-200 file:text-[13px] file:bg-white hover:file:border-gray-400" />
        {status && status.last_linkedin_import && (
          <p className="text-xs text-gray-400 mt-2">
            Last import: {status.last_linkedin_import.summary}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-900 mb-1">Airtable networks</h2>
        <p className="text-[13px] text-gray-500 mb-3">
          Merges the Advisor Network and Investor Network tables. Read-only — Stu never writes to the
          base your team maintains. Expertise typed there outranks anything parsed from a job title.
        </p>
        <button onClick={mergeAirtable} disabled={busy || !(status && status.airtable_configured)}
          className="btn-secondary">
          {busy ? 'Working…' : 'Merge from Airtable'}
        </button>
        {status && status.last_airtable_import && (
          <p className="text-xs text-gray-400 mt-2">Last merge: {status.last_airtable_import.summary}</p>
        )}
      </section>

      <p className="text-xs text-gray-400">
        Everything is matched deterministically from titles, employers and your message history.
        No model reads your contacts, and nothing here is sent to an external service.
      </p>
    </div>
  );
}
