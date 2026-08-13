import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';

// ══════════════════════════════════════════════════════════════════════════
// The Read — two columns that never merge.
//
// Danny: "This should run a comprehensive diligence check on the company
// (product, team, market, etc). It should cover all the bases to equip me to
// write a full-fledged memo on the company. In fact, it should be pretty close to
// a memo. And I should be able to add my own thoughts."
//
// And from his own analysis, the thing this page exists to fix:
//   "I don't bring anything to IC. It's really annoying... I should be the deal
//    leader. So I need the info to be able to take on that role."
//
// ── WHAT I DID NOT REBUILD ──
// The engine. conviction.js is 563 lines where every refusal is load-bearing and
// every comment records a real bug found empirically. The agents, the rubric-first
// ordering, temperature 0, the 8192 token ceiling, the retry wrapper — all of it
// stays. The nightly workup task also out-researches Stu (web access, cited URLs,
// a 4-lens panel) and this does not compete with it.
//
// What was missing was never the analysis. It was a PLACE FOR DANNY. The old page
// was 1,541 lines with literally zero <input> or <textarea> — and a section that
// rendered, on every assessment, forever:
//
//     Personal conviction
//     Unanswered
//     Your call. Stu does not assess this.
//
// An honest placeholder for the exact hole he keeps asking me to fill.
//
// ── BLIND-FIRST, AND WHY IT'S NOT A GIMMICK ──
// His call is entered BEFORE Stu's read unlocks. If he reads a 7.8 and then types
// his view, that isn't calibration — it's priming, and the disagreement record it
// produces is worthless because it can only ever measure how much he anchors.
//
// Portfolio Pattern Analysis names the blind spot this serves: "you pass well on
// markets, poorly on documentation — and the gap is exactly on your best founders
// ... you can't tell whether those were good passes or fear/laziness." The only
// cure is a dated view recorded BEFORE the outcome is known. That's this screen.
//
// The gap between his band and Stu's is the artifact. It's the only dataset here
// that compounds, and the only question no tool he can buy can answer — because
// answering it requires a record of what he thought before he knew.
// ══════════════════════════════════════════════════════════════════════════

const BANDS = [
  { key: 'anchor', label: 'Anchor-grade', hint: 'First call within a week' },
  { key: 'memo', label: 'Top-quartile', hint: 'Write a memo' },
  { key: 'monitor', label: 'Monitor', hint: 'Track the next data point' },
  { key: 'pass', label: 'Pass with respect', hint: 'Pass' },
];

const RUNNING_STATES = new Set(['processing_inputs', 'running', 'synthesizing']);

export default function Read() {
  const { id } = useParams();
  const nav = useNavigate();
  const [a, setA] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () => api.getAssessment(id).then((d) => { setA(d); return d; }).catch((e) => { setErr(e.message); }),
    [id],
  );
  // Poll while the read is still running. Runs take ~5-6 min (nine lenses on Opus), so a
  // one-shot load would leave a stale "still reading" — or, once unlocked mid-run, the
  // misleading "predates the engine" state — until a manual refresh.
  useEffect(() => {
    let timer;
    const tick = () => load().then((d) => { if (d && RUNNING_STATES.has(d.status)) timer = setTimeout(tick, 3000); });
    tick();
    return () => clearTimeout(timer);
  }, [load]);

  if (err) return <div className="p-4 text-small text-danger">{err}</div>;
  if (!a) return <ReadSkeleton />;

  // Has Danny already ruled? If so the read is unlocked — the blind window has
  // closed and re-hiding it would just be theatre.
  const decided = !!a.decision;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-2 bg-ground flex-shrink-0">
        <button onClick={() => nav('/pipeline')} className="text-mini text-ink-4 hover:text-ink">← Pipeline</button>
        <span className="text-ink-4">/</span>
        {a.founder_id ? (
          <Link to={`/founders/${a.founder_id}`} className="text-small font-semibold text-ink hover:text-accent">
            {a.founder_company || a.founder_name}
          </Link>
        ) : (
          <span className="text-small font-semibold text-ink">{a.founder_company || a.founder_name}</span>
        )}
        <span className="text-mini text-ink-4">{String(a.created_at).slice(0, 10)}</span>
        <div className="flex-1" />
        <Status a={a} />
      </div>

      <div className="grid grid-cols-2 flex-1 min-h-0 divide-x divide-line-2">
        <YourCall assessment={a} onDecided={load} />
        <TheRead assessment={a} locked={!decided} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LEFT — YOUR CALL. His column. Stu never writes here.
// ══════════════════════════════════════════════════════════════════════════
function YourCall({ assessment: a, onDecided }) {
  const d = a.decision;
  const [band, setBand] = useState(d?.band || '');
  const [rationale, setRationale] = useState(d?.rationale || '');
  const [prediction, setPrediction] = useState(d?.prediction || '');
  const [resolveBy, setResolveBy] = useState(d?.resolve_by || defaultResolveBy());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      await api.createDecision({
        founder_id: a.founder_id,
        assessment_id: a.id,
        band, rationale, prediction, resolve_by: resolveBy,
      });
      onDecided();
    } catch (e) {
      // The server refuses a decision with no prediction and says why. Surface
      // its sentence rather than a generic failure — the refusal IS the teaching.
      setError(e.detail ? `${e.message} ${e.detail}` : e.message);
    } finally {
      setSaving(false);
    }
  }

  if (d) return <DecisionMade decision={d} stuBand={a.conviction_band} stuScore={a.conviction_score} />;

  return (
    <div className="overflow-y-auto p-4 space-y-5">
      <div>
        <h2 className="text-large font-semibold text-ink">Your call</h2>
        <p className="text-small text-ink-3 mt-1 max-w-md leading-relaxed">
          Before you read Stu's. You've seen the deck and taken the call — that view is the
          one worth recording, and it stops being yours the moment you read a number.
        </p>
      </div>

      {/* The rubric's own separate gate, quoted from Brain/02 Frameworks:
          "We don't invest in founders we don't want to be around, or whose vision
          doesn't resonate." It is deliberately not part of the quality score. */}
      <div className="rounded border border-line-2 bg-ground-2 px-3 py-2">
        <p className="text-small text-ink-2 leading-relaxed">
          Would you want to work with them for ten years — and would you take this call again
          if there were no deal in it?
        </p>
      </div>

      <div>
        <label className="label">Your verdict</label>
        <div className="space-y-1">
          {BANDS.map((b) => (
            <button
              key={b.key}
              onClick={() => setBand(b.key)}
              className={`w-full flex items-baseline gap-2 px-2 h-row rounded text-left transition ${
                band === b.key ? 'bg-ground-4 text-ink' : 'text-ink-2 hover:bg-ground-3'
              }`}
            >
              <span className="text-small font-medium w-32">{b.label}</span>
              <span className="text-mini text-ink-4">{b.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Why — one line</label>
        <textarea
          className="textarea"
          rows={3}
          placeholder="What actually decided it?"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </div>

      {/* ── The required prediction. This is the whole design of the metric. ──
          A pass without a dated checkable claim is a reflex, not a decision. His
          most common kill is a ten-second "cool but indefensible", and a bare
          pass=+1 would pay him to fire it faster. In 12 months the prediction is
          the only thing that can tell a good pass from a fast one. */}
      <div>
        <label className="label">A dated, checkable claim</label>
        <textarea
          className="textarea"
          rows={2}
          placeholder="Something that will be provably right or wrong. Not &quot;they'll do well&quot; — &quot;they'll have 3 paying customers by October.&quot;"
          value={prediction}
          onChange={(e) => setPrediction(e.target.value)}
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-mini text-ink-4">We find out on</span>
          <input
            type="date"
            className="input w-40"
            value={resolveBy}
            onChange={(e) => setResolveBy(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-small text-danger leading-relaxed">{error}</p>}

      <button
        onClick={submit}
        disabled={saving || !band}
        className="btn-primary w-full justify-center"
      >
        {saving ? 'Recording…' : 'Record my verdict and show me Stu’s'}
      </button>
      <p className="text-micro text-ink-4">
        Recorded first, so the disagreement means something. You can't un-see a score.
      </p>
    </div>
  );
}

function DecisionMade({ decision: d, stuBand, stuScore }) {
  const disagreed = stuBand && stuBand !== 'indeterminate' && stuBand !== d.band;
  return (
    <div className="overflow-y-auto p-4 space-y-5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-large font-semibold text-ink">Your call</h2>
        <span className="text-mini text-ink-4">{String(d.decided_at).slice(0, 10)}</span>
      </div>

      <div>
        <div className={`band band-${d.band} text-large`}>{labelFor(d.band)}</div>
        {d.rationale && <p className="text-regular text-ink mt-2 leading-relaxed">{d.rationale}</p>}
      </div>

      {/* The gap. The only artifact here that compounds. */}
      {disagreed && (
        <div className="rounded border border-line-2 px-3 py-2">
          <div className="text-micro font-semibold uppercase text-ink-4 mb-1">You and Stu disagree</div>
          <p className="text-small text-ink-2 leading-relaxed">
            You said <span className="font-medium text-ink">{labelFor(d.band)}</span>. Stu read{' '}
            <span className="font-medium text-ink">{labelFor(stuBand)}</span>
            {stuScore != null && <span className="num"> ({stuScore})</span>}.
            {' '}This is the row worth keeping — in a year it's the only thing that can say who was right.
          </p>
        </div>
      )}

      <div>
        <div className="text-micro font-semibold uppercase text-ink-4 mb-1">Your prediction</div>
        <p className="text-regular text-ink leading-relaxed">{d.prediction}</p>
        <p className="text-mini text-ink-3 mt-1">
          We find out on <span className="num">{d.resolve_by}</span>
          {d.outcome && d.outcome !== 'unresolved' && (
            <span className="text-ink"> · you were {d.outcome}</span>
          )}
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// RIGHT — THE READ. Stu's. Locked until Danny has ruled.
// ══════════════════════════════════════════════════════════════════════════
function TheRead({ assessment: a, locked }) {
  if (locked) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="max-w-xs text-center">
          <p className="text-small text-ink-3 leading-relaxed">
            Stu's assessment is here. It stays covered until you've recorded yours — otherwise
            the disagreement measures how much you anchor, not who was right.
          </p>
        </div>
      </div>
    );
  }

  // Still running? Say so — don't fall through to "predates the engine" (which reads as
  // a stale, never-scored row) while the room is mid-read. Polling flips this to the real
  // read on completion.
  if (RUNNING_STATES.has(a.status)) return <StillReading a={a} />;

  const conv = parse(a.conviction_output);

  // ── Three states for the SCORE. The analysis renders regardless. ──
  //
  // "No score" means one of two completely different things and the screen must
  // never conflate them: either the engine RAN and honestly held for lack of
  // evidence, or the row predates the engine and was never scored at all. Saying
  // "not enough evidence" about a run that never happened is the same lie this
  // rebuild exists to remove.
  //
  // But my first pass returned EARLY on both, which threw away the whole read —
  // and 14 of Danny's 18 assessments predate the engine. Those rows have a
  // complete team/product/market/bear analysis and a defensibility section; only
  // the conviction NUMBER is absent. Hiding four months of real work because one
  // field is null is its own kind of dishonesty: it renders "we know nothing"
  // when the truth is "we know a lot and haven't scored it."
  //
  // So the score header is conditional. Everything below it is not.
  return (
    <div className="overflow-y-auto p-4 space-y-5">
      {!a.conviction_output ? (
        <PredatesEngine a={a} />
      ) : !conv?.determinate ? (
        <Held conv={conv} a={a} />
      ) : (
        <Verdict conv={conv} />
      )}

      {/* Above the movements, deliberately. "Cool but indefensible" is his most
          common kill and the fastest one to fire — it should be the first thing
          he can check the machine against, not something he finds at memo time. */}
      <Defensibility parts={a.defensibility} />
      {conv?.determinate && <Movements conv={conv} />}
      {conv?.determinate && <Docks conv={conv} />}
      {/* Lead with the decision, then the room, then the agenda. The panel is the
          felt experience of nine investors weighing in; abstentions are shown, not
          hidden, and every claim carries whether its evidence checked out. */}
      <Panel panel={a.panel} bear={a.bear} synthesis={parse(a.synthesis_output)} />
      <Agenda agenda={a.agenda} />
      <Memo a={a} />
      {conv?.calibration && (
        <p className="text-micro text-ink-4 leading-relaxed border-t border-line pt-3">{conv.calibration}</p>
      )}
    </div>
  );
}

function Defensibility({ parts }) {
  if (!parts?.length) return null;
  return (
    <div className="border-t border-line pt-3">
      <div className="text-micro font-semibold uppercase text-ink-4 mb-2">Defensibility</div>
      <div className="space-y-2">
        {parts.map((p) => (
          <div key={p.label}>
            <div className="text-mini text-ink-4">{p.label}</div>
            <p className="text-small text-ink-2 leading-relaxed whitespace-pre-wrap">{p.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Verdict({ conv }) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-display num text-ink">{conv.score}</span>
        <div>
          <div className={`band band-${conv.band.key} text-regular`}>{conv.band.label}</div>
          <div className="text-mini text-ink-3">{conv.band.action}</div>
        </div>
      </div>
      <p className="text-mini text-ink-3 mt-2">
        Evidence: {conv.rung_label}
        {conv.gate_applied && ' · capped — the load-bearing movements did not clear'}
      </p>
    </div>
  );
}

// The two movements that SET the score. The other two can only move it ±1.
const LOAD_BEARING = ['earned_insight', 'execution_velocity'];

function Movements({ conv }) {
  // ── movements is an OBJECT keyed by movement name, not an array. ──
  // Found by running the engine for real: my first pass called .map() on it and
  // would have crashed the page — a bug that could ONLY ever appear on a
  // determinate score, which had never existed in this database until today.
  // Zero tests would have caught it, because there was no data shaped like this
  // to test against.
  //
  // Each value is { label, blurb, weight, evidence_strength, needs_rung, score,
  // scorable, fault, reason, evidence } — and `evidence` is the good part: the
  // engine's argument for the number, quoting the source.
  const entries = Object.entries(conv.movements || {});
  if (!entries.length) return null;

  return (
    <div className="border-t border-line pt-3">
      <div className="text-micro font-semibold uppercase text-ink-4 mb-2">The four movements</div>
      <div className="space-y-3">
        {entries.map(([key, m]) => {
          const lb = LOAD_BEARING.includes(key);
          return (
            <div key={key}>
              <div className="flex items-baseline gap-2">
                <span className={`text-small ${lb ? 'text-ink font-medium' : 'text-ink-2'}`}>{m.label}</span>
                {lb && <span className="text-micro text-ink-4">sets the score</span>}
                <div className="flex-1" />
                <span className="num text-small">
                  {m.score == null ? <span className="text-ink-4">—</span> : <span className="text-ink">{m.score}</span>}
                </span>
              </div>
              {/* The engine's reasoning, with its receipts. This is the whole
                  reason to read a score rather than just see it. */}
              {m.evidence && <p className="text-mini text-ink-3 leading-relaxed mt-0.5">{m.evidence}</p>}
              {!m.scorable && m.reason && (
                <p className="text-mini text-ink-3 leading-relaxed mt-0.5">Not scored — {m.reason}</p>
              )}
            </div>
          );
        })}
      </div>
      {conv.unscorable?.length > 0 && (
        <p className="text-mini text-ink-4 mt-2 leading-relaxed">
          {conv.unscorable.length} unscored. The engine abstains rather than defaulting to 5 — the rubric says
          default, the engine refuses, and the engine is right.
        </p>
      )}
    </div>
  );
}

function Docks({ conv }) {
  // ── Shape: { key, amount, why }. NOT { applied, reason }. ──
  // My first pass filtered on `.applied` — undefined, therefore falsy — so it
  // silently dropped the only dock on the first real run: bear -1.1. The score
  // read 4.8 with "docks -1.1" in the calculation string and no docks shown.
  //
  // Third shape I guessed wrong on this page (movements, docks, memo fields),
  // all three found the moment the engine produced a determinate score for the
  // first time. Writing a UI against an output shape that has never existed is
  // writing fiction; there was no data to check against until now.
  const docks = (conv.docks || []).filter((d) => d && d.amount);
  if (!docks.length) return null;
  return (
    <div className="border-t border-line pt-3">
      <div className="text-micro font-semibold uppercase text-ink-4 mb-2">Docks</div>
      {docks.map((d, i) => (
        <div key={i} className="flex items-baseline gap-2 py-0.5">
          <span className="num text-small text-ink w-10">{d.amount}</span>
          <span className="text-small text-ink-2 flex-1 leading-relaxed">{d.why || d.key}</span>
        </div>
      ))}
      {/* The engine's own arithmetic, stated. Danny should never have to trust
          the number — he should be able to check it. */}
      {conv.calculation && <p className="text-mini text-ink-3 mt-2 leading-relaxed">{conv.calculation}</p>}
      {conv.dock_capped && (
        <p className="text-micro text-ink-4 mt-1">Capped — docks can't overrule two bands of evidence.</p>
      )}
      {conv.dock_note && <p className="text-micro text-ink-4 mt-1">{conv.dock_note}</p>}
    </div>
  );
}

// The 7-M. Already built as a pure formatter over the agent outputs — no LLM
// call, no second opinion, no sampling. Danny asked for "pretty close to a memo"
// and this is it; it was just buried below the fold.
// ══════════════════════════════════════════════════════════════════════════
// THE MEMO HAS TO BE ABLE TO LEAVE THE BUILDING.
//
// Danny's stated goal: "I publish memos in Obsidian." His stated pain: "I don't
// bring anything to IC... I should be the deal leader."
//
// The 7-M memo was already assembled and already good — and it was a collapsed
// disclosure at the bottom of a column, with no copy, no export, no file. Every
// other thing in this product is upstream plumbing for an outlet that wasn't
// wired. A review panel called it worth more than the next four gaps combined,
// and they were right: an analysis that can't become a document he walks in with
// is a hobby.
//
// Copy → markdown, straight to the clipboard, paste into Obsidian. Not an
// integration, not a sync, not a new secret — the shortest path from "Stu did the
// analysis" to "Danny has a document". Open by default now, because a memo behind
// a ▸ is a memo nobody reads.
// ══════════════════════════════════════════════════════════════════════════
function Memo({ a }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(memoMarkdown(a));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied — the text is on screen either way */ }
  }

  if (!a.memo_7m?.length) return null;

  return (
    <div className="border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="text-small font-medium text-ink hover:text-accent">
          {open ? '▾' : '▸'} Deal memo — 7-M
        </button>
        <div className="flex-1" />
        <button onClick={copy} className="text-mini text-accent hover:text-accent-hover">
          {copied ? 'Copied — paste into Obsidian' : 'Copy as markdown'}
        </button>
      </div>
      {open && <MemoBody a={a} />}
    </div>
  );
}

// The document he walks in with. His verdict leads — it's his memo, not Stu's.
function memoMarkdown(a) {
  const d = a.decision;
  const co = a.founder_company || a.founder_name || 'Untitled';
  const L = [`# ${co} — Deal Memo`, '', `*${String(a.created_at).slice(0, 10)} · Danny Goodman · Superior Studios*`, ''];

  if (d) {
    L.push('## My call', '', `**${labelFor(d.band)}**`, '');
    if (d.rationale) L.push(d.rationale, '');
    L.push(`**Prediction:** ${d.prediction}`, `**We find out:** ${d.resolve_by}`, '');
    // The disagreement is the artifact. It belongs in the document, not just the DB —
    // walking into IC with "Stu read this Monitor, I read it Anchor, check me in
    // November" is the thing nobody else at that table can do.
    if (a.conviction_band && a.conviction_band !== 'indeterminate' && a.conviction_band !== d.band) {
      L.push(`> Stu read this **${labelFor(a.conviction_band)}**${a.conviction_score != null ? ` (${a.conviction_score})` : ''}. I disagree. Check me on ${d.resolve_by}.`, '');
    }
  }

  if (a.defensibility?.length) {
    L.push('## Defensibility', '');
    for (const p of a.defensibility) L.push(`**${p.label}.** ${p.body}`, '');
  }

  for (const s of a.memo_7m) {
    L.push(`## ${s.title}`, '');
    if (s.note) L.push(`*${s.note}*`, '');
    L.push(s.body, '');
  }

  // The room and its agenda leave the building too — a memo that names which lenses
  // spoke, what they saw, and where they split is one Danny can actually lead IC with.
  const spoke = (a.panel || []).filter((l) => l && l.applies !== false && !l.error);
  if (spoke.length || (a.bear && !a.bear.error)) {
    L.push('## The room', '');
    for (const l of spoke) {
      L.push(`**${l.label}.** ${[l.verdict, l.read].filter(Boolean).join(' ')}`, '');
    }
    if (a.bear && !a.bear.error) {
      L.push(`**The Bear (adversarial risk).** ${[a.bear.kill_shot_risk, a.bear.narrative].filter(Boolean).join(' ')}`, '');
    }
    const sat = (a.panel || []).filter((l) => l && l.applies === false);
    if (sat.length) L.push(`*Sat out: ${sat.map((l) => l.label).join('; ')}.*`, '');
  }

  if (a.agenda) {
    const lines = [];
    if (a.agenda.top_priorities?.length) {
      lines.push('**Start here:**');
      a.agenda.top_priorities.forEach((q) => lines.push(`1. ${typeof q === 'string' ? q : q?.q}`));
      lines.push('');
    }
    for (const [k, label] of [['founder', 'Ask the founder'], ['sme', 'Subject-matter expert'], ['expert_call', 'Expert-network call'], ['desktop', 'Desktop research']]) {
      const items = Array.isArray(a.agenda[k]) ? a.agenda[k] : [];
      if (!items.length) continue;
      lines.push(`**${label}:**`);
      items.forEach((it) => lines.push(`- ${typeof it === 'string' ? it : it?.q}${it?.why ? ` — ${it.why}` : ''}`));
      lines.push('');
    }
    if (lines.length) L.push('## Diligence agenda', '', ...lines);
  }

  if (a.conviction_score != null) {
    L.push('---', '', `*Stu: ${a.conviction_score} — ${labelFor(a.conviction_band)}. This is an evidence-organising score, not a prediction; it has never been checked against an outcome. The judgement is mine.*`);
  }
  return L.join('\n');
}

function StillReading({ a }) {
  const stage = a.status === 'synthesizing' ? 'Chairing the room — writing the diligence agenda' : 'Convening the room — nine lenses on the deal';
  return (
    <div className="p-2 space-y-3">
      <div className="text-large font-semibold text-ink">Reading…</div>
      <p className="text-small text-ink-2 leading-relaxed max-w-md">
        {stage}. A full read runs the Founder Rubric plus nine investor lenses on the strong model — it takes about five minutes. This updates on its own.
      </p>
      <div className="space-y-1.5 pt-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-2 bg-ground-3 rounded-sm animate-pulse" style={{ width: `${[70, 90, 55, 80, 45][i]}%` }} />
        ))}
      </div>
    </div>
  );
}

function PredatesEngine({ a }) {
  return (
    <div>
      <div className="text-large font-semibold text-ink">No score</div>
      <p className="text-small text-ink-2 leading-relaxed max-w-md mt-1">
        This read ran on <span className="num">{String(a.created_at).slice(0, 10)}</span>, before the
        conviction engine existed. There is no score — not because the evidence was thin, but because
        nothing scored it. The analysis below is real; the number was never computed.
      </p>
      <Link to={`/assess?founder=${a.founder_id}`} className="btn-secondary mt-2 inline-flex">
        Re-run to score it
      </Link>
    </div>
  );
}

function Held({ conv, a }) {
  return (
    <div className="p-4 space-y-3">
      <div>
        <div className="text-large font-semibold text-ink">No score</div>
        <p className="text-small text-ink-2 mt-1 leading-relaxed max-w-md">
          {conv?.reason ||
            'The load-bearing movements — earned insight and execution velocity — could not be scored from these inputs.'}
        </p>
        <p className="text-mini text-ink-3 mt-2">
          Evidence: {conv?.rung_label || 'none'}. Below "observed in conversation" there is no score —
          there's a question list. That refusal is the product.
        </p>
      </div>
      {conv?.missing_load_bearing?.length > 0 && (
        <div>
          <div className="text-micro font-semibold uppercase text-ink-4 mb-1">What's missing</div>
          {conv.missing_load_bearing.map((m) => (
            <div key={m} className="text-small text-ink-2">{m}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// THE ROOM — nine named lenses. The felt experience of a panel of great
// investors weighing in, with worldviews that sometimes disagree. Abstentions
// are shown honestly (never padded away), and every lens's claims carry whether
// their evidence actually checked out against the source.
// ══════════════════════════════════════════════════════════════════════════
function Panel({ panel, bear, synthesis }) {
  if (!Array.isArray(panel) || !panel.length) return null;
  const spoke = panel.filter((l) => l && l.applies !== false && !l.error);
  const abstained = panel.filter((l) => l && l.applies === false && !l.error);
  const dark = panel.filter((l) => l && l.error);
  const bearSpoke = bear && !bear.error;

  return (
    <div className="border-t border-line pt-3">
      <div className="text-micro font-semibold uppercase text-ink-4 mb-2">The room</div>

      {/* Disagreement is signal. Surface where the room splits before the cards. */}
      {synthesis?.room_disagreements?.length > 0 && (
        <div className="rounded border border-line-2 bg-ground-2 px-3 py-2 mb-3">
          <div className="text-micro font-semibold uppercase text-ink-4 mb-1">Where the room splits</div>
          <div className="space-y-1">
            {synthesis.room_disagreements.map((d, i) => (
              <p key={i} className="text-small text-ink-2 leading-relaxed">{d}</p>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {spoke.map((l) => <LensCard key={l.key} lens={l} />)}
        {/* The Bear is the ninth voice in the room. It keeps its own schema (it alone
            feeds the score), so it renders as its own card rather than a lens card. */}
        {bearSpoke && <BearCard bear={bear} />}
      </div>

      {/* Honest abstention is a first-class output — a lens with nothing useful to
          add on this deal says so rather than manufacturing a generic take. */}
      {abstained.length > 0 && (
        <div className="mt-3">
          <div className="text-micro text-ink-4 mb-1">Sat this one out</div>
          <div className="space-y-0.5">
            {abstained.map((l) => (
              <p key={l.key} className="text-mini text-ink-4 leading-relaxed">
                <span className="text-ink-3">{l.label}</span> — {l.abstain_reason || 'no useful perspective on this deal.'}
              </p>
            ))}
          </div>
        </div>
      )}

      {dark.length > 0 && (
        <p className="text-mini text-danger mt-2 leading-relaxed">
          {dark.map((l) => l.label).join(', ')} failed to return — this read is partial. Re-run.
        </p>
      )}
    </div>
  );
}

function LensCard({ lens: l }) {
  return (
    <div className="rounded border border-line-2 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-small font-medium text-ink leading-tight">{l.label}</span>
        <div className="flex-1" />
        {l.weighs && <span className="text-micro text-ink-4">{l.weighs}</span>}
        {l.confidence && (
          <span className={`text-micro ${l.confidence === 'high' ? 'text-ink-2' : l.confidence === 'low' ? 'text-ink-4' : 'text-ink-3'}`}>
            {l.confidence}
          </span>
        )}
      </div>
      {l.verdict && <p className="text-small font-medium text-ink mt-1 leading-relaxed">{l.verdict}</p>}
      {l.read && <p className="text-small text-ink-2 mt-1 leading-relaxed whitespace-pre-wrap">{l.read}</p>}
      {/* The one lens field that reaches the score. If the Unit-Economics lens calls the
          market structurally dead, that's the most decision-changing thing it can say —
          surface it loudly, don't bury it in the read. */}
      {isTrue(l.structurally_dead) && (
        <div className="mt-1.5 rounded border border-danger/40 bg-danger/5 px-2 py-1">
          <span className="text-mini font-semibold text-danger">Structurally dead market.</span>
          {l.dead_market_note && <span className="text-mini text-ink-2 leading-relaxed"> {l.dead_market_note}</span>}
        </div>
      )}
      {l.strengths?.length > 0 && <ClaimList items={l.strengths} mark="+" />}
      {l.risks?.length > 0 && <ClaimList items={l.risks} mark="−" />}
      <Grounding lens={l} />
    </div>
  );
}

// The Bear renders as the ninth card. Its schema differs from the named lenses (it alone
// feeds bear_adjustment), so it's shaped by hand: the kill shot is the verdict, the
// narrative is the read, and its enumerated risks fill the risk list.
function BearCard({ bear: b }) {
  const risks = (Array.isArray(b.primary_risks) ? b.primary_risks : [])
    .map((r) => (typeof r === 'string' ? r : [r?.risk, r?.severity && `(${r.severity})`].filter(Boolean).join(' ')))
    .filter(Boolean);
  const badNums = b.quote_integrity?.unsupported_numbers;
  return (
    <div className="rounded border border-line-2 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-small font-medium text-ink leading-tight">The Bear (adversarial risk)</span>
        <div className="flex-1" />
        <span className="text-micro text-ink-4">Risk</span>
      </div>
      {b.kill_shot_risk && <p className="text-small font-medium text-ink mt-1 leading-relaxed">{b.kill_shot_risk}</p>}
      {b.narrative && <p className="text-small text-ink-2 mt-1 leading-relaxed whitespace-pre-wrap">{b.narrative}</p>}
      {b.twelve_month_kill?.scenario && (
        <p className="text-mini text-ink-3 mt-1 leading-relaxed">
          <span className="text-ink-4">12-month kill{b.twelve_month_kill.probability ? ` (${b.twelve_month_kill.probability})` : ''}:</span> {b.twelve_month_kill.scenario}
        </p>
      )}
      {risks.length > 0 && <ClaimList items={risks} mark="−" />}
      {badNums?.length > 0 && (
        <p className="text-micro text-danger mt-1.5 pt-1.5 border-t border-line leading-relaxed">
          ⚠ Number(s) in the risk prose not found in the source: {badNums.flatMap((x) => x.numbers || []).join(', ')}
        </p>
      )}
    </div>
  );
}

function ClaimList({ items, mark }) {
  return (
    <div className="mt-1 space-y-0.5">
      {items.map((it, i) => (
        <div key={i} className="flex gap-1.5">
          <span className="text-mini text-ink-4 select-none">{mark}</span>
          <span className="text-mini text-ink-3 leading-relaxed">{typeof it === 'string' ? it : it?.text || ''}</span>
        </div>
      ))}
    </div>
  );
}

// Per-claim grounding, made visible. The trust layer (server/agents/verify.js)
// classified each of this lens's quotes against the source; here that verdict is
// shown so Danny can trust — or distrust — the evidence behind the read. A clean
// footer means the quotes checked out; an amber one means a quote or number didn't.
function Grounding({ lens: l }) {
  const quotes = l.quote_verification || [];
  const badNums = l.unsupported_numbers || [];
  // Nothing to attest to — don't render an empty bordered strip.
  if (!quotes.length && !badNums.length) return null;

  // The footer verdict is derived from EXACTLY what's rendered below it — the per-quote
  // marks and the number flags — so it can never say "clean" above a visible ⚠. (An
  // earlier version read a separate quote_integrity summary that could disagree.)
  const clean = quotes.length > 0 && quotes.every((q) => q.verification !== 'unverified') && !badNums.length;

  return (
    <div className="mt-1.5 pt-1.5 border-t border-line">
      {quotes.length > 0 && (
        <div className="space-y-0.5">
          {quotes.map((q, i) => (
            <div key={i} className="flex items-baseline gap-1.5">
              <span
                className={`text-micro select-none ${
                  q.verification === 'verbatim' ? 'text-ink-2' : q.verification === 'paraphrased' ? 'text-ink-3' : 'text-danger'
                }`}
                title={q.verification}
              >
                {q.verification === 'verbatim' ? '✓' : q.verification === 'paraphrased' ? '≈' : '⚠'}
              </span>
              <span className="text-micro text-ink-4 leading-relaxed italic">“{q.quote}”</span>
            </div>
          ))}
        </div>
      )}
      {badNums.length > 0 && (
        <p className="text-micro text-danger mt-1 leading-relaxed">
          ⚠ Number{badNums.length > 1 ? 's' : ''} not in the source: {badNums.join(', ')}
        </p>
      )}
      {clean && (
        <p className="text-micro text-ink-4 mt-0.5">Grounded — quotes check out against the materials.</p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// THE DILIGENCE AGENDA — every lens's questions, deduped and bucketed by who
// answers them, prioritised by what most changes the decision. When the score is
// indeterminate, THIS is the deliverable.
// ══════════════════════════════════════════════════════════════════════════
const AGENDA_BUCKETS = [
  ['founder', 'Ask the founder'],
  ['sme', 'Subject-matter expert'],
  ['expert_call', 'Expert-network call'],
  ['desktop', 'Desktop research'],
];

function Agenda({ agenda }) {
  if (!agenda || typeof agenda !== 'object') return null;
  const priorities = Array.isArray(agenda.top_priorities) ? agenda.top_priorities : [];
  const hasBuckets = AGENDA_BUCKETS.some(([k]) => Array.isArray(agenda[k]) && agenda[k].length);
  if (!priorities.length && !hasBuckets) return null;

  return (
    <div className="border-t border-line pt-3">
      <div className="text-micro font-semibold uppercase text-ink-4 mb-2">Diligence agenda</div>

      {priorities.length > 0 && (
        <div className="mb-3">
          <div className="text-mini text-ink-3 mb-1">Start here — what most changes the picture</div>
          <ol className="list-decimal ml-4 space-y-0.5">
            {priorities.map((q, i) => (
              <li key={i} className="text-small text-ink leading-relaxed">{typeof q === 'string' ? q : q?.q}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="space-y-3">
        {AGENDA_BUCKETS.map(([k, label]) => {
          const items = Array.isArray(agenda[k]) ? agenda[k] : [];
          if (!items.length) return null;
          return (
            <div key={k}>
              <div className="text-mini text-ink-3 mb-1">{label} <span className="text-ink-4">· {items.length}</span></div>
              <div className="space-y-1.5">
                {items.map((it, i) => (
                  <div key={i}>
                    <p className="text-small text-ink-2 leading-relaxed">{typeof it === 'string' ? it : it?.q}</p>
                    {it?.why && <p className="text-mini text-ink-4 leading-relaxed">{it.why}</p>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Status({ a }) {
  if (a.status === 'running' || a.status === 'processing_inputs' || a.status === 'synthesizing')
    return <span className="text-mini text-ink-3">Reading…</span>;
  if (a.status === 'error') return <span className="text-mini text-danger">Failed</span>;
  if (a.status === 'partial') return <span className="text-mini text-ink-3">Partial — some agents failed</span>;
  return null;
}

const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const labelFor = (k) => BANDS.find((b) => b.key === k)?.label || k;
// Mirror the server's isTrue coercion — a boolean field can arrive as the string "true".
const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';

// 90 days. Long enough that a real thing can happen, short enough that he'll
// still care about the answer.
function defaultResolveBy() {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

function MemoBody({ a }) {
  const memo = a.memo_7m;
  if (!memo?.length) return <p className="text-mini text-ink-4 mt-2">No memo — the depth agents didn't complete.</p>;
  return (
    <div className="mt-3 space-y-4">
      {memo.map((s) => (
        <div key={s.key}>
          <div className="text-micro font-semibold uppercase text-ink-4 mb-1">{s.title}</div>
          {s.note && <p className="text-mini text-ink-4 mb-1 leading-relaxed">{s.note}</p>}
          <div className="text-small text-ink-2 whitespace-pre-wrap leading-relaxed">{s.body}</div>
        </div>
      ))}
    </div>
  );
}

function ReadSkeleton() {
  return (
    <div className="grid grid-cols-2 h-full divide-x divide-line-2">
      {[0, 1].map((c) => (
        <div key={c} className="p-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-2 bg-ground-3 rounded-sm" style={{ width: `${[45, 80, 60, 70, 40, 65][i]}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
