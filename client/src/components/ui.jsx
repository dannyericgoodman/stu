/**
 * Stu design system — the shared spine.
 * =====================================
 * Two colors only: accent (blue) for interactive/selected/the one primary action, danger
 * (red) for pass/reject/divergence. Everything else gray. Tiers & scores are typographic,
 * never colored. Every product is built from these: PageHeader → FilterBar → RankedList/Row
 * → DetailPanel. Learn it once, use it everywhere.
 */
import { useEffect, useRef, useState } from 'react';

// ── PageHeader ──────────────────────────────────────────────────────────────
export function PageHeader({ title, count, subtitle, search, actions, children }) {
  return (
    <div className="mb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {title}
            {count != null && <span className="ml-2 text-gray-300 font-normal">{count}</span>}
          </h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>
      </div>
      {search && <div className="mt-4">{search}</div>}
      {children}
    </div>
  );
}

// ── SearchInput ─────────────────────────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder = 'Search…', autoFocus }) {
  return (
    <div className="relative">
      <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm text-ink placeholder-gray-400 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10"
      />
    </div>
  );
}

// ── FilterBar + controls ─────────────────────────────────────────────────────
export function FilterBar({ children, resultCount, onClearAll, dirty }) {
  return (
    <div className="flex items-center flex-wrap gap-2 mb-4">
      {children}
      {(resultCount != null || (dirty && onClearAll)) && (
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-400">
          {dirty && onClearAll && (
            <button onClick={onClearAll} className="hover:text-gray-700 font-medium">Clear</button>
          )}
          {resultCount != null && <span>{resultCount} result{resultCount === 1 ? '' : 's'}</span>}
        </div>
      )}
    </div>
  );
}

function Popover({ trigger, children, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen(o => !o)}>{trigger}</div>
      {open && (
        <div className={`absolute z-30 mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

const pillBase = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors';

export function FilterSelect({ label, value, options, onChange, multi = false }) {
  const sel = multi ? (Array.isArray(value) ? value : []) : value;
  const active = multi ? sel.length > 0 : (value != null && value !== '' && value !== 'all');
  const display = multi
    ? (sel.length ? `${label}: ${sel.length}` : label)
    : (active ? `${label}: ${options.find(o => o.value === value)?.label || value}` : label);
  return (
    <Popover trigger={
      <button className={`${pillBase} ${active ? 'border-accent text-accent bg-accent-soft' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
        {display}
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" /></svg>
      </button>
    }>
      {(close) => (
        <div className="max-h-72 overflow-y-auto">
          {options.map(o => {
            const isSel = multi ? sel.includes(o.value) : value === o.value;
            return (
              <button key={String(o.value)}
                onClick={() => { multi ? onChange(isSel ? sel.filter(v => v !== o.value) : [...sel, o.value]) : (onChange(o.value), close()); }}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-gray-50 ${isSel ? 'text-accent font-medium' : 'text-gray-700'}`}>
                {o.label}
                {isSel && <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" /></svg>}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

export function FilterToggle({ label, active, onChange }) {
  return (
    <button onClick={() => onChange(!active)} className={`${pillBase} ${active ? 'border-accent text-accent bg-accent-soft' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
      {label}
    </button>
  );
}

// ── Tier glyph (grayscale, weight = caliber) ──────────────────────────────────
export function Tier({ tier }) {
  if (!tier) return null;
  const t = String(tier).toUpperCase();
  const isS = t === 'S';
  return (
    <span title={`Caliber ${t}`} className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-md text-xs font-bold border ${isS ? 'bg-ink text-white border-ink' : 'bg-white text-ink border-gray-300'}`}>
      {t}
    </span>
  );
}

// ── Score (numeral + thin track, never colored by value) ──────────────────────
export function Score({ value, max = 100, label }) {
  if (value == null) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="text-sm tabular-nums font-semibold text-ink w-7 text-right">{Math.round(value)}</div>
      <div className="w-10 h-1 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full bg-gray-400" style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="text-2xs text-gray-400 uppercase tracking-wide">{label}</span>}
    </div>
  );
}

// ── Conviction badge — the ONE place the verdict vocabulary lives ─────────────
//
// The old vocabulary was Invest / Monitor / Pass, coloured green / amber / red and
// re-implemented inline on four different screens. The Founder Rubric's ladder has
// four bands plus an indeterminate state, and the indeterminate state is the whole
// point of the rebuild: "we have not learned enough to judge this" is NOT a Pass.
//
// The old list badges rendered it as one. FounderDetail did
//   signal === 'Invest' ? green : signal === 'Monitor' ? amber : RED
// so "Insufficient evidence" fell through to bright red — a company we know nothing
// about looked identical to a company we rejected, on the screen Danny actually scans.
//
// Per tailwind.config.js the bands are TYPOGRAPHIC, never coloured by value: rank reads
// as weight, not hue. Indeterminate is the one visually distinct state — dashed and dim,
// because it is a different KIND of thing, not a worse score.
const BAND_STYLE = {
  anchor: 'border-ink bg-ink text-white font-bold',
  memo: 'border-ink bg-white text-ink font-bold',
  monitor: 'border-gray-300 bg-white text-gray-600 font-medium',
  pass: 'border-gray-200 bg-white text-gray-400 font-normal',
  indeterminate: 'border-dashed border-gray-300 bg-gray-50 text-gray-400 font-normal italic',
};

const BAND_LABEL = {
  anchor: 'Anchor-grade',
  memo: 'Top-quartile',
  monitor: 'Monitor',
  pass: 'Pass with respect',
  indeterminate: 'Insufficient evidence',
};

// `conviction_band` is the ONLY source of truth. Deliberately no fallback to
// overall_signal.
//
// The tempting fallback — map the signal string onto a band — is wrong, and the live
// DB shows exactly why: the legacy rows carry signals "Pass", "Pass On", and "Monitor".
// "Monitor" is BOTH a retired Invest/Monitor/Pass value AND a current band label. A
// string match would dress a row scored 5.8 under the old Team45/Product25/Market30
// average — at temperature 1.0, so not even reproducible — as though the Founder Rubric
// had judged it. That is the same class of lie this rebuild exists to remove, so a row
// without a band is reported as what it is: old.
export function convictionBand({ conviction_band }) {
  return conviction_band && BAND_STYLE[conviction_band] ? conviction_band : null;
}

export function ConvictionBadge({ assessment, score, size = 'sm' }) {
  if (!assessment) return null;
  const band = convictionBand(assessment);
  const value = score !== undefined ? score : assessment.conviction_score;
  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-xs';

  // No band. First separate a CURRENT run that failed or is still going from a genuine
  // legacy row — a run that errored today must not be dressed as a retired-ladder score.
  if (!band) {
    const st = assessment.status;
    if (st === 'error' || st === 'partial' || st === 'running' || st === 'processing_inputs' || st === 'synthesizing') {
      const label = st === 'error' ? 'failed' : st === 'partial' ? 'partial' : 'running';
      const tip = st === 'error' ? "This run didn't finish — re-run it"
        : st === 'partial' ? 'Finished with gaps — re-run to complete the write-up'
        : 'Still running';
      return (
        <span title={tip} className={`inline-flex items-center rounded-full border ${pad} border-gray-200 bg-white text-gray-400 font-normal`}>
          {label}
        </span>
      );
    }
    // Genuine legacy row scored under the old ladder — say so rather than dressing it as a band.
    const legacy = assessment.overall_signal || assessment.status;
    if (!legacy) return null;
    return (
      <span title="Scored under the retired Invest/Monitor/Pass ladder" className={`inline-flex items-center gap-1 rounded-full border ${pad} border-gray-200 bg-white text-gray-400 font-normal`}>
        {legacy}
        <span className="text-gray-300">·</span>
        <span className="text-gray-300">old</span>
      </span>
    );
  }

  return (
    <span
      title={band === 'indeterminate' ? 'Not enough evidence to score — this is not a pass' : BAND_LABEL[band]}
      className={`inline-flex items-center gap-1.5 rounded-full border ${pad} ${BAND_STYLE[band]}`}
    >
      {band !== 'indeterminate' && value != null && (
        <span className="tabular-nums font-bold">{value}</span>
      )}
      {BAND_LABEL[band]}
    </span>
  );
}

// ── Tag (the only metadata chip, always neutral) ──────────────────────────────
export function Tag({ children }) {
  if (!children) return null;
  return <span className="inline-flex items-center bg-gray-100 text-gray-600 rounded-full px-2 py-0.5 text-xs font-medium">{children}</span>;
}

// ── TasteFlag (the only red in a list) ────────────────────────────────────────
export function TasteFlag({ active, title = 'Diverges from your revealed taste' }) {
  if (!active) return null;
  return <span title={title} className="inline-block w-2 h-2 rounded-full bg-danger" />;
}

// ── RankedList + Row ──────────────────────────────────────────────────────────
export function RankedList({ items, renderRow, loading, emptyState, className = '' }) {
  if (loading) return <div className="text-center py-16 text-sm text-gray-400">Loading…</div>;
  if (!items || items.length === 0) return emptyState || <EmptyState title="Nothing here yet" />;
  return (
    <div className={`divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white overflow-hidden ${className}`}>
      {items.map((it, i) => renderRow(it, i))}
    </div>
  );
}

export function Row({ tier, title, subtitle, score, meta, trailing, flag, selected, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selected ? 'bg-accent-soft border-l-2 border-accent' : 'border-l-2 border-transparent hover:bg-gray-50'}`}
    >
      {tier !== undefined && <div className="flex-shrink-0"><Tier tier={tier} /></div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink truncate">{title}</span>
          <TasteFlag active={flag} />
        </div>
        {subtitle && <div className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</div>}
        {meta && <div className="flex items-center gap-1.5 mt-1 flex-wrap">{meta}</div>}
      </div>
      {score !== undefined && <div className="flex-shrink-0">{score}</div>}
      {trailing && <div className="flex-shrink-0 flex items-center gap-1.5">{trailing}</div>}
    </div>
  );
}

// ── DetailPanel (640px slide-over, ↑/↓ cycles) ────────────────────────────────
export function DetailPanel({ open, onClose, title, subtitle, primaryAction, secondaryActions = [], onPrev, onNext, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowDown' && onNext) { e.preventDefault(); onNext(); }
      else if (e.key === 'ArrowUp' && onPrev) { e.preventDefault(); onPrev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, onPrev, onNext]);

  if (!open) return null;
  const toneClass = (tone) => tone === 'danger'
    ? 'bg-danger text-white hover:bg-red-700'
    : tone === 'ghost'
      ? 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
      : 'bg-accent text-white hover:bg-accent-hover';
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[640px] max-w-[92vw] bg-white shadow-xl flex flex-col h-full">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink truncate">{title}</h2>
            {subtitle && <p className="text-sm text-gray-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {(onPrev || onNext) && (
              <>
                <button onClick={onPrev} disabled={!onPrev} className="p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Previous (↑)">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m18 15-6-6-6 6" /></svg>
                </button>
                <button onClick={onNext} disabled={!onNext} className="p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Next (↓)">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" /></svg>
                </button>
              </>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700" title="Close (Esc)">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {(primaryAction || secondaryActions.length > 0) && (
          <div className="flex items-center gap-2 px-6 py-3 border-t border-gray-200 flex-shrink-0">
            {primaryAction && (
              <button onClick={primaryAction.onClick} disabled={primaryAction.disabled}
                className={`text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-40 ${toneClass(primaryAction.tone)}`}>
                {primaryAction.label}
              </button>
            )}
            {secondaryActions.map((a, i) => (
              <button key={i} onClick={a.onClick} disabled={a.disabled}
                className={`text-sm font-medium px-3 py-2 rounded-lg transition-colors disabled:opacity-40 ${toneClass(a.tone || 'ghost')}`}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── DetailSection (used inside DetailPanel bodies) ────────────────────────────
export function DetailSection({ label, children }) {
  return (
    <div className="mb-5">
      {label && <div className="text-2xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">{label}</div>}
      <div className="text-sm text-gray-700 leading-relaxed">{children}</div>
    </div>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────
export function EmptyState({ title, description, action }) {
  return (
    <div className="text-center py-16 px-6">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {description && <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="mt-4 text-sm font-medium text-accent hover:text-accent-hover">{action.label}</button>
      )}
    </div>
  );
}
