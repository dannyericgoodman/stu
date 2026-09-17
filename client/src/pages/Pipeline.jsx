import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import KanbanBoard from '../components/KanbanBoard';

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// Pipeline — Danny's personal ledger.
//
// 2026-09-17 — Danny: "keep Airtable as my always on team record and Pipeline
// as a ledger of founders I've seen in inbox that I like that goes from
// Stage 1: Identified to Stage 2: Outreach Sent to Stage 3: Meeting Set
// Stage 4a: Add to Investment Pipeline or Stage 4b: Pass"
//
// So this page is ONE thing now: his personal ledger, over HIS five stages.
// It is not the Airtable mirror anymore — the team's record lives in Airtable
// itself. A row is in the ledger iff founders.ledger_stage IS NOT NULL.
//
// The axis is Stu-local by construction. Dragging between 1→2→3→4b writes
// nothing but the ledger column. Dragging to 4a is the publish-to-team moment:
// it creates (or updates) the founder's row in the team's Airtable base as
// Under Consideration, and the drag asks first. Nothing else on this page
// touches Airtable — that is the whole point of the split.
//
// What the old board taught: a kanban whose axis is someone else's vocabulary
// drifts (22 declined founders resurrected as live prospects). This axis has
// five values, defined once in server/lib/ledgerStages.js, sent with the
// payload — the client keeps no copy.
// ══════════════════════════════════════════════════════════════════════════

const BAND_LABEL = { anchor: 'Anchor', memo: 'Memo', monitor: 'Monitor', pass: 'Pass', indeterminate: 'Held' };

// The band renders as weight and position on the ink ramp, never as color. A
// colored verdict tells him what to think before he's read the evidence.
// ══════════════════════════════════════════════════════════════════════════
// TRIAGE — three keys, no dialog.
//
// This is the only thing on the board that teaches the rubric anything, so the cost
// of using it has to be near zero: at a hundred rows a morning, any control that
// opens something gets abandoned by row nine, and an abandoned loop teaches nothing.
// Reason is optional and lives on the card, not here.
//
// Stops propagation because the row itself navigates — triaging a founder should not
// also open him.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// WHAT HE ACTUALLY ADVANCES — the calibration panel.
//
// The rubric has always been argued into its current shape. This is the first thing
// in Stu that can contradict it with evidence: each signal's advance rate against the
// base rate, computed only from founders Danny personally ruled on.
//
// Two refusals, both deliberate:
//   * nothing is shown below 30 calls. A lift table built on nine decisions is a
//     horoscope, and the danger is not that it is wrong — it is that it is specific,
//     which is what makes a wrong thing get acted on.
//   * disagreements are shown FIRST. Where the rubric and Danny agree, there is
//     nothing to learn; the whole value is in the rows where one of them is wrong.
// ══════════════════════════════════════════════════════════════════════════
function Learning({ data, onClose }) {
  if (!data) return null;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const d = data.disagreement || {};
  return (
    <div className="border-b border-line-2 bg-ground-2 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-micro font-semibold uppercase text-ink-4">What you actually advance</span>
        <span className="text-mini text-ink-4">
          {data.decided} calls · {pct(data.base_advance_rate || 0)} advance rate
        </span>
        <div className="flex-1" />
        <button className="text-mini text-ink-4 hover:text-ink-2" onClick={onClose}>Hide</button>
      </div>

      {!data.enough_to_read ? (
        <div className="text-mini text-ink-3">
          {data.decided} of 30 calls. Below that this is anecdote, so it is not shown — triage
          from the board and it fills in.
        </div>
      ) : (
        <>
          <div className="flex gap-4 mb-2 text-mini">
            <span className="text-ink-2">
              Rubric said must-meet, you passed: <span className="num font-medium">{d.rubric_said_meet_he_passed}</span>
            </span>
            <span className="text-ink-2">
              Rubric said no, you advanced: <span className="num font-medium">{d.rubric_said_no_he_advanced}</span>
            </span>
            <span className="text-ink-4">No rubric verdict: <span className="num">{d.no_rubric_verdict}</span></span>
          </div>
          <div className="flex flex-col gap-px">
            {(data.signals || []).slice(0, 10).map((sig) => (
              <div key={sig.signal} className="flex items-center gap-2 text-mini">
                <span className="w-64 truncate text-ink-2">{sig.signal}</span>
                <span className="num w-10 text-right text-ink-3">{sig.n}</span>
                <span className="num w-12 text-right text-ink">{pct(sig.rate)}</span>
                <span className={`num w-12 text-right ${sig.lift >= 1.2 ? 'text-accent' : sig.lift <= 0.8 ? 'text-ink-4' : 'text-ink-3'}`}>
                  {sig.lift == null ? '—' : `${sig.lift.toFixed(1)}x`}
                </span>
              </div>
            ))}
            {!(data.signals || []).length && (
              <span className="text-mini text-ink-3">No signal has been seen five times yet.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Triage({ row, onSet }) {
  const opts = [
    { k: 'advance', label: '→', title: 'Advance — worth my time' },
    { k: 'watch', label: '~', title: 'Watch — not now' },
    { k: 'pass', label: '×', title: 'Pass — not for us' },
  ];
  return (
    <span className="w-20 flex items-center justify-end gap-px flex-none">
      {opts.map((o) => (
        <button
          key={o.k}
          title={o.title}
          onClick={(e) => { e.stopPropagation(); onSet(row.id, row.triage === o.k ? null : o.k); }}
          className={`w-5 h-5 rounded text-mini leading-none transition ${
            row.triage === o.k
              ? 'bg-accent-soft text-accent font-semibold'
              : 'text-ink-4 hover:text-ink-2 hover:bg-ground-3'
          }`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Band({ band, score, muted }) {
  if (!band) return <span className="text-ink-4">—</span>;
  return (
    <span className={`band band-${band} ${muted ? 'opacity-60' : ''}`}>
      {BAND_LABEL[band] || band}
      {score != null && <span className="num text-ink-3 font-normal ml-1">{Number(score).toFixed(1)}</span>}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// The composer — a company, added in about four seconds.
//
// Danny takes ~28 first calls a month and adds companies between them. So the
// affordance that matters is speed: type, Tab, Enter, gone.
//
// ── WHY IT ASKS FOR BOTH NAMES ──
// A card is a person AND their company. The board still carries rows from the March
// import where a company name got written into the founder field, and nothing
// downstream can untangle them — which is why the server refuses a bare company and
// why this doesn't offer one. The website is optional and does real work: fill it in
// and the card reads the site before he's finished typing the name.
function Composer({ onCreate, onClose }) {
  const [v, setV] = useState({ company: '', name: '', website_url: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const first = useRef(null);

  useEffect(() => { first.current?.focus(); }, []);

  async function submit() {
    if (!v.company.trim() || !v.name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      await onCreate(v);
    } catch (e) {
      // The 409 knows which card he already has. Say so — "already on the board" with
      // no name is a dead end, and he'd just make the duplicate anyway.
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-ink/10" onClick={onClose}>
      <div
        className="w-[420px] bg-ground rounded-md border border-line-2 shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          // Enter submits from any field — Cmd+Enter shouldn't be required to do the
          // only thing this dialog does.
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      >
        <div className="px-3 h-8 flex items-center border-b border-line">
          <span className="text-mini font-semibold uppercase text-ink-4">New company</span>
        </div>
        <div className="p-3 space-y-2">
          <input
            ref={first}
            className="input w-full"
            placeholder="Company"
            value={v.company}
            onChange={(e) => setV({ ...v, company: e.target.value })}
          />
          <input
            className="input w-full"
            placeholder="Founder"
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
          <input
            className="input w-full"
            placeholder="Website (optional — Stu reads it now if you add it)"
            value={v.website_url}
            onChange={(e) => setV({ ...v, website_url: e.target.value })}
          />
          {err && <p className="text-mini text-danger">{err}</p>}
        </div>
        <div className="px-3 h-9 flex items-center gap-2 border-t border-line bg-ground-2">
          {/* Says where it goes and who sees it. The second half is the load-bearing
              part: Airtable is the team's, and he should know a card he adds here is
              his alone until the 4a drag. */}
          <span className="text-micro text-ink-4 flex-1 truncate" title="A card you add here stays in Stu. Only the Stage 4a drag publishes to the team's Airtable.">
            Stage 1: Identified · stays in Stu
          </span>
          <button onClick={onClose} className="text-mini text-ink-3 hover:text-ink px-2">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !v.company.trim() || !v.name.trim()}
            className="px-2 h-6 rounded text-mini font-medium bg-accent text-white disabled:bg-ground-4 disabled:text-ink-4"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Pipeline() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  // The ledger IS a kanban — five stages, left to right, is the whole point.
  // An existing saved preference still wins.
  const [view, setView] = useState(() => localStorage.getItem('stu_pipeline_view') || 'kanban');
  // Null until asked for. The panel is opt-in because the honest answer early on is
  // "not enough calls yet", and a dashboard that says that on every load is furniture.
  const [learning, setLearning] = useState(null);
  const [showLearning, setShowLearning] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [composing, setComposing] = useState(false);
  const [undo, setUndo] = useState(null);
  const stage = params.get('stage') || '';

  useEffect(() => { localStorage.setItem('stu_pipeline_view', view); }, [view]);

  // ── One fetch: the personal ledger ──
  useEffect(() => {
    let dead = false;
    api.getLedger().then((d) => !dead && setData(d)).catch((e) => !dead && setErr(e.message));
    return () => { dead = true; };
  }, []);

  const stageLabel = useMemo(() => {
    const m = {};
    for (const s of data?.stages || []) m[s.key] = s.label;
    return m;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    let out = data.rows;
    if (stage) out = out.filter((r) => r.funnel_stage === stage);
    if (q) {
      const n = q.toLowerCase();
      out = out.filter(
        (r) => (r.company || '').toLowerCase().includes(n) ||
               (r.person || '').toLowerCase().includes(n) ||
               (r.company_one_liner || '').toLowerCase().includes(n)
      );
    }
    return out;
  }, [data, stage, q]);

  useEffect(() => {
    if (view !== 'list') return;
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, rows.length - 1));
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === 'Enter' && rows[cursor]) nav(`/founders/${rows[cursor].id}`);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, nav, view]);

  // ── The ledger's writes ──
  // Both are optimistic, and both RE-FETCH on failure rather than leaving the
  // optimistic state on screen. A silent divergence between the board and the
  // truth is how the old board rotted for four months.
  //
  // The 4a drag is the publish-to-team moment: it writes to the team's Airtable
  // base, so it asks first. Every other drag is Stu-local and just moves.
  async function onLedgerStageChange(founderId, newStage) {
    const row = data?.rows?.find((r) => r.id === founderId);
    if (newStage === 'invest_pipeline') {
      const label = row?.company || row?.person || 'this founder';
      if (!confirm(`Add ${label} to the Investment Pipeline?\n\nThis publishes them to the team's Airtable as Under Consideration.`)) return;
    }
    const prev = data;
    setData((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === founderId ? { ...r, ledger_stage: newStage } : r)),
    }));
    try {
      const r = await api.setLedgerStage(founderId, newStage);
      // The ledger moved but Airtable refused the publish. The card is honestly
      // in 4a in Stu — but the team can't see it yet, and that gap has to be
      // said out loud, not discovered in Monday's pipeline review.
      if (r?.airtable?.error) setErr(`Saved in your ledger, but Airtable refused it: ${r.airtable.error}`);
      else if (newStage === 'invest_pipeline' && r?.airtable?.skipped && r.airtable.skipped !== 'unchanged') {
        setErr(`Saved in your ledger, but the Airtable publish was skipped (${r.airtable.skipped}).`);
      }
    } catch (e) {
      setErr(e.message);
      setData(prev);
    }
  }

  async function onCreate(v) {
    const created = await api.createPipelineCompany({
      company: v.company.trim(), name: v.name.trim(), website_url: v.website_url.trim(),
    });
    setData((d) => ({ ...d, rows: [...d.rows, created] }));
    setComposing(false);
    // Straight into the card. He added it because he has something to put in it.
    nav(`/founders/${created.id}`);
  }

  // ── Delete, with the undo attached ──
  // The row is the join target for transcripts, commitments, assessments and
  // decisions, so the server deletes softly. That makes undo a restore, and undo is
  // what makes the delete usable: without it he won't touch the button, and the
  // board keeps accreting companies he stopped caring about in March.
  async function onDelete(id) {
    const row = data?.rows.find((r) => r.id === id);
    if (!row) return;
    const prev = data;
    setData((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== id) }));
    try {
      await api.deletePipelineCompany(id);
      setUndo({ id, label: `${row.company || row.person || 'Card'} removed` });
    } catch (e) {
      setErr(e.message);
      setData(prev);
    }
  }

  // Optimistic: the row flips instantly and reverts if the write fails. The whole
  // point of this control is that it costs nothing to use, and a spinner per click
  // across a hundred rows is not nothing.
  async function onTriage(founderId, verdict) {
    const prev = data?.rows?.find((r) => r.id === founderId)?.triage ?? null;
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.id === founderId ? { ...r, triage: verdict } : r)) }));
    try {
      if (verdict) await api.triageFounder(founderId, verdict);
      else await api.triageFounder(founderId, 'watch');
      setLearning(null); // force the panel to re-read; his call just changed the set
    } catch (e) {
      setData((d) => ({ ...d, rows: d.rows.map((r) => (r.id === founderId ? { ...r, triage: prev } : r)) }));
      setErr(e.message);
    }
  }

  async function onUndo() {
    if (!undo) return;
    try {
      const restored = await api.restorePipelineCompany(undo.id);
      setData((d) => ({ ...d, rows: [...d.rows, restored] }));
      setUndo(null);
    } catch (e) { setErr(e.message); }
  }

  if (err && !data) return <div className="p-4 text-small text-danger">{err}</div>;

  return (
    <div className="flex flex-col h-full">
      {composing && <Composer onCreate={onCreate} onClose={() => setComposing(false)} />}

      {/* The undo. Sits until he dismisses it rather than timing out — a 5-second
          toast is a delete he can't take back if he looks away, which makes the
          delete button something he learns not to press. */}
      {undo && (
        <div className="px-3 h-8 flex items-center gap-2 border-b border-line bg-accent-soft flex-shrink-0">
          <span className="text-mini text-ink flex-1">{undo.label}</span>
          <button onClick={onUndo} className="text-mini font-medium text-accent hover:text-accent-hover">Undo</button>
          <button onClick={() => setUndo(null)} className="text-mini text-ink-4 hover:text-ink">Dismiss</button>
        </div>
      )}

      {/* A save/delete that failed while the board is still usable. Not a full-page
          error — losing the board because one write 500'd would be worse than the bug. */}
      {err && data && (
        <div className="px-3 h-8 flex items-center gap-2 border-b border-line bg-danger-soft flex-shrink-0">
          <span className="text-mini text-danger flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="text-mini text-ink-4 hover:text-ink">Dismiss</button>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-2 bg-ground flex-shrink-0">
        <span className="text-small font-semibold text-ink">Pipeline</span>
        <span className="text-mini text-ink-4">your ledger — nothing here touches the team's Airtable until you drag to 4a</span>
        <button
          onClick={() => setComposing(true)}
          className="px-2 h-6 rounded text-mini font-medium bg-ground-4 text-ink hover:bg-line"
          title="Add a company (N)"
        >
          + New
        </button>
        <input
          className="input w-44 border-0 bg-transparent focus:ring-0 px-0 ml-2"
          placeholder="Filter…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(0); }}
        />
        {stage && (
          <button
            onClick={() => setParams({})}
            className="px-2 h-6 rounded text-mini font-medium bg-ground-4 text-ink capitalize"
            title="Clear the filter from Home"
          >
            {stage} <span className="text-ink-4 ml-1">×</span>
          </button>
        )}
        <div className="flex-1" />

        {/* The track filter is gone. Tracks were an Airtable concept — this board
            is Danny's own five stages now, and nothing here is sliced by team
            track. */}
        <div className="flex items-center gap-px ml-2 border-l border-line-2 pl-2">
          {[
            { k: 'kanban', label: 'Board' },
            { k: 'list', label: 'Table' },
          ].map((v) => (
            <button
              key={v.k}
              onClick={() => setView(v.k)}
              className={`px-2 h-6 rounded text-mini font-medium transition ${
                view === v.k ? 'bg-ground-4 text-ink' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          className={`ml-2 px-2 h-6 rounded text-mini font-medium transition ${
            showLearning ? 'bg-ground-4 text-ink' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
          }`}
          onClick={async () => {
            const next = !showLearning;
            setShowLearning(next);
            if (next && !learning) {
              try { setLearning(await api.getPipelineLearning()); } catch (e) { setErr(e.message); }
            }
          }}
        >
          What you advance
        </button>
        <span className="num text-mini text-ink-4 pl-2">{rows.length}</span>
      </div>
      {showLearning && <Learning data={learning} onClose={() => setShowLearning(false)} />}

      {!data ? (
        <div className="flex-1 p-3">
          <div className="flex gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex-1 border border-line rounded-md p-2 space-y-2">
                {Array.from({ length: 3 }).map((__, j) => (
                  <div key={j} className="h-8 bg-ground-3 rounded-sm" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : view === 'kanban' ? (
        <div className="flex-1 overflow-auto p-3">
          <KanbanBoard
            founders={rows}
            // The five stages come from the server (server/lib/ledgerStages.js).
            // The client keeps no copy — that is how the old board drifted.
            stages={(data.stages || []).map((s) => s.key)}
            stageField="ledger_stage"
            stageLabels={stageLabel}
            showAllStages
            tracks={[]}
            onStageChange={onLedgerStageChange}
            onDelete={onDelete}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center h-6 px-3 border-b border-line-2 bg-ground-3 text-micro font-semibold uppercase text-ink-4 flex-shrink-0">
            <span className="flex-[3] min-w-0">Company</span>
            <span className="flex-[2] min-w-0">Founder</span>
            <span className="w-20">Stage</span>
            <span className="w-24">Read · Stu</span>
            <span className="w-24">Call · You</span>
            <span className="w-14 text-right">Owed</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="px-3 py-4 text-small text-ink-3">
                Nothing here.{' '}
                <button className="text-accent" onClick={() => nav('/sourcing')}>Go find someone →</button>
              </div>
            ) : (
              rows.map((r, i) => (
                <div
                  key={r.id}
                  onClick={() => nav(`/founders/${r.id}`)}
                  onMouseEnter={() => setCursor(i)}
                  className={`row px-3 cursor-pointer ${i === cursor ? 'row-selected' : ''}`}
                >
                  {/* The ONE primary ink in the row. flex-none so the one-liner
                      truncates instead of crushing the company name to 16px. */}
                  <span className="flex-[3] min-w-0 flex items-baseline gap-2">
                    <span className="row-primary flex-none max-w-[200px]">{r.company || r.person || r.name}</span>
                    {r.company_one_liner && <span className="row-meta min-w-0 hidden xl:inline">{r.company_one_liner}</span>}
                  </span>
                  <span className="flex-[2] min-w-0 text-ink-2 truncate">
                    {r.person || <span className="text-ink-4">—</span>}
                  </span>
                  <span className="w-20 text-ink-3 text-mini">{stageLabel[r.ledger_stage] || r.ledger_stage || '—'}</span>
                  <span className="w-24"><Band band={r.stu_band} score={r.stu_score} muted /></span>
                  <span className="w-24"><Band band={r.my_band} /></span>
                  <span className="w-14 text-right num text-mini">
                    {r.they_owe > 0 ? <span className="text-ink font-medium">{r.they_owe}</span>
                      : r.i_owe > 0 ? <span className="text-ink-2">{r.i_owe}</span>
                      : <span className="text-ink-4">—</span>}
                  </span>
                  <Triage row={r} onSet={onTriage} />
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-3 px-3 h-6 border-t border-line-2 bg-ground text-micro text-ink-4 flex-shrink-0">
            <span><kbd className="text-ink-3">j</kbd>/<kbd className="text-ink-3">k</kbd> move</span>
            <span><kbd className="text-ink-3">↵</kbd> open the card</span>
          </div>
        </>
      )}
    </div>
  );
}

