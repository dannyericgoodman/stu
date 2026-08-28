import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// ══════════════════════════════════════════════════════════════════════════
// Sourcing — the inbox. Study and triage people you have never met.
//
// Danny, 2026-07-15, after I stacked this on top of the pipeline board:
//   "I wonder if we're conflating two actions here: 1) I need an inbox to study
//    and triage new founders (true sourcing) and 2) the ability to manage a
//    pipeline (like a kanban). But right now, this screen is a jumble."
//
// He's right, and the mistake is worth recording so it isn't made a fourth time:
// the insight that Stu has ONE object moving through stages is about the DATA,
// not the SCREENS. Affinity and Attio both have one record substrate AND separate
// surfaces. Triaging a stranger and managing a company you're tracking are
// different jobs in different mental modes — one is fast and mostly rejecting,
// the other is slow and mostly accumulating. Stacking them made both worse.
//
// So: one substrate, three surfaces. The record is still the same record — Track
// promotes it in a single transaction that keeps the source chain — but this
// screen only ever does one thing.
//
// ── THE JOB HERE ──
// Read a stranger, decide in about two seconds, move on. Everything on the row
// exists to serve that: WHO they are, WHY they're in front of you (the signal),
// and WHAT ties them to Illinois. Nothing else earns its width.
//
// Harmonic's lesson: the alert is the product and the search bar is its config
// UI. This should fill overnight and be waiting.
// ══════════════════════════════════════════════════════════════════════════

// The YC connector builds `headline` as role + bio, and the bio usually opens with
// the same role — so rows read "Founder Founder at Floracene" and "Co-Founder &
// CTO Co-Founder & CTO at Rise Reforming". A phrase printed twice carries the
// information once and costs the column its first 120px.
//
// Strips ONLY an exact duplicated opening phrase. Nothing else.
//
// I tried also dropping the leading role, and it produced rows starting
// "at Floracene…" and "prev @ two sigma…" — sentences beginning mid-clause, which
// reads worse than the noise it removed. "Founder at Floracene (YC S26)" is fine.
// Cosmetic only: the raw headline is on hover, and nothing here feeds the tie gate.
const parseArr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ══════════════════════════════════════════════════════════════════════════
// WHY IS THIS STRANGER IN FRONT OF ME?
//
// The most important column on this screen, and it was rendering the person's
// name back at them. `headline || company_one_liner` looks obviously right and is
// wrong on the data: measured 2026-07-16, 22 of 23 exa-sourced rows have
// headline === name. So the top of the queue — which is now, after the sort fix,
// exactly where Danny's S/A-tier founders live — read:
//
//   Rodrigo Mosqueira   |   Rodrigo Mosqueira
//   Jason Zhan          |   Jason Zhan
//
// Twelve of the top thirteen rows. The real signal was sitting in
// company_one_liner the whole time ("LeanLog — AI-powered operations management
// platform"), losing a || race to a field that repeats the name.
//
// This is the one-primary-ink rule failing at the data layer rather than the CSS
// layer: two identical strings on one row makes the eye compare them, find
// nothing, and move on.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// WHY THEY'RE HERE — the elevated reasoning, not a company blurb.
//
// Danny, 2026-07-16: "a lot of the entries are...odd...it just says the person's
// name. If the intention is to show why they're here, there should be some
// elevated reasoning. They are an exited founder. They're in a notable
// accelerator. They go to a prestigious university."
//
// He's right, and my first pass answered the wrong question. I made this column
// show what the COMPANY DOES ("AI-powered operations management platform"), which
// is better than a name and still isn't the reason the scout picked them.
//
// The reasoning was in the database the whole time. caliber_signals, for Geoff
// Segal:
//   ["Prior exit", "YC alum", "Strong traction (revenue/users)",
//    "Raised institutional capital",
//    "Repeat founder: built TaxProper (YC S19, acquired), now FullSeam (YC W26)",
//    "YC twice: S19 (TaxProper) and W26 (FullSeam)"]
//
// Two kinds of entry in one array: short TAGS ("Prior exit") and long EVIDENCED
// strings ("Prior exit: 'Acquired by Opendoor (NASDAQ: OPEN) in 2022'"). The tags
// belong in the row — they're scannable at 32px. The evidenced ones belong in the
// study panel, where he's already decided to look closer.
//
// Coverage is honest and uneven:
//   exa (23)          caliber_signals on 22, pedigree on 20   — rich
//   yc_directory (23) breakout_signals only                   — thin
//   pre_program (15)  breakout_signals only                   — thin
//
// For the thin rows the HEADLINE already carries the reasoning ("Founder at
// Floracene (YC S26). Previously Tech Lead at Palantir"), so it wins there.
// ══════════════════════════════════════════════════════════════════════════

// Signals that assert nothing. "actively building" fires on the word "founder"
// appearing in a bio — in a table where every row is a founder — and it is on 268
// of 624 rows carrying the identical score. A tag that is always true is not a
// reason; it's noise wearing a signal's clothes.
const JUNK_SIGNAL = /^(actively building|founder|building|startup|entrepreneur)$/i;

// ── Where a row came from, in words ──
// The `source` column holds the connector key. Rendering it raw put
// "il_school_discovery" and "a16z_speedrun" in a 96px column, which is a database
// identifier leaking into a reading surface. This is a display map only — one
// entry per real connector, and an unknown key degrades to the key with its
// underscores opened up rather than to a guess.
const SOURCE_LABEL = {
  exa: 'Web sweep',
  yc_directory: 'YC',
  a16z_speedrun: 'a16z Speedrun',
  thiel_fellows: 'Thiel',
  z_fellows: 'Z Fellows',
  neo_scholars: 'Neo',
  the_residency: 'The Residency',
  emergent_ventures: 'Emergent',
  pre_program: 'Applied to YC',
  il_school_discovery: 'IL schools',
  github: 'GitHub',
  uspto_trademark: 'Trademark filing',
  sec_filings: 'SEC Form D',
};
function sourceLabel(k) {
  if (!k) return '—';
  return SOURCE_LABEL[k] || String(k).replace(/_/g, ' ');
}

// ── When it arrived ──
// Relative for the last week (that's the window he acts in), then an absolute date
// — "14d ago" stops being a date you can reason about somewhere around a fortnight.
function addedLabel(iso) {
  if (!iso) return '—';
  const t = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(t.getTime())) return '—';
  const days = Math.floor((Date.now() - t.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A tag is the scannable half: short, no embedded evidence quote.
const isTag = (s) => s && s.length <= 46 && !/:\s*['"]/.test(s);

function whyOf(r) {
  // Prefer the founder-quality check's verified markers. Danny, 2026-07-21: "I'm
  // super not confident about the 'Why they're here' descriptions. I've checked a
  // few and some are good, some are bad." The old source below is loose regex tags
  // that could fire wrong. fit.why is different in kind: every marker's evidence is
  // verbatim in the profile or it's dropped server-side (lib/founderFit). A chip
  // here now means a receipt exists — that's the whole fix.
  const fitWhy = r.fit && Array.isArray(r.fit.why) ? r.fit.why.filter(Boolean) : [];
  if (fitWhy.length) return [...new Set(fitWhy)];

  const tags = [...parseArr(r.caliber_signals), ...parseArr(r.pedigree_signals)]
    .filter((s) => isTag(s) && !JUNK_SIGNAL.test(String(s).trim()));

  if (tags.length) return [...new Set(tags)];

  // Thin rows: the headline IS the reasoning, when it isn't just the name.
  const h = String(r.headline || '').trim();
  if (h && !isJustTheName(h, r.name)) return null; // signalOf renders it as prose

  // Last resort — breakout tags, minus the junk.
  const weak = parseArr(r.breakout_signals).filter((s) => !JUNK_SIGNAL.test(String(s).trim()));
  return weak.length ? [...new Set(weak)] : null;
}

// Is this string just the person's name wearing a different hat?
// Not exact equality — that missed "Amrit Kanesa-thasan" for name "Amrit Kanesa",
// which sailed through and rendered the name in the signal column anyway. Either
// string containing the other is the test that actually holds.
function isJustTheName(s, name) {
  const a = norm(s), b = norm(name);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function signalOf(r) {
  const h = String(r.headline || '').trim();
  const raw = h && !isJustTheName(h, r.name) ? h : String(r.company_one_liner || '').trim();
  if (!raw) return null;

  // Retained from the original: some headlines repeat their own opening clause
  // ("Founder Founder at Amulet…"). Strip the echo. Cosmetic only — the raw
  // headline is on hover and nothing here feeds the tie gate.
  const dup = raw.match(/^(.{3,40}?)\s+\1(?=\s|\b)/i);
  let out = dup ? raw.slice(dup[1].length).trim() : raw;

  // The one-liner opens with the company name ("LeanLog — AI-powered operations
  // management platform"), and the company already has its own column two inches
  // to the left. Printing it twice on one row is the one-primary-ink rule failing
  // at the data layer: the eye compares two identical strings, learns nothing, and
  // the row costs a beat for free. Strip the echo and let the sentence start where
  // the information does.
  const co = companyOf(r);
  if (co) {
    const re = new RegExp(`^${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—–-]\\s*`, 'i');
    out = out.replace(re, '');
  }
  // If stripping left nothing, the one-liner WAS the company name — say nothing
  // rather than an empty cell pretending to be a signal.
  return out.trim() || null;
}

// ══════════════════════════════════════════════════════════════════════════
// The company field is polluted on exa rows: "LeanLog. Before this",
// "just in time for all those last" — sentence fragments the extractor tore out
// of prose. But company_one_liner reliably starts with the real name and an em
// dash ("LeanLog — AI-powered operations..."), so the truth is recoverable.
//
// Cleaned at RENDER, not in the database. Danny owns his data; a display
// heuristic that guesses wrong should cost him a glance, not a row. If this
// proves out, it belongs in the extractor.
// ══════════════════════════════════════════════════════════════════════════
function companyOf(r) {
  const c = String(r.company || '').trim();
  // The one-liner reliably opens "CompanyName — what they do", so the real name is
  // recoverable even when the company column is garbage.
  const fromLiner = String(r.company_one_liner || '').split(/\s+[—–]\s+/)[0].trim();
  const linerUsable = fromLiner && fromLiner.length <= 32 && fromLiner.split(/\s+/).length <= 4;

  // Prose tells on itself. Real company names are short and don't contain verbs:
  //   good:  "LeanLog"  "Rise Reforming"  "Remix (YC W26)"
  //   prose: "AviaryAI builds AI voice a…"  "Co-CEO of Greyscalegorilla (merged…"
  //          "just in time for all those last"  "LeanLog. Before this"
  // Two independent tells, either sufficient: too many words, or an embedded verb
  // phrase. Both are things a name never has.
  const wordy = c.split(/\s+/).length > 3;
  const verby = /\b(builds?|building|is|are|was|helps?|makes?|powers?|enables?|of|for|with|and|the)\b/i.test(c);
  const sentence = /\.\s/.test(c);

  if (c && (wordy || sentence || (verby && c.split(/\s+/).length > 2)) && linerUsable) return fromLiner;
  if (c && sentence) return c.replace(/\.\s.*$/, '').trim(); // "LeanLog. Before this" -> "LeanLog"
  if (c && !wordy) return c;
  return linerUsable ? fromLiner : c || null;
}

export default function Sourcing() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('pipeline');
  // How selective. Danny: "cull the list down to the very best while making this a
  // repeat-use feature so I can trust the engine's judgment."
  //   must-meet — the very best (default): a proven builder at the earliest stage —
  //               a prior exit, a repeat founder with pedigree, or 2+ signals.
  //   strong    — widen to solid single-signal founders.
  //   all       — the whole inbox, still ranked by the same check.
  // Defaulting to must-meet IS the repeat-use trust feature: every time he opens
  // Sourcing, the engine has already done the culling and shown its reasoning.
  const [tierView, setTierView] = useState('must-meet');
  // Best or newest. Danny: "I want to log in in the morning and see new folks!"
  // Quality stays the default — it's what the screen is for the other 23 hours of
  // the day — but the arrival date is only useful if one click can bring today's
  // names to the top, so Newest is a toggle rather than a buried sort menu.
  const [sort, setSort] = useState('best');
  // How many rows the server has been asked for. The inbox used to return EVERY
  // pending row (2,232 in production, ~51 MB of scrape blobs read to score them),
  // which is what "it's very laggy" was. Now it's a page, and this grows on demand.
  const [pageSize, setPageSize] = useState(200);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [err, setErr] = useState(null);
  const [justTracked, setJustTracked] = useState(null);
  const [running, setRunning] = useState(false);
  // The study half of the job. Danny on the original inbox: "I liked it as an
  // inbox where I could vote Pass/Add to Pipeline or jump off to see their
  // LinkedIn. I could see a bit about the founder. That paradigm worked well."
  // I'd stripped it to a flat table with no way to look closer, which turned a
  // reading surface into a guessing one.
  const [openId, setOpenId] = useState(null);

  // Changing the view is a different question, not a longer answer — go back to
  // one page rather than re-requesting however many the last view had grown to.
  useEffect(() => { setPageSize(200); setCursor(0); }, [scope, tierView, sort]);

  useEffect(() => {
    let dead = false;
    setData(null);
    api
      .getPipelineInbox({
        scope,
        ...(tierView === 'all' ? {} : { tier: tierView }),
        sort,
        limit: pageSize,
      })
      .then((d) => !dead && setData(d))
      .catch((e) => !dead && setErr(e.message));
    return () => { dead = true; };
  }, [scope, tierView, sort, pageSize]);

  const rows = useMemo(() => {
    if (!data) return [];
    if (!q) return data.rows;
    const n = q.toLowerCase();
    return data.rows.filter(
      (r) =>
        (r.name || '').toLowerCase().includes(n) ||
        (r.company || '').toLowerCase().includes(n) ||
        (r.headline || '').toLowerCase().includes(n)
    );
  }, [data, q]);

  async function triage(row, action) {
    setBusy(row.id);
    const before = data;
    setData((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== row.id), total: s.total - 1 }));
    try {
      if (action === 'approve') {
        const founder = await api.approveSourced(row.id);
        // The promotion IS the connective tissue: one transaction writes the
        // company card and both direction pointers, so six months from now
        // "how did I find them?" is still answerable. Confirm it by name, with a
        // link — a triage action that vanishes silently feels like a delete.
        setJustTracked({ name: row.name, company: row.company, id: founder?.id });
        setTimeout(() => setJustTracked((j) => (j && j.id === founder?.id ? null : j)), 6000);
      } else if (action === 'dismiss') await api.dismissSourced(row.id);
      else if (action === 'hide') await api.hideForeverSourced(row.id);
    } catch (e) {
      setData(before);
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Triage is a keyboard job. j/k to read, t/x to decide. Danny should be able to
  // clear this list without touching the mouse.
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const row = rows[cursor];
      if (e.key === 'j') { setCursor((c) => Math.min(c + 1, rows.length - 1)); if (openId) setOpenId(rows[Math.min(cursor + 1, rows.length - 1)]?.id); }
      else if (e.key === 'k') { setCursor((c) => Math.max(c - 1, 0)); if (openId) setOpenId(rows[Math.max(cursor - 1, 0)]?.id); }
      else if (e.key === 't' && row) triage(row, 'approve');
      else if (e.key === 'x' && row) triage(row, 'dismiss');
      else if (e.key === 'Enter' && row) setOpenId(openId === row.id ? null : row.id);
      else if (e.key === 'Escape') setOpenId(null);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = rows.find((r) => r.id === openId) || null;

  // The manual sweep. It fires two engines and takes minutes, so the honest thing
  // is to say it's working and keep polling — not to spin, and not to claim it
  // finished. The old button returned instantly and the run log then reported the
  // Exa sweep's 0 while the connectors added 167, which is how "Find Founders"
  // came to mean "nothing happens".
  async function runScout() {
    setRunning(true);
    try {
      await api.triggerSourcing();
      const started = Date.now();
      const poll = setInterval(async () => {
        const d = await api.getPipelineInbox({ scope }).catch(() => null);
        if (d) setData(d);
        // 6 minutes: a full sweep with enrichment took ~100s per connector when I
        // measured it, and there are nine.
        if (d?.last_run && new Date(d.last_run.ran_at).getTime() > started - 5000) {
          clearInterval(poll); setRunning(false);
        } else if (Date.now() - started > 360000) {
          clearInterval(poll); setRunning(false);
        }
      }, 8000);
    } catch (e) {
      setErr(e.message);
      setRunning(false);
    }
  }

  if (err) return <div className="p-4 text-small text-danger">{err}</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-2 bg-ground flex-shrink-0">
        <span className="text-small font-semibold text-ink">Source</span>
        <span className="text-mini text-ink-4">
          {scope === 'pipeline' ? 'verified Illinois tie' : 'no Illinois tie — national frontier'}
        </span>
        <ScoutState data={data} running={running} onRun={runScout} />
        <div className="flex-1 min-w-0" />
        <input
          className="input w-40 flex-none border-0 bg-transparent focus:ring-0 px-0"
          placeholder="Filter…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(0); }}
        />
        <div className="flex items-center gap-px flex-none">
          {[
            { k: 'pipeline', label: 'Illinois', n: data?.total },
            { k: 'watchlist', label: 'Frontier Watch', n: data?.watchlist },
          ].map((s) => (
            <button
              key={s.k}
              onClick={() => { setScope(s.k); setCursor(0); }}
              className={`px-2 h-6 rounded text-mini font-medium transition ${
                scope === s.k ? 'bg-ground-4 text-ink' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
              }`}
            >
              {s.label}
              {s.n != null && <span className="num text-ink-4 ml-1">{s.n}</span>}
            </button>
          ))}
          <div className="w-px h-3.5 bg-line-2 mx-1" />
          {[
            { k: 'must-meet', label: 'Must-meet', n: data?.tiers?.mustMeet, title: 'The very best: a prior exit, a repeat founder with pedigree, or 2+ independent signals — all at the earliest stage with a verified Illinois tie.' },
            { k: 'strong', label: 'Strong', n: data?.tiers ? data.tiers.mustMeet + data.tiers.strong : undefined, title: 'Widen to solid single-signal founders (one core marker), still earliest-stage with an Illinois tie.' },
            { k: 'all', label: 'All', n: data?.tiers?.all, title: 'The whole inbox, still ranked best-first by the same check.' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => { setTierView(t.k); setCursor(0); }}
              title={t.title}
              className={`px-2 h-6 rounded text-mini font-medium transition ${
                tierView === t.k ? 'bg-accent-soft text-accent' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
              }`}
            >
              {t.label}
              {t.n != null && <span className="num text-ink-4 ml-1">{t.n}</span>}
            </button>
          ))}
          <div className="w-px h-3.5 bg-line-2 mx-1" />
          {/* Two orderings, both honest about what they are. "Best" is the founder
              rubric; "Newest" is arrival order. Neither is a filter — the same rows
              are present either way, which is the whole point of one inbox. */}
          {[
            { k: 'best', label: 'Best', title: 'Ranked by the founder-quality check: must-meet first, then earliest-stage, then signal strength.' },
            { k: 'newest', label: 'Newest', title: 'Most recently found first — what the scout brought in overnight.' },
          ].map((o) => (
            <button
              key={o.k}
              onClick={() => setSort(o.k)}
              title={o.title}
              className={`px-2 h-6 rounded text-mini font-medium transition ${
                sort === o.k ? 'bg-ground-4 text-ink' : 'text-ink-3 hover:text-ink hover:bg-ground-3'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          THE NIGHTLY RUN IS OFF, AND WHY.

          The scout arms only if the owner's Exa + Anthropic keys resolve and
          PIPELINE_ENABLED isn't 'false'. Both live outside the repo — in Settings
          and in Railway's dashboard — so no deploy can fix or even test them. If
          either is wrong the scout silently never runs and this screen just looks
          quiet, which is precisely the failure that went unnoticed for months.

          It gets a full-width row, not a slot in the toolbar: the first version of
          this rendered inline between the Run button and the filter box and
          truncated to "Nightly sco…", which is a warning you cannot read and
          therefore is not a warning. ══════════════════════════════════════════ */}
      {data?.scout_blocked && (
        <div className="flex items-center gap-2 px-3 h-row border-b attn-open text-small flex-shrink-0">
          <span className="text-attention flex-none">▲</span>
          <span className="text-ink">
            The nightly scout is off — <span className="text-ink-2">{data.scout_blocked.reason}</span>
          </span>
          <div className="flex-1" />
          <button className="text-accent font-medium text-mini" onClick={() => nav('/settings')}>
            Open Settings →
          </button>
        </div>
      )}

      {justTracked && (
        <div className="flex items-center gap-2 px-3 h-row border-b border-line bg-accent-soft text-small flex-shrink-0">
          <span className="text-ink">
            <span className="font-medium">{justTracked.company || justTracked.name}</span> is on the pipeline.
          </span>
          <button className="text-accent font-medium" onClick={() => nav(`/founders/${justTracked.id}`)}>
            Open the card →
          </button>
          <div className="flex-1" />
          <button className="text-ink-4 hover:text-ink-2" onClick={() => setJustTracked(null)}>Dismiss</button>
        </div>
      )}

      <div className="flex items-center h-6 px-3 border-b border-line-2 bg-ground-3 text-micro font-semibold uppercase text-ink-4 flex-shrink-0">
        <span className="flex-[2] min-w-0">Person</span>
        <span className="flex-[3] min-w-0">Why they're here</span>
        <span className="w-36">Illinois tie</span>
        <span className="w-28">Found via</span>
        <span className="w-16">Added</span>
        <span className="w-36 text-right pr-1">Triage</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!data ? (
          Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="row px-3">
              <span className="flex-[2]"><span className="block h-2 w-28 bg-ground-3 rounded-sm" /></span>
              <span className="flex-[3]"><span className="block h-2 w-56 bg-ground-3 rounded-sm" /></span>
              <span className="w-36"><span className="block h-2 w-20 bg-ground-3 rounded-sm" /></span>
              <span className="w-28"><span className="block h-2 w-14 bg-ground-3 rounded-sm" /></span>
              <span className="w-16"><span className="block h-2 w-8 bg-ground-3 rounded-sm" /></span>
              <span className="w-36" />
            </div>
          ))
        ) : rows.length === 0 ? (
          // Not a blank state — a diagnosis. An empty inbox means one of two very
          // different things, and the old Discover screen taught Danny to read the
          // ambiguous version as "broken".
          <div className="px-3 py-4 text-small text-ink-3 max-w-2xl">
            {data.total === 0 && !q ? (
              <>
                Nothing waiting. The scout found no new Illinois-tied founders — that's an
                answer, not a failure.{' '}
                {data.watchlist > 0 && (
                  <button className="text-accent" onClick={() => setScope('watchlist')}>
                    {data.watchlist} are on the national Frontier Watch →
                  </button>
                )}
              </>
            ) : (
              'Nothing matches that filter.'
            )}
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.id}
              onMouseEnter={() => setCursor(i)}
              onClick={() => setOpenId(r.id)}
              className={`row px-3 group cursor-pointer ${i === cursor || r.id === openId ? 'row-selected' : ''} ${
                busy === r.id ? 'opacity-40' : ''
              }`}
            >
              <span className="flex-[2] min-w-0 flex items-baseline gap-2">
                {/* Must-meet marker — the engine's top tier, with its reason on
                    hover. Only shown when the view is mixed (Strong/All); in the
                    Must-meet view every row is one, so the star would be noise. */}
                {r.fit?.tier === 'must-meet' && tierView !== 'must-meet' && (
                  <span className="flex-none text-accent text-mini leading-none" title={`Must-meet — ${r.fit.tierReason}`}>★</span>
                )}
                <span className="row-primary flex-none max-w-[150px]">{r.name}</span>
                {companyOf(r) && <span className="row-meta min-w-0">{companyOf(r)}</span>}
              </span>

              {/* The reason this stranger is in front of him. Without it the row is
                  just a name, and a name is not a reason to read anything. */}
              {/* Reasoning first, prose second. A row that can say "Prior exit ·
                  YC alum · Raised institutional capital" should never spend its
                  width on a product description — Danny is deciding whether this
                  PERSON is worth a call, and the tags answer that in one glance
                  where a sentence needs a read. */}
              <span className="flex-[3] min-w-0 truncate" title={reasonTitle(r)}>
                {whyOf(r) ? (
                  <Why tags={whyOf(r)} />
                ) : signalOf(r) ? (
                  <span className="text-ink-2">{signalOf(r)}</span>
                ) : (
                  <span className="text-ink-4">no signal recorded</span>
                )}
              </span>

              {/* Geography is the moat, so the tie is a column and its evidence is on
                  hover. 55 of 85 rows here once carried a fabricated Chicago tie, and
                  it survived four months because nobody could see it. */}
              <span className="w-36 min-w-0 text-mini truncate" title={r.chicago_connection || 'no verified Illinois tie'}>
                {r.location_type === 'cofounder' ? (
                  <span className="text-ink-3">via co-founder</span>
                ) : r.location_type ? (
                  <span className="text-ink-2">
                    {r.location_type}
                    <span className="text-ink-4">
                      {' · '}
                      {String(r.chicago_connection || '').split(' — ')[0].split(': ')[1] || ''}
                    </span>
                  </span>
                ) : (
                  <span className="text-ink-4">—</span>
                )}
              </span>

              {/* The raw connector key ("il_school_discovery", "a16z_speedrun") is a
                  column name, not a sentence. Same fact, readable at a glance —
                  the raw key stays on hover so nothing is hidden. */}
              <span className="w-28 text-ink-3 text-mini truncate" title={r.source}>{sourceLabel(r.source)}</span>

              {/* When it arrived. Danny asked for the date rather than a per-session
                  "new" state — a date is a fact about the row that reads the same
                  however long he's been away, and it can't get out of sync with
                  anything. Today's arrivals are inked, the rest recede. */}
              <span className={`w-16 text-mini tabular-nums ${r.is_new ? 'text-accent font-medium' : 'text-ink-4'}`}
                    title={`Found ${new Date(r.created_at).toLocaleString()}`}>
                {addedLabel(r.created_at)}
              </span>

              <span className="w-36 flex items-center justify-end gap-1">
                {/* LinkedIn is always visible, never hover-gated. Danny: "jump off
                    to see their LinkedIn" — it's the single most-used action on a
                    stranger, and hiding it behind hover taxes every row. */}
                {r.linkedin_url && (
                  <a
                    href={r.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="px-1.5 h-5 rounded text-mini font-medium text-ink-3 border border-line-2 hover:border-accent hover:text-accent transition flex items-center"
                    title="Open LinkedIn"
                  >
                    in ↗
                  </a>
                )}
                <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                  <button
                    onClick={(e) => { e.stopPropagation(); triage(r, 'approve'); }}
                    className="px-2 h-5 rounded text-mini font-medium bg-ink text-white hover:bg-ink-2 transition"
                    title="Create the company card and put it on the pipeline (t)"
                  >
                    Add
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); triage(r, 'dismiss'); }}
                    className="px-2 h-5 rounded text-mini text-ink-3 border border-line-2 hover:bg-ground-4 hover:text-ink transition"
                    title="Pass for now (x)"
                  >
                    Pass
                  </button>
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      {open && (
        <Detail
          row={open}
          onClose={() => setOpenId(null)}
          onTriage={(action) => { triage(open, action); setOpenId(null); }}
        />
      )}

      <div className="flex items-center gap-3 px-3 h-6 border-t border-line-2 bg-ground text-micro text-ink-4 flex-shrink-0">
        <span><kbd className="text-ink-3">j</kbd>/<kbd className="text-ink-3">k</kbd> read</span>
        <span><kbd className="text-ink-3">↵</kbd> study</span>
        <span><kbd className="text-ink-3">t</kbd> add</span>
        <span><kbd className="text-ink-3">x</kbd> pass</span>
        <div className="flex-1" />
        {/* Was `{rows.length} waiting`, which after pagination would quietly mean
            "waiting on this page". Say what's shown AND what matched, so a page
            boundary never reads as an empty queue. */}
        {data && data.total > rows.length && (
          <button
            onClick={() => setPageSize((n) => n + 200)}
            className="text-accent hover:text-accent-hover font-medium"
          >
            Show more
          </button>
        )}
        <span>
          {rows.length}
          {data && data.total > rows.length ? ` of ${data.total}` : ''} waiting
        </span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// The study panel. Danny: "I could see a bit about the founder. That paradigm
// worked well."
//
// Everything here is EVIDENCE, not inference. The verbatim quotes from their
// profile are the point — the tie gate and the caliber scorer both make claims,
// and this is where he checks them against the actual words. Machine-written
// prose (the enrichment summary) sits at ink-3 and is labelled as such; quoted
// profile text is the founder's own and reads darker.
// ══════════════════════════════════════════════════════════════════════════
function Detail({ row, onClose, onTriage }) {
  let ev = {};
  try { ev = JSON.parse(row.evidence_map || '{}') || {}; } catch { /* not fatal */ }
  const quotes = [
    ['Illinois tie', ev.tie_evidence],
    ['Caliber', ev.caliber_evidence],
    ['Stage', ev.stage_evidence],
  ].filter(([, q]) => q && String(q).trim());

  const links = [
    ['LinkedIn', row.linkedin_url],
    ['GitHub', row.github_url],
    ['Website', row.website_url],
  ].filter(([, u]) => u);

  return (
    <>
      <div className="fixed inset-0 bg-ink/5 z-30" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-[420px] bg-ground border-l border-line-2 z-40 flex flex-col">
        <div className="flex items-center gap-2 h-8 px-3 border-b border-line-2 flex-shrink-0">
          <span className="text-small font-semibold text-ink truncate">{row.name}</span>
          {row.company && <span className="text-mini text-ink-3 truncate">{row.company}</span>}
          <div className="flex-1" />
          <button onClick={onClose} className="text-mini text-ink-4 hover:text-ink">Esc</button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {links.length > 0 && (
            <div className="flex items-center gap-2">
              {links.map(([label, url]) => (
                <a
                  key={label}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-small font-medium text-accent hover:text-accent-hover"
                >
                  {label} ↗
                </a>
              ))}
            </div>
          )}

          <Section label="Illinois tie">
            {row.location_type ? (
              <>
                <div className="text-small text-ink">
                  {row.location_type === 'cofounder' ? 'Via a co-founder' : row.location_type}
                </div>
                {/* The evidence IS the tie. 55 of 85 rows once carried a fabricated
                    one, and it survived four months because nobody could read it. */}
                <p className="text-mini text-ink-3 mt-1 leading-relaxed">{row.chicago_connection}</p>
              </>
            ) : (
              <p className="text-mini text-ink-3">
                No verified Illinois tie — this row is on the national Frontier Watch.
              </p>
            )}
          </Section>

          {signalOf(row) && (
            <Section label="What their profile says">
              <p className="text-small text-ink leading-relaxed">{signalOf(row)}</p>
            </Section>
          )}

          {quotes.length > 0 && (
            <Section label="Verbatim, from their profile">
              <div className="space-y-2">
                {quotes.map(([k, q]) => (
                  <div key={k} className="border-l-2 border-line-2 pl-2">
                    <div className="text-micro uppercase text-ink-4">{k}</div>
                    <p className="text-mini text-ink-2 leading-relaxed">“{String(q).slice(0, 280)}”</p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {parseArr(row.caliber_signals).length > 0 && (
            <Section label={`Why caliber ${row.caliber_tier || ''}`.trim()}>
              <div className="flex flex-wrap gap-1">
                {parseArr(row.caliber_signals).map((s, i) => (
                  <span key={i} className="text-mini text-ink-2 bg-ground-3 rounded-sm px-1.5 py-0.5">{s}</span>
                ))}
              </div>
            </Section>
          )}

          {parseArr(row.builder_signals).length > 0 && (
            <Section label="Builder signals">
              <div className="flex flex-wrap gap-1">
                {parseArr(row.builder_signals).map((s, i) => (
                  <span key={i} className="text-mini text-ink-2 bg-ground-3 rounded-sm px-1.5 py-0.5">{s}</span>
                ))}
              </div>
            </Section>
          )}

          {row.confidence_rationale && (
            // Machine-written. Recedes to ink-3 with no badge — Granola's rule.
            <Section label="Stu's note">
              <p className="text-mini text-ink-3 leading-relaxed">{row.confidence_rationale}</p>
            </Section>
          )}

          <Section label="Found via">
            <p className="text-mini text-ink-3">
              {row.source}
              {row.created_at && ` · ${String(row.created_at).slice(0, 10)}`}
            </p>
          </Section>
        </div>

        {/* The vote. One primary action, and Pass is not destructive — it's a
            respectable answer, so it never renders red. */}
        <div className="flex items-center gap-2 px-3 h-10 border-t border-line-2 flex-shrink-0">
          <button onClick={() => onTriage('approve')} className="btn-primary flex-1 justify-center">
            Add to pipeline
          </button>
          <button onClick={() => onTriage('dismiss')} className="btn-secondary flex-1 justify-center">
            Pass
          </button>
          <button
            onClick={() => onTriage('hide')}
            className="btn-ghost"
            title="Never surface this person again"
          >
            Never
          </button>
        </div>
      </aside>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Is the scout alive?
//
// Danny: "it didn't seem to be sourcing new founders for me on any time
// interval? I would click 'Find Founders' and it wouldn't really work."
//
// It was running. It just never said so — the cron recorded nothing at all, and
// the manual run recorded only the Exa sweep's zero while the connectors added
// 167 rows. So this states the last run plainly, including the case that has
// been true for most of this app's life: never recorded one.
// ══════════════════════════════════════════════════════════════════════════
function ScoutState({ data, running, onRun }) {
  if (!data) return null;
  const last = data.last_run;

  const when = last
    ? (() => {
        const mins = Math.round((Date.now() - new Date(last.ran_at).getTime()) / 60000);
        if (mins < 2) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
        return `${Math.round(mins / 1440)}d ago`;
      })()
    : null;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <button onClick={onRun} disabled={running} className="btn-secondary h-6 text-mini flex-none whitespace-nowrap">
        {running ? 'Sweeping…' : 'Run scout'}
      </button>
      <span className="text-mini text-ink-4 truncate min-w-0" title={last?.detail || ''}>
        {running ? (
          <span className="text-ink-2">Sweeping — this takes a few minutes…</span>
        ) : !last ? (
          // Never-run and found-nothing are completely different states, and
          // conflating them is what taught him the tool was broken.
          <span className="text-ink-3">Scout has never recorded a run</span>
        ) : (
          <>
            <span className={last.status === 'error' ? 'text-ink-2' : 'text-ink-4'}>
              Scout ran {when}
            </span>
            {/* The number that answers "is it worth opening this morning". It counts
                arrivals since the last scout run — not since midnight — so a run
                that finishes at 4:30am still reads as one night's work. */}
            {data.new_count > 0 && (
              <span className="text-ink-2"> · <span className="text-accent font-medium">{data.new_count} new</span> since the last run</span>
            )}
            {data.new_count === 0 && last.status !== 'error' && <span className="text-ink-4"> · nobody new</span>}
            {last.status === 'error' && <span className="text-ink-2"> · failed</span>}
          </>
        )}
      </span>
    </div>
  );
}

// ── The reasoning, rendered. ──
// Ranked, not alphabetical: the reason Danny takes the call leads. A prior exit
// and "strong traction" are not equal claims, and whichever lands first is the one
// that gets read at 32px — the rest truncate.
const SIGNAL_RANK = [
  /prior exit|acquired|exited/i,          // the strongest thing a founder can be
  /repeat|serial|second-time|\bYC twice/i,
  /YC|y combinator|techstars|a16z|speedrun|thiel|z fellows|neo|pear|on deck/i, // picked by someone good
  /raised|institutional capital|backed by/i,
  /elite-company|ex-|worked at/i,
  /wharton|mba|phd|stanford|harvard|mit|chicago|northwestern|illinois|uiuc/i,   // school
  /traction|revenue|users|shipped at scale/i,
];

function rankOf(tag) {
  const i = SIGNAL_RANK.findIndex((re) => re.test(tag));
  return i === -1 ? SIGNAL_RANK.length : i;
}

function Why({ tags }) {
  const ranked = [...tags].sort((a, b) => rankOf(a) - rankOf(b));

  // ONE string, ONE truncation. Not a flex row of chips.
  //
  // Two failed passes are worth recording. First I pinned each tag with
  // flex-shrink-0, so they didn't truncate at all — they bled through into the
  // Illinois column and rendered "Elite-ccurrent · Chicago". Then I let each tag
  // truncate, and flex distributed the squeeze evenly, producing four useless
  // fragments: "YC… · YC P26 admit (cur… · Raised inst… · Elite-company …".
  //
  // A chopped tag is worth nothing — "YC…" says less than nothing, because the
  // eye stops to parse it. So: join into one sentence and let it clip ONCE, at
  // the end, where a trailing ellipsis means "there's more" instead of "this word
  // is broken". Ranking is what makes the clip safe — the prior exit survives it.
  return (
    <span className="text-mini text-ink-2 truncate block">
      {ranked.map((t, i) => (
        <span key={i}>
          {i > 0 && <span className="text-ink-4"> · </span>}
          {t}
        </span>
      ))}
    </span>
  );
}

// Everything, including the evidenced long-form signals, on hover. The row shows
// the claim; the tooltip shows the receipt.
function reasonTitle(r) {
  const all = [...parseArr(r.caliber_signals), ...parseArr(r.pedigree_signals), ...parseArr(r.breakout_signals)]
    .filter((s) => !JUNK_SIGNAL.test(String(s).trim()));
  return all.length ? all.join('\n') : r.headline || '';
}

function Section({ label, children }) {
  return (
    <div>
      <div className="text-micro font-semibold uppercase text-ink-4 mb-1">{label}</div>
      {children}
    </div>
  );
}
