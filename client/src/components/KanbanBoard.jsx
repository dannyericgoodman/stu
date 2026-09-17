import { useState, useMemo } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useSensor, useSensors,
  closestCorners, useDroppable, useDraggable,
} from '@dnd-kit/core';
import { useNavigate } from 'react-router-dom';

// ══════════════════════════════════════════════════════════════════════════
// The board. Move companies you already know through your deal stages.
//
// Rewritten onto the design system. What it replaced had colored columns (blue,
// yellow), avatar circles, colored badges, and cards so tall only three fit on a
// screen — and it led with the PERSON's name on a board of COMPANIES.
//
// Three rules it now obeys:
//   · Color means state, never decoration. The columns are hairlines and ground.
//     A stage is a POSITION, and position is already the signal; painting it too
//     says the same thing twice in a louder voice.
//   · One primary ink per card — the company. The founder recedes.
//   · A stage badge on a card sitting in that stage's column is one bit of
//     information printed twice. Gone.
//
// ── THE (NO STAGE) COLUMN IS NOT A STYLE CHOICE ──
// The old board did `f[stageField] || stages[0]` and silently dumped every
// stage-less company into the first column — which is how a column read 71 when
// only 40 companies actually carried that status. That is the same failure as a
// going-cold clock computed off an import date: an absence rendered as a definite
// state. It kept its own column, and that column said what it was.
//
// It is now almost always empty, and deliberately so: the server only sends cards
// that HAVE a stage (routes/pipeline.js), because a card with no stage is not an
// opportunity — it's untriaged sourcing output, and it belongs in Sourcing. The
// column stays for the case the server is wrong. An empty lane costs one hairline.
//
// ── ONE BOARD, ONE AXIS, AND A BADGE ──
// Danny: "Let's merge Investment and Admissions pipelines, consolidating.
// Investment and/or Admissions Pipeline should be a badge I can edit on each card,
// similar to what I have in Airtable."
//
// So `stage_status` is the only axis, spelled in Airtable's words, and the
// Resident/Investment track moved from being a whole separate BOARD to a chip on
// the card. This mirrors how Airtable models it — one Admission Status field, one
// Pipeline multi-select — which is the point: the tool should read like the base
// he actually maintains.
// ══════════════════════════════════════════════════════════════════════════

const NO_STAGE = '(no stage)';

// A stage nobody is in AND nobody moves INTO on purpose. Airtable's option list
// carries history — "Stage 0: Legacy (Density)" predates the fund, and the two
// Resident-Only Stage 3s were never adopted. Rendering an empty lane for each
// would put four dead columns between Danny and the deals he's working.
// An empty lane he might legitimately drag into (Stage 2, Stage 4) still shows.
const isDeadEnd = (s) => /^Stage 0:/.test(s) || /^Stage 5:/.test(s);

export default function KanbanBoard({ founders, stages, tracks, onStageChange, onTracksChange, onDelete,
  // The ledger (2026-09-17) reuses this board over its own axis: pass
  // stageField="ledger_stage" plus stageLabels for the column headers, and
  // showAllStages so all five ledger stages render even when empty. Passing
  // tracks={[]} hides the track badges — tracks are an Airtable concept and the
  // ledger is Danny's personal workflow.
  stageField = 'stage_status', stageLabels = null, showAllStages = false }) {
  const [activeId, setActiveId] = useState(null);
  const nav = useNavigate();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const { columns, order } = useMemo(() => {
    const grouped = { [NO_STAGE]: [] };
    for (const s of stages) grouped[s] = [];
    for (const f of founders) {
      const s = f[stageField];
      if (!s) grouped[NO_STAGE].push(f);
      else if (grouped[s]) grouped[s].push(f);
      else grouped[s] = [f]; // a stage not in the canonical list still shows itself
    }
    // 12 stages is a lot of horizontal travel, and Airtable's list carries options
    // Danny's book has never used (Stage 0, the two Resident-Only Stage 3s). Show a
    // lane if it holds anything; otherwise show it only if it's a live stage he
    // could plausibly drag into. Terminal stages with nothing in them are noise.
    // (The ledger opts out: its five stages are all live, always.)
    const keys = Object.keys(grouped)
      .filter((k) => k !== NO_STAGE)
      .filter((k) => grouped[k].length > 0 || showAllStages || !isDeadEnd(k));
    return { columns: grouped, order: grouped[NO_STAGE].length ? [NO_STAGE, ...keys] : keys };
  }, [founders, stages, stageField, showAllStages]);

  const active = activeId ? founders.find((f) => String(f.id) === String(activeId)) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setActiveId(e.active.id)}
      onDragEnd={(e) => {
        setActiveId(null);
        const { active: a, over } = e;
        if (!over) return;
        const to = String(over.id);
        const f = founders.find((x) => String(x.id) === String(a.id));
        // Dropping into (no stage) would mean "un-decide", which isn't a thing you
        // do on purpose. And a no-op drag must never fire a write.
        if (!f || to === NO_STAGE || f[stageField] === to) return;
        onStageChange(f.id, to);
      }}
    >
      <div className="flex gap-2 items-start h-full">
        {order.map((stage) => (
          <Column
            key={stage}
            id={stage}
            label={(stageLabels && stageLabels[stage]) || stage}
            rows={columns[stage]}
            unstaged={stage === NO_STAGE}
            allTracks={tracks}
            onTracksChange={onTracksChange}
            onDelete={onDelete}
            onOpen={(id) => nav(`/founders/${id}`)}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>{active ? <Card row={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ id, label, rows, unstaged, onOpen, allTracks, onTracksChange, onDelete }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`w-[220px] flex-none flex flex-col rounded-md border transition ${
        isOver && !unstaged ? 'border-accent bg-accent-soft' : 'border-line-2 bg-ground-2'
      }`}
    >
      <div className="flex items-center gap-2 h-6 px-2 border-b border-line flex-shrink-0">
        {/* The stage name is the label. No dot, no hue — the column IS the state. */}
        <span className={`text-micro font-semibold uppercase truncate ${unstaged ? 'text-ink-4' : 'text-ink-2'}`}>
          {label}
        </span>
        <div className="flex-1" />
        <span className="num text-micro text-ink-4">{rows.length}</span>
      </div>

      <div className="p-1 space-y-1 overflow-y-auto max-h-[calc(100vh-160px)]">
        {unstaged && rows.length > 0 && (
          // Says what it is rather than pretending. These aren't under
          // consideration — nobody has said anything about them yet.
          <p className="text-mini text-ink-4 px-1 pb-1 leading-snug">
            No deal stage set. Drag one onto a column to start tracking it.
          </p>
        )}
        {rows.map((r) => (
          <Card key={r.id} row={r} onOpen={onOpen} allTracks={allTracks} onTracksChange={onTracksChange} onDelete={onDelete} />
        ))}
        {!rows.length && !unstaged && (
          <div className="h-8 flex items-center justify-center text-mini text-ink-4">—</div>
        )}
      </div>
    </div>
  );
}

const BAND_LABEL = { anchor: 'Anchor', memo: 'Memo', monitor: 'Monitor', pass: 'Pass', indeterminate: 'Held' };

// ── THE TRACK BADGE ──
// Danny: "a badge I can edit on each card, similar to what I have in Airtable."
//
// Two chips, R and I. Lit = on that track. Click toggles, and the toggle writes
// through to Airtable's Pipeline multi-select (routes/pipeline.js PATCH /:id/tracks).
//
// Why single letters: the card is 220px and the company name is the one primary
// ink on it. "Resident" and "Investment" spelled out would be two more strings
// competing with the name for the same eye. The title attribute carries the word.
//
// Why onPointerDown stops propagation: this chip sits inside a draggable card. The
// drag sensor claims the pointer at 8px of travel, so without this a click that
// wobbles becomes a drag and the badge silently never toggles.
function TrackBadge({ row, allTracks, onTracksChange }) {
  // An explicitly empty track list means "no track axis here" (the personal
  // ledger, 2026-09-17) — render nothing rather than the default badges.
  if (Array.isArray(allTracks) && allTracks.length === 0) return null;
  const on = new Set(row.tracks || []);
  const opts = allTracks && allTracks.length ? allTracks : ['Resident', 'Investment'];

  return (
    <div className="flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
      {opts.map((t) => {
        const lit = on.has(t);
        return (
          <button
            key={t}
            title={lit ? `${t} — click to remove` : `Add to ${t}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!onTracksChange) return;
              const next = lit ? [...on].filter((x) => x !== t) : [...on, t];
              onTracksChange(row.id, next);
            }}
            className={`w-4 h-4 rounded-sm text-micro font-semibold leading-none transition ${
              lit
                ? 'bg-ink-2 text-ground border border-ink-2'
                : 'bg-transparent text-ink-4 border border-line-2 hover:border-line-3 hover:text-ink-3'
            }`}
          >
            {t[0]}
          </button>
        );
      })}
    </div>
  );
}

// Airtable's one-liner field is a working field, so it holds working notes — seen on
// the real board: "(Exited Founder) To be added", rendered as if it were an insight.
// A placeholder is not a claim about the company; it's an empty field with words in it.
// Show nothing rather than dress a TODO as a thesis.
const PLACEHOLDER = /^\s*(\(.*\)\s*)?(to be added|tbd|n\/?a|todo|coming soon|—|-)\s*$/i;

function insightOf(row) {
  if (row.stu_read) return row.stu_read;
  const c = (row.company_one_liner || '').trim();
  if (!c || PLACEHOLDER.test(c) || c.length < 12) return null;
  return c;
}

function Card({ row, onOpen, dragging, allTracks, onTracksChange, onDelete }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: String(row.id) });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !dragging && onOpen && onOpen(row.id)}
      className={`group bg-ground border rounded-sm px-2 py-1.5 cursor-pointer select-none transition ${
        dragging ? 'border-line-3 rotate-1' : 'border-line hover:border-line-3'
      } ${isDragging && !dragging ? 'opacity-30' : ''}`}
    >
      {/* ONE primary ink: the company. This is a board of companies, so the founder
          recedes — the old card had it exactly the other way round. */}
      <div className="flex items-baseline gap-1">
        <span className="text-small font-medium text-ink truncate flex-1">
          {row.company || row.person || row.name}
        </span>
        {row.investment_amount > 0 && (
          <span className="text-micro text-ink-4 flex-none" title="Portfolio company">●</span>
        )}
        {/* Danny: "I need to be able to create and delete the cards themselves."
            Hidden until hover: 184 always-visible × buttons would be 184 invitations
            to misclick on a board whose primary gesture is drag.

            Both handlers stop propagation, and they stop DIFFERENT things —
            onPointerDown keeps dnd-kit from reading the press as the start of a drag,
            onClick keeps the card from opening underneath. Missing either one makes
            the button look broken in a way that reads as a flaky board. */}
        {onDelete && !dragging && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(row.id); }}
            className="flex-none text-micro text-ink-4 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity px-1 -mr-1"
            title={`Remove ${row.company || row.person || 'this card'} from the board`}
          >
            ×
          </button>
        )}
      </div>

      {row.person && <div className="text-mini text-ink-3 truncate">{row.person}</div>}

      {/* THE INSIGHT. Danny, looking at this board: "I just want insights posted
          there." The card carried company / person / next step — the SHAPE of the
          pipeline, and nothing Stu had ever learned about them.

          Stu's read wins over Airtable's one-liner when it exists, because they are
          different kinds of thing: Airtable's is the founder's pitch about themselves
          ("Netflix for AI-created content"), Stu's is the read after listening to them
          ("Young founder with strong velocity... but synthesized insight and unclear
          team composition"). A claim vs a judgment. The board should carry judgment,
          and fall back to the claim only when there's no judgment yet. */}
      {insightOf(row) && (
        <div
          className={`text-micro mt-1 leading-snug line-clamp-2 ${row.stu_read ? 'text-ink-3' : 'text-ink-4 italic'}`}
          title={insightOf(row)}
        >
          {insightOf(row)}
        </div>
      )}

      {/* Airtable's OTHER axis. The stage says where they stand; this says what is
          physically next ("Scheduling 2nd Mtg", "Active Evaluation"). Stu used to
          mash both into one status field and destroy this one — "Stage 5: Not
          Admitted / 1st Mtg Scheduled" collapsed to a single word. It's the most
          actionable string on the card, so it gets its own line. */}
      {row.airtable_next_step && (
        <div className="text-micro text-ink-4 truncate mt-0.5" title={row.airtable_next_step}>
          {row.airtable_next_step}
        </div>
      )}

      <div className="flex items-center gap-2 mt-1">
        <TrackBadge row={row} allTracks={allTracks} onTracksChange={onTracksChange} />

        {/* Bands are typographic. A colored verdict tells him what to think before
            he has read the evidence. His call outranks Stu's read. */}
        {row.my_band ? (
          <span className={`band band-${row.my_band}`}>{BAND_LABEL[row.my_band]}</span>
        ) : row.stu_band ? (
          <span className={`band band-${row.stu_band} opacity-60`} title="Stu's read — your call is still open">
            {BAND_LABEL[row.stu_band]}
          </span>
        ) : null}

        <div className="flex-1" />
        {/* Urgency is a promotion up the ink ramp, not a new hue. */}
        {row.they_owe > 0 && (
          <span className="num text-micro text-ink font-medium" title={`${row.they_owe} owed to you`}>
            {row.they_owe} owed
          </span>
        )}
      </div>
    </div>
  );
}
