import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import { useToast } from '../../components/Toast';

// Hiring home: the front door. Drop a JD in (paste / link / upload), link it to a
// portco, and it becomes a role you can match. Below, every open role grouped by the
// company it's for — so Danny sees all of Hale's reqs, all of Perspectives', in one place.

const STATUS_BADGE = { open: 'badge-green', paused: 'badge-amber', filled: 'badge-blue', closed: 'badge-gray' };

export default function HiringHome() {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [warm, setWarm] = useState(null);
  const [importing, setImporting] = useState(false);
  const { toast } = useToast();

  useEffect(() => { load(); api.getHiringWarmStatus().then(setWarm).catch(() => {}); }, []);

  async function load() {
    setLoading(true);
    try { setRoles(await api.getHiringRoles()); }
    catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setLoading(false); }
  }

  async function refreshWarm() {
    setImporting(true);
    try {
      const r = await api.importHiringWarm();
      toast({ message: `Warm pool: ${r.inserted} new, ${r.updated} refreshed, ${r.il_tied} IL-tied` });
      setWarm(await api.getHiringWarmStatus());
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setImporting(false); }
  }

  // Group roles by portco (company_name / founder_company), invested first.
  const groups = [];
  const byCompany = new Map();
  for (const r of roles) {
    const key = r.founder_id || r.company_name || 'unlinked';
    if (!byCompany.has(key)) {
      const g = { key, company: r.company_name || r.founder_company || 'Unlinked', founder_id: r.founder_id, invested: r.invested, roles: [] };
      byCompany.set(key, g); groups.push(g);
    }
    byCompany.get(key).roles.push(r);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold text-gray-900 tracking-tight">Hiring</h1>
        {warm && (
          <button onClick={refreshWarm} disabled={importing}
            className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50">
            {importing ? 'Refreshing…' : `Warm pool: ${warm.total || 0} (${warm.il_tied || 0} IL) · refresh`}
          </button>
        )}
      </div>
      <p className="text-[13px] text-gray-500 mb-6">Paste a JD, link it to a portfolio company, get a warm-first shortlist.</p>

      <NewRole onCreated={load} />

      <div className="mt-8">
        {loading ? (
          <p className="text-sm text-gray-400">Loading roles…</p>
        ) : !groups.length ? (
          <p className="text-sm text-gray-400">No roles yet. Add one above to get started.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-2 mb-2">
                  {g.founder_id ? (
                    <Link to={`/founders/${g.founder_id}`} className="text-[13px] font-semibold text-gray-900 hover:underline">{g.company}</Link>
                  ) : (
                    <span className="text-[13px] font-semibold text-gray-900">{g.company}</span>
                  )}
                  {g.invested && <span className="badge-green text-[10px]">portfolio</span>}
                  <span className="text-[11px] text-gray-400">{g.roles.length} {g.roles.length === 1 ? 'role' : 'roles'}</span>
                </div>
                <div className="space-y-1.5">
                  {g.roles.map((r) => (
                    <Link key={r.id} to={`/hiring/${r.id}`}
                      className="flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 rounded-lg hover:border-gray-300 transition-colors">
                      <div className="min-w-0">
                        <span className="text-[13px] font-medium text-gray-900">{r.title}</span>
                        <span className="ml-2 text-[11px] text-gray-400">{[r.role_function, r.seniority].filter(Boolean).join(' · ')}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {r.match_count > 0 && <span className="text-[11px] text-gray-500">{r.shortlisted_count || 0}/{r.match_count} shortlisted</span>}
                        <span className={`${STATUS_BADGE[r.status] || 'badge-gray'} text-[10px]`}>{r.status}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The intake. Three ways in — describe, link, upload — one grounded parse out. ──
function NewRole({ onCreated }) {
  const [mode, setMode] = useState('text'); // text | url | pdf
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [ilOnly, setIlOnly] = useState(false);
  const [company, setCompany] = useState(null); // {founder_id, founder_name, company}
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();
  const navigate = useNavigate();
  const { toast } = useToast();

  async function submit() {
    if (mode === 'text' && !text.trim()) return toast({ message: 'Paste or describe the role first', tone: 'error' });
    if (mode === 'url' && !url.trim()) return toast({ message: 'Add the JD link', tone: 'error' });
    if (mode === 'pdf' && !file) return toast({ message: 'Choose a PDF', tone: 'error' });
    setBusy(true);
    try {
      const payload = {
        jd_source: mode === 'pdf' ? 'pdf' : mode === 'url' ? 'url' : 'sentence',
        title: title || undefined, il_only: ilOnly ? '1' : '',
        founder_id: company?.founder_id || undefined, company_name: company?.company || undefined,
      };
      if (mode === 'text') payload.text = text;
      if (mode === 'url') payload.url = url;
      const role = await api.ingestHiringRole(payload, mode === 'pdf' ? file : null);
      toast({ message: `Parsed “${role.title}” — finding matches next` });
      onCreated && onCreated();
      navigate(`/hiring/${role.id}`);
    } catch (err) {
      toast({ message: err.message + (err.detail ? ` — ${err.detail}` : ''), tone: 'error' });
    } finally { setBusy(false); }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex gap-1 mb-3">
        {[['text', 'Describe / paste'], ['url', 'Link'], ['pdf', 'Upload PDF']].map(([m, label]) => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${mode === m ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>{label}</button>
        ))}
      </div>

      {mode === 'text' && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="Paste the JD, or describe it: “Founding backend engineer for Hale — Python/Postgres, Chicago.”"
          className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400 resize-none" />
      )}
      {mode === 'url' && (
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jobs.lever.co/… or a careers page"
          className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400" />
      )}
      {mode === 'pdf' && (
        <button onClick={() => fileRef.current?.click()}
          className="w-full text-[13px] border border-dashed border-gray-300 rounded-lg px-3 py-3 text-gray-500 hover:border-gray-400">
          {file ? file.name : 'Choose a JD PDF…'}
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <CompanyPicker value={company} onChange={setCompany} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)"
          className="text-[13px] border border-gray-200 rounded-lg px-2.5 py-1.5 w-40 focus:outline-none focus:border-gray-400" />
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="checkbox" checked={ilOnly} onChange={(e) => setIlOnly(e.target.checked)} /> IL only
        </label>
        <button onClick={submit} disabled={busy}
          className="ml-auto px-3.5 py-1.5 rounded-lg bg-gray-900 text-white text-[13px] font-medium hover:bg-gray-800 disabled:opacity-50">
          {busy ? 'Parsing…' : 'Add role'}
        </button>
      </div>
    </div>
  );
}

// A tiny type-ahead over the founder universe (invested first). Any portco is pickable.
function CompanyPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState([]);
  useEffect(() => {
    let live = true;
    api.pickHiringCompanies(q).then((r) => { if (live) setOpts(r); }).catch(() => {});
    return () => { live = false; };
  }, [q]);
  if (value) return (
    <button onClick={() => onChange(null)} className="text-[13px] px-2.5 py-1.5 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200">
      {value.company}{value.invested ? ' ·◆' : ''} ✕
    </button>
  );
  return (
    <div className="relative">
      <input value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        placeholder="Link to portco…" className="text-[13px] border border-gray-200 rounded-lg px-2.5 py-1.5 w-44 focus:outline-none focus:border-gray-400" />
      {open && opts.length > 0 && (
        <div className="absolute z-20 mt-1 w-56 max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          {opts.map((o) => (
            <button key={o.founder_id} onClick={() => { onChange(o); setOpen(false); setQ(''); }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 flex items-center justify-between">
              <span className="truncate">{o.company || o.founder_name}</span>
              {o.invested && <span className="badge-green text-[9px] ml-2">portfolio</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
