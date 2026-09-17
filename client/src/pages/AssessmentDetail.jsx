import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { PageHeader, DetailSection, Score, Tag, EmptyState } from '../components/ui';

// ════════════════════════════════════════════════════════
// Assessment detail — ONE scrollable page.
//
// The verdict is the Conviction Score (1-10) computed deterministically in
// server/lib/conviction.js from the assessment's rubric dimensions (the snapshot
// stored on the row — Danny's Founder Rubric by default, any investor-defined
// framework otherwise). It is NOT the old Team45/Product25/Market30 weighted
// average — those pillars survive here only as the collapsed depth layer,
// explicitly labelled as informing rather than deciding.
//
// The one semantic use of colour on this page is EVIDENCE RUNG: a low rung renders dim,
// a high rung renders full-strength. Confidence is visible as contrast. Everything else
// follows tailwind.config.js: accent (blue) = interactive, danger (red) = reject/divergence,
// the rest gray. Scores are typographic — never coloured by value.
// ════════════════════════════════════════════════════════

// ── Evidence rung → contrast. The whole design idea. ──
// A dim headline means "go read the gaps." Keys match RUNG in server/lib/conviction.js.
const RUNG_TONE = {
  0: { head: 'text-gray-300', body: 'text-gray-400', dot: 'bg-gray-200' },
  1: { head: 'text-gray-400', body: 'text-gray-400', dot: 'bg-gray-300' },
  2: { head: 'text-gray-500', body: 'text-gray-500', dot: 'bg-gray-400' },
  3: { head: 'text-gray-700', body: 'text-gray-600', dot: 'bg-gray-600' },
  4: { head: 'text-ink', body: 'text-gray-700', dot: 'bg-ink' },
};
const toneFor = (rung) => RUNG_TONE[rung] ?? RUNG_TONE[0];

const RUNNING_STATES = ['running', 'synthesizing', 'processing_inputs'];

function parseOutput(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

// The yardstick this run was scored against, from the immutable snapshot.
// Falls back to the legacy name for runs that predate snapshots.
function rubricNameOf(assessment) {
  try {
    const snap = parseOutput(assessment?.rubric_snapshot);
    if (snap?.name) return snap.name;
  } catch { /* legacy run */ }
  return 'Founder Rubric — Pre-seed';
}

export default function AssessmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [assessment, setAssessment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [showVersions, setShowVersions] = useState(false);
  const [notionState, setNotionState] = useState({ status: 'idle', url: null, error: null });
  const [divergence, setDivergence] = useState(null);
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef(null);

  // ?tab=memo used to select a tab. There are no tabs now — it opens the Deal Memo
  // section and scrolls to it, so existing links from the Deal Memo task flow still land.
  const deepLink = searchParams.get('tab');

  useEffect(() => {
    loadAssessment();
    api.getAssessmentTasteDivergence(id).then(setDivergence).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id]);

  useEffect(() => {
    if (loading || !deepLink) return;
    const el = document.getElementById(`section-${deepLink}`);
    if (el) {
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [loading, deepLink]);

  async function loadAssessment() {
    try {
      const a = await api.getAssessment(id);
      setAssessment(a);

      api.getAssessmentInputs(id).then(setInputs).catch(() => {});
      if (a.group_id) api.getAssessmentGroup(a.group_id).then(setVersions).catch(() => {});

      if (RUNNING_STATES.includes(a.status)) {
        pollRef.current = setInterval(async () => {
          try {
            const updated = await api.getAssessment(id);
            setAssessment(updated);
            if (!RUNNING_STATES.includes(updated.status)) {
              clearInterval(pollRef.current);
              pollRef.current = null;
              api.getAssessmentInputs(id).then(setInputs).catch(() => {});
            }
          } catch {}
        }, 3000);
      }
    } catch (err) {
      console.error('Failed to load assessment:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handlePushToNotion() {
    if (notionState.status === 'pushing') return;
    setNotionState({ status: 'pushing', url: null, error: null });
    try {
      const result = await api.pushAssessmentToNotion(id);
      setNotionState({ status: 'success', url: result.url, error: null, action: result.action });
    } catch (err) {
      setNotionState({ status: 'error', url: null, error: err?.message || 'Failed to push to Notion' });
    }
  }

  // Re-run: a 'partial' or 'error' assessment stalled mid-run with no way to retry from the
  // UI. This creates a new version (same inputs) and navigates to it.
  async function handleRerun() {
    if (rerunning) return;
    setRerunning(true);
    try {
      const result = await api.rerunAssessment(id, { inputs: {} });
      navigate(`/assess/${result.id}`);
    } catch (err) {
      console.error('Failed to re-run assessment:', err);
      setRerunning(false);
    }
  }

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelAssessment(id);
      const updated = await api.getAssessment(id);
      setAssessment(updated);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } catch (err) {
      console.error('Failed to cancel assessment:', err);
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-400 text-sm">Loading…</div>;
  if (!assessment) return <EmptyState title="Assessment not found" />;

  const synthesis = parseOutput(assessment.synthesis_output);
  const isRunning = RUNNING_STATES.includes(assessment.status);
  const isComplete = assessment.status === 'complete' || assessment.status === 'partial';

  // Meeting Prep is a briefing, not an investability eval — no verdict, no conviction.
  // synthesis_output holds the brief JSON here (contextual per assessment_type).
  if (assessment.assessment_type === 'meeting_prep') {
    return (
      <MeetingPrepDetail
        assessment={assessment} brief={synthesis} isRunning={isRunning} isComplete={isComplete}
        error={assessment.status === 'error'} onRerun={handleRerun} rerunning={rerunning}
      />
    );
  }

  // conviction_output is the contract. synthesis.conviction is the same object, kept as a
  // fallback for rows written before the column landed.
  const conviction = parseOutput(assessment.conviction_output) || synthesis?.conviction || null;
  const evidence = parseOutput(assessment.evidence_output);
  const rubric = parseOutput(assessment.rubric_output);
  const contextNotes = parseOutput(assessment.context_notes) || [];
  const rung = evidence?.rung ?? conviction?.rung ?? assessment.evidence_rung ?? 0;
  const tone = toneFor(rung);

  const team = parseOutput(assessment.founder_agent_output);
  const product = parseOutput(assessment.market_agent_output);
  const market = parseOutput(assessment.economics_agent_output);
  const bear = parseOutput(assessment.bear_agent_output);

  return (
    <div className="max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/assess" className="hover:text-gray-600">Assess</Link>
        <span>/</span>
        <span className="text-gray-700">{assessment.founder_name || 'Assessment'}</span>
      </div>

      <PageHeader
        title={assessment.founder_name || 'Unknown Founder'}
        subtitle={assessment.founder_company || null}
        actions={
          <>
            {isRunning && (
              <>
                <span className="text-xs text-gray-400 animate-pulse">
                  {assessment.status === 'processing_inputs' ? 'Processing…' : assessment.status === 'synthesizing' ? 'Synthesizing…' : 'Running…'}
                </span>
                <button onClick={handleCancel} disabled={cancelling}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              </>
            )}
            {!isRunning && (
              <button onClick={handleRerun} disabled={rerunning}
                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                title="Re-run this assessment from the same inputs">
                {rerunning ? 'Starting…' : 'Re-run'}
              </button>
            )}
            {isComplete && (
              notionState.status === 'success' && notionState.url ? (
                <a href={notionState.url} target="_blank" rel="noopener noreferrer"
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-accent hover:bg-accent-soft">
                  Open in Notion ↗
                </a>
              ) : (
                <button onClick={handlePushToNotion} disabled={notionState.status === 'pushing'}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  title={notionState.error || 'Send this assessment to your Strider Notion'}>
                  {notionState.status === 'pushing' ? 'Sending…' : notionState.status === 'error' ? 'Retry → Notion' : 'Send to Notion'}
                </button>
              )
            )}
          </>
        }
      />

      {/* Deck-integrity warning — the score is suspect when the deck couldn't be ingested. */}
      {assessment.deck_status === 'suspect' && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="text-sm font-semibold text-danger">Deck not ingested — read this with that in mind</p>
          <p className="text-xs text-gray-600 mt-1">
            {assessment.deck_status_reason || 'The pitch deck could not be read.'}
            {' '}It contributed nothing to the evidence rung below. Re-run with a PDF export of the deck.
          </p>
        </div>
      )}

      {assessment.status === 'error' && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="text-sm font-semibold text-danger">This run failed</p>
          <p className="text-xs text-gray-600 mt-1">Nothing below is a judgment about the company. Re-run it.</p>
        </div>
      )}

      {/* Taste divergence — red is reserved for divergence; alignment is neutral. */}
      {divergence?.available && divergence.direction !== 'neutral' && (
        <div className={`mb-4 rounded-lg border px-4 py-3 ${divergence.direction === 'divergent' ? 'border-danger/30 bg-danger-soft' : 'border-gray-200 bg-gray-50'}`}>
          <p className={`text-sm font-semibold ${divergence.direction === 'divergent' ? 'text-danger' : 'text-gray-700'}`}>
            {divergence.direction === 'divergent' ? 'Counter to your usual pattern' : 'Matches your revealed taste'}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">{divergence.note}</p>
        </div>
      )}

      <VersionStrip versions={versions} currentId={id} show={showVersions} onToggle={() => setShowVersions(v => !v)} />

      {isRunning && !conviction ? (
        <div className="border-t border-gray-200 pt-10 text-center">
          <p className="text-sm text-gray-400 animate-pulse">The agents are still reading. The verdict appears when they finish.</p>
        </div>
      ) : (
        <div className="space-y-12">
          {/* 1 ── The verdict */}
          <Verdict conviction={conviction} synthesis={synthesis} rubric={rubric} tone={tone} />

          {/* 2 ── Evidence strength: the trust chip, directly under the verdict */}
          <EvidenceStrength evidence={evidence} rung={rung} tone={tone} />

          {/* 3 ── Assessment dimensions (the rubric's questions) */}
          <Movements conviction={conviction} rubric={rubric} rubricName={rubricNameOf(assessment)} tone={tone} />

          {/* 4 ── Docks + the calculation */}
          <Docks conviction={conviction} />

          {/* 5 ── Chip on shoulder + flags */}
          <ChipAndFlags rubric={rubric} determinate={!!conviction?.determinate} />

          {/* 6 ── Personal Conviction — the human gate, deliberately unanswered */}
          <PersonalConviction />

          {/* 7 ── What we didn't look at */}
          <NotLookedAt evidence={evidence} contextNotes={contextNotes} assessment={assessment} />

          {/* 8 ── The depth layer + memo + materials */}
          <DepthLayer team={team} product={product} market={market} bear={bear} synthesis={synthesis} />
          <MemoSectionCollapsed team={team} product={product} market={market} bear={bear} synthesis={synthesis} />
          <MaterialsCollapsed inputs={inputs} />
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 1 ── The verdict
// ════════════════════════════════════════════════════════

function Verdict({ conviction, synthesis, rubric, tone }) {
  // A row written before the conviction engine landed. Say so rather than reconstruct a
  // number from the retired pillar average.
  if (!conviction) {
    return (
      <section>
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Conviction</div>
        <div className="text-3xl font-semibold text-gray-400">Not scored</div>
        <p className="text-sm text-gray-600 mt-2 max-w-xl">
          This assessment predates the conviction engine, or its run never reached synthesis. Re-run it to score
          against your framework.
        </p>
      </section>
    );
  }

  const det = conviction.determinate;
  const questions = rubric?.what_would_change_this || [];

  return (
    <section>
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Conviction</div>

      {/* Fatal flaw — a veto forces the band to Pass regardless of the number.
          It is the single most important line on the page, so it sits on top. */}
      {det && conviction.vetoed && (
        <div className="rounded-lg border border-danger/40 bg-red-50 p-4 mb-5">
          <p className="text-sm font-semibold text-danger">Fatal flaw</p>
          <p className="text-sm text-gray-700 leading-relaxed mt-1">{conviction.veto_reason}</p>
          <p className="text-xs text-gray-500 mt-2">One disqualifier kills the deal — no average can save it. The score above is preserved for reference; the call is Pass.</p>
        </div>
      )}

      <div className="flex items-start gap-6">
        {/* The score slot. Indeterminate renders a deliberate blank — never a number. */}
        <div className="flex items-baseline gap-1 flex-shrink-0">
          <span className={`text-7xl font-bold tabular-nums leading-none ${det ? tone.head : 'text-gray-200'}`}>
            {det ? conviction.score : '—'}
          </span>
          {det && <span className="text-lg font-medium text-gray-300">/10</span>}
        </div>

        <div className="min-w-0 pt-1">
          <div className={`text-2xl font-semibold leading-tight ${det ? tone.head : 'text-gray-400'}`}>
            {det ? conviction.band.label : 'Insufficient evidence'}
          </div>
          {det && <div className="text-sm text-gray-500 mt-1">{conviction.band.action}</div>}
          {!det && conviction.missing_load_bearing?.length > 0 && (
            <div className="text-sm text-gray-500 mt-1">
              Not scorable: {conviction.missing_load_bearing.join(', ')}
            </div>
          )}
        </div>
      </div>

      {!det && conviction.reason && (
        <p className="text-sm text-gray-700 leading-relaxed mt-5 max-w-2xl">{conviction.reason}</p>
      )}

      {det && synthesis?.one_liner && (
        <p className={`text-sm leading-relaxed mt-5 max-w-2xl ${tone.body}`}>{synthesis.one_liner}</p>
      )}

      {/* The engine's whole argument is that a claim gets sized to its evidence. That
          has to apply to the engine. n=6, no outcome loop, the score has never been
          checked against a result, and the gate threshold and dock magnitudes are
          author-set rather than rubric-derived. Rendering the band and its action as a
          bare instruction — "Anchor-grade / First call within a week" — without saying
          any of that would be the same unearned confidence this rebuild removed from
          everything else. It sits directly under the number on purpose. */}
      {det && conviction.calibration && (
        <p className="text-xs text-gray-400 leading-relaxed mt-4 max-w-2xl border-l-2 border-gray-200 pl-3">
          {conviction.calibration}
        </p>
      )}

      {det && conviction.gate_applied && (
        <p className="text-xs text-gray-500 leading-relaxed mt-3 max-w-2xl">
          Capped below Top-quartile: the founder did not clear the bar on the load-bearing
          {conviction.load_bearing_labels?.length ? ` (${conviction.load_bearing_labels.join(' and ')})` : ' dimensions'}.
          The other dimensions differentiate among founders who clear those — they don't substitute for them.
        </p>
      )}

      {/* When there is no score, the question list IS the product. Accent = the one
          primary action on the screen. */}
      {!det && questions.length > 0 && (
        <div className="mt-6 rounded-lg border border-accent/30 bg-accent-soft p-4">
          <div className="text-2xs font-semibold uppercase tracking-wide text-accent mb-2">What would change this</div>
          <ul className="space-y-2">
            {questions.map((q, i) => (
              <li key={i} className="text-sm text-gray-800 flex gap-2.5 leading-relaxed">
                <span className="text-accent font-semibold tabular-nums flex-shrink-0">{i + 1}.</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 mt-3">Ask these on the call. Then re-run.</p>
        </div>
      )}
      {/* Only prescribe "take the call" when the gap is genuinely evidence. If the rubric
          agent crashed, the reason above already says to re-run, and telling Danny to book a
          call would be advice derived from a system failure. */}
      {!det && questions.length === 0 && conviction.rung < 3 && !rubric?.error && (
        <p className="text-sm text-gray-500 mt-4">
          Get the founder on a call. Earned Insight and Learning Velocity are only readable once they have
          answered questions.
        </p>
      )}

      {det && questions.length > 0 && (
        <div className="mt-6">
          <DetailSection label="What would change this">
            <ul className="space-y-1.5">
              {questions.map((q, i) => (
                <li key={i} className="flex gap-2.5"><span className="text-gray-300 flex-shrink-0">{i + 1}.</span><span>{q}</span></li>
              ))}
            </ul>
          </DetailSection>
        </div>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════
// 2 ── Evidence strength
// ════════════════════════════════════════════════════════

function EvidenceStrength({ evidence, rung, tone }) {
  if (!evidence) {
    return (
      <section className="border-t border-gray-200 pt-6">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Evidence strength</div>
        <p className="text-sm text-gray-400">Not recorded for this run.</p>
      </section>
    );
  }

  const c = evidence.counts || {};
  const counts = [
    ['transcript', c.transcripts], ['deck', c.decks], ['URL', c.urls], ['note', c.notes],
  ].filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`);

  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Evidence strength</div>
      <div className="flex items-center gap-3 mb-2">
        {/* Four rungs. The fill is the confidence. */}
        <div className="flex items-center gap-1" title={`Rung ${rung} of 4`}>
          {[1, 2, 3, 4].map(i => (
            <span key={i} className={`w-6 h-1.5 rounded-full ${i <= rung ? tone.dot : 'bg-gray-100'}`} />
          ))}
        </div>
        <span className={`text-base font-semibold ${tone.head}`}>{evidence.label}</span>
        <span className="text-xs text-gray-400 tabular-nums">{rung}/4</span>
      </div>
      <p className={`text-sm leading-relaxed max-w-2xl ${tone.body}`}>{evidence.meaning}</p>
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        {counts.length > 0
          ? counts.map(t => <Tag key={t}>{t}</Tag>)
          : <span className="text-xs text-gray-400">Nothing readable reached the agents.</span>}
      </div>
    </section>
  );
}

// ════════════════════════════════════════════════════════
// 3 ── The four movements
// ════════════════════════════════════════════════════════

function Movements({ conviction, rubric, rubricName, tone }) {
  const movements = conviction?.movements;
  if (!movements || Object.keys(movements).length === 0) return null;

  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Assessment dimensions</div>
      <p className="text-xs text-gray-400 mb-5">{rubricName}. These, and only these, produce the conviction score.</p>
      {/* When the rubric agent crashed, conviction was computed from an empty movement set,
          so every movement reads "the agent abstained". It didn't — it died. Say so. */}
      {rubric?.error && (
        <p className="text-sm text-danger mb-5">
          The {rubricName} agent failed, so nothing below was actually scored. These are empty slots, not judgments.
        </p>
      )}
      <div className="space-y-6">
        {Object.entries(movements).map(([key, m]) => (
          <Movement key={key} m={m} tone={tone} />
        ))}
      </div>
    </section>
  );
}

function Movement({ m, tone }) {
  return (
    <div className="border-l-2 border-gray-100 pl-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <span className={`text-sm font-semibold ${m.scorable ? tone.head : 'text-gray-400'}`}>{m.label}</span>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Tag>weight {m.weight}</Tag>
            <Tag>{m.evidence_strength} evidence</Tag>
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          {m.scorable ? (
            <span className={`text-3xl font-bold tabular-nums ${tone.head}`}>{m.score}</span>
          ) : (
            <span className="text-3xl font-bold tabular-nums text-gray-200">—</span>
          )}
        </div>
      </div>

      {m.blurb && <p className="text-xs text-gray-400 mt-2">{m.blurb}</p>}

      {!m.scorable && m.reason && (
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          <span className="font-medium text-gray-600">Not scorable</span> — {m.reason}
        </p>
      )}

      {m.evidence && (
        <p className={`text-sm leading-relaxed mt-2 ${m.scorable ? tone.body : 'text-gray-400'}`}>{m.evidence}</p>
      )}

      {m.quotes?.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {m.quotes.map((q, i) => (
            <p key={i} className="text-sm text-gray-600 italic border-l-2 border-gray-200 pl-3 leading-relaxed">“{q}”</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 4 ── Docks + calculation
// ════════════════════════════════════════════════════════

function Docks({ conviction }) {
  if (!conviction?.determinate) return null;
  const docks = conviction.docks || [];

  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Docks</div>
      <p className="text-xs text-gray-400 mb-4">Penalties only. Nothing here can raise a score.</p>

      {docks.length === 0 ? (
        <p className="text-sm text-gray-500">No docks. The bear found nothing scoreable, the market is not structurally dead, and no yellow flags fired.</p>
      ) : (
        <div className="space-y-3">
          {docks.map((d, i) => (
            <div key={i} className="flex items-baseline gap-4">
              <span className="text-lg font-bold tabular-nums text-ink w-12 flex-shrink-0">{d.amount}</span>
              <p className="text-sm text-gray-700 leading-relaxed">{d.why}</p>
            </div>
          ))}
        </div>
      )}

      {conviction.calculation && (
        <p className="text-xs font-mono text-gray-400 mt-5 pt-4 border-t border-gray-100 break-words">
          {conviction.calculation}
        </p>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════
// 5 ── Chip on shoulder + flags
// ════════════════════════════════════════════════════════

function ChipAndFlags({ rubric, determinate }) {
  const chip = rubric?.chip_on_shoulder;
  const flags = rubric?.flags;
  const firedFlags = [
    flags?.charisma_over_substance && 'Charisma over substance',
    flags?.grievance_grandiosity && 'Grievance / grandiosity',
  ].filter(Boolean);

  if (!chip && firedFlags.length === 0) return null;

  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Chip on shoulder & flags</div>

      {chip && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-sm font-semibold text-ink">
              {chip.present === true ? 'Present' : chip.present === false ? 'Not present' : 'Can’t tell'}
            </span>
            {chip.direction && <Tag>aimed at the {chip.direction}</Tag>}
          </div>
          {chip.read && <p className="text-sm text-gray-700 leading-relaxed">{chip.read}</p>}
          <p className="text-xs text-gray-400 mt-2">
            A variance amplifier, not a quality filter. It is not scored.
          </p>
        </div>
      )}

      {firedFlags.length > 0 && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft p-4">
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {firedFlags.map(f => (
              <span key={f} className="inline-flex items-center bg-white text-danger border border-danger/30 rounded-full px-2 py-0.5 text-xs font-semibold">{f}</span>
            ))}
          </div>
          {flags?.flag_evidence && <p className="text-sm text-gray-700 leading-relaxed">{flags.flag_evidence}</p>}
          {/* Only claim a dock when one actually happened. With no score there is no Docks
              section and nothing was subtracted — saying otherwise invents arithmetic. */}
          <p className="text-xs text-gray-500 mt-2">
            {determinate
              ? 'Each fired flag docked the score by 0.5. See Docks above.'
              : 'These would each dock the score by 0.5 — but there is no score to dock.'}
          </p>
        </div>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════
// 6 ── Personal Conviction — the human gate
//
// Deliberately blank. The rubric agent is explicitly forbidden from assessing this so it
// can never inflate a quality score. Rendering it as an empty slot is the point: it makes
// the one judgment Stu does not make visible on the page.
// ════════════════════════════════════════════════════════

function PersonalConviction() {
  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Personal conviction</div>
      <div className="rounded-lg border border-dashed border-gray-300 px-5 py-6">
        <p className="text-lg font-semibold text-gray-300">Unanswered</p>
        <p className="text-sm text-gray-600 mt-2 max-w-xl leading-relaxed">
          Your call. Stu does not assess this. Would you want to work with them for ten years — and would you
          take this call again if there were no deal in it?
        </p>
      </div>
    </section>
  );
}

// ════════════════════════════════════════════════════════
// 7 ── What we didn't look at — derived, never authored
// ════════════════════════════════════════════════════════

function NotLookedAt({ evidence, contextNotes, assessment }) {
  const dropped = evidence?.dropped || [];
  const notes = Array.isArray(contextNotes) ? contextNotes : [];
  // deck_status_reason and the dropped-deck row are two views of the same failed deck.
  // Only fall back to deck_status_reason when the rung didn't already catch it.
  const deckAlreadyDropped = dropped.some(d => d.type === 'deck');
  const deckNote = assessment.deck_status === 'suspect' && !deckAlreadyDropped
    ? assessment.deck_status_reason : null;

  if (dropped.length === 0 && notes.length === 0 && !deckNote) return null;

  return (
    <section className="border-t border-gray-200 pt-6">
      <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-1">What we didn’t look at</div>
      <p className="text-xs text-gray-400 mb-4">Inputs that were handed to Stu but never made it into the analysis.</p>
      <ul className="space-y-2.5">
        {dropped.map((d, i) => (
          <li key={`d${i}`} className="text-sm text-gray-700 flex gap-3">
            <span className="text-2xs uppercase tracking-wide text-gray-400 w-16 flex-shrink-0 pt-0.5">{d.type}</span>
            <span><span className="font-medium">{d.label}</span> <span className="text-gray-500">— {d.reason}</span></span>
          </li>
        ))}
        {deckNote && (
          <li className="text-sm text-gray-700 flex gap-3">
            <span className="text-2xs uppercase tracking-wide text-gray-400 w-16 flex-shrink-0 pt-0.5">deck</span>
            <span className="text-gray-500">{deckNote}</span>
          </li>
        )}
        {notes.map((n, i) => (
          <li key={`n${i}`} className="text-sm text-gray-700 flex gap-3">
            <span className="text-2xs uppercase tracking-wide text-gray-400 w-16 flex-shrink-0 pt-0.5">context</span>
            <span className="text-gray-500">{n}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ════════════════════════════════════════════════════════
// Version strip
// ════════════════════════════════════════════════════════

function VersionStrip({ versions, currentId, show, onToggle }) {
  if (!versions || versions.length <= 1) return null;
  return (
    <div className="mb-6">
      <button onClick={onToggle} className="text-xs text-gray-400 hover:text-gray-600">
        {show ? 'Hide' : 'Show'} version history ({versions.length})
      </button>
      {show && (
        <div className="mt-2 space-y-1">
          {versions.map(v => {
            const c = parseOutput(v.conviction_output);
            return (
              <Link key={v.id} to={`/assess/${v.id}`}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${v.id === parseInt(currentId) ? 'bg-accent-soft border border-accent/30' : 'bg-gray-50 hover:bg-gray-100'}`}>
                <span>
                  <span className="font-medium text-ink">v{v.version_number}</span>
                  <span className="text-gray-400 ml-2">{new Date(v.created_at).toLocaleDateString()}</span>
                  {v.change_summary && <span className="text-gray-400 ml-2">{v.change_summary}</span>}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-gray-500">
                    {c?.determinate ? c.band.label : v.overall_signal || v.status}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-ink w-8 text-right">
                    {v.conviction_score ?? (c?.determinate ? c.score : '—')}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 8 ── The depth layer — informs, does not decide
// ════════════════════════════════════════════════════════

function Collapsible({ id, title, subtitle, children }) {
  return (
    <details id={id} className="border-t border-gray-200 pt-6 group">
      <summary className="cursor-pointer list-none flex items-baseline justify-between gap-4">
        <span>
          <span className="text-2xs font-semibold uppercase tracking-wide text-gray-400">{title}</span>
          {subtitle && <span className="block text-xs text-gray-400 mt-1">{subtitle}</span>}
        </span>
        <span className="text-xs text-accent font-medium flex-shrink-0 group-open:hidden">Show</span>
        <span className="text-xs text-accent font-medium flex-shrink-0 hidden group-open:inline">Hide</span>
      </summary>
      <div className="mt-5">{children}</div>
    </details>
  );
}

function DepthLayer({ team, product, market, bear, synthesis }) {
  const has = team || product || market || bear || synthesis;
  if (!has) return null;

  return (
    <Collapsible
      id="section-depth"
      title="The depth layer"
      subtitle="Team, Product, Market and the Bear. These inform the read — they do not decide it. The conviction score above comes only from the four movements."
    >
      <div className="space-y-8">
        {synthesis && <SynthesisProse data={synthesis} />}
        <DepthAgent label="Team" data={team}>{d => <TeamOutput data={d} />}</DepthAgent>
        <DepthAgent label="Product" data={product}>{d => <ProductOutput data={d} />}</DepthAgent>
        <DepthAgent label="Market" data={market}>{d => <MarketOutput data={d} />}</DepthAgent>
        <DepthAgent label="Bear" data={bear}>{d => <BearOutput data={d} />}</DepthAgent>
      </div>
    </Collapsible>
  );
}

function DepthAgent({ label, data, children }) {
  if (!data) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-3 pb-2 border-b border-gray-100">{label}</h3>
      {/* An agent that died is an error, not a low score — say which. */}
      {data.error
        ? <p className="text-sm text-danger">This agent failed: {data.error}. Re-run — this is a system failure, not a judgment.</p>
        : children(data)}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// Shared depth-layer helpers
// ════════════════════════════════════════════════════════

// Quote verification is the one place a second colour earns its keep in the depth layer:
// an unverified quote is a trust divergence, which is exactly what danger is for.
const VERIFY_META = {
  verbatim: { label: 'Verbatim', cls: 'text-gray-500 bg-gray-50 border-gray-200', title: 'Found word-for-word in the source materials' },
  paraphrased: { label: 'Paraphrased', cls: 'text-gray-500 bg-gray-50 border-gray-200', title: 'Closely matches the source, not word-for-word' },
  unverified: { label: 'Unverified', cls: 'text-danger bg-danger-soft border-danger/30', title: 'Not found in the source materials — confirm before citing' },
};

function QuoteVerifyBadge({ verification }) {
  const m = VERIFY_META[verification];
  if (!m) return null;
  return (
    <span className={`flex-shrink-0 text-2xs font-semibold px-1.5 py-0.5 rounded border ${m.cls}`} title={m.title}>
      {m.label}
    </span>
  );
}

function QuoteIntegritySummary({ integrity }) {
  if (!integrity) return null;
  const parts = [
    integrity.verbatim && `${integrity.verbatim} verbatim`,
    integrity.paraphrased && `${integrity.paraphrased} paraphrased`,
  ].filter(Boolean);
  if (!parts.length && !integrity.unverified) return null;
  return (
    <span className="text-2xs text-gray-400 flex items-center gap-2" title="Quote verification against source materials">
      {parts.join(' · ')}
      {integrity.unverified > 0 && <span className="text-danger font-semibold">{integrity.unverified} unverified</span>}
    </span>
  );
}

function SubcategoryCard({ label, score, evidence, extras }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-sm font-semibold text-gray-700">{label}</span>
        <Score value={score} max={10} />
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">{evidence}</p>
      {extras}
    </div>
  );
}

function RisksList({ risks }) {
  if (!risks || risks.length === 0) return null;
  return (
    <DetailSection label="Risks">
      <div className="space-y-2">
        {risks.map((r, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-2xs font-semibold uppercase text-gray-400 w-14 flex-shrink-0 pt-0.5">{r.severity}</span>
            <div>
              <p className="text-sm text-gray-800">{r.risk}</p>
              {r.evidence && <p className="text-xs text-gray-400 mt-0.5">{r.evidence}</p>}
            </div>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}

function QuestionsList({ questions, title }) {
  if (!questions || questions.length === 0) return null;
  return (
    <DetailSection label={title || 'Open questions'}>
      <ul className="space-y-1.5">
        {questions.map((q, i) => (
          <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">{i + 1}.</span><span>{q}</span></li>
        ))}
      </ul>
    </DetailSection>
  );
}

// ── Synthesis prose. The verdict, pillar scores and score_calculation are NOT rendered
// here — they live at the top of the page, computed from conviction. This is prose only. ──
function SynthesisProse({ data }) {
  const p = data.pillar_scores;
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-3 pb-2 border-b border-gray-100">Synthesis</h3>

      {p && (p.team != null || p.product != null || p.market != null) && (
        <DetailSection label="Pillar scores — depth only, not the verdict">
          <div className="flex items-start gap-8">
            {[['Team', p.team], ['Product', p.product], ['Market', p.market]].map(([label, val]) => (
              val == null ? null : (
                <div key={label}>
                  <div className="text-2xl font-bold tabular-nums text-ink">{val}</div>
                  <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                </div>
              )
            ))}
            {data.bear_adjustment != null && data.bear_adjustment !== 0 && (
              <div>
                <div className="text-2xl font-bold tabular-nums text-ink">{data.bear_adjustment}</div>
                <p className="text-xs text-gray-500 mt-0.5">Bear</p>
              </div>
            )}
          </div>
        </DetailSection>
      )}

      {data.executive_summary && (
        <DetailSection label="Executive summary">
          <p className="whitespace-pre-wrap">{data.executive_summary}</p>
        </DetailSection>
      )}

      {data.agent_consensus?.length > 0 && (
        <DetailSection label="Agent consensus">
          <ul className="space-y-1.5">
            {data.agent_consensus.map((c, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">+</span>{c}</li>)}
          </ul>
        </DetailSection>
      )}

      {data.agent_disagreements?.length > 0 && (
        <DetailSection label="Agent disagreements">
          <ul className="space-y-1.5">
            {data.agent_disagreements.map((d, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">~</span>{d}</li>)}
          </ul>
        </DetailSection>
      )}

      <QuestionsList questions={data.top_questions} title="Top questions for the next meeting" />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// TEAM
// ════════════════════════════════════════════════════════

function TeamOutput({ data }) {
  const v = data.verdict;
  const subs = data.subcategories;

  return (
    <div>
      {v && (
        <DetailSection label="Read">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-2xl font-bold tabular-nums text-ink">{v.score}</span>
            <span className="text-sm font-semibold text-gray-600">{v.signal}</span>
            {v.archetype && <Tag>{v.archetype}</Tag>}
            {data.stage_classification && <Tag>{data.stage_classification}</Tag>}
          </div>
          <p className="text-sm text-gray-800 font-medium">{v.one_liner}</p>
        </DetailSection>
      )}

      {data.snapshot?.length > 0 && (
        <DetailSection label="Snapshot">
          <ul className="space-y-1.5">
            {data.snapshot.map((b, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">-</span><span>{b}</span></li>)}
          </ul>
        </DetailSection>
      )}

      {data.the_read && <DetailSection label="The read"><p>{data.the_read}</p></DetailSection>}

      {subs && (
        <DetailSection label="Subcategories">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { key: 'founder_problem_fit', label: 'Founder-Problem Fit', weight: '2x' },
              { key: 'sales_capability', label: 'Sales Capability', weight: '2x' },
              { key: 'velocity', label: 'Velocity & Bias to Action' },
              { key: 'storytelling_framing', label: 'Storytelling & Framing' },
              { key: 'team_composition', label: 'Team Composition' },
              { key: 'competitive_precision', label: 'Competitive Precision' },
              { key: 'missionary_conviction', label: 'Missionary Conviction' },
              // Legacy keys (old assessments)
              { key: 'founder_market_fit', label: 'Founder-Market Fit' },
              { key: 'idea_maze', label: 'Idea Maze Navigation' },
              { key: 'experience_stage_fit', label: 'Experience & Stage Fit' },
            ].map(({ key, label, weight }) => {
              const sub = subs[key];
              if (!sub) return null;
              return (
                <SubcategoryCard
                  key={key} label={weight ? `${label} (${weight})` : label}
                  score={sub.score} evidence={sub.evidence}
                  extras={(sub.insight_type || sub.fit_signal) && (
                    <div className="flex items-center gap-1.5 mt-2">
                      {sub.insight_type && <Tag>{sub.insight_type === 'earned_insider' ? 'earned' : 'synthesized'}</Tag>}
                      {sub.fit_signal && <Tag>{sub.fit_signal} fit</Tag>}
                    </div>
                  )}
                />
              );
            })}
          </div>
        </DetailSection>
      )}

      {data.key_quotes?.length > 0 && (
        <DetailSection label="Key quotes">
          {data.quote_integrity && <div className="mb-2"><QuoteIntegritySummary integrity={data.quote_integrity} /></div>}
          <div className="space-y-3">
            {data.key_quotes.map((q, i) => (
              <div key={i} className="border-l-2 border-gray-200 pl-3">
                <div className="flex items-start gap-2">
                  <p className="text-sm text-gray-800 italic flex-1">“{q.quote}”</p>
                  {q.verification && <QuoteVerifyBadge verification={q.verification} />}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  <span className="font-semibold uppercase tracking-wide text-gray-400">{q.signal}</span>
                  {' — '}{q.read}
                </p>
              </div>
            ))}
          </div>
          {data.quote_integrity?.has_unverified && (
            <p className="text-xs text-danger mt-3">
              Unverified quotes were not found in the source materials — treat as paraphrase or model error and confirm before citing.
            </p>
          )}
        </DetailSection>
      )}

      <RisksList risks={data.risks} />
      <QuestionsList questions={data.open_questions} />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// PRODUCT
// ════════════════════════════════════════════════════════

function ProductOutput({ data }) {
  const subs = data.subcategories;
  return (
    <div>
      {data.pillar_score != null && (
        <DetailSection label="Pillar score">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.pillar_score}</span>
          <span className="text-sm text-gray-400">/10</span>
        </DetailSection>
      )}
      {data.product_thesis && <DetailSection label="Product thesis"><p>{data.product_thesis}</p></DetailSection>}
      {data.build_vs_buy_risk && <DetailSection label="Build vs. buy risk"><p>{data.build_vs_buy_risk}</p></DetailSection>}
      {data.vision_gap && <DetailSection label="Vision gap"><p>{data.vision_gap}</p></DetailSection>}

      {subs && (
        <DetailSection label="Subcategories">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { key: 'product_velocity', label: 'Product Velocity' },
              { key: 'customer_proximity', label: 'Customer Proximity' },
              { key: 'focus_prioritization', label: 'Focus & Prioritization' },
              { key: 'moat_architecture', label: 'Moat Architecture' },
              { key: 'flywheel_design', label: 'Flywheel Design' },
              // Legacy keys (old assessments)
              { key: 'technical_defensibility', label: 'Technical Defensibility' },
              { key: 'product_market_intuition', label: 'Product-Market Intuition' },
            ].map(({ key, label }) => {
              const sub = subs[key];
              if (!sub) return null;
              return <SubcategoryCard key={key} label={label} score={sub.score} evidence={sub.evidence} />;
            })}
          </div>
        </DetailSection>
      )}

      <RisksList risks={data.risks} />
      <QuestionsList questions={data.key_questions} />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// MARKET
// ════════════════════════════════════════════════════════

function MarketOutput({ data }) {
  const subs = data.subcategories;
  return (
    <div>
      {data.pillar_score != null && (
        <DetailSection label="Pillar score">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.pillar_score}</span>
          <span className="text-sm text-gray-400">/10</span>
        </DetailSection>
      )}
      {/* structurally_dead is what actually docks the conviction score — surface it. */}
      {data.structurally_dead === true && (
        <DetailSection label="Structurally dead market">
          {/* State the judgment, not the arithmetic — an indeterminate run has no score to
              dock. The Docks section above is the authority on what was actually applied. */}
          <p className="text-danger">
            The market agent judged this category structurally dead — the one market condition that docks the
            conviction score. See Docks.
          </p>
        </DetailSection>
      )}
      {data.why_now && <DetailSection label="Why now"><p>{data.why_now}</p></DetailSection>}
      {data.competitive_moat && <DetailSection label="Competitive moat"><p>{data.competitive_moat}</p></DetailSection>}
      {data.kill_shot_risk && <DetailSection label="Kill shot risk"><p>{data.kill_shot_risk}</p></DetailSection>}

      {subs && (
        <DetailSection label="Subcategories">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { key: 'market_timing', label: 'Market Timing' },
              { key: 'market_structure', label: 'Market Structure' },
              { key: 'incumbent_conflict_mapping', label: 'Incumbent Conflict Mapping' },
              { key: 'tam_realism', label: 'TAM Realism' },
              { key: 'unit_economics_structure', label: 'Unit Economics Structure' },
              { key: 'category_momentum', label: 'Category Momentum' },
              { key: 'neutral_layer_viability', label: 'Neutral Layer Viability' },
              // Legacy keys (old assessments)
              { key: 'competitive_landscape', label: 'Competitive Landscape' },
            ].map(({ key, label }) => {
              const sub = subs[key];
              if (!sub) return null;
              return <SubcategoryCard key={key} label={label} score={sub.score} evidence={sub.evidence} />;
            })}
          </div>
        </DetailSection>
      )}

      <RisksList risks={data.risks} />
      <QuestionsList questions={data.key_questions} />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// BEAR
// ════════════════════════════════════════════════════════

function BearOutput({ data }) {
  return (
    <div>
      {data.bear_adjustment != null && (
        <DetailSection label="Bear adjustment">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.bear_adjustment}</span>
          <p className="text-xs text-gray-400 mt-1">Clamped to [-1.5, 0] before it docks the conviction score. It is never a boost.</p>
        </DetailSection>
      )}

      {data.kill_shot_risk && <DetailSection label="Kill shot risk"><p>{data.kill_shot_risk}</p></DetailSection>}

      {/* twelve_month_kill is {scenario, probability, adjustment} — there is no `evidence`
          field in the prompt schema, so it is not rendered. */}
      {data.twelve_month_kill && (
        <DetailSection label="12-month kill scenario">
          {data.twelve_month_kill.probability && <div className="mb-1.5"><Tag>{data.twelve_month_kill.probability} probability</Tag></div>}
          {data.twelve_month_kill.scenario && <p>{data.twelve_month_kill.scenario}</p>}
          {data.twelve_month_kill.adjustment != null && (
            <p className="text-xs text-gray-400 mt-1">Contributed {data.twelve_month_kill.adjustment} to the bear adjustment.</p>
          )}
        </DetailSection>
      )}

      {/* bundling_risk is {assessment, defensible, adjustment} — NOT {severity, scenario,
          evidence}. The old component read those three nonexistent fields and rendered an
          empty header. */}
      {data.bundling_risk && (
        <DetailSection label="Bundling risk">
          {data.bundling_risk.defensible != null && (
            <div className="mb-1.5"><Tag>{data.bundling_risk.defensible ? 'defensible' : 'not defensible'}</Tag></div>
          )}
          {data.bundling_risk.assessment && <p>{data.bundling_risk.assessment}</p>}
          {data.bundling_risk.adjustment != null && (
            <p className="text-xs text-gray-400 mt-1">Contributed {data.bundling_risk.adjustment} to the bear adjustment.</p>
          )}
        </DetailSection>
      )}

      {data.narrative && <DetailSection label="Bear case"><p className="whitespace-pre-wrap">{data.narrative}</p></DetailSection>}

      {data.primary_risks?.length > 0 && (
        <DetailSection label="Primary risks">
          <div className="space-y-2.5">
            {data.primary_risks.map((r, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-2xs font-semibold uppercase text-gray-400 w-14 flex-shrink-0 pt-0.5">{r.severity}</span>
                <div>
                  <p className="text-sm text-gray-800 font-medium">{r.risk}</p>
                  {r.detail && <p className="text-xs text-gray-500 mt-0.5">{r.detail}</p>}
                  {r.mitigation && <p className="text-xs text-gray-400 mt-0.5">Mitigation: {r.mitigation}</p>}
                </div>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {data.failure_scenarios?.length > 0 && (
        <DetailSection label="Failure scenarios">
          <ul className="space-y-1.5">
            {data.failure_scenarios.map((s, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">-</span>{s}</li>)}
          </ul>
        </DetailSection>
      )}

      {data.deck_omissions?.length > 0 && (
        <DetailSection label="Deck omissions">
          <ul className="space-y-1.5">
            {data.deck_omissions.map((o, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">?</span>{o}</li>)}
          </ul>
        </DetailSection>
      )}

      {data.assumptions_required?.length > 0 && (
        <DetailSection label="Required assumptions">
          <div className="space-y-2">
            {data.assumptions_required.map((a, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-2xs font-semibold uppercase text-gray-400 w-14 flex-shrink-0 pt-0.5">{a.likelihood}</span>
                <p className="text-sm text-gray-700">{a.assumption}</p>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      <QuestionsList questions={data.key_questions} />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// Deal Memo — Danny's 7-M structure, assembled from the already-computed
// team/product/market/bear/synthesis outputs. No new LLM call. Two honest gaps are called
// out inline: Model has no dedicated unit-economics agent, Conditions has no deal-terms agent.
// ════════════════════════════════════════════════════════

function sub(obj, key) { return obj && obj.subcategories && obj.subcategories[key]; }

function buildDealMemo({ team, product, market, bear, synthesis }) {
  if (!synthesis) return null;
  const conviction = synthesis.conviction || null;
  return {
    recommendation: {
      // The recommendation is the conviction band — not a pillar average. When conviction
      // is indeterminate there is no signal and no score, and the memo must say so.
      determinate: !!conviction?.determinate,
      signal: conviction?.determinate ? conviction.band.label : 'Insufficient evidence',
      action: conviction?.determinate ? conviction.band.action : null,
      score: conviction?.determinate ? conviction.score : null,
      reason: conviction?.determinate ? null : conviction?.reason,
      oneLiner: synthesis.one_liner,
      nextStep: synthesis.recommended_next_step,
      summary: synthesis.executive_summary,
      consensus: synthesis.agent_consensus,
      disagreements: synthesis.agent_disagreements,
    },
    management: team && !team.error && {
      verdict: team.verdict,
      theRead: team.the_read,
      snapshot: team.snapshot,
      subs: [
        ['founder_problem_fit', 'Founder-Problem Fit'], ['sales_capability', 'Sales Capability'],
        ['velocity', 'Velocity'], ['storytelling_framing', 'Storytelling & Framing'],
        ['team_composition', 'Team Composition'], ['competitive_precision', 'Competitive Precision'],
        ['missionary_conviction', 'Missionary Conviction'],
      ].map(([k, label]) => ({ label, ...sub(team, k) })).filter(s => s.score != null),
      quotes: team.key_quotes,
    },
    model: {
      unitEconomics: sub(market, 'unit_economics_structure'),
      moat: sub(product, 'moat_architecture'),
      flywheel: sub(product, 'flywheel_design'),
      note: 'Assembled from the Market and Product agents’ unit-economics and defensibility subscores — Stu does not run a dedicated financial-model agent. Treat as directional.',
    },
    market: market && !market.error && {
      whyNow: market.why_now,
      competitiveMoat: market.competitive_moat,
      killShotRisk: market.kill_shot_risk,
      subs: [
        ['market_timing', 'Market Timing'], ['market_structure', 'Market Structure'],
        ['incumbent_conflict_mapping', 'Incumbent Conflict Mapping'], ['tam_realism', 'TAM Realism'],
        ['category_momentum', 'Category Momentum'], ['neutral_layer_viability', 'Neutral Layer Viability'],
      ].map(([k, label]) => ({ label, ...sub(market, k) })).filter(s => s.score != null),
    },
    momentum: [
      ['Team Velocity', sub(team, 'velocity')],
      ['Product Velocity', sub(product, 'product_velocity')],
      ['Customer Proximity', sub(product, 'customer_proximity')],
      ['Category Momentum', sub(market, 'category_momentum')],
    ].filter(([, s]) => s && s.score != null),
    malfeasance: bear && !bear.error && {
      primaryRisks: bear.primary_risks,
      twelveMonthKill: bear.twelve_month_kill,
      bundlingRisk: bear.bundling_risk,
      deckOmissions: bear.deck_omissions,
      narrative: bear.narrative,
      note: 'The Bear agent’s adversarial business/competitive/execution risk read — not a fraud or legal-diligence check.',
    },
    conditions: {
      topQuestions: synthesis.top_questions,
      assumptions: bear && !bear.error && bear.assumptions_required,
      nextStep: synthesis.recommended_next_step,
      note: 'Stu does not evaluate deal terms, valuation, or round structure — bring these separately.',
    },
  };
}

function MemoSection({ title, subtitle, note, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2 pb-1.5 border-b border-gray-100">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
        {subtitle && <span className="text-2xs text-gray-400">{subtitle}</span>}
      </div>
      <div className="text-sm text-gray-700 leading-relaxed">{children}</div>
      {note && <p className="text-xs text-gray-400 italic mt-3">{note}</p>}
    </div>
  );
}

function MemoSubList({ items }) {
  if (!items || items.length === 0) return <p className="text-sm text-gray-400">No scored subcategories.</p>;
  return (
    <div className="space-y-3">
      {items.map((s, i) => (
        <div key={i}>
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <span className="text-sm font-medium text-gray-700">{s.label}</span>
            <Score value={s.score} max={10} />
          </div>
          {s.evidence && <p className="text-xs text-gray-500 leading-snug">{s.evidence}</p>}
        </div>
      ))}
    </div>
  );
}

function MemoSectionCollapsed({ team, product, market, bear, synthesis }) {
  const memo = buildDealMemo({ team, product, market, bear, synthesis });
  if (!memo) return null;
  const { recommendation: r, management: m, model, market: mkt, momentum, malfeasance: mf, conditions: c } = memo;

  return (
    <Collapsible id="section-memo" title="Deal memo" subtitle="The 7-M structure, assembled from the outputs above. No new analysis.">
      <div className="space-y-7">
        <MemoSection title="I. Recommendation">
          <div className="flex items-baseline gap-3 mb-2">
            <span className={`text-3xl font-bold tabular-nums ${r.determinate ? 'text-ink' : 'text-gray-200'}`}>
              {r.determinate ? r.score : '—'}
            </span>
            <span className={`text-lg font-semibold ${r.determinate ? 'text-ink' : 'text-gray-400'}`}>{r.signal}</span>
            {r.action && <span className="text-xs text-gray-500 ml-auto">{r.action}</span>}
          </div>
          {r.reason && <p className="mb-2">{r.reason}</p>}
          {r.oneLiner && <p className="font-medium text-gray-800 mb-2">{r.oneLiner}</p>}
          {r.summary && <p className="whitespace-pre-line">{r.summary}</p>}
        </MemoSection>

        <MemoSection title="II. Management">
          {m ? (
            <div className="space-y-3">
              {m.verdict && <p className="font-medium text-gray-800">{m.verdict.one_liner} <span className="text-gray-400 font-normal">({m.verdict.archetype})</span></p>}
              {m.theRead && <p>{m.theRead}</p>}
              <MemoSubList items={m.subs} />
            </div>
          ) : <p className="text-gray-400">Team agent output not available.</p>}
        </MemoSection>

        <MemoSection title="III. Model" note={model.note}>
          <div className="space-y-3">
            {[['Unit Economics Structure', model.unitEconomics], ['Moat Architecture', model.moat], ['Flywheel Design', model.flywheel]]
              .filter(([, s]) => s && s.score != null)
              .map(([label, s], i) => (
                <div key={i}>
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-sm font-medium text-gray-700">{label}</span>
                    <Score value={s.score} max={10} />
                  </div>
                  <p className="text-xs text-gray-500 leading-snug">{s.evidence}</p>
                </div>
              ))}
          </div>
        </MemoSection>

        <MemoSection title="IV. Market">
          {mkt ? (
            <div className="space-y-3">
              {mkt.whyNow && <p><span className="font-semibold text-gray-800">Why now: </span>{mkt.whyNow}</p>}
              {mkt.competitiveMoat && <p><span className="font-semibold text-gray-800">Competitive moat: </span>{mkt.competitiveMoat}</p>}
              <MemoSubList items={mkt.subs} />
            </div>
          ) : <p className="text-gray-400">Market agent output not available.</p>}
        </MemoSection>

        <MemoSection title="V. Momentum" subtitle="cross-agent">
          <MemoSubList items={momentum.map(([label, s]) => ({ label, ...s }))} />
        </MemoSection>

        <MemoSection title="VI. Malfeasance" note={mf?.note}>
          {mf ? (
            <div className="space-y-3">
              {mf.narrative && <p>{mf.narrative}</p>}
              {mf.twelveMonthKill?.scenario && (
                <p><span className="font-semibold text-gray-800">12-month kill scenario ({mf.twelveMonthKill.probability}): </span>{mf.twelveMonthKill.scenario}</p>
              )}
              {mf.bundlingRisk?.assessment && (
                <p><span className="font-semibold text-gray-800">Bundling risk ({mf.bundlingRisk.defensible ? 'defensible' : 'not defensible'}): </span>{mf.bundlingRisk.assessment}</p>
              )}
              {mf.primaryRisks?.length > 0 && (
                <div className="space-y-2 pt-1">
                  {mf.primaryRisks.map((rk, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-2xs font-semibold uppercase text-gray-400 w-14 flex-shrink-0 pt-0.5">{rk.severity}</span>
                      <p>{rk.risk}{rk.mitigation && <span className="text-gray-400"> — {rk.mitigation}</span>}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : <p className="text-gray-400">Bear agent output not available.</p>}
        </MemoSection>

        <MemoSection title="VII. Conditions" note={c.note}>
          <div className="space-y-3">
            {c.nextStep && <p><span className="font-semibold text-gray-800">Recommended next step: </span>{c.nextStep}</p>}
            {c.topQuestions?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">What needs to be true / next questions</p>
                <ul className="space-y-1">
                  {c.topQuestions.map((q, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">{i + 1}.</span>{q}</li>)}
                </ul>
              </div>
            )}
          </div>
        </MemoSection>
      </div>
    </Collapsible>
  );
}

// ════════════════════════════════════════════════════════
// Materials
// ════════════════════════════════════════════════════════

function MaterialsCollapsed({ inputs }) {
  return (
    <Collapsible id="section-inputs" title="Materials" subtitle={`${inputs.length} input${inputs.length === 1 ? '' : 's'} handed to the agents`}>
      {inputs.length === 0 ? (
        <p className="text-sm text-gray-400">No input materials recorded.</p>
      ) : (
        <div className="space-y-4">
          {inputs.map((inp, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <Tag>{inp.input_type}</Tag>
                <span className="text-sm font-medium text-gray-700">{inp.label || inp.input_type}</span>
                {inp.source_url && (
                  <a href={inp.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline truncate">{inp.source_url}</a>
                )}
              </div>
              <p className="text-xs text-gray-500 max-h-32 overflow-y-auto whitespace-pre-wrap bg-gray-50 rounded-lg p-3">
                {(inp.content || '').slice(0, 2000)}{(inp.content || '').length > 2000 ? '…' : ''}
              </p>
            </div>
          ))}
        </div>
      )}
    </Collapsible>
  );
}

// ════════════════════════════════════════════════════════
// Meeting Prep — a briefing, not an eval. Own layout, no verdict, no scores.
// ════════════════════════════════════════════════════════

function MeetingPrepDetail({ assessment, brief, isRunning, isComplete, error, onRerun, rerunning }) {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/assess" className="hover:text-gray-600">Assess</Link>
        <span>/</span>
        <span className="text-gray-700">Meeting Prep</span>
      </div>

      <PageHeader
        title={assessment.founder_name || 'Unknown Founder'}
        subtitle={assessment.founder_company || null}
        actions={(error || (!isRunning && !isComplete)) && (
          <button onClick={onRerun} disabled={rerunning}
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
            {rerunning ? 'Starting…' : 'Re-run'}
          </button>
        )}
      />

      {isRunning && <div className="text-center py-12 text-gray-400 text-sm animate-pulse">Preparing the briefing…</div>}
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-gray-700">
          The briefing failed to generate.{' '}
          <button onClick={onRerun} disabled={rerunning} className="text-accent font-medium underline">{rerunning ? 'Starting…' : 'Retry'}</button>
        </div>
      )}
      {!isRunning && !error && !brief && <EmptyState title="Not available" />}

      {brief && (
        <div className="space-y-7">
          <MemoSection title="Founder Profile">
            <p className="whitespace-pre-line">{brief.founder_profile}</p>
          </MemoSection>

          {brief.company_snapshot && (
            <MemoSection title="Company Snapshot">
              <div className="space-y-2">
                {brief.company_snapshot.one_liner && <p className="font-medium text-gray-800">{brief.company_snapshot.one_liner}</p>}
                {brief.company_snapshot.stage_and_traction && <p><span className="font-semibold text-gray-800">Stage & traction: </span>{brief.company_snapshot.stage_and_traction}</p>}
                {brief.company_snapshot.product && <p><span className="font-semibold text-gray-800">Product: </span>{brief.company_snapshot.product}</p>}
                {brief.company_snapshot.competitors && <p><span className="font-semibold text-gray-800">Competitors: </span>{brief.company_snapshot.competitors}</p>}
              </div>
            </MemoSection>
          )}

          {brief.thesis_fit && (
            <MemoSection title="Thesis Fit">
              <p className="font-semibold text-ink mb-1">{brief.thesis_fit.verdict}</p>
              <p>{brief.thesis_fit.reasoning}</p>
            </MemoSection>
          )}

          {brief.market_context && (
            <MemoSection title="Market Context"><p>{brief.market_context}</p></MemoSection>
          )}

          {brief.questions_to_ask?.length > 0 && (
            <MemoSection title="Questions to Ask">
              <ul className="space-y-1.5">
                {brief.questions_to_ask.map((q, i) => (
                  <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">{i + 1}.</span>{q}</li>
                ))}
              </ul>
            </MemoSection>
          )}

          {brief.danny_angle && (
            <MemoSection title="Danny's Angle">
              <div className="space-y-3">
                {brief.danny_angle.watch_for && <p>{brief.danny_angle.watch_for}</p>}
                {brief.danny_angle.lean_in_signals?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 mb-1">Lean-in signals</p>
                    <ul className="space-y-1">{brief.danny_angle.lean_in_signals.map((s, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">+</span>{s}</li>)}</ul>
                  </div>
                )}
                {brief.danny_angle.pass_signals?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 mb-1">Pass signals</p>
                    <ul className="space-y-1">{brief.danny_angle.pass_signals.map((s, i) => <li key={i} className="flex gap-2"><span className="text-gray-300 flex-shrink-0">-</span>{s}</li>)}</ul>
                  </div>
                )}
              </div>
            </MemoSection>
          )}
        </div>
      )}
    </div>
  );
}
