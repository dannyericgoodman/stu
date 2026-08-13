import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';

// ══════════════════════════════════════════════════════════════════════════
// The company card. Everything Danny knows about one company, in one place.
//
// "When I click into the companies in pipeline, I want to be able to read
//  everything about them. Their decks (if provided), site URL, Founder LinkedIn
//  URL, company hiring signals, Granola notes, etc. These should all be fields I
//  can enter and edit too, but I'm sure a lot of this can be automated like
//  Harmonic."  — 2026-07-15
//
// ── THE ORGANISING RULE ──
// Two authors, never merged. Danny owns the columns; the machine owns the blob.
// A re-fetch can never clobber his typing, and his typing can never be mistaken
// for LinkedIn's data. That's why every field here is either an <Editable/> (his,
// dark ink, saves on blur) or a machine block (grey, with provenance) — and never
// something in between.
//
// ── WHAT EARNS A PLACE ──
// Density is not decoration. He takes ~28 first calls a month and needs to
// re-enter a company cold, six weeks later, in about fifteen seconds. So the
// answer to "who are these people and are they real" is above the fold, and
// everything else is one scroll.
// ══════════════════════════════════════════════════════════════════════════

export default function CompanyCard() {
  const { id } = useParams();
  const nav = useNavigate();
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(() => {
    api.getPipelineCompany(id).then(setC).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  // Save one field. Optimistic — the row is already on screen and a save that
  // repaints the whole card would lose his scroll position and his place.
  async function save(field, value) {
    if (!c || String(c[field] ?? '') === String(value ?? '')) return;
    setC((s) => ({ ...s, [field]: value }));
    try {
      await api.updatePipelineCompany(id, { [field]: value });
    } catch (e) {
      setErr(e.message);
      load(); // put the truth back
    }
  }

  // Put a folded co-founder back on the board as their own card. The inverse of
  // folding exists because folding is a view decision, not a deletion — Danny has
  // to be able to change his mind without anything being gone.
  async function unfold(founderId) {
    try {
      await api.setRepresentedBy(founderId, null);
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function enrich() {
    setEnriching(true);
    setErr(null);
    try {
      const blob = await api.enrichPipelineCompany(id);
      setC((s) => ({ ...s, enrichment: blob }));
      setFlash(`Found ${blob.people?.length ?? 0} people`);
      setTimeout(() => setFlash(null), 4000);
    } catch (e) {
      setErr(e.detail ? `${e.message} — ${e.detail}` : e.message);
    } finally {
      setEnriching(false);
    }
  }

  if (err && !c) return <div className="p-4 text-small text-danger">{err}</div>;
  if (!c) return <CardSkeleton />;

  const e = c.enrichment;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* ── Identity bar ── */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-2 bg-ground sticky top-0 z-10 flex-shrink-0">
        <button onClick={() => nav('/pipeline')} className="text-mini text-ink-4 hover:text-ink">← Pipeline</button>
        <span className="text-ink-4">/</span>
        <Editable
          value={c.company}
          onSave={(v) => save('company', v)}
          className="text-small font-semibold text-ink"
          placeholder="Company name"
        />
        <Stage stage={c.funnel_stage} />
        <div className="flex-1" />
        <RunRead founderId={id} company={c} />
      </div>

      {err && (
        <div className="px-3 py-2 border-b border-line bg-danger-soft text-mini text-danger flex items-center gap-2">
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="text-ink-4 hover:text-ink">dismiss</button>
        </div>
      )}
      {flash && (
        <div className="px-3 py-2 border-b border-line bg-accent-soft text-mini text-ink">{flash}</div>
      )}

      <div className="grid grid-cols-[1fr_320px] gap-0 flex-1 min-h-0">
        {/* ══ LEFT: the company ══ */}
        <div className="border-r border-line-2 min-w-0">
          {/* One line on what they do. The thing he forgets first. */}
          <Block>
            <Editable
              value={c.company_one_liner}
              onSave={(v) => save('company_one_liner', v)}
              className="text-regular text-ink leading-relaxed"
              placeholder="What do they do? One line."
              multiline
            />
          </Block>

          {/* ══ THE TEAM — the automated half ══ */}
          <Block label="The team" right={
            <button onClick={enrich} disabled={enriching} className="text-mini text-accent hover:text-accent-hover disabled:text-ink-4">
              {enriching ? 'Reading LinkedIn…' : e ? 'Refresh' : 'Fetch from LinkedIn'}
            </button>
          }>
            {!e ? (
              <Empty>
                {c.company_linkedin_url
                  ? 'Not fetched yet. Costs ~2 credits + 4 per employee.'
                  : 'Add the company LinkedIn URL on the right, then fetch.'}
              </Empty>
            ) : !e.people?.length ? (
              <Empty>LinkedIn returned no employees for this company.</Empty>
            ) : (
              <>
                {/* Verified vs self-reported. LinkedIn's company page said 8 for
                    Permute; only 3 people's own profiles name it. Both numbers are
                    "true" and they mean different things, so both are shown rather
                    than one being quietly picked. */}
                <div className="flex items-baseline gap-3 mb-2">
                  <span className="text-display num text-ink">{e.verified_count}</span>
                  <span className="text-mini text-ink-3">
                    verified from profiles
                    {e.size_on_linkedin != null && e.size_on_linkedin !== e.verified_count && (
                      <> · company page claims <span className="num">{e.size_on_linkedin}</span></>
                    )}
                  </span>
                  {e.team_arrival?.delta > 0 && (
                    <span className="text-mini text-ink-2">
                      +<span className="num">{e.team_arrival.delta}</span> in {e.team_arrival.months}mo
                    </span>
                  )}
                </div>

                {e.team_arrival && <Sparkline curve={e.team_arrival} />}

                <div className="mt-2 -mx-2">
                  {e.people.map((p, i) => (
                    <div key={i} className="row px-2">
                      <span className="w-40 min-w-0">
                        {p.linkedin_url ? (
                          <a href={p.linkedin_url} target="_blank" rel="noopener noreferrer" className="row-primary hover:text-accent">
                            {p.name}
                          </a>
                        ) : (
                          <span className="row-primary">{p.name}</span>
                        )}
                      </span>
                      <span className="w-48 text-mini text-ink-2 truncate">{p.title}</span>
                      <span className="w-16 text-mini text-ink-3 num">{p.joined || '—'}</span>
                      {/* Danny's explicit ask, and the sleeper feature: prior
                          employers intersected with his own network IS the warm
                          path. Affinity charges $2k/user/yr for this column and
                          computes it from email metadata; this is employment
                          history, and it arrives in the same call as the rest. */}
                      <span className="flex-1 text-mini text-ink-3 truncate" title={(p.previously || []).join(' · ')}>
                        {p.previously?.length ? p.previously.slice(0, 3).join(' · ') : '—'}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-micro text-ink-4 mt-2">
                  Arrival curve is built from current employees’ start dates — anyone who joined and left isn’t in it.
                  {e.fetched_at && ` Read ${String(e.fetched_at).slice(0, 10)}.`}
                </p>
              </>
            )}
          </Block>

          {/* ══ YOUR CALL — first, because his read outranks anything a machine fetched ══ */}
          <YourCall founderId={id} company={c} onChange={load} />

          {/* ══ THE PUBLIC RECORD — free, and the only block true of every card ══ */}
          <PublicRecord founderId={id} company={c} onChange={load} />

          {/* ══ WHAT STU HAS READ ══ */}
          <Sources founderId={id} company={c} />

          {/* ══ NOTES — Granola + his own ══ */}
          <Notes founderId={id} notes={c.notes} onChange={load} />
        </div>

        {/* ══ RIGHT: the fields he owns ══ */}
        <div className="min-w-0">
          <Block label="Links">
            <Field label="Website" value={c.website_url} onSave={(v) => save('website_url', v)} link />
            <Field label="Deck" value={c.deck_url} onSave={(v) => save('deck_url', v)} link />
            <Field label="Data room" value={c.data_room_url} onSave={(v) => save('data_room_url', v)} link />
            <Field label="Founder LinkedIn" value={c.linkedin_url} onSave={(v) => save('linkedin_url', v)} link />
            <Field
              label="Company LinkedIn"
              value={c.company_linkedin_url}
              onSave={(v) => save('company_linkedin_url', v)}
              link
              hint="the /company/ page — powers the team block"
            />
          </Block>

          <Block label="Founder">
            <Field label="Name" value={c.name} onSave={(v) => save('name', v)} />
            <Field label="Role" value={c.role} onSave={(v) => save('role', v)} />
            <Field label="Email" value={c.email} onSave={(v) => save('email', v)} />
            <Field label="Illinois tie" value={c.chicago_connection} onSave={(v) => save('chicago_connection', v)} />
          </Block>

          {/* ── The co-founders folded into this card ──
              Danny: "Eric Mills and Scott Nelson are both showing for Permute...
              Could we just have Scott and Kyle kept in?" They're off the BOARD, not
              out of the product — Eric is still Permute's co-founder. Folding a
              relationship out of sight to tidy a column would be deleting it. */}
          {c.cofounders?.length > 0 && (
            <Block label={c.cofounders.length > 1 ? 'Co-founders' : 'Co-founder'}>
              {c.cofounders.map((p) => (
                <div key={p.id} className="flex items-baseline gap-2 py-0.5">
                  <span className="text-small text-ink flex-1 truncate">{p.name}</span>
                  {p.role && <span className="text-mini text-ink-4 truncate">{p.role}</span>}
                  {p.linkedin_url && (
                    <a href={p.linkedin_url} target="_blank" rel="noreferrer" className="text-mini text-accent flex-none">in ↗</a>
                  )}
                  <button
                    onClick={() => unfold(p.id)}
                    title="Put them back on the board as their own card"
                    className="text-mini text-ink-4 hover:text-ink flex-none"
                  >
                    unfold
                  </button>
                </div>
              ))}
            </Block>
          )}

          {/* This card is folded into another. Say so — a card that isn't on the
              board otherwise reads as a bug rather than a decision. */}
          {c.represented_by && (
            <Block label="Folded into">
              <div className="flex items-baseline gap-2 py-0.5">
                <button
                  onClick={() => nav(`/founders/${c.represented_by.id}`)}
                  className="text-small text-accent flex-1 text-left truncate"
                >
                  {c.represented_by.company} · {c.represented_by.name}
                </button>
                <button onClick={() => unfold(c.id)} className="text-mini text-ink-4 hover:text-ink flex-none">
                  unfold
                </button>
              </div>
              <p className="text-mini text-ink-4 leading-snug pt-1">
                This founder isn't on the board — their company is shown by that card.
              </p>
            </Block>
          )}

          <Block label="Deal">
            <Field label="Stage" value={c.deal_status} onSave={(v) => save('deal_status', v)} />
            <Field label="Round" value={c.stage} onSave={(v) => save('stage', v)} />
            <Field label="ARR" value={c.arr} onSave={(v) => save('arr', v)} num />
            <Field label="Burn / mo" value={c.monthly_burn} onSave={(v) => save('monthly_burn', v)} num />
            <Field label="Runway (mo)" value={c.runway_months} onSave={(v) => save('runway_months', v)} num />
            <Field label="Valuation" value={c.valuation} onSave={(v) => save('valuation', v)} num />
            <Field label="Round size" value={c.round_size} onSave={(v) => save('round_size', v)} num />
            <Field label="We invested" value={c.investment_amount} onSave={(v) => save('investment_amount', v)} num />
          </Block>

          {e?.industry && (
            <Block label="From LinkedIn">
              <Ro label="Industry" v={e.industry} />
              <Ro label="Founded" v={e.founded_year} />
              <Ro label="HQ" v={hq(e.hq)} />
              <Ro label="Size band" v={e.size_range ? `${e.size_range[0]}–${e.size_range[1] ?? '∞'}` : null} />
              {/* LinkedIn's website, shown ONLY when it disagrees with Danny's.
                  Real case that surfaced this: Permute's website_url was
                  "scout.space" — Scott Nelson's PREVIOUS company, inherited from
                  bad sourcing data — while LinkedIn correctly said permute.ai.
                  Auto-overwriting his field would be the wrong fix: he owns those
                  columns. Showing the disagreement and letting him take it in one
                  click is the right one. Silence would just leave the wrong URL
                  sitting there looking authoritative. */}
              {e.website && normUrl(e.website) !== normUrl(c.website_url) && (
                <div className="flex items-baseline gap-2 h-6">
                  <span className="w-24 text-mini text-ink-4 flex-shrink-0">Website</span>
                  <span className="text-mini text-ink-2 truncate flex-1">{normUrl(e.website)}</span>
                  <button
                    onClick={() => save('website_url', e.website)}
                    className="text-micro text-accent hover:text-accent-hover flex-shrink-0"
                    title={c.website_url ? `Yours says ${normUrl(c.website_url)}` : 'Your field is empty'}
                  >
                    {c.website_url ? 'use this' : 'add'}
                  </button>
                </div>
              )}
            </Block>
          )}

          {c.source && (
            <Block label="How you found them">
              {/* Source is a CHAIN, not a dropdown — Airtable records only the last
                  hop, which is why outbound looks like it produces nothing when
                  it's actually how the top of the funnel gets filled. */}
              <p className="text-mini text-ink-3">{c.source}</p>
              {c.sourced_from_id && <p className="text-micro text-ink-4 mt-1">via the sourcing inbox</p>}
            </Block>
          )}
        </div>
      </div>
    </div>
  );
}

// ── The arrival curve, drawn small. ──
// No chart library: 13 points and a polyline. Recharts would be 40KB gzipped for
// a shape that is nine lines of SVG, on a page whose whole budget matters.
function Sparkline({ curve }) {
  const pts = curve.series;
  if (!pts?.length) return null;
  const max = Math.max(...pts.map((p) => p.count), 1);
  const W = 260, H = 28;
  const d = pts
    .map((p, i) => `${(i / Math.max(pts.length - 1, 1)) * W},${H - (p.count / max) * H}`)
    .join(' ');
  return (
    <div className="flex items-center gap-2">
      <svg width={W} height={H} className="overflow-visible">
        <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-3" />
      </svg>
      <span className="text-micro text-ink-4">
        {pts[0].at} → {pts[pts.length - 1].at}
      </span>
    </div>
  );
}

// ── The action the card was missing. ──
// It linked to an EXISTING read and offered no way to start one — so running a
// read on a company whose deck and calls were already on the card meant going to
// /assess and re-uploading all of it. This hands the engine what's already here.
function RunRead({ founderId, company: c }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const latest = c.assessments?.[0];

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.runCardRead(founderId);
      nav(`/assess/${r.id}`);
    } catch (e) {
      setErr(e.detail ? `${e.message} ${e.detail}` : e.message);
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {err && <span className="text-mini text-danger max-w-md truncate" title={err}>{err}</span>}
      {latest && (
        <Link to={`/assess/${latest.id}`} className="text-mini text-ink-3 hover:text-ink">
          Last read {String(latest.created_at).slice(0, 10)}
        </Link>
      )}
      <button onClick={go} disabled={busy} className="btn-primary">
        {busy ? 'Assessing…' : latest ? 'Assess again' : 'Assess this company'}
      </button>
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SOURCES + SIGNALS — the loop, closed.
//
// Danny: "This should be very automated but give me the ability to input and
// modify wherever possible."
//
// So: automated where a machine is genuinely better (extract signals from a deck,
// read the team off LinkedIn), manual everywhere he might disagree (add a source,
// re-extract, delete a source and its claims, add his own note).
//
// The rule that shapes this block: EVERY SIGNAL SHOWS ITS RECEIPT. A claim renders
// with the verbatim line that proves it, one hover away, and the source it came
// from is named. If Danny can't check it in two seconds, it shouldn't be here —
// that's what lib/signals.js enforces in the schema and this is where he sees it.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// YOUR CALL — the only thing here nobody can buy.
//
// Danny: "It's way more efficient if I come in with conviction one way or the
// other before brokering the second meeting."
//
// ── WHY THIS BLOCK EXISTS ──
// Measured on production 2026-07-16: **0 of 183 cards carried Danny's call.**
// Not because he has no view — he takes ~28 first calls a month and forms one on
// every single one. Because `createDecision` was only reachable from the
// assessment page, so recording a view REQUIRED a ~$2, 215-second AI run to exist
// first. He could record his judgement on 9 of 183 cards.
//
// The free, abundant, proprietary thing was gated behind the expensive, rare,
// commodity thing. That is exactly backwards, and it is why the disagreement
// dataset — described in pipeline.js as "the only dataset in this product that
// compounds, and the only question no tool he can buy is able to answer" — had
// zero rows on both sides.
//
// The server never required an assessment (`assessment_id || null`). This was
// purely a missing affordance. So: band, one line, a dated prediction, from the
// card, in about five seconds, whether or not Stu has ever looked at the company.
//
// ── THE PREDICTION STAYS REQUIRED ──
// The server refuses a decision without one and says why. That refusal is not
// friction to be designed around — it IS the feature. Danny's own pattern analysis
// found his undocumented passes on strong founders were his most fixable blind
// spot: "you can't tell whether those were good passes or fear/laziness." A pass
// without a dated, checkable claim isn't a decision; it's a reflex. So this block
// surfaces the server's sentence rather than a generic error.
// ══════════════════════════════════════════════════════════════════════════
const BANDS = [
  { key: 'anchor', label: 'Anchor-grade', hint: 'First call within a week' },
  { key: 'memo', label: 'Top-quartile', hint: 'Write a memo' },
  { key: 'monitor', label: 'Monitor', hint: 'Track the next data point' },
  { key: 'pass', label: 'Pass with respect', hint: 'Pass' },
];

// Ninety days out. Long enough that a pre-seed claim can actually resolve, short
// enough that he'll still remember the call.
function defaultResolveBy() {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

function YourCall({ founderId, company: c, onChange }) {
  const d = c.my_decision;
  const [open, setOpen] = useState(false);
  const [band, setBand] = useState(d?.band || null);
  const [rationale, setRationale] = useState('');
  const [prediction, setPrediction] = useState('');
  const [resolveBy, setResolveBy] = useState(defaultResolveBy());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null); setSaving(true);
    try {
      await api.createDecision({
        founder_id: Number(founderId),
        // Deliberately absent when Stu hasn't run. A decision with no assessment is
        // the NORMAL case — 174 of 183 cards — not a degraded one.
        assessment_id: c.assessment_id || undefined,
        band, rationale, prediction, resolve_by: resolveBy,
      });
      setOpen(false); onChange();
    } catch (e) {
      // The server's refusal is the teaching. Show its words.
      setErr(e.detail ? `${e.message} ${e.detail}` : e.message);
    } finally { setSaving(false); }
  }

  if (d && !open) {
    return (
      <Block label="Your call" right={
        <span className="flex items-center gap-2">
          {/* Change records a NEW decision and supersedes; both are kept. Delete is
              for a mis-click or a probe, not for changing his mind. */}
          <button onClick={() => setOpen(true)} className="text-mini text-accent hover:text-accent-hover">Change</button>
          <button
            onClick={async () => {
              if (!confirm('Delete this call? Changing your mind doesn’t need this — recording a new one supersedes it.')) return;
              try { await api.deleteDecision(d.id); onChange(); } catch (e) { setErr(e.message); }
            }}
            className="text-mini text-ink-4 hover:text-danger"
          >delete</button>
        </span>
      }>
        <div className="flex items-baseline gap-3">
          <span className={`band band-${d.band}`}>{BANDS.find((b) => b.key === d.band)?.label || d.band}</span>
          <span className="text-mini text-ink-3">{String(d.decided_at || '').slice(0, 10)}</span>
          {/* The disagreement is the artifact — the only thing here that compounds. */}
          {d.stu_band && d.stu_band !== d.band && d.stu_band !== 'indeterminate' && (
            <span className="text-mini text-attention" title={`Stu read this as ${d.stu_band}`}>
              Stu said {d.stu_band}
            </span>
          )}
        </div>
        {d.rationale && <p className="text-mini text-ink-2 mt-1">{d.rationale}</p>}
        {d.prediction && (
          <p className="text-mini text-ink-3 mt-1">
            <span className="text-ink-4">Predicted:</span> {d.prediction}
            {d.resolve_by && <span className="text-ink-4"> · check {String(d.resolve_by).slice(0, 10)}</span>}
          </p>
        )}
      </Block>
    );
  }

  if (!open) {
    return (
      <Block label="Your call">
        <button onClick={() => setOpen(true)} className="text-mini text-accent hover:text-accent-hover">
          Record your read →
        </button>
        <p className="text-micro text-ink-4 mt-1">
          Takes a band, a line, and something checkable. Stu doesn’t need to have run.
        </p>
      </Block>
    );
  }

  return (
    <Block label="Your call" right={
      <button onClick={() => { setOpen(false); setErr(null); }} className="text-mini text-ink-4 hover:text-ink">cancel</button>
    }>
      {err && <p className="text-mini text-danger mb-2">{err}</p>}

      <div className="flex flex-wrap gap-1 mb-2">
        {BANDS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBand(b.key)}
            title={b.hint}
            className={`text-mini px-2 py-1 rounded-sm border transition ${
              band === b.key ? 'border-accent-line bg-accent-soft text-ink' : 'border-line text-ink-3 hover:border-line-3'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <textarea
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="Why? One line."
        rows={2}
        className="w-full text-mini bg-ground border border-line rounded-sm px-2 py-1 mb-1 focus:border-line-3 focus:outline-none"
      />
      <textarea
        value={prediction}
        onChange={(e) => setPrediction(e.target.value)}
        placeholder="What will be true — or not — by the date below?"
        rows={2}
        className="w-full text-mini bg-ground border border-line rounded-sm px-2 py-1 focus:border-line-3 focus:outline-none"
      />
      <div className="flex items-center gap-2 mt-1">
        <span className="text-micro text-ink-4">Check on</span>
        <input
          type="date"
          value={resolveBy}
          onChange={(e) => setResolveBy(e.target.value)}
          className="text-mini bg-ground border border-line rounded-sm px-1 py-0.5 num focus:border-line-3 focus:outline-none"
        />
        <div className="flex-1" />
        <button
          onClick={submit}
          disabled={!band || saving}
          className="text-mini px-2 py-1 rounded-sm bg-ink text-ground disabled:bg-ground-4 disabled:text-ink-4"
        >
          {saving ? 'Saving…' : 'Record'}
        </button>
      </div>
    </Block>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// The public record — what the SEC and their job board say, for free.
//
// Danny: "click a founder/company and be able to get a lot of insight into how the
// company is doing. How many people/are they hiring and growing, what you could
// learn from the company site and crunchbase, etc..."
//
// The team block above answers headcount and growth but costs credits and needs a
// resolved LinkedIn URL. This costs nothing, so it's the block that can be true of
// every card rather than the two that had the URL.
//
// ── HOW THIS BLOCK EARNS TRUST ──
// Every fact here is either sworn to the SEC or posted by the company itself, so
// the risk isn't accuracy — it's ATTRIBUTION. Show another company's Form D and
// Danny walks into IC with a number that is real and isn't theirs. So the server
// refuses far more often than it answers, and this block renders the refusal
// rather than hiding it: a reason he can read beats an empty space he'll assume is
// a bug.
//
// The `name-only` case is the one to look at. It means the filing's name matched
// but the founder isn't on the officer list — usually harmless (a lawyer filed it),
// occasionally the wrong company. That's a judgement, and judgements are Danny's,
// so it's flagged in place instead of being silently upgraded or dropped.
// ══════════════════════════════════════════════════════════════════════════
function PublicRecord({ founderId, company: c, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const p = c.public_record;

  async function read() {
    setBusy(true); setErr(null);
    try { await api.readPublicRecord(founderId); onChange(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const f = p?.funding;
  const h = p?.hiring;

  return (
    <Block label="The public record" right={
      <button onClick={read} disabled={busy} className="text-mini text-accent hover:text-accent-hover disabled:text-ink-4">
        {busy ? 'Reading SEC + careers…' : p ? 'Refresh' : 'Read the free web'}
      </button>
    }>
      {err && <p className="text-mini text-danger mb-2">{err}</p>}

      {!p ? (
        <Empty>Not read yet. Free — the SEC’s Form D record and their open roles.</Empty>
      ) : (
        <div className="space-y-3">
          {/* ── FUNDING ── */}
          <div>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-micro font-semibold uppercase text-ink-4">Raised</span>
              {f?.found && f.confidence === 'name-only' && (
                // The `attention` hue is reserved in tailwind.config.js for the
                // attention engine — "only when a check is not clean". This is a
                // deliberate extension of that reservation, not an oversight: it is
                // literally an unclean check, and it's the one state in this block
                // where the number may belong to a different company. Machine text
                // recedes to ink-3 by house rule, and letting THIS recede is how a
                // wrong number reaches an IC meeting.
                <span className="text-micro text-attention" title={f.reason}>unconfirmed — check it’s them</span>
              )}
            </div>
            {!f?.found ? (
              <Empty>{f?.reason}</Empty>
            ) : (
              <>
                <div className="flex items-baseline gap-3">
                  <span className="text-display num text-ink">{fmt(f.latest.amount_sold)}</span>
                  <span className="text-mini text-ink-3">
                    {f.latest.offering_amount && f.latest.offering_amount !== f.latest.amount_sold && (
                      <>of {fmt(f.latest.offering_amount)} offered · </>
                    )}
                    {f.latest.sale_yet_to_occur
                      ? 'filed, first sale not yet'
                      : f.latest.first_sale && `first sale ${String(f.latest.first_sale).slice(0, 10)}`}
                  </span>
                </div>
                {/* The history is the story: one Form D is a fact, four ascending is
                    a company that keeps clearing the bar. */}
                {f.filings?.length > 1 && (
                  <p className="text-mini text-ink-3 mt-0.5">
                    <span className="num">{f.filings.length}</span> Form Ds since {String(f.filings[f.filings.length - 1].filed).slice(0, 4)}
                  </p>
                )}
                {/* Form D names officers AND directors — and a director at this stage
                    is usually the investor who took the board seat. This is the
                    "who else is in it" answer, from a legal filing rather than a
                    rumour. */}
                {f.latest.people?.length > 0 && (
                  <p className="text-mini text-ink-3 mt-0.5 truncate" title={f.latest.people.map((x) => `${x.name} — ${x.relationships.join(', ')}`).join(' · ')}>
                    {f.latest.people.slice(0, 4).map((x) => x.name).join(' · ')}
                    {f.latest.people.length > 4 && ` +${f.latest.people.length - 4}`}
                  </p>
                )}
                <a href={f.source_url} target="_blank" rel="noreferrer" className="text-micro text-accent">
                  SEC filing ↗
                </a>
              </>
            )}
          </div>

          {/* ── HIRING ── */}
          <div>
            <span className="text-micro font-semibold uppercase text-ink-4">Hiring</span>
            {!h?.found ? (
              <div className="mt-1">
                {/* Never "not hiring". No board found means we don't know, and at
                    pre-seed that's the normal case, not a finding. */}
                <Empty>{h?.reason}</Empty>
                {h?.careers_url && (
                  <a href={h.careers_url} target="_blank" rel="noreferrer" className="text-micro text-accent">
                    {normUrl(h.careers_url)} ↗
                  </a>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-3 mt-1">
                  <span className="text-display num text-ink">{h.role_count}</span>
                  <span className="text-mini text-ink-3">
                    open {h.role_count === 1 ? 'role' : 'roles'} on {h.ats}
                    {h.newest_post && <> · newest {String(h.newest_post).slice(0, 10)}</>}
                  </span>
                </div>

                {/* WHAT they're hiring for is the roadmap — stated in the one place
                    a founder can't hedge it. A deck says "going to market in Q3"; a
                    Founding AE posted eleven days ago is them doing it. */}
                {h.tells?.length > 0 && (
                  <div className="mt-1">
                    {h.tells.map((t, i) => (
                      <p key={i} className="text-mini text-ink-2">
                        {t.role} <span className="text-ink-4">— {t.means}</span>
                      </p>
                    ))}
                  </div>
                )}

                <div className="mt-1.5 -mx-2">
                  {h.roles.slice(0, 6).map((r, i) => (
                    <div key={i} className="row px-2">
                      <span className="flex-1 min-w-0">
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noreferrer" className="row-primary hover:text-accent truncate">{r.title}</a>
                        ) : (
                          <span className="row-primary truncate">{r.title}</span>
                        )}
                      </span>
                      <span className="w-40 text-mini text-ink-3 truncate">{[r.team, r.location].filter(Boolean).join(' · ') || '—'}</span>
                      <span className="w-20 text-mini text-ink-4 num text-right">{r.posted ? String(r.posted).slice(0, 10) : '—'}</span>
                    </div>
                  ))}
                </div>
                {h.role_count > 6 && (
                  <a href={h.board_url} target="_blank" rel="noreferrer" className="text-micro text-accent">
                    all {h.role_count} on {h.ats} ↗
                  </a>
                )}
              </>
            )}
          </div>

          <p className="text-micro text-ink-4">
            SEC Form D + their own job board. Free, no account.
            {p.fetched_at && ` Read ${String(p.fetched_at).slice(0, 10)}.`}
          </p>
        </div>
      )}
    </Block>
  );
}

const SOURCE_LABEL = { deck: 'Deck', url: 'Web', granola: 'Call', note: 'Note', linkedin: 'LinkedIn', filing: 'Filing' };
const KIND_ORDER = ['traction', 'customer', 'raise', 'team', 'product', 'market', 'risk'];

function Sources({ founderId, company }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [drag, setDrag] = useState(false);
  const [roomResult, setRoomResult] = useState(null);

  const load = useCallback(() => {
    api.getCompanySources(founderId).then(setD).catch((e) => setErr(e.message));
  }, [founderId]);
  useEffect(load, [load]);

  async function run(label, fn) {
    setBusy(label);
    setErr(null);
    try { await fn(); load(); }
    catch (e) { setErr(e.detail ? `${e.message} — ${e.detail}` : e.message); }
    finally { setBusy(null); }
  }

  // A data room is a folder of files, not one deck. Ingest them all at once; each
  // still passes the honesty gate, so the summary reports what was kept vs dropped.
  async function uploadRoom(files) {
    setRoomResult(null);
    await run('room', async () => {
      const r = await api.uploadDataRoom(founderId, Array.from(files));
      setRoomResult(r);
    });
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    // One file → treat as a deck; a folder-drop of several → the data room.
    if (files.length === 1) run('deck', () => api.uploadDeck(founderId, files[0]));
    else uploadRoom(files);
  };

  const sources = d?.sources || [];
  const signals = d?.signals || [];
  const byKind = KIND_ORDER.map((k) => [k, signals.filter((s) => s.kind === k)]).filter(([, v]) => v.length);

  return (
    <Block
      label={`Everything on this company${sources.length ? ` · ${sources.length}` : ''}`}
      right={
        <div className="flex items-center gap-3">
          <label className="text-mini text-accent hover:text-accent-hover cursor-pointer">
            {busy === 'deck' ? 'Reading the deck…' : 'Upload a deck'}
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) run('deck', () => api.uploadDeck(founderId, f)); e.target.value = ''; }}
            />
          </label>
          <label className="text-mini text-accent hover:text-accent-hover cursor-pointer">
            {busy === 'room' ? 'Reading the room…' : 'Upload a data room'}
            <input
              type="file"
              accept=".pdf,.txt,.md,.markdown,.csv"
              multiple
              className="hidden"
              onChange={(e) => { const fs = e.target.files; if (fs?.length) uploadRoom(fs); e.target.value = ''; }}
            />
          </label>
        </div>
      }
    >
      {err && (
        <p className="text-mini text-danger mb-2 leading-relaxed">
          {err} <button onClick={() => setErr(null)} className="text-ink-4 hover:text-ink ml-1">dismiss</button>
        </p>
      )}

      {/* Drop target doubles as the URL box — one place to put things in. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`rounded border border-dashed px-2 py-2 mb-3 transition ${drag ? 'border-accent bg-accent-soft' : 'border-line-2'}`}
      >
        <div className="flex items-center gap-2">
          <input
            className="input flex-1 border-0 bg-transparent focus:ring-0 px-0"
            placeholder={drag ? 'Drop the deck…' : 'Paste a URL — their site, a press piece…'}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && urlInput.trim()) {
                const u = urlInput.trim();
                setUrlInput('');
                run('url', () => api.addSourceUrl(founderId, u));
              }
            }}
          />
          {busy === 'url' && <span className="text-mini text-ink-4">Reading…</span>}
        </div>
        <p className="text-micro text-ink-4 mt-1">
          Drop a PDF, drop several files for a data room, paste a URL, or press Enter. LinkedIn goes in the field on the right — it blocks crawlers.
        </p>
      </div>

      {/* The data-room gate, reported. Kept vs dropped, with the reason each file
          was dropped — a gate you can't see is indistinguishable from an extractor
          that found nothing. */}
      {roomResult && (
        <div className="rounded border border-line-2 bg-ground-2 px-2 py-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-mini text-ink-2">
              Data room — kept {roomResult.kept} of {roomResult.total}
              {roomResult.dropped ? `, dropped ${roomResult.dropped}` : ''}
            </span>
            <div className="flex-1" />
            <button onClick={() => setRoomResult(null)} className="text-micro text-ink-4 hover:text-ink">dismiss</button>
          </div>
          {roomResult.results?.filter((r) => !r.ok).map((r, i) => (
            <p key={i} className="text-micro text-ink-4 mt-0.5 leading-relaxed">
              <span className="text-ink-3">{r.file}</span> — {r.error}
            </p>
          ))}
        </div>
      )}

      {!sources.length ? (
        <Empty>Nothing yet. A deck or a URL is enough to start.</Empty>
      ) : (
        <div className="-mx-2 mb-3">
          {sources.map((s) => (
            <div key={s.id} className="row px-2 group">
              <span className="w-14 text-mini text-ink-3 flex-shrink-0">{SOURCE_LABEL[s.kind] || s.kind}</span>
              <span className="flex-1 min-w-0 text-small text-ink truncate" title={s.title || ''}>{s.title}</span>
              <span className="w-16 text-mini text-ink-4 num">{s.occurred_at ? String(s.occurred_at).slice(0, 10) : ''}</span>
              <span className="w-20 text-mini text-ink-3">
                {s.signal_count ? `${s.signal_count} facts` : <span className="text-ink-4">not analysed</span>}
              </span>
              {/* Sources analyse themselves now (lib/extract-signals extractSoon), so
                  "not analysed" should be a brief state or a real failure — not the
                  resting state it used to be. It stayed the resting state for 35 of 37
                  cards because the only cure was a button rendered at opacity-0 until
                  you hovered the row. So: hidden while there's nothing to fix, VISIBLE
                  the moment a source has no facts. An unanalysed source is the one
                  thing on this row worth a click. */}
              <span className={`w-28 flex justify-end gap-2 transition ${
                s.signal_count ? 'opacity-0 group-hover:opacity-100' : ''
              }`}>
                <button
                  onClick={() => run('x' + s.id, () => api.extractSignals(founderId, s.id))}
                  className="text-micro text-accent hover:text-accent-hover"
                >
                  {busy === 'x' + s.id ? 'analysing…' : s.signal_count ? 'analyse again' : 'pull the facts'}
                </button>
                {/* Deleting a source deletes its signals — a claim must never
                    outlive its evidence. Said out loud rather than assumed. */}
                <button
                  onClick={() => { if (confirm(`Delete "${s.title}" and the ${s.signal_count || 0} signals it produced?`)) run('d' + s.id, () => api.deleteSource(founderId, s.id)); }}
                  className="text-micro text-ink-4 hover:text-danger"
                >
                  delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {signals.length > 0 && (
        <div className="space-y-3">
          <div className="text-micro font-semibold uppercase text-ink-4">
            What they told you · {signals.length} verified
          </div>
          {byKind.map(([kind, rows]) => (
            <div key={kind}>
              <div className="text-mini text-ink-4 capitalize">{kind}</div>
              {rows.map((s) => (
                <div key={s.id} className="group py-0.5">
                  <p className="text-small text-ink leading-relaxed">{s.claim}</p>
                  {/* The receipt. Always present — the schema makes a signal
                      without one impossible — and always one hover away. */}
                  <p className="text-mini text-ink-3 leading-relaxed opacity-0 group-hover:opacity-100 transition">
                    “{s.quote}”
                    <span className="text-ink-4"> — {SOURCE_LABEL[s.source_kind] || s.source_kind}
                      {s.verification === 'paraphrased' && ', paraphrased'}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          ))}
          <p className="text-micro text-ink-4 leading-relaxed">
            Every line is checked against its own source. Anything that couldn’t be found there was dropped, not flagged.
          </p>
        </div>
      )}
    </Block>
  );
}

// ── Notes. His words dark, the machine's grey. ──
function Notes({ founderId, notes, onChange }) {
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!adding.trim() || busy) return;
    setBusy(true);
    try { await api.addCompanyNote(founderId, { content: adding.trim() }); setAdding(''); onChange(); }
    finally { setBusy(false); }
  }

  return (
    <Block label={`Notes${notes?.length ? ` · ${notes.length}` : ''}`}>
      <textarea
        className="textarea text-small"
        rows={2}
        placeholder="Add a note…  (⌘↵ to save)"
        value={adding}
        onChange={(ev) => setAdding(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) add(); }}
      />
      {adding.trim() && (
        <div className="flex gap-2 mt-1">
          <button onClick={add} disabled={busy} className="btn-primary">Save</button>
          <button onClick={() => setAdding('')} className="btn-ghost">Cancel</button>
        </div>
      )}

      <div className="mt-3 space-y-3">
        {!notes?.length && <Empty>No notes yet.</Empty>}
        {notes?.map((n) => (
          <div key={n.id} className="group">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-micro text-ink-4">{String(n.created_at).slice(0, 10)}</span>
              {/* Provenance, not a badge. Granola's rule: no sparkle, no chip —
                  the machine's text simply sits lower on the ink ramp. */}
              {n.source && n.source !== 'manual' && <span className="text-micro text-ink-4">{n.source}</span>}
              <div className="flex-1" />
              <span className="opacity-0 group-hover:opacity-100 flex gap-2 transition">
                <button onClick={() => setEditing(editing === n.id ? null : n.id)} className="text-micro text-ink-4 hover:text-ink">edit</button>
                <button
                  onClick={async () => { await api.deleteCompanyNote(founderId, n.id); onChange(); }}
                  className="text-micro text-ink-4 hover:text-danger"
                >delete</button>
              </span>
            </div>
            {editing === n.id ? (
              <textarea
                className="textarea text-regular"
                rows={4}
                defaultValue={n.content}
                autoFocus
                onBlur={async (ev) => { await api.updateCompanyNote(founderId, n.id, { content: ev.target.value }); setEditing(null); onChange(); }}
              />
            ) : (
              <p className={`text-regular leading-relaxed whitespace-pre-wrap ${n.source && n.source !== 'manual' ? 'text-ink-3' : 'text-ink'}`}>
                {n.content}
              </p>
            )}
          </div>
        ))}
      </div>
    </Block>
  );
}

// ── Primitives ──

function Block({ label, right, children }) {
  return (
    <div className="px-3 py-3 border-b border-line">
      {(label || right) && (
        <div className="flex items-center mb-2">
          {label && <span className="text-micro font-semibold uppercase text-ink-4">{label}</span>}
          <div className="flex-1" />
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

const Empty = ({ children }) => <p className="text-mini text-ink-4">{children}</p>;
const Ro = ({ label, v }) =>
  v == null || v === '' ? null : (
    <div className="flex items-baseline gap-2 h-6">
      <span className="w-24 text-mini text-ink-4 flex-shrink-0">{label}</span>
      <span className="text-mini text-ink-2 truncate">{v}</span>
    </div>
  );

/** A label + inline-editable value. Saves on blur; Esc reverts. */
function Field({ label, value, onSave, link, num, hint }) {
  const [v, setV] = useState(value ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => setV(value ?? ''), [value]);

  return (
    <div className="flex items-baseline gap-2 min-h-6 group">
      <span className="w-24 text-mini text-ink-4 flex-shrink-0" title={hint}>{label}</span>
      {editing ? (
        <input
          className="input h-6 text-mini flex-1"
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => { setEditing(false); onSave(v); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setV(value ?? ''); setEditing(false); }
          }}
        />
      ) : (
        <span onClick={() => setEditing(true)} className="flex-1 min-w-0 cursor-text">
          {value ? (
            link ? (
              <a
                href={value}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-mini text-accent hover:text-accent-hover truncate block"
              >
                {String(value).replace(/^https?:\/\/(www\.)?/, '').slice(0, 34)} ↗
              </a>
            ) : (
              <span className={`text-mini text-ink-2 truncate block ${num ? 'num' : ''}`}>
                {num ? fmt(value) : value}
              </span>
            )
          ) : (
            <span className="text-mini text-ink-4 opacity-0 group-hover:opacity-100 transition">add</span>
          )}
        </span>
      )}
    </div>
  );
}

/** Click-to-edit text that renders as plain text until you touch it. */
function Editable({ value, onSave, className, placeholder, multiline }) {
  const [v, setV] = useState(value ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => setV(value ?? ''), [value]);

  if (!editing) {
    return (
      <span onClick={() => setEditing(true)} className={`${className} cursor-text ${!value ? 'text-ink-4' : ''}`}>
        {value || placeholder}
      </span>
    );
  }
  const P = multiline ? 'textarea' : 'input';
  return (
    <P
      className={multiline ? 'textarea' : 'input'}
      autoFocus
      rows={multiline ? 2 : undefined}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { setEditing(false); onSave(v); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !multiline) e.currentTarget.blur();
        if (e.key === 'Escape') { setV(value ?? ''); setEditing(false); }
      }}
    />
  );
}

function Stage({ stage }) {
  if (!stage) return null;
  // Typographic, never a colored pill — the same rule the bands follow.
  return <span className="text-mini text-ink-3">{stage}</span>;
}

// EnrichLayer packs the state INTO the city field — Permute's real payload is
// { city: "Chicago, Illinois", state: "Illinois" }, which naively joined renders
// "Chicago, Illinois, Illinois". Dedupe rather than trust the field names.
function hq(h) {
  if (!h) return null;
  const parts = [];
  for (const p of String(h.city || '').split(',').concat(h.state || '')) {
    const t = p.trim();
    if (t && !parts.some((x) => x.toLowerCase() === t.toLowerCase())) parts.push(t);
  }
  return parts.join(', ') || null;
}

const normUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

function fmt(n) {
  const x = Number(n);
  if (!isFinite(x)) return n;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `$${Math.round(x / 1_000)}K`;
  return String(n);
}

function CardSkeleton() {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-2 bg-ground-3 rounded-sm" style={{ width: `${[40, 70, 55, 80, 35, 60, 45, 75][i]}%` }} />
      ))}
    </div>
  );
}
