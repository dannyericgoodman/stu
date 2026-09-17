import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Tag } from './ui';

// ════════════════════════════════════════════════════════
// FrameworksPanel — the Assessment Architect, embeddable.
// Rendered full-page at /frameworks and inside a modal on the Assess page.
// Three steps: 1 Start (describe / preset / blank) → 2 Refine the draft →
// 3 Save. The investor owns every question before it becomes a framework.
// ════════════════════════════════════════════════════════

const EVIDENCE_OPTIONS = [
  { value: 1, label: 'Website / public record' },
  { value: 2, label: 'Deck / founder materials' },
  { value: 3, label: 'Met the founder' },
  { value: 4, label: 'Multiple conversations' },
];

const ENTRY_CARDS = [
  { key: 'describe', title: 'Describe it', blurb: 'Say what you assess in plain words. The architect drafts the questions.' },
  { key: 'preset', title: 'Start from a preset', blurb: 'Pick a proven framework and make it yours.' },
  { key: 'blank', title: 'Start blank', blurb: 'Write every question yourself. No drafting.' },
];

const blankDimension = () => ({
  key: 'q' + Math.random().toString(36).slice(2, 7),
  label: '',
  question: '',
  guidance: '',
  weight: 3,
  min_rung: 2,
  load_bearing: false,
});

export default function FrameworksPanel() {
  const [rubrics, setRubrics] = useState([]);
  const [loading, setLoading] = useState(true);

  // Builder state
  const [entry, setEntry] = useState('describe'); // describe | preset | blank
  const [description, setDescription] = useState('');
  const [answers, setAnswers] = useState({ focus: '', excitement: '', deal_killers: '' });
  const [basePreset, setBasePreset] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(null); // editable rubric shape
  const [draftErrors, setDraftErrors] = useState([]);
  const [nudge, setNudge] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { rubrics } = await api.getRubrics();
      setRubrics(rubrics || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  const presets = rubrics.filter(r => r.is_preset);
  const customs = rubrics.filter(r => !r.is_preset);

  function resetBuilder() {
    setDescription('');
    setAnswers({ focus: '', excitement: '', deal_killers: '' });
    setBasePreset(null);
    setDraft(null);
    setDraftErrors([]);
    setNudge(null);
    setEditingId(null);
  }

  async function handleDraft() {
    const payload = {
      description: description.trim(),
      answers: {
        focus: answers.focus.trim(),
        excitement: answers.excitement.trim(),
        deal_killers: answers.deal_killers.trim(),
      },
      base_preset_key: entry === 'preset' ? basePreset : null,
    };
    if (entry === 'blank') {
      setDraft({ name: '', description: '', dimensions: [blankDimension()], extras: { yellow_flags: [] }, gate_threshold: 6 });
      setDraftErrors([]);
      setNudge(null);
      setEditingId(null);
      return;
    }
    if (entry === 'preset' && !basePreset) {
      setDraftErrors(['Pick a preset below, or describe your framework instead.']);
      return;
    }
    setDrafting(true);
    setDraftErrors([]);
    try {
      const res = await api.generateRubric(payload);
      const dims = (res.draft.dimensions || []).map(d => ({ ...d, key: d.key || ('q' + Math.random().toString(36).slice(2, 7)) }));
      setDraft({ ...res.draft, dimensions: dims });
      setDraftErrors(res.errors || []);
      setNudge(res.nudge || null);
      setEditingId(null);
    } catch (e) {
      setDraftErrors([e.message || 'The architect is unreachable right now. Try again in a bit.']);
    }
    setDrafting(false);
  }

  function updateDim(i, patch) {
    setDraft(d => ({ ...d, dimensions: d.dimensions.map((dim, j) => j === i ? { ...dim, ...patch } : dim) }));
  }

  function addFlag() {
    const flags = draft.extras?.yellow_flags || [];
    if (flags.length >= 3) return;
    setDraft(d => ({ ...d, extras: { ...(d.extras || {}), yellow_flags: [...flags, { key: '', label: '', blurb: '', dock: 0.5 }] } }));
  }

  function updateFlag(i, patch) {
    setDraft(d => ({
      ...d,
      extras: { ...(d.extras || {}), yellow_flags: (d.extras?.yellow_flags || []).map((f, j) => j === i ? { ...f, ...patch } : f) },
    }));
  }

  async function handleSave() {
    if (!draft.name?.trim()) { setDraftErrors(['Give the framework a name.']); return; }
    setSaving(true);
    setDraftErrors([]);
    try {
      const dimensions = draft.dimensions.map(d => ({
        ...d,
        key: d.key || d.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'q',
        label: d.label || d.question.slice(0, 40),
      }));
      const body = { ...draft, dimensions };
      const res = editingId ? await api.updateRubric(editingId, body) : await api.createRubric(body);
      setNudge(res.nudge || null);
      resetBuilder();
      await load();
    } catch (e) {
      setDraftErrors(e.body?.errors?.length ? e.body.errors : [e.message || 'Could not save.']);
    }
    setSaving(false);
  }

  function startEdit(r) {
    setDraft(JSON.parse(JSON.stringify(r)));
    setDraftErrors([]);
    setNudge(null);
    setEditingId(r.id);
    setEntry('describe');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSetDefault(id) {
    try { await api.setDefaultRubric(id); await load(); }
    catch (e) { alert('Could not set default: ' + e.message); }
  }

  async function handleDuplicate(id) {
    try {
      const { rubric } = await api.duplicateRubric(id);
      await load();
      startEdit(rubric);
    } catch (e) { alert('Could not duplicate: ' + e.message); }
  }

  async function handleDelete(r) {
    if (!confirm(`Delete "${r.name}"? Assessments already scored keep their results.`)) return;
    try { await api.deleteRubric(r.id); await load(); }
    catch (e) { alert('Could not delete: ' + e.message); }
  }

  const step = draft ? 2 : 1;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* ── Library ── */}
      <div className="space-y-4">
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Yours</h3>
          {loading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : customs.length === 0 ? (
            <EmptyNote>None yet — build your first on the right, or duplicate a preset below.</EmptyNote>
          ) : (
            <div className="space-y-2.5">
              {customs.map(r => (
                <div key={r.id} className={`border rounded-lg p-3 ${r.is_default ? 'border-blue-300 bg-blue-50/50' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink truncate">{r.name}</p>
                    {r.is_default && <Tag>default</Tag>}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">{r.dimensions?.length || 0} questions</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                    {!r.is_default && <InlineBtn onClick={() => handleSetDefault(r.id)}>Set as default</InlineBtn>}
                    <InlineBtn onClick={() => startEdit(r)}>Edit</InlineBtn>
                    <InlineBtn muted onClick={() => handleDuplicate(r.id)}>Duplicate</InlineBtn>
                    <InlineBtn danger onClick={() => handleDelete(r)}>Delete</InlineBtn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4">
          <h3 className="text-sm font-semibold text-gray-700">Presets</h3>
          <p className="text-xs text-gray-400 mt-0.5 mb-3">Proven starting points. Use as-is, or duplicate to make one yours.</p>
          <div className="space-y-2.5">
            {presets.map(p => (
              <div key={p.preset_key} className="border border-gray-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-ink">{p.name}</p>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{p.blurb}</p>
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-xs text-gray-400">{p.dimensions?.length || 0} questions</p>
                  <InlineBtn onClick={() => handleDuplicate(p.id)}>Duplicate to edit</InlineBtn>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Builder ── */}
      <div className="lg:col-span-2">
        <div className="card p-5 md:p-6">
          <Steps step={step} editing={!!editingId} />

          {!draft && (
            <>
              <h3 className="text-base font-semibold text-ink mt-5 mb-1">
                {editingId ? 'Edit framework' : 'How do you want to start?'}
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                {editingId
                  ? 'Saving updates future assessments only — past ones keep the yardstick they were scored against.'
                  : 'However you start, you review and edit every question before it becomes a framework.'}
              </p>

              {!editingId && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
                  {ENTRY_CARDS.map(c => (
                    <button
                      key={c.key}
                      onClick={() => { setEntry(c.key); setDraftErrors([]); }}
                      className={`text-left border rounded-xl p-4 transition-colors ${entry === c.key ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <p className={`text-sm font-semibold ${entry === c.key ? 'text-blue-800' : 'text-ink'}`}>{c.title}</p>
                      <p className="text-xs text-gray-500 mt-1 leading-relaxed">{c.blurb}</p>
                    </button>
                  ))}
                </div>
              )}

              {!editingId && entry === 'describe' && (
                <div className="space-y-4 mb-5">
                  <div>
                    <label className="text-sm font-medium text-gray-700 block mb-1.5">What do you assess? Say it like you'd say it to a partner.</label>
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      rows={3}
                      placeholder="e.g. I back technical founders in boring industries. I care more about distribution than product polish, and I won't touch anything that needs a regulatory miracle."
                      className="input w-full text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[
                      ['focus', 'What do you invest in?', 'Stage, sector, founder type…'],
                      ['excitement', 'What gets you excited?', 'The thing that makes you lean in…'],
                      ['deal_killers', 'What kills a deal instantly?', 'Non-negotiables…'],
                    ].map(([k, label, ph]) => (
                      <div key={k}>
                        <label className="text-xs font-medium text-gray-600 block mb-1.5">{label}</label>
                        <textarea value={answers[k]} onChange={e => setAnswers(a => ({ ...a, [k]: e.target.value }))} rows={2} placeholder={ph} className="input w-full text-sm" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!editingId && entry === 'preset' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
                  {presets.map(p => (
                    <button
                      key={p.preset_key}
                      onClick={() => setBasePreset(p.preset_key)}
                      className={`text-left border rounded-xl p-4 transition-colors ${basePreset === p.preset_key ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <p className="text-sm font-semibold text-ink">{p.name}</p>
                      <p className="text-xs text-gray-500 mt-1 leading-relaxed">{p.blurb}</p>
                      <p className="text-xs text-gray-400 mt-1.5">{p.dimensions?.length || 0} questions</p>
                    </button>
                  ))}
                </div>
              )}

              {!editingId && entry === 'blank' && (
                <p className="text-sm text-gray-500 mb-5">Start with one question and add more. The architect won't draft anything — it's all you.</p>
              )}

              <button onClick={handleDraft} disabled={drafting} className="btn-primary text-sm disabled:opacity-50">
                {drafting ? 'Drafting…' : entry === 'blank' ? 'Start building' : 'Draft my framework →'}
              </button>
            </>
          )}

          {/* ── Step 2: the editable draft ── */}
          {draft && (
            <div className="mt-5">
              <h3 className="text-base font-semibold text-ink mb-1">{editingId ? 'Edit the framework' : 'Refine your draft'}</h3>
              <p className="text-sm text-gray-500 mb-5">Every question is scored 1–10 on evidence, or left unscored when the materials can't support a judgment.</p>

              {/* Basics */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">Framework name</label>
                  <input value={draft.name || ''} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Applied AI Pre-seed" className="input w-full text-sm font-medium" />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">What it's for — one line</label>
                  <input value={draft.description || ''} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} placeholder="Who and what this judges." className="input w-full text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">Gate — minimum score on the load-bearing questions</label>
                  <input type="number" min={1} max={10} value={draft.gate_threshold ?? 6} onChange={e => setDraft(d => ({ ...d, gate_threshold: parseInt(e.target.value) || 6 }))} className="input w-full text-sm" />
                </div>
              </div>

              {nudge && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-6">
                  <p className="text-xs text-amber-800 leading-relaxed"><span className="font-medium">Worth considering: </span>{nudge}</p>
                </div>
              )}

              {/* Questions */}
              <div className="flex items-center justify-between mb-1">
                <h4 className="text-sm font-semibold text-ink">The questions <span className="text-gray-400 font-normal">({draft.dimensions.length})</span></h4>
                <button onClick={() => setDraft(d => ({ ...d, dimensions: [...d.dimensions, blankDimension()] }))} className="text-xs text-blue-600 hover:underline font-medium">+ Add a question</button>
              </div>
              <p className="text-xs text-gray-400 mb-4 leading-relaxed">Load-bearing questions <span className="font-medium text-amber-700">set</span> the score. The rest can only move it a point either way.</p>

              <div className="space-y-3">
                {draft.dimensions.map((dim, i) => (
                  <div key={dim.key + i} className={`border rounded-xl p-4 transition-colors ${dim.load_bearing ? 'border-amber-300 bg-amber-50/50' : 'border-gray-200'}`}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ${dim.load_bearing ? 'bg-amber-200 text-amber-800' : 'bg-gray-100 text-gray-500'}`}>{i + 1}</span>
                      <input
                        value={dim.label || ''}
                        onChange={e => updateDim(i, { label: e.target.value })}
                        placeholder="Short label — e.g. Why now"
                        className="input text-sm font-semibold flex-1 !border-0 !bg-transparent !px-0 focus:!ring-0"
                      />
                      <button
                        onClick={() => updateDim(i, { load_bearing: !dim.load_bearing })}
                        title="Load-bearing questions set the score"
                        className={`flex-shrink-0 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${dim.load_bearing ? 'border-amber-400 bg-amber-100 text-amber-800' : 'border-gray-200 text-gray-400 hover:border-amber-300 hover:text-amber-700'}`}
                      >
                        {dim.load_bearing ? '★ Sets the score' : 'Set the score'}
                      </button>
                      <button onClick={() => setDraft(d => ({ ...d, dimensions: d.dimensions.filter((_, j) => j !== i) }))} className="flex-shrink-0 text-gray-300 hover:text-red-500 text-lg leading-none px-1" aria-label="Remove question">×</button>
                    </div>
                    <textarea
                      value={dim.question || ''}
                      onChange={e => updateDim(i, { question: e.target.value })}
                      rows={2}
                      placeholder="The question the agent answers — e.g. What changed in the world that makes now the moment?"
                      className="input w-full text-sm mb-2.5"
                    />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500">Weight</span>
                        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                          {[1, 2, 3, 4, 5].map(w => (
                            <button
                              key={w}
                              onClick={() => updateDim(i, { weight: w })}
                              className={`w-7 h-7 text-xs font-medium transition-colors ${(dim.weight || 3) === w ? 'bg-ink text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                            >{w}</button>
                          ))}
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-gray-500">
                        Evidence needed
                        <select value={dim.min_rung ?? 2} onChange={e => updateDim(i, { min_rung: parseInt(e.target.value) })} className="input text-xs !py-1">
                          {EVIDENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    </div>
                    <details className="mt-2.5">
                      <summary className="text-xs text-blue-600 hover:underline cursor-pointer select-none">Scoring guidance — what good evidence looks like</summary>
                      <textarea
                        value={dim.guidance || ''}
                        onChange={e => updateDim(i, { guidance: e.target.value })}
                        rows={3}
                        placeholder="Tests to ask, what an 8+ looks like, when to abstain instead of guessing."
                        className="input w-full text-xs mt-2"
                      />
                    </details>
                  </div>
                ))}
              </div>

              {/* Yellow flags */}
              <div className="mt-6">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-semibold text-ink">Yellow flags <span className="text-gray-400 font-normal">(up to 3)</span></h4>
                  {(draft.extras?.yellow_flags || []).length < 3 && (
                    <button onClick={addFlag} className="text-xs text-blue-600 hover:underline font-medium">+ Add a flag</button>
                  )}
                </div>
                <p className="text-xs text-gray-400 mb-3">Patterns that dock the score when the evidence is real. Docks, never rewards.</p>
                {(draft.extras?.yellow_flags || []).map((f, i) => (
                  <div key={i} className="flex items-center gap-2 mb-2">
                    <input value={f.label || ''} onChange={e => updateFlag(i, { label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} placeholder="Label — e.g. Hype over substance" className="input text-sm flex-1" />
                    <input value={f.blurb || ''} onChange={e => updateFlag(i, { blurb: e.target.value })} placeholder="What it looks like" className="input text-sm flex-[2]" />
                    <select value={f.dock ?? 0.5} onChange={e => updateFlag(i, { dock: parseFloat(e.target.value) })} className="input text-sm !w-auto" title="How much it docks">
                      <option value={0.25}>−0.25</option>
                      <option value={0.5}>−0.5</option>
                      <option value={1}>−1</option>
                    </select>
                    <button onClick={() => setDraft(d => ({ ...d, extras: { ...(d.extras || {}), yellow_flags: (d.extras?.yellow_flags || []).filter((_, j) => j !== i) } }))} className="text-gray-300 hover:text-red-500 text-lg leading-none px-1" aria-label="Remove flag">×</button>
                  </div>
                ))}
              </div>

              {draftErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 mt-4">
                  {draftErrors.map((e, i) => <p key={i} className="text-xs text-red-700 leading-relaxed">{e}</p>)}
                </div>
              )}

              {/* Sticky save bar */}
              <div className="sticky bottom-0 -mx-5 md:-mx-6 mt-6 px-5 md:px-6 py-3 bg-white/95 backdrop-blur border-t border-gray-100 flex items-center gap-3">
                <button onClick={handleSave} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save framework'}
                </button>
                <button onClick={resetBuilder} className="text-sm text-gray-500 hover:text-gray-700">Start over</button>
                <span className="text-xs text-gray-400 ml-auto hidden md:inline">Past assessments keep the yardstick they were scored against.</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ step, editing }) {
  const items = editing ? ['Edit', 'Save'] : ['Start', 'Refine & save'];
  const labels = editing ? step : step;
  return (
    <div className="flex items-center gap-2 mb-1">
      {items.map((label, i) => {
        const n = i + 1;
        const active = labels === n;
        const done = labels > n;
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <span className="w-6 h-px bg-gray-200" />}
            <span className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ${active ? 'bg-ink text-white' : done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>{done ? '✓' : n}</span>
            <span className={`text-xs font-medium ${active ? 'text-ink' : 'text-gray-400'}`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function InlineBtn({ children, onClick, muted, danger }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs hover:underline ${danger ? 'text-gray-400 hover:text-red-500' : muted ? 'text-gray-500' : 'text-blue-600'}`}
    >{children}</button>
  );
}

function EmptyNote({ children }) {
  return <p className="text-sm text-gray-400 leading-relaxed">{children}</p>;
}
