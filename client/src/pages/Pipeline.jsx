import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import KanbanBoard from '../components/KanbanBoard';

// ══════════════════════════════════════════════════════════════════════════
// Pipeline — managing companies you're already tracking.
//
// Danny, 2026-07-15: "we're conflating two actions here: 1) I need an inbox to
// study and triage new founders (true sourcing) and 2) the ability to manage a
// pipeline (like a kanban)... right now, this screen is a jumble."
//
// He was right. The insight that Stu has ONE object moving through stages is
// about the DATA, not the SCREENS — Affinity and Attio both have one substrate
// AND separate surfaces. So sourcing moved to its own screen and this one does
// one job: move companies you know through your deal stages.
//
// ── ONE BOARD (2026-07-16) ──
// Danny: "Let's merge Investment and Admissions pipelines, consolidating.
// Investment and/or Admissions Pipeline should be a badge I can edit on each card,
// similar to what I have in Airtable."
//
// There were two boards over two different stage axes, and a toggle between them.
// Now there is one board over `stage_status` — Airtable's Admission Status,
// verbatim — and the Resident/Investment track is a chip on the card. That is how
// Airtable itself models it: one stage field, one Pipeline multi-select. The
// Investment/Resident buttons in the header are a FILTER over the one board, not
// a mode that swaps it.
//
// ── WHY THE KANBAN GROUPS BY stage_status, NOT THE DERIVED FUNNEL ──
// There are two different "stage" ideas in this product and they must not be
// confused:
//
//   stage_status   — WHERE THEY STAND, in Airtable's words. Editable: this is what
//                    a card DRAGS between, and the drag writes through to the
//                    team's Airtable base so the two can't disagree.
//   funnel_stage   — DERIVED from evidence (found/met/assessed/decided/invested).
//                    Read-only by construction: you cannot drag a card to make a
//                    company "assessed" — either an assessment exists or it
//                    doesn't. Dragging into it would be a lie.
//
// So the kanban is the workflow, and the derived read lives in the table view and
// on Home. A board you can drag has to write something real.
//
// `deal_status` is no longer an axis here. It survives on the card as history and
// as what backfill-stage-status derived the 26 Investment-Pipeline orphans from.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// THE STAGE LIST USED TO LIVE HERE. It doesn't anymore — the server sends it
// (routes/pipeline.js → `vocab`), read from Airtable's own schema via
// lib/airtableVocab. Danny: "Use Airtable right now as the source of truth for the
// correct stage." A copy of the list in the client is a copy that drifts, and
// drift in exactly this list is what put 22 declined founders back on the board.
//
// Worth recording what the deleted constants claimed, because it is the lesson:
// the comment above DEAL_STAGES asserted "First Meeting, Partner Call, Memo Draft,
// IC Review and Committed had ZERO rows each" and "Family office 3". Measured
// against production the day it was deleted: Committed 8, IC Review 4, First
// Meeting 3 — and Family office ZERO. Every number was wrong, and inverted. A
// hand-maintained list of what the data looks like starts rotting the moment it's
// written; the data is right there and can simply be asked.
// ══════════════════════════════════════════════════════════════════════════

const BAND_LABEL = { anchor: 'Anchor', memo: 'Memo', monitor: 'Monitor', pass: 'Pass', indeterminate: 'Held' };

// The band renders as weight and position on the ink ramp, never as color. A
// colored verdict tells him what to think before he's read the evidence.
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
              his alone until he drags it. */}
          <span className="text-micro text-ink-4 flex-1 truncate" title="A card you add here stays in Stu. Only dragging it to a new stage writes to Airtable.">
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
  // Default to the flat bank, not the Airtable-shaped board. Danny tracks deal
  // progress in Airtable; what he wants HERE is the list of founders he picked out of
  // Source, in one place, so he can keep track of them. A kanban mirroring someone
  // else's stage vocabulary is a second copy of a system that already exists — and a
  // second copy is a thing to drift. An existing saved preference still wins.
  const [view, setView] = useState(() => localStorage.getItem('stu_pipeline_view') || 'list');
  // '' = the whole board. There is one board now; Investment/Resident narrow it.
  const [track, setTrack] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [composing, setComposing] = useState(false);
  const [undo, setUndo] = useState(null);
  const stage = params.get('stage') || '';

  useEffect(() => { localStorage.setItem('stu_pipeline_view', view); }, [view]);

  // ── One fetch, not one per track ──
  // This used to refetch whenever the track flipped, because the two tracks were
  // two different boards over two different stage axes. They're one board now, so
  // the track is a filter over rows already in memory: zero requests, zero flicker,
  // and no stale-while-revalidate dance to get wrong.
  useEffect(() => {
    let dead = false;
    api.getPipeline({}).then((d) => !dead && setData(d)).catch((e) => !dead && setErr(e.message));
    return () => { dead = true; };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    let out = data.rows;
    if (track) out = out.filter((r) => (r.tracks || []).includes(track));
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
  }, [data, stage, q, track]);

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

  // ── The two writes on this board ──
  // Both are optimistic, and both RE-FETCH on failure rather than leaving the
  // optimistic state on screen. Danny drags a card, Stu writes it, and Stu pushes
  // it to Airtable (his call: "Drag in Stu, and it writes to Airtable"). If the
  // push fails, the card must snap back — showing a move that didn't happen is the
  // exact bug that let this board lie for four months.
  async function onStageChange(founderId, newStage) {
    const prev = data;
    setData((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === founderId ? { ...r, stage_status: newStage } : r)),
    }));
    try {
      const r = await api.setPipelineStage(founderId, newStage);
      // The write landed in Stu but Airtable refused it. Say so — a silent
      // divergence between the board and the team's base is how this rots.
      if (r?.airtable?.error) setErr(`Saved in Stu, but Airtable rejected it: ${r.airtable.error}`);
    } catch (e) {
      setErr(e.message);
      setData(prev);
    }
  }

  async function onTracksChange(founderId, nextTracks) {
    const prev = data;
    setData((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === founderId ? { ...r, tracks: nextTracks } : r)),
    }));
    try {
      const r = await api.setPipelineTracks(founderId, nextTracks);
      if (r?.airtable?.error) setErr(`Saved in Stu, but Airtable rejected it: ${r.airtable.error}`);
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

        {/* ── The track toggle is gone, on purpose ──
            It used to switch between two boards over two different stage axes.
            Danny: "Let's merge Investment and Admissions pipelines, consolidating."
            The track is now a badge on the card, so this is a FILTER, not a mode:
            "All" is the real board and these narrow it. Same rows either way. */}
        <div className="flex items-center gap-px">
          {[
            { k: '', label: 'All' },
            { k: 'Investment', label: 'Investment' },
            { k: 'Resident', label: 'Resident' },
          ].map((t) => (
            <button
              key={t.k || 'all'}
              onClick={() => setTrack(t.k)}
              className={`px-2 h-6 rounded text-mini font-medium transition ${
                track === t.k ? 'bg-ground-4 text-ink' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
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
        <span className="num text-mini text-ink-4 pl-2">{rows.length}</span>
      </div>

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
            // The stage list comes from the server, which reads it from Airtable's
            // own schema. The client keeping its own copy is how the two drift.
            stages={data.vocab?.stages || []}
            tracks={data.vocab?.tracks || []}
            onStageChange={onStageChange}
            onTracksChange={onTracksChange}
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
                  <span className="w-20 text-ink-3 text-mini capitalize">{r.funnel_stage}</span>
                  <span className="w-24"><Band band={r.stu_band} score={r.stu_score} muted /></span>
                  <span className="w-24"><Band band={r.my_band} /></span>
                  <span className="w-14 text-right num text-mini">
                    {r.they_owe > 0 ? <span className="text-ink font-medium">{r.they_owe}</span>
                      : r.i_owe > 0 ? <span className="text-ink-2">{r.i_owe}</span>
                      : <span className="text-ink-4">—</span>}
                  </span>
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

