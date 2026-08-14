import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../utils/api';
import { useToast } from '../../components/Toast';

// One role → its shortlist. Warm network first, each match with a grounded "why," an
// IL-tie receipt, and links. Move a candidate along the handoff (sourced → shared →
// intro made) and export the list to hand the founder. Stu never contacts anyone.

const HANDOFF = ['sourced', 'shortlisted', 'shared', 'intro_made', 'hired', 'passed'];
const HANDOFF_LABEL = { sourced: 'Sourced', shortlisted: 'Shortlisted', shared: 'Shared', intro_made: 'Intro made', hired: 'Hired', passed: 'Passed' };
const HANDOFF_BADGE = { sourced: 'badge-gray', shortlisted: 'badge-blue', shared: 'badge-amber', intro_made: 'badge-green', hired: 'badge-green', passed: 'badge-gray' };

export default function HiringRole() {
  const { id } = useParams();
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState('');
  const [exportText, setExportText] = useState(null);
  const { toast } = useToast();

  useEffect(() => { load(); }, [id]);
  async function load() {
    setLoading(true);
    try { setRole(await api.getHiringRole(id)); }
    catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setLoading(false); }
  }

  async function runMatch() {
    setRunning('match');
    try {
      const r = await api.runHiringMatch(Number(id));
      toast({ message: r.summary || 'Shortlist ready' });
      await load();
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setRunning(''); }
  }

  async function discover() {
    setRunning('discover');
    try {
      const r = await api.runHiringDiscovery(Number(id));
      toast({ message: r.discovery ? `${r.discovery.added || 0} new IL builders found` : 'Discovery done' });
      await load();
    } catch (err) { toast({ message: err.message, tone: 'error' }); }
    finally { setRunning(''); }
  }

  async function doExport() {
    try { const r = await api.exportHiringRole(id); setExportText(r); }
    catch (err) { toast({ message: err.message, tone: 'error' }); }
  }

  async function setStatus(matchId, status) {
    // Optimistic: reflect the move immediately, the list is small.
    setRole((r) => ({ ...r, matches: r.matches.map((m) => (m.id === matchId ? { ...m, status } : m)) }));
    try { await api.updateHiringMatch(matchId, { status }); }
    catch (err) { toast({ message: err.message, tone: 'error' }); load(); }
  }

  if (loading) return <div className="max-w-4xl mx-auto px-6 py-8 text-sm text-gray-400">Loading…</div>;
  if (!role) return <div className="max-w-4xl mx-auto px-6 py-8 text-sm text-gray-400">Role not found.</div>;

  const matches = role.matches || [];
  const stack = role.must_have_stack || [];
  const nice = role.nice_to_have_stack || [];
  const musts = role.must_haves || [];

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link to="/hiring" className="text-xs text-gray-400 hover:text-gray-700">← Hiring</Link>

      <div className="mt-2 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 tracking-tight">{role.title}</h1>
          <p className="text-[13px] text-gray-500 mt-0.5">
            {role.founder_id ? <Link to={`/founders/${role.founder_id}`} className="hover:underline">{role.company_name || role.founder_company}</Link> : (role.company_name || 'Unlinked')}
            {['role_function', 'seniority', 'location_pref'].map((k) => role[k]).filter(Boolean).length > 0 && ' · '}
            {[role.role_function, role.seniority, role.location_pref].filter(Boolean).join(' · ')}
            {role.il_only ? ' · IL only' : ''}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={runMatch} disabled={!!running}
            className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-[13px] font-medium hover:bg-gray-800 disabled:opacity-50">
            {running === 'match' ? 'Matching…' : matches.length ? 'Re-match' : 'Find matches'}
          </button>
          <button onClick={discover} disabled={!!running}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 text-[13px] font-medium hover:border-gray-300 disabled:opacity-50">
            {running === 'discover' ? 'Searching…' : 'Find more on GitHub'}
          </button>
          {matches.length > 0 && (
            <button onClick={doExport} className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 text-[13px] font-medium hover:border-gray-300">Export</button>
          )}
        </div>
      </div>

      {/* Parsed requirements — what the JD actually asked for (blanks left blank). */}
      {(stack.length || nice.length || musts.length || role.domain || role.comp_note) ? (
        <div className="mt-4 flex flex-wrap gap-1.5 items-center">
          {stack.map((s) => <span key={s} className="badge-blue text-[11px]">{s}</span>)}
          {nice.map((s) => <span key={s} className="badge-gray text-[11px]">{s}<span className="opacity-50"> (nice)</span></span>)}
          {role.domain && <span className="text-[11px] text-gray-500">· {role.domain}</span>}
          {role.comp_note && <span className="text-[11px] text-gray-500">· {role.comp_note}</span>}
          {musts.map((m) => <span key={m} className="text-[11px] text-gray-500">· {m}</span>)}
        </div>
      ) : null}

      {/* Shortlist */}
      <div className="mt-6">
        {!matches.length ? (
          <div className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-200 rounded-xl">
            No shortlist yet. Click <span className="font-medium text-gray-600">Find matches</span> to rank your warm network and IL-tied builders for this role.
          </div>
        ) : (
          <div className="space-y-2">
            {matches.map((m) => <MatchCard key={m.id} m={m} onStatus={setStatus} />)}
          </div>
        )}
      </div>

      {exportText && <ExportModal data={exportText} onClose={() => setExportText(null)} />}
    </div>
  );
}

function MatchCard({ m, onStatus }) {
  const warm = m.tier === 'warm';
  const strengths = m.strengths || [];
  const gaps = m.gaps || [];
  return (
    <div className={`bg-white border rounded-xl p-4 ${warm ? 'border-amber-200' : 'border-gray-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-gray-900">{m.candidate_name}</span>
            {warm ? <span className="badge-amber text-[10px]">warm{m.warm_source ? ` · ${m.warm_source}` : ''}</span>
                  : <span className="badge-gray text-[10px]">cold</span>}
            {m.il_tie_type && (
              <span className="badge-green text-[10px]" title={m.il_tie_evidence || ''}>
                IL · {m.il_tie_type}{m.il_tie_place ? ` (${m.il_tie_place})` : ''}
              </span>
            )}
            {m.github_slope_score >= 5 && <span className="text-[10px] text-gray-400">slope {m.github_slope_score}/10</span>}
          </div>
          {(m.current_role || m.current_company) && (
            <p className="text-[12px] text-gray-500 mt-0.5">{[m.current_role, m.current_company].filter(Boolean).join(' @ ')}{m.location_city ? ` · ${m.location_city}` : ''}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-gray-400">{m.fit_score}/100</span>
          <span className={`${HANDOFF_BADGE[m.status] || 'badge-gray'} text-[10px]`}>{HANDOFF_LABEL[m.status] || m.status}</span>
        </div>
      </div>

      {m.rationale && <p className="text-[13px] text-gray-700 mt-2 leading-snug">{m.rationale}</p>}
      {(strengths.length || gaps.length) ? (
        <div className="mt-1.5 text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
          {strengths.slice(0, 4).map((s, i) => <span key={i}>✓ {s}</span>)}
          {gaps.map((g, i) => <span key={i} className="text-gray-400">— {g}</span>)}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-3">
          {m.linkedin_url && <a href={m.linkedin_url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-600 hover:underline">LinkedIn</a>}
          {m.github_url && <a href={m.github_url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-600 hover:underline">GitHub</a>}
          {m.website_url && <a href={m.website_url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-600 hover:underline">Site</a>}
        </div>
        {/* Handoff stepper — Stu never contacts; Danny moves the state. */}
        <select value={m.status} onChange={(e) => onStatus(m.id, e.target.value)}
          className="text-[11px] border border-gray-200 rounded-md px-1.5 py-1 text-gray-600 focus:outline-none focus:border-gray-400">
          {HANDOFF.map((s) => <option key={s} value={s}>{HANDOFF_LABEL[s]}</option>)}
        </select>
      </div>
    </div>
  );
}

function ExportModal({ data, onClose }) {
  const { toast } = useToast();
  function copy() {
    navigator.clipboard.writeText(data.text || data.markdown || '').then(
      () => toast({ message: 'Copied — paste to the founder' }),
      () => toast({ message: 'Copy failed', tone: 'error' })
    );
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/20 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-[13px] font-semibold text-gray-900">Shortlist to share · {data.count}</span>
          <div className="flex gap-2">
            <button onClick={copy} className="px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs">Copy</button>
            <button onClick={onClose} className="px-2.5 py-1 rounded-md text-gray-500 text-xs hover:bg-gray-50">Close</button>
          </div>
        </div>
        <pre className="p-4 overflow-auto text-[12px] text-gray-700 whitespace-pre-wrap font-sans">{data.markdown}</pre>
      </div>
    </div>
  );
}
