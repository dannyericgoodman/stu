import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Tag } from './ui';

const EVIDENCE_OPTIONS = [
  { value: 1, label: 'Website / public record' },
  { value: 2, label: 'Deck / founder materials' },
  { value: 3, label: 'Met the founder' },
  { value: 4, label: 'Multiple conversations' },
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
  const presetByKey = Object.fromEntries(presets.map(p => [p.preset_key, p]));

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
      setDraftErrors(['Pick a preset to start from, or describe your framework instead.']);
      return;
    }
    setDrafting(true);
    setDraftErrors([]);
    try {
      const res = await api.generateRubric(payload);
      // Give every dimension a stable local key for editing.
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
      // Derive slugs from labels where the drafter left keys blank.
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
      // Validation failures come back as { errors: [...] } on the error body.
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

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left: the library ── */}
        <div className="space-y-4">
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Your frameworks</h3>
            {loading ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : customs.length === 0 ? (
              <p className="text-sm text-gray-400">None yet. Build your first on the right — or duplicate a preset below.</p>
            ) : (
              <div className="space-y-3">
                {customs.map(r => (
                  <div key={r.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{r.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{r.dimensions?.length || 0} questions{r.is_default ? ' · default' : ''}</p>
                      </div>
                      {r.is_default && <Tag>default</Tag>}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {!r.is_default && (
                        <button onClick={() => handleSetDefault(r.id)} className="text-xs text-blue-600 hover:underline">Set as default</button>
                      )}
                      <button onClick={() => startEdit(r)} className="text-xs text-blue-600 hover:underline">Edit</button>
                      <button onClick={() => handleDuplicate(r.id)} className="text-xs text-gray-500 hover:underline">Duplicate</button>
                      <button onClick={() => handleDelete(r)} className="text-xs text-gray-400 hover:text-red-500">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Starting points</h3>
            <p className="text-xs text-gray-400 mb-3">Four presets, ready to use as-is. Duplicate one to make it yours.</p>
            <div className="space-y-3">
              {presets.map(p => (
                <div key={p.preset_key} className="border border-gray-200 rounded-lg p-3">
                  <p className="text-sm font-semibold text-ink">{p.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{p.blurb}</p>
                  <p className="text-xs text-gray-400 mt-1">{p.dimensions?.length || 0} questions</p>
                  <button onClick={() => handleDuplicate(p.id)} className="text-xs text-blue-600 hover:underline mt-1.5">Duplicate to edit</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: the architect ── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">{editingId ? 'Edit framework' : 'Build a framework'}</h3>
            <p className="text-xs text-gray-400 mb-4">
              {editingId
                ? 'Change the questions, the weights, what counts as evidence. Saving updates future assessments only — past ones keep the yardstick they were scored against.'
                : 'Three ways in. However you start, you review and edit every question before it becomes a framework.'}
            </p>

            {!editingId && (
              <div className="flex gap-2 mb-5">
                {[
                  ['describe', 'Describe it'],
                  ['preset', 'Start from a preset'],
                  ['blank', 'Start blank'],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => { setEntry(k); setDraft(null); setDraftErrors([]); }}
                    className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${entry === k ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                  >{label}</button>
                ))}
              </div>
            )}

            {!draft && !editingId && entry === 'describe' && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">What do you assess? Say it like you'd say it to a partner.</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={3}
                    placeholder="e.g. I back technical founders in boring industries. I care more about distribution than product polish, and I won't touch anything that needs a regulatory miracle."
                    className="input w-full text-sm"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">What do you invest in?</label>
                    <textarea value={answers.focus} onChange={e => setAnswers(a => ({ ...a, focus: e.target.value }))} rows={2} placeholder="Stage, sector, founder type…" className="input w-full text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">What gets you excited?</label>
                    <textarea value={answers.excitement} onChange={e => setAnswers(a => ({ ...a, excitement: e.target.value }))} rows={2} placeholder="The thing that makes you lean in…" className="input w-full text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">What kills a deal instantly?</label>
                    <textarea value={answers.deal_killers} onChange={e => setAnswers(a => ({ ...a, deal_killers: e.target.value }))} rows={2} placeholder="Non-negotiables…" className="input w-full text-sm" />
                  </div>
                </div>
              </div>
            )}

            {!draft && !editingId && entry === 'preset' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {presets.map(p => (
                  <button
                    key={p.preset_key}
                    onClick={() => setBasePreset(p.preset_key)}
                    className={`text-left border rounded-lg p-3 transition-colors ${basePreset === p.preset_key ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <p className="text-sm font-semibold text-ink">{p.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{p.blurb}</p>
                  </button>
                ))}
              </div>
            )}

            {!draft && !editingId && entry === 'blank' && (
              <p className="text-sm text-gray-500">Start with one question and add more. The architect won't draft anything — it's all you.</p>
            )}

            {!draft && (
              <button onClick={handleDraft} disabled={drafting} className="btn-primary text-sm mt-5 disabled:opacity-50">
                {drafting ? 'Drafting…' : entry === 'blank' ? 'Start building' : 'Draft my framework'}
              </button>
            )}
          </div>

          {/* ── The editable draft ── */}
          {draft && (
            <div className="card p-5 space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">{editingId ? 'Your framework' : 'Your draft — edit everything'}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">Name</label>
                    <input value={draft.name || ''} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Deep Tech Pre-seed" className="input w-full text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">Gate — minimum on the load-bearing questions to clear (1-10)</label>
                    <input type="number" min={1} max={10} value={draft.gate_threshold ?? 6} onChange={e => setDraft(d => ({ ...d, gate_threshold: parseInt(e.target.value) || 6 }))} className="input w-full text-sm" />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">What this framework is for (one line)</label>
                  <input value={draft.description || ''} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} placeholder="Who and what this judges." className="input w-full text-sm" />
                </div>
              </div>

              {nudge && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <p className="text-xs text-amber-800 leading-relaxed"><span className="font-medium">Worth considering: </span>{nudge}</p>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">The questions ({draft.dimensions.length})</h4>
                  <button onClick={() => setDraft(d => ({ ...d, dimensions: [...d.dimensions, blankDimension()] }))} className="text-xs text-blue-600 hover:underline">+ Add a question</button>
                </div>
                <p className="text-xs text-gray-400 mb-4 leading-relaxed">Each question is scored 1-10 on evidence, or left unscored when the materials can't support a judgment. The load-bearing ones <em>set</em> the score; the rest can only move it a point.</p>
                <div className="space-y-4">
                  {draft.dimensions.map((dim, i) => (
                    <div key={dim.key + i} className={`border rounded-lg p-4 ${dim.load_bearing ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <input
                          value={dim.label || ''}
                          onChange={e => updateDim(i, { label: e.target.value })}
                          placeholder="Short label — e.g. Why now"
                          className="input text-sm font-medium flex-1"
                        />
                        <button onClick={() => setDraft(d => ({ ...d, dimensions: d.dimensions.filter((_, j) => j !== i) }))} className="text-xs text-gray-400 hover:text-red-500 mt-2">remove</button>
                      </div>
                      <label className="text-xs font-medium text-gray-600 block mb-1.5">The question the agent answers</label>
                      <textarea value={dim.question || ''} onChange={e => updateDim(i, { question: e.target.value })} rows={2} placeholder="What exactly should the agent try to answer from the materials?" className="input w-full text-sm mb-3" />
                      <label className="text-xs font-medium text-gray-600 block mb-1.5">Guidance — what good evidence looks like</label>
                      <textarea value={dim.guidance || ''} onChange={e => updateDim(i, { guidance: e.target.value })} rows={2} placeholder="e.g. Look for specific customer names and timelines, not adjectives." className="input w-full text-sm mb-3" />
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                        <div>
                          <label className="text-xs font-medium text-gray-600 block mb-1.5">Weight (1-5)</label>
                          <select value={dim.weight || 3} onChange={e => updateDim(i, { weight: parseInt(e.target.value) })} className="input w-full text-sm">
                            {[1, 2, 3, 4, 5].map(w => <option key={w} value={w}>{w}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-gray-600 block mb-1.5">Don't score below</label>
                          <select value={dim.min_rung ?? 2} onChange={e => updateDim(i, { min_rung: parseInt(e.target.value) })} className="input w-full text-sm">
                            {EVIDENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer pb-2">
                          <input type="checkbox" checked={!!dim.load_bearing} onChange={e => updateDim(i, { load_bearing: e.target.checked })} className="w-4 h-4 accent-amber-500" />
                          Load-bearing <span className="text-gray-400">(sets the score)</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Yellow flags (up to 3)</h4>
                  <button onClick={addFlag} className="text-xs text-blue-600 hover:underline">+ Add a flag</button>
                </div>
                <p className="text-xs text-gray-400 mb-3">Patterns that dock the score when the evidence is real. Docks, never rewards.</p>
                {(draft.extras?.yellow_flags || []).map((f, i) => (
                  <div key={i} className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
                    <input value={f.label || ''} onChange={e => updateFlag(i, { label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_') })} placeholder="Label — e.g. Hype over substance" className="input text-sm" />
                    <input value={f.blurb || ''} onChange={e => updateFlag(i, { blurb: e.target.value })} placeholder="What it looks like" className="input text-sm md:col-span-2" />
                    <div className="flex items-center gap-2">
                      <select value={f.dock ?? 0.5} onChange={e => updateFlag(i, { dock: parseFloat(e.target.value) })} className="input text-sm flex-1">
                        <option value={0.25}>−0.25</option>
                        <option value={0.5}>−0.5</option>
                        <option value={1}>−1</option>
                      </select>
                      <button onClick={() => setDraft(d => ({ ...d, extras: { ...(d.extras || {}), yellow_flags: (d.extras?.yellow_flags || []).filter((_, j) => j !== i) } }))} className="text-xs text-gray-400 hover:text-red-500">remove</button>
                    </div>
                  </div>
                ))}
              </div>

              {draftErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                  {draftErrors.map((e, i) => <p key={i} className="text-xs text-red-700 leading-relaxed">{e}</p>)}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={handleSave} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save framework'}
                </button>
                <button onClick={resetBuilder} className="text-sm text-gray-500 hover:text-gray-700 px-3">Start over</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
