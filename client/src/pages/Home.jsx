import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// ══════════════════════════════════════════════════════════════════════════
// Home — the screen Danny opens first.
//
// Danny, 2026-08-28: "The homepage doesn't look different. I'd like it to be
// cleaner, more actionable. It could even just give me the ability to build a custom
// task list or set off agents to go accomplish tasks for me."
//
// ── WHAT CAME OFF ──
// Two thirds of this screen was a second, worse view of Airtable: a five-stage
// funnel grid (87 Found / 20 Met / 1 Assessed / 0 Decided / 9 Invested), a
// "which channels produce" bar chart whose top channel was the string "Danny
// Goodman" and whose second was "Unknown", and two big number cards. He told me he
// cleaned up Airtable and is comfortable there, so every one of those panels asked
// him to read a worse copy of something he already trusts. None of them had a verb.
//
// The Pipeline screen itself is untouched — this is about what Home spends its space
// on, and a link is enough.
//
// ── WHAT IT IS NOW, IN ORDER ──
//   1. YOUR LIST      his own rows, first, with the add box at the TOP. It was
//                     buried under a machine-written panel with the input at the
//                     bottom, which is the layout of a log, not a to-do list.
//   2. SET RUNNING    the three things in Stu that do real work in the background,
//                     one per product, dispatchable in two clicks with a target
//                     picker that only lists targets that would actually work.
//   3. NEEDS YOU      the integrity checks — but only the ones that are a TASK.
//
// ── THE 101 ──
// "Live deals with no read: 101" was the loudest row on the old screen and the least
// actionable thing on it: each read is a nine-lens Opus run, and a list of 101 of
// them is a wall, not a task. It taught him to scroll past the panel that matters
// most. It is now a fact in the footer strip, and the handful he can actually run
// today — the companies that have materials on file — are the picker for the read
// agent. Same truth, moved from nagging to doing.
//
// ── UNCHANGED, DELIBERATELY ──
// No pipeline total, no growth trend, no conversion rate. Danny: "I want to inflate
// my pipeline numbers." A metric he has told me he games is a metric I will not
// build. DECIDED is still the only progress number, and it still requires a dated
// falsifiable prediction to increment.
// ══════════════════════════════════════════════════════════════════════════

export default function Home() {
  const nav = useNavigate();
  const [attention, setAttention] = useState(null);
  const [stats, setStats] = useState(null);
  const [today, setToday] = useState(null);
  const [agents, setAgents] = useState(null);
  const [shortlist, setShortlist] = useState(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);   // what was just set running

  function loadAgents() { api.getAgents({ fresh: true }).then(setAgents).catch(() => {}); }

  useEffect(() => {
    api.getAttention().then(setAttention).catch((e) => setErr(e.message));
    api.getPipelineStats().then(setStats).catch(() => {});
    api.getToday().then(setToday).catch(() => {});
    api.getShortlist().then(setShortlist).catch(() => {});
    loadAgents();
  }, []);

  // Poll only while something is actually running. A background job that finishes
  // without the screen noticing is the same defect as one that never ran.
  const anyRunning = (agents?.agents || []).some((a) => a.running?.length);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(loadAgents, 10000);
    return () => clearInterval(t);
  }, [anyRunning]);

  // ── Dispatch ──
  // Each agent fires its PRODUCT'S OWN route. Home does not re-implement any of the
  // three workflows; it just knows how to start them and how to say so.
  async function dispatch(kind, target) {
    try {
      if (kind === 'scout') {
        await api.triggerSourcing();
        setNote('Scout is sweeping. It takes a few minutes — new founders land in Source.');
      } else if (kind === 'read') {
        await api.runCardRead(target.id);
        setNote(`Reading ${target.label}. The panel takes a couple of minutes.`);
      } else if (kind === 'hiring') {
        await api.sourceHiringRole(target.id);
        setNote(`Sourcing candidates for ${target.label}.`);
      }
      loadAgents();
    } catch (e) {
      // Say what failed, in its own words. `/read` in particular refuses politely
      // and usefully ("Nothing to read yet — add a deck or call notes first").
      setErr(e.message);
    }
  }

  async function addItem(e) {
    e?.preventDefault?.();
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    try {
      const item = await api.addTodayItem({ title, lane: 'mine' });
      setToday((t) => ({ ...t, items: [...(t?.items || []), item] }));
    } catch (e2) {
      setErr(e2.message);
      setDraft(title); // never silently eat what he typed — the old add box did
    }
  }

  async function toggleItem(item) {
    const done = !item.completed_at;
    setToday((t) => ({
      ...t,
      items: t.items.map((i) => (i.id === item.id ? { ...i, completed_at: done ? 'now' : null } : i)),
    }));
    try { await api.updateTodayItem(item.id, { completed: done }); } catch { /* optimistic */ }
  }

  async function removeItem(item) {
    setToday((t) => ({ ...t, items: t.items.filter((i) => i.id !== item.id) }));
    try { await api.deleteTodayItem(item.id); } catch { /* optimistic */ }
  }

  // Danny: "I just want a daily task list so I know what to be doing per day. As
  // my day goes on, I'll want to add things and remove them."
  // Add, complete and delete already worked. EDIT didn't — so a typo meant delete
  // and retype, which is exactly the friction that makes a list stop being used.
  async function renameItem(item, title) {
    const t = String(title).trim();
    if (!t || t === item.title) return;
    setToday((s) => ({ ...s, items: s.items.map((i) => (i.id === item.id ? { ...i, title: t } : i)) }));
    try { await api.updateTodayItem(item.id, { title: t }); } catch { /* optimistic */ }
  }

  const items = today?.items || [];
  const open = items.filter((i) => !i.completed_at).length;

  // The read backlog is a FACT, not a task — see the header. Split it out of the
  // amber list so the checks panel holds only things he can finish today.
  const BACKLOG_KEYS = new Set(['considering_never_assessed']);
  const checkData = attention && {
    ...attention,
    checks: attention.checks.filter((c) => !BACKLOG_KEYS.has(c.key)),
  };
  const backlog = attention?.checks.find((c) => BACKLOG_KEYS.has(c.key));

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-4 max-w-[820px]">
        {err && (
          <div className="flex items-start gap-2 text-small text-danger mb-3">
            <span className="flex-1">{err}</span>
            <button className="text-ink-4 hover:text-ink-2" onClick={() => setErr(null)}>Dismiss</button>
          </div>
        )}

        <div className="flex items-baseline gap-2 mb-4">
          <h1 className="text-large font-semibold text-ink">Today</h1>
          <span className="text-mini text-ink-3">{todayLabel}</span>
          <div className="flex-1" />
          {attention && (
            <span className="text-mini text-ink-3">
              {attention.needs_attention === 0
                ? 'nothing needs you'
                : `${attention.needs_attention} ${attention.needs_attention === 1 ? 'company needs' : 'companies need'} you`}
            </span>
          )}
        </div>

        {/* ── 1. HIS LIST ── first, and the input is at the TOP.
            Danny: "It is my to-do list — I should be able to add/modify/delete/
            check-off my own ideas in addition to what your agents suggest." An add
            box below the rows is the layout of a log; you write at the top of a list. */}
        <div className="border border-line-2 rounded-md bg-ground mb-4">
          <div className="px-3 h-6 flex items-center border-b border-line bg-ground-3">
            <span className="text-micro font-semibold uppercase text-ink-4">Your list</span>
            <div className="flex-1" />
            {open > 0 && <span className="num text-micro text-ink-4">{open}</span>}
          </div>

          {/* Enter is handled EXPLICITLY, not left to the browser's implicit form
              submission. Implicit submission depends on the form having exactly one
              submittable field and is the kind of behaviour that quietly stops
              working when someone adds a second input next year — and the thing that
              would break is the only interaction on this screen that must never fail.
              The onSubmit stays so a future submit button also works. */}
          <form onSubmit={addItem} className="flex items-center h-row px-3 border-b border-line">
            <span className="w-3 mr-2 text-ink-4 text-center leading-none">+</span>
            <input
              className="flex-1 bg-transparent border-0 outline-none text-small text-ink placeholder-ink-4"
              placeholder="Add something…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(e); } }}
            />
          </form>

          {items.length === 0 ? (
            <div className="px-3 py-2.5 text-mini text-ink-4">
              Nothing on your list. Type above, or set one of the agents below running.
            </div>
          ) : (
            items.map((item) => (
              <TaskRow
                key={item.id}
                item={item}
                onToggle={() => toggleItem(item)}
                onDelete={() => removeItem(item)}
                onRename={(title) => renameItem(item, title)}
              />
            ))
          )}
        </div>

        {/* ── 2. THE AGENTS ── directly under the to-do list.
            Danny, 2026-08-31: "This box should really be the item under my to-do
            list (Your List) and before This Morning." The order encodes the morning:
            what you owe people, then what you can set running while you read, then
            the founders to read. Starting a scout takes a click and finishes without
            you, so it belongs BEFORE the list that takes twenty minutes of attention
            — not after it, where you would reach it having already spent them. */}
        <Agents data={agents} note={note} onClearNote={() => setNote(null)} onRun={dispatch} nav={nav} />

        {/* ── 3. THIS MORNING'S FOUNDERS ── the ranked list, capped.
            Danny: "a full funnel inbox of top founder candidates as well as a
            prioritized, ranked list — both updated in the morning before I wake up."
            The inbox lives on Source and holds everything that cleared the gates.
            This is the short one: the handful worth his attention today. */}
        <Shortlist data={shortlist} nav={nav} />

        {/* ── 4. WHAT NEEDS HIM ── only rows that are a task. */}
        <div className="border border-line-2 rounded-md bg-ground mb-4">
          <div className="px-3 h-6 flex items-center border-b border-line bg-ground-3">
            <span className="text-micro font-semibold uppercase text-ink-4">Needs you</span>
          </div>
          {!checkData ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="row px-3"><span className="block h-2 w-64 bg-ground-3 rounded-sm" /></div>
            ))
          ) : (
            <Checks data={checkData} nav={nav} />
          )}
        </div>

        {/* ── The footer strip ──
            Everything that is a NUMBER rather than a task. One line, no cards, each
            one a link to the screen that owns it. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-mini text-ink-3">
          {stats && (
            <button className="hover:text-ink transition" onClick={() => nav('/sourcing')}>
              <span className="num text-ink">{stats.inbox_waiting}</span> waiting in Source →
            </button>
          )}
          {today && (
            <span title="The only progress metric here. It requires a dated, falsifiable prediction to increment.">
              <span className="num text-ink">{today.decided_this_week}</span> decided this week
            </span>
          )}
          {backlog?.count > 0 && (
            <span title={backlog.action}>
              <span className="num text-ink">{backlog.count}</span> live deals with no read
            </span>
          )}
          <button className="hover:text-ink transition" onClick={() => nav('/pipeline')}>
            Open the pipeline →
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SET SOMETHING RUNNING.
//
// Three agents, one per product, each firing its own existing route. Two of them
// need a target, and the picker only ever lists targets that would actually work —
// the read agent lists companies that HAVE materials on file, because the engine
// refuses (correctly) to score a company with nothing to read, and offering the
// other ninety would be offering ninety errors.
//
// An agent with no valid target says WHY rather than rendering an empty menu.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// Shortlist — the ten founders worth looking at this morning.
//
// The one rule that shapes this component: a reason is shown WITH ITS KIND.
// "Exited a startup" and "Northwestern" are both true and they are not the same
// claim — the first says this person has built something, the second says the
// Series A market tends to fund people like this. Outcome data puts unicorn
// founders at ~36% top-10 school / ~36% outside the top 100, so school predicts
// the next ROUND, not the company. Rendering both in the same grey pill is how a
// fund ends up with a pedigree portfolio it never chose.
//
// So: quality signals read normally, graduation signals are muted and suffixed,
// and "reachable now" gets its own mark because timing decays and nothing else here
// does.
//
// The row's action is LINKEDIN. Danny: "when I click Open it does nothing... I want
// it to take me to their LinkedIn. So the homepage lets me get right to the business
// of sourcing." The morning list exists to start conversations, and the first thing
// you do with a stranger's name is read their LinkedIn.
// ══════════════════════════════════════════════════════════════════════════

// A scheme-less URL ("linkedin.com/in/x") in an href is a RELATIVE path: React Router
// would swallow it, miss every route, and the catch-all would bounce you to "/" —
// which is precisely the dead-click this component was just fixed for. The stored data
// is clean today (932 rows, 0 without a scheme), so this guards the next bad writer,
// not the current one.
function externalUrl(u) {
  if (!u) return null;
  const t = String(u).trim();
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
}

function Shortlist({ data, nav }) {
  if (!data) {
    return (
      <div className="border border-line-2 rounded-md bg-ground mb-4">
        <div className="px-3 h-6 flex items-center border-b border-line bg-ground-3">
          <span className="text-micro font-semibold uppercase text-ink-4">This morning</span>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="row px-3"><span className="block h-2 w-56 bg-ground-3 rounded-sm" /></div>
        ))}
      </div>
    );
  }

  return (
    <div className="border border-line-2 rounded-md bg-ground mb-4">
      <div className="px-3 h-6 flex items-center border-b border-line bg-ground-3">
        <span className="text-micro font-semibold uppercase text-ink-4">This morning</span>
        <div className="flex-1" />
        {data.count > 0 && (
          <span className="num text-micro text-ink-4">
            {data.new_today > 0 ? `${data.new_today} new · ${data.count}` : data.count}
          </span>
        )}
      </div>

      {data.count === 0 ? (
        // Silence must mean "I looked". An empty list states that it ran.
        <div className="px-3 py-2 text-mini text-ink-3">{data.empty_reason}</div>
      ) : (
        data.founders.map((f) => (
          <div key={f.id} className="border-b border-line last:border-b-0 px-3 py-1.5">
            <div className="flex items-baseline gap-2">
              {f.is_new && <span className="text-micro text-accent flex-none" title="New since last night's scout">new</span>}
              <span className="text-small text-ink font-medium flex-none">{f.name}</span>
              <span className="text-mini text-ink-3 truncate flex-1 min-w-0">
                {f.company || f.one_liner || '—'}
              </span>
              <span
                className={`text-micro flex-none ${f.tier === 'must-meet' ? 'text-accent' : 'text-ink-4'}`}
                title={f.why || ''}
              >
                {f.tier === 'must-meet' ? 'Must meet' : 'Strong'}
              </span>
              {/* Never render a control that cannot act. With a LinkedIn on file this
                  is a real anchor (middle-click and ⌘-click work, which a button's
                  onClick never did); without one it says so and falls back to the
                  inbox rather than pretending. */}
              {externalUrl(f.linkedin_url) ? (
                <a
                  href={externalUrl(f.linkedin_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary h-5 text-mini flex-none"
                  title={`Open ${f.name} on LinkedIn`}
                >
                  Open ↗
                </a>
              ) : (
                <button
                  className="btn-secondary h-5 text-mini flex-none"
                  onClick={() => nav('/sourcing')}
                  title="No LinkedIn on file for this founder — opens the sourcing inbox instead"
                >
                  Inbox
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
              {f.reachable_now && (
                <span className="text-micro text-accent" title="Recently left a role — the window where a first conversation is easiest">
                  reachable now
                </span>
              )}
              {f.signals.map((sig, i) => (
                <span
                  key={i}
                  className={`text-micro ${sig.kind === 'quality' ? 'text-ink-3' : 'text-ink-4'}`}
                  title={
                    sig.kind === 'graduation'
                      ? `Next-round signal, not a quality signal — evidence: ${sig.evidence}`
                      : sig.evidence
                  }
                >
                  {sig.label}{sig.kind === 'graduation' ? ' ·' : ''}
                </span>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="px-3 h-6 flex items-center border-t border-line text-micro text-ink-4">
        <span className="flex-1 truncate">
          Ranked on quality signals · school and employer shown as next-round signals only
        </span>
        {/* "/source" is not a route. The catch-all redirected it to "/", so this
            silently reloaded the home page — the same dead click as Open. */}
        <button className="text-ink-4 hover:text-ink-2" onClick={() => nav('/sourcing')}>Full inbox →</button>
      </div>
    </div>
  );
}

function Agents({ data, note, onClearNote, onRun, nav }) {
  const [picking, setPicking] = useState(null);

  return (
    <div className="border border-line-2 rounded-md bg-ground mb-4">
      <div className="px-3 h-6 flex items-center border-b border-line bg-ground-3">
        <span className="text-micro font-semibold uppercase text-ink-4">Set something running</span>
      </div>

      {note && (
        <div className="flex items-center gap-2 px-3 h-row border-b border-line bg-accent-soft text-small">
          <span className="flex-1 text-ink">{note}</span>
          <button className="text-ink-4 hover:text-ink-2 text-mini" onClick={onClearNote}>Dismiss</button>
        </div>
      )}

      {!data ? (
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="row px-3"><span className="block h-2 w-48 bg-ground-3 rounded-sm" /></div>
        ))
      ) : (
        data.agents.map((a) => {
          const targets = a.targets || [];
          const isOpen = picking === a.kind;
          const blocked = a.needs_target && targets.length === 0;

          return (
            <div key={a.kind} className="border-b border-line last:border-b-0">
              <div className="flex items-center gap-2 h-row px-3">
                <span className="text-small text-ink font-medium flex-none w-40">{a.label}</span>
                <span className="text-mini text-ink-3 truncate flex-1 min-w-0">
                  {blocked ? a.empty_reason : a.detail}
                </span>

                {/* What's running now, named. A spinner with no subject is a spinner
                    you learn to ignore. */}
                {a.running?.length > 0 && (
                  <span className="text-mini text-accent flex-none">
                    running · {a.running.map((r) => r.label).join(', ')}
                  </span>
                )}

                {!blocked && (
                  <button
                    onClick={() => (a.needs_target ? setPicking(isOpen ? null : a.kind) : onRun(a.kind))}
                    className="btn-secondary h-5 text-mini flex-none"
                  >
                    {a.needs_target ? (isOpen ? 'Close' : 'Pick…') : 'Run'}
                  </button>
                )}
              </div>

              {/* The scout is the one agent with a durable record of its last run, so
                  it is the one that can honestly report when it last worked. */}
              {a.kind === 'scout' && a.last && (
                <div className="px-3 pb-1.5 text-mini text-ink-4 truncate" title={a.last.detail || ''}>
                  Last run {timeAgo(a.last.ran_at)}
                  {a.last.detail ? ` · ${a.last.detail}` : ''}
                </div>
              )}
              {a.kind === 'scout' && !a.last && (
                <div className="px-3 pb-1.5 text-mini text-ink-4">
                  No run recorded yet — it runs nightly at 4:30am.
                </div>
              )}

              {isOpen && (
                <div className="border-t border-line bg-ground-2 max-h-56 overflow-y-auto">
                  {targets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setPicking(null); onRun(a.kind, t); }}
                      className="w-full flex items-center gap-2 h-row px-3 pl-8 text-left hover:bg-ground-3 transition"
                    >
                      <span className="row-primary flex-none w-60 truncate" title={t.label}>{t.label}</span>
                      <span className="text-mini text-ink-3 truncate flex-1 min-w-0">{t.detail}</span>
                      <span className="text-mini text-accent flex-none">Run →</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(t)) return 'never';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// Every check renders daily, including when clean — the reason Permute's version
// is trustworthy is that "✓ no overdue follow-ups" sits next to the amber one. A
// list that only appears when something is wrong is indistinguishable from a list
// that is broken. Silence has to mean "I looked."
// ── One task row. Click the text to edit it. ──
// Deliberately not a modal, not a pencil icon, not a right-click menu: click the
// words, they become an input, Enter or blur saves, Esc reverts. A daily list
// gets edited mid-thought while he's on a call — anything that costs a second
// click gets skipped, and a list you skip editing becomes a list of stale lies.
function TaskRow({ item, onToggle, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  useEffect(() => setDraft(item.title), [item.title]);

  return (
    <div className="row px-3 group">
      <button
        onClick={onToggle}
        className={`w-3 h-3 rounded-sm border mr-2 flex-none transition ${
          item.completed_at ? 'bg-ink border-ink' : 'border-line-3 hover:border-ink-3'
        }`}
        aria-label={item.completed_at ? 'Mark undone' : 'Mark done'}
      />

      {editing ? (
        <input
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-small text-ink"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); onRename(draft); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setDraft(item.title); setEditing(false); }
          }}
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={`flex-1 min-w-0 truncate cursor-text ${item.completed_at ? 'text-ink-4 line-through' : 'text-ink'}`}
          title="Click to edit"
        >
          {item.title}
        </span>
      )}

      {/* An agent row says where it came from, quietly — and carries the line that
          produced it on hover. "Send the deck" is a nag; "My next step, I guess, is
          I'll send you some slides" — Dan Preiss, 2 days ago — is a fact he can act
          on without re-deriving anything. The quote is the whole difference. */}
      {item.origin === 'agent' && (
        <span className="text-mini text-ink-4 mr-2 flex-none" title={item.quote || 'suggested by Stu'}>
          {item.quote ? 'from a call ⌄' : 'from a call'}
        </span>
      )}

      <button
        onClick={onDelete}
        className="text-mini text-ink-4 hover:text-danger opacity-0 group-hover:opacity-100 transition flex-none"
      >
        Delete
      </button>
    </div>
  );
}

function Checks({ data, nav }) {
  const [open, setOpen] = useState(null);
  const [showClean, setShowClean] = useState(false);
  const clean = data.checks.filter((c) => !c.count && !c.blocked);
  const live = data.checks.filter((c) => c.count || c.blocked);
  const shown = showClean ? data.checks : live;

  return (
    <>
      {shown.map((c) => (
        <div key={c.key}>
          <button
            onClick={() => setOpen(open === c.key ? null : c.key)}
            disabled={!c.count && !c.blocked}
            className={`w-full flex items-center gap-2 h-row px-3 text-small text-left transition ${
              c.count || c.blocked ? 'hover:bg-ground-3 cursor-pointer' : 'cursor-default'
            }`}
          >
            <span className="w-3 text-center text-mini flex-none">
              {c.blocked ? <span className="text-ink-4">·</span>
                : c.count ? <span className="text-attention">▲</span>
                : <span className="text-ink-4">✓</span>}
            </span>
            <span className={`flex-none ${c.count ? 'text-ink font-medium' : 'text-ink-3'}`}>{c.title}</span>
            <span className="text-ink-4 text-mini truncate">
              {c.blocked ? (open === c.key ? "can't run yet" : "can't run yet — why?") : c.count ? c.action : c.clean}
            </span>
            <span className="flex-1" />
            {c.count > 0 && <span className="num text-mini text-ink font-medium">{c.count}</span>}
          </button>

          {/* Blocked is a first-class state, not a failure — the engine refuses to
              compute a number off data it doesn't have, and says what would fix it.
              But the reason is a PARAGRAPH, and rendering it inline made the one row
              on this panel that Danny cannot act on the largest thing on it. It now
              opens on click like every other row, so the honesty is one click away
              instead of in the way. */}
          {c.blocked && open === c.key && (
            <div className="px-3 pb-2 pl-8 text-mini text-ink-3 max-w-2xl">{c.blocked_reason}</div>
          )}

          {open === c.key && c.rows.length > 0 && (
            <div className="border-y border-line bg-ground-2 max-h-64 overflow-y-auto">
              {c.rows.map((r) => (
                <div
                  key={`${c.key}-${r.id}`}
                  onClick={() => r.founder_id && nav(`/founders/${r.founder_id}`)}
                  className="row px-3 pl-8 cursor-pointer"
                >
                  <span className="row-primary w-44 flex-none">{r.primary}</span>
                  <span className="flex-1 min-w-0 text-ink-2 truncate">{r.detail}</span>
                  {r.meta && <span className="row-meta w-52 text-right">{r.meta}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {clean.length > 0 && (
        <button
          onClick={() => setShowClean((s) => !s)}
          className="w-full flex items-center gap-2 h-6 px-3 text-mini text-ink-4 hover:text-ink-2 transition border-t border-line"
        >
          <span className="w-3 text-center">✓</span>
          {showClean ? 'Hide the clean ones' : `${clean.length} checks clean`}
        </button>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Dashboard — REMOVED 2026-08-28.
//
// It rendered the five-stage funnel grid, the "which channels produce" bar chart,
// "Decided this week", and "Waiting in sourcing" as four cards taking two thirds of
// Home. Danny: "The homepage doesn't look different. I'd like it to be cleaner, more
// actionable."
//
// Every panel here was a read-only view of the Airtable mirror, which he told me he
// had cleaned up and was comfortable managing in Airtable — so this was asking him to
// consult a worse copy of a system he already trusts. None of the four had a verb on
// it. The channel chart's top two rows were the strings "Danny Goodman" and
// "Unknown", which is the Airtable Source field ungrouped rather than a channel
// taxonomy.
//
// The two numbers worth keeping (inbox waiting, decided this week) are one line in
// the footer strip, each a link to the screen that owns it. /api/pipeline/stats is
// unchanged and still serves them; the Pipeline screen is untouched.
// ══════════════════════════════════════════════════════════════════════════
