import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

// The default five pipeline stages, matching server/lib/ledgerStages.js.
// Served from the server on every load (GET /api/settings returns pipeline_stages);
// this copy is only the reset target and the first-run fallback.
const DEFAULT_PIPELINE_STAGES = [
  { id: 'identified', label: 'Stage 1: Identified', subtitle: 'Fresh arrivals — from the inbox or + New. Worth a look?', is_entry: true, is_pass: false },
  { id: 'outreach', label: 'Stage 2: Outreach Sent', subtitle: 'You reached out. Waiting to hear back.', is_entry: false, is_pass: false },
  { id: 'meeting', label: 'Stage 3: Meeting Set', subtitle: 'Talking or just talked — decide what happens next.', is_entry: false, is_pass: false },
  { id: 'invest_pipeline', label: 'Stage 4a: Investment Pipeline', subtitle: 'The keepers — you add these to Airtable yourself.', is_entry: false, is_pass: false },
  { id: 'pass', label: 'Stage 4b: Pass', subtitle: 'Not for us. Kept as a record, not a maybe.', is_entry: false, is_pass: false },
];

const STAGE_OPTIONS = ['Pre-seed', 'Seed', 'Series A', 'Any'];

// --- Reusable Components ---

function SaveButton({ onClick, saving, saved }) {
  return (
    <div className="flex items-center gap-3">
      <button onClick={onClick} disabled={saving} className="btn-primary">
        {saving ? 'Saving...' : 'Save'}
      </button>
      {saved && <span className="text-sm text-emerald-600 font-medium animate-fade-in">Saved</span>}
    </div>
  );
}

function TagInput({ tags, onAdd, onRemove, placeholder }) {
  const [value, setValue] = useState('');

  function handleKeyDown(e) {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      const trimmed = value.trim();
      if (!tags.includes(trimmed)) {
        onAdd(trimmed);
      }
      setValue('');
    }
    if (e.key === 'Backspace' && !value && tags.length > 0) {
      onRemove(tags.length - 1);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 p-2 min-h-[42px] bg-white border border-gray-200 rounded-lg focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 transition-all">
      {tags.map((tag, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-sm rounded-md">
          {tag}
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="text-gray-400 hover:text-gray-600 ml-0.5"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? placeholder : 'Add...'}
        className="flex-1 min-w-[120px] text-sm text-gray-900 placeholder-gray-400 outline-none bg-transparent py-1 px-1"
      />
    </div>
  );
}


function CustomQueryRow({ query, index, onChange, onDelete }) {
  return (
    <div className="flex items-start gap-2 group">
      <div className="flex-1 space-y-2">
        <input
          type="text"
          value={query.name}
          onChange={(e) => onChange(index, 'name', e.target.value)}
          className="input w-full"
          placeholder="Query name (e.g., Chicago AI founders)"
        />
        <textarea
          value={query.query}
          onChange={(e) => onChange(index, 'query', e.target.value)}
          className="input w-full resize-none"
          rows={2}
          placeholder="Search query for Exa AI..."
        />
      </div>
      <button
        type="button"
        onClick={() => onDelete(index)}
        className="text-gray-300 hover:text-red-500 transition-colors p-1 mt-2 opacity-0 group-hover:opacity-100"
        title="Remove query"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
      </button>
    </div>
  );
}

// --- Hook for save state ---

function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const doSave = useCallback(async (fn) => {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await fn();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, saved, error, doSave, setError };
}

// --- Main Settings Page ---

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('pipeline');
  const [loadError, setLoadError] = useState('');

  // Pipeline state — the user's own stages for the loading-dock board.
  // Canonical shape: { id, label, subtitle, is_entry, is_pass }.
  const [pipelineStages, setPipelineStages] = useState([]);
  const [stageCounts, setStageCounts] = useState({});
  const pipelineSave = useSaveState();

  // Sourcing state
  const [locations, setLocations] = useState([]);
  const [schools, setSchools] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [builderSignals, setBuilderSignals] = useState([]);
  const [domains, setDomains] = useState([]);
  const [stageFilter, setStageFilter] = useState('Pre-seed');
  const [fundName, setFundName] = useState(''); // profile_fund_name — feeds Stu AI's identity
  const [customQueries, setCustomQueries] = useState([]);
  const sourcingSave = useSaveState();
  const profileSave = useSaveState();

  // API Keys state
  const [apiKeyExa, setApiKeyExa] = useState('');
  const [apiKeyAnthropic, setApiKeyAnthropic] = useState('');
  const [anthropicTest, setAnthropicTest] = useState(null);
  const [apiKeyEnrichlayer, setApiKeyEnrichlayer] = useState('');
  const [apiKeyGithub, setApiKeyGithub] = useState('');
  const [keysConfigured, setKeysConfigured] = useState({});
  const apiKeysSave = useSaveState();

  useEffect(() => {
    async function load() {
      try {
        const settings = await api.getSettings();
        setPipelineStages(settings.pipeline_stages || DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })));
        setLocations(settings.sourcing_locations || []);
        setSchools(settings.sourcing_schools || []);
        setCompanies(settings.sourcing_companies || []);
        setBuilderSignals(settings.sourcing_builder_signals || []);
        setDomains(settings.sourcing_domains || []);
        setStageFilter(settings.sourcing_stage_filter || 'Pre-seed');
        setCustomQueries(settings.sourcing_custom_queries || []);
        // Secret keys come back as { configured: true } (or null) — never the value.
        // Keep inputs empty (an empty field means "leave the saved key as-is") and track
        // which are already configured so we can show a "saved" hint.
        const asStr = (v) => (typeof v === 'string' ? v : '');
        const isSet = (v) => (typeof v === 'string' ? !!v : !!(v && v.configured));
        setApiKeyExa(asStr(settings.api_key_exa));
        setApiKeyAnthropic(asStr(settings.api_key_anthropic));
        setApiKeyEnrichlayer(asStr(settings.api_key_enrichlayer));
        setApiKeyGithub(asStr(settings.api_key_github));
        setKeysConfigured({
          exa: isSet(settings.api_key_exa),
          anthropic: isSet(settings.api_key_anthropic),
          enrichlayer: isSet(settings.api_key_enrichlayer),
          github: isSet(settings.api_key_github),
        });
        setFundName(settings.profile_fund_name || '');
        // Per-stage card counts, so the editor can block deleting a stage that
        // still holds cards. Read-only; failure here just disables the guard.
        try {
          const { counts } = await api.getStageCounts();
          setStageCounts(counts || {});
        } catch { /* leave the guard empty */ }
      } catch (err) {
        setLoadError(err.message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Pipeline stage handlers
  function updatePipelineStage(index, field, value) {
    setPipelineStages(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }

  function movePipelineStage(index, direction) {
    setPipelineStages(prev => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setPipelineFlag(index, flag) {
    // Exactly one entry stage and one pass stage — setting one unsets the rest.
    setPipelineStages(prev => prev.map((s, i) => ({ ...s, [flag]: i === index })));
  }

  async function deletePipelineStage(index) {
    const stage = pipelineStages[index];
    if (!stage) return;
    // Refresh counts at delete time so the guard can't go stale.
    let counts = stageCounts;
    try {
      const r = await api.getStageCounts();
      counts = r.counts || {};
      setStageCounts(counts);
    } catch { /* fall back to the loaded counts */ }
    const n = counts[stage.id] || 0;
    if (n > 0) {
      pipelineSave.setError(`Can't delete "${stage.label}" — it has ${n} card${n === 1 ? '' : 's'} on the board. Move them first.`);
      return;
    }
    setPipelineStages(prev => {
      let next = prev.filter((_, i) => i !== index).map((s) => ({ ...s }));
      // If the deleted stage was entry/pass, the first (entry) / last (pass)
      // remaining stage takes over so the flags are never empty.
      if (next.length > 0) {
        if (stage.is_entry && !next.some((s) => s.is_entry)) next[0].is_entry = true;
        if (stage.is_pass && !next.some((s) => s.is_pass)) next[next.length - 1].is_pass = true;
      }
      return next;
    });
  }

  function addPipelineStage() {
    setPipelineStages(prev => [...prev, {
      id: `custom-${Date.now().toString(36)}`,
      label: '',
      subtitle: '',
      is_entry: false,
      is_pass: false,
    }]);
  }

  function resetPipeline() {
    setPipelineStages(DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })));
  }

  async function savePipeline() {
    await pipelineSave.doSave(async () => {
      // Every stage needs an id and a label — the server normalizes and drops
      // anything unusable, so validate here to say what's wrong instead.
      const stages = pipelineStages.map((s) => ({
        id: String(s.id || '').trim(),
        label: String(s.label || '').trim(),
        subtitle: String(s.subtitle || ''),
        is_entry: !!s.is_entry,
        is_pass: !!s.is_pass,
      }));
      const ids = stages.map((s) => s.id);
      if (stages.length === 0) throw new Error('You need at least one stage.');
      if (stages.some((s) => !s.id || !s.label)) throw new Error('Every stage needs a name.');
      if (new Set(ids).size !== ids.length) throw new Error('Stage ids must be unique.');
      await api.updateSetting('pipeline_stages', stages);
      // Saved — the in-memory copy is now what's on disk.
      setPipelineStages(stages);
    });
  }

  // Sourcing handlers
  function addTag(setter) {
    return (tag) => setter(prev => [...prev, tag]);
  }

  function removeTag(setter) {
    return (index) => setter(prev => prev.filter((_, i) => i !== index));
  }

  function updateQuery(index, field, value) {
    setCustomQueries(prev => prev.map((q, i) => i === index ? { ...q, [field]: value } : q));
  }

  function deleteQuery(index) {
    setCustomQueries(prev => prev.filter((_, i) => i !== index));
  }

  function addQuery() {
    setCustomQueries(prev => [...prev, { name: '', query: '' }]);
  }

  async function saveSourcing() {
    await sourcingSave.doSave(async () => {
      await Promise.all([
        api.updateSetting('sourcing_locations', locations),
        api.updateSetting('sourcing_schools', schools),
        api.updateSetting('sourcing_companies', companies),
        api.updateSetting('sourcing_builder_signals', builderSignals),
        api.updateSetting('sourcing_domains', domains),
        api.updateSetting('sourcing_stage_filter', stageFilter),
        api.updateSetting('sourcing_custom_queries', customQueries),
      ]);
    });
  }

  async function saveProfile() {
    await profileSave.doSave(async () => {
      await api.updateSetting('profile_fund_name', fundName.trim());
    });
  }

  async function saveApiKeys() {
    await apiKeysSave.doSave(async () => {
      // Only update a key the user actually typed — an empty field keeps the saved key
      // (we never receive it back, so blank must NOT overwrite it).
      const puts = [];
      if (apiKeyExa.trim()) puts.push(api.updateSetting('api_key_exa', apiKeyExa.trim()));
      if (apiKeyAnthropic.trim()) puts.push(api.updateSetting('api_key_anthropic', apiKeyAnthropic.trim()));
      if (apiKeyEnrichlayer.trim()) puts.push(api.updateSetting('api_key_enrichlayer', apiKeyEnrichlayer.trim()));
      if (apiKeyGithub.trim()) puts.push(api.updateSetting('api_key_github', apiKeyGithub.trim()));
      await Promise.all(puts);
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-gray-500">Loading settings...</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-red-600">{loadError}</div>
      </div>
    );
  }

  const tabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'pipeline', label: 'Pipeline Stages' },
    { id: 'sourcing', label: 'Sourcing Criteria' },
    { id: 'apikeys', label: 'API Keys' },
    { id: 'mcp', label: 'API & MCP Access' },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your pipeline stages and sourcing criteria.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.id
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Pipeline Tab — the user's own board stages */}
      {activeTab === 'pipeline' && (
        <div className="space-y-6">
          <div className="card p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Pipeline stages</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                The columns on your Pipeline board. Rename them, reorder them, add your own —
                they stay yours. One stage takes new cards, one stage records a pass.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mb-5">
              <div>
                <label className="label">New cards start in</label>
                <select
                  className="select w-full"
                  value={(pipelineStages.findIndex((s) => s.is_entry) + 1) || 1}
                  onChange={(e) => setPipelineFlag(Number(e.target.value) - 1, 'is_entry')}
                >
                  {pipelineStages.map((s, i) => (
                    <option key={s.id} value={i + 1}>{s.label || `Stage ${i + 1}`}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Pass stage</label>
                <select
                  className="select w-full"
                  value={(pipelineStages.findIndex((s) => s.is_pass) + 1) || 1}
                  onChange={(e) => setPipelineFlag(Number(e.target.value) - 1, 'is_pass')}
                >
                  {pipelineStages.map((s, i) => (
                    <option key={s.id} value={i + 1}>{s.label || `Stage ${i + 1}`}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              {pipelineStages.map((stage, i) => (
                <div key={stage.id} className="flex items-center gap-2 group">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => movePipelineStage(i, -1)}
                      disabled={i === 0}
                      className="text-gray-300 hover:text-gray-500 disabled:opacity-30 disabled:cursor-default p-0.5"
                      title="Move up"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => movePipelineStage(i, 1)}
                      disabled={i === pipelineStages.length - 1}
                      className="text-gray-300 hover:text-gray-500 disabled:opacity-30 disabled:cursor-default p-0.5"
                      title="Move down"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>
                  <span className="text-xs text-gray-400 w-5 text-right tabular-nums">{i + 1}</span>
                  <div className="flex-1 min-w-0 space-y-1">
                    <input
                      type="text"
                      value={stage.label}
                      onChange={(e) => updatePipelineStage(i, 'label', e.target.value)}
                      className="input w-full"
                      placeholder="Stage name"
                    />
                    <input
                      type="text"
                      value={stage.subtitle}
                      onChange={(e) => updatePipelineStage(i, 'subtitle', e.target.value)}
                      className="input w-full text-xs text-gray-500"
                      placeholder="What this stage means (shows under the column)"
                    />
                  </div>
                  <div className="flex items-center gap-1 flex-none">
                    {stage.is_entry && <span className="badge bg-blue-50 text-blue-700 text-[10px]">entry</span>}
                    {stage.is_pass && <span className="badge bg-gray-100 text-gray-600 text-[10px]">pass</span>}
                    {(stageCounts[stage.id] || 0) > 0 && (
                      <span className="text-[10px] text-gray-400 tabular-nums" title="Cards on the board">
                        {stageCounts[stage.id]} on board
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => deletePipelineStage(i)}
                      className="text-gray-300 hover:text-red-500 transition-colors p-1 opacity-0 group-hover:opacity-100"
                      title="Remove stage"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addPipelineStage}
              className="btn-ghost mt-3 text-xs"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add stage
            </button>
          </div>

          {/* Pipeline Actions */}
          <div className="flex items-center justify-between">
            <SaveButton onClick={savePipeline} saving={pipelineSave.saving} saved={pipelineSave.saved} />
            <button type="button" onClick={resetPipeline} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              Reset to defaults
            </button>
          </div>
          {pipelineSave.error && (
            <p className="text-sm text-red-600 mt-2">{pipelineSave.error}</p>
          )}
        </div>
      )}
      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="space-y-6">
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-gray-900">Profile</h2>
            <p className="text-xs text-gray-500 mt-0.5 mb-4">
              Stu AI introduces itself with your fund's name. Leave blank for a neutral investor identity.
            </p>
            <label className="label">Fund / firm name</label>
            <input
              type="text"
              value={fundName}
              onChange={(e) => setFundName(e.target.value)}
              placeholder="e.g. Acme Ventures"
              className="input w-full max-w-sm"
            />
            <div className="mt-4">
              <SaveButton onClick={saveProfile} saving={profileSave.saving} saved={profileSave.saved} />
            </div>
          </div>
        </div>
      )}

      {/* Sourcing Tab */}
      {activeTab === 'sourcing' && (
        <div className="space-y-6">
          {/* Target Locations */}
          <div className="card p-6">
            <label className="label">Target Locations</label>
            <p className="text-xs text-gray-400 mb-2">Geographic areas where you source founders. Press Enter to add.</p>
            <TagInput tags={locations} onAdd={addTag(setLocations)} onRemove={removeTag(setLocations)} placeholder="e.g., Chicago, San Francisco, Austin" />
          </div>

          {/* Target Schools */}
          <div className="card p-6">
            <label className="label">Target Schools</label>
            <p className="text-xs text-gray-400 mb-2">Schools that signal pedigree in your sourcing criteria.</p>
            <TagInput tags={schools} onAdd={addTag(setSchools)} onRemove={removeTag(setSchools)} placeholder="e.g., Northwestern, University of Chicago" />
          </div>

          {/* Target Companies */}
          <div className="card p-6">
            <label className="label">Target Companies</label>
            <p className="text-xs text-gray-400 mb-2">Companies whose alumni you want to track (ex-Google, ex-Stripe, etc).</p>
            <TagInput tags={companies} onAdd={addTag(setCompanies)} onRemove={removeTag(setCompanies)} placeholder="e.g., Google, Stripe, OpenAI" />
          </div>

          {/* Builder Signals */}
          <div className="card p-6">
            <label className="label">Builder Signals</label>
            <p className="text-xs text-gray-400 mb-2">Signals that indicate strong founder potential.</p>
            <TagInput tags={builderSignals} onAdd={addTag(setBuilderSignals)} onRemove={removeTag(setBuilderSignals)} placeholder="e.g., YC Alum, Previous Exit, Serial Founder" />
          </div>

          {/* Focus Domains */}
          <div className="card p-6">
            <label className="label">Focus Domains</label>
            <p className="text-xs text-gray-400 mb-2">Industry verticals you invest in.</p>
            <TagInput tags={domains} onAdd={addTag(setDomains)} onRemove={removeTag(setDomains)} placeholder="e.g., AI/ML, Fintech, Health Tech" />
          </div>

          {/* Stage Filter */}
          <div className="card p-6">
            <label className="label">Stage Filter</label>
            <p className="text-xs text-gray-400 mb-2">Preferred funding stage for sourcing.</p>
            <select
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
              className="select w-48"
            >
              {STAGE_OPTIONS.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>

          {/* Custom Search Queries */}
          <div className="card p-6">
            <div className="mb-3">
              <label className="label">Custom Search Queries</label>
              <p className="text-xs text-gray-400">Advanced Exa AI queries for specialized sourcing.</p>
            </div>
            {customQueries.length > 0 && (
              <div className="space-y-3 mb-3">
                {customQueries.map((q, i) => (
                  <CustomQueryRow
                    key={i}
                    query={q}
                    index={i}
                    onChange={updateQuery}
                    onDelete={deleteQuery}
                  />
                ))}
              </div>
            )}
            <button type="button" onClick={addQuery} className="btn-ghost text-xs">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add query
            </button>
          </div>

          {/* Sourcing Actions */}
          <div className="flex items-center">
            <SaveButton onClick={saveSourcing} saving={sourcingSave.saving} saved={sourcingSave.saved} />
          </div>
          {sourcingSave.error && (
            <p className="text-sm text-red-600 mt-2">{sourcingSave.error}</p>
          )}
        </div>
      )}

      {/* API Keys Tab */}
      {activeTab === 'apikeys' && (
        <div className="space-y-6">
          <div className="card p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-900">API Integrations</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Provide your own API keys to power sourcing, scoring, and enrichment. Keys are stored securely and never shared.
              </p>
            </div>

            <div className="space-y-5">
              {/* Exa */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="label mb-0">Exa API Key</label>
                  <span className="text-[10px] font-medium text-red-500 bg-red-50 px-1.5 py-0.5 rounded">Required</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Powers founder discovery and web search.{' '}
                  <a href="https://exa.ai" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600">
                    Get a key →
                  </a>
                </p>
                <input
                  type="password"
                  value={apiKeyExa}
                  onChange={(e) => setApiKeyExa(e.target.value)}
                  className="input w-full"
                  placeholder={keysConfigured.exa ? 'Saved ✓ — leave blank to keep' : 'exa-...'}
                  autoComplete="off"
                />
              </div>

              {/* Anthropic */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="label mb-0">Anthropic API Key</label>
                  <span className="text-[10px] font-medium text-red-500 bg-red-50 px-1.5 py-0.5 rounded">Required</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Powers AI scoring, assessments, and Ask Stu.{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600">
                    Get a key →
                  </a>
                </p>
                <input
                  type="password"
                  value={apiKeyAnthropic}
                  onChange={(e) => setApiKeyAnthropic(e.target.value)}
                  className="input w-full"
                  placeholder={keysConfigured.anthropic ? 'Saved ✓ — leave blank to keep' : 'sk-ant-...'}
                  autoComplete="off"
                />
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      setAnthropicTest({ loading: true });
                      try { setAnthropicTest(await api.testAnthropic()); }
                      catch (e) { setAnthropicTest({ ok: false, message: e.message }); }
                    }}
                    disabled={anthropicTest?.loading}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >
                    {anthropicTest?.loading ? 'Testing…' : 'Test connection'}
                  </button>
                  <span className="text-xs text-gray-400">Save first, then test the key the app actually uses.</span>
                </div>
                {anthropicTest && !anthropicTest.loading && (
                  <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${anthropicTest.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                    <span className="font-semibold">{anthropicTest.ok ? '✓ Connected' : '✗ Not working'}</span>
                    <span className="ml-1 text-gray-600">{anthropicTest.message}</span>
                    {anthropicTest.source && <span className="block text-[10px] text-gray-400 mt-0.5">Tested: {anthropicTest.source}</span>}
                  </div>
                )}
              </div>

              {/* EnrichLayer */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="label mb-0">EnrichLayer API Key</label>
                  <span className="text-[10px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">Optional</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Enriches founder profiles with email, company, and social data.{' '}
                  <a href="https://enrichlayer.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600">
                    Get a key →
                  </a>
                </p>
                <input
                  type="password"
                  value={apiKeyEnrichlayer}
                  onChange={(e) => setApiKeyEnrichlayer(e.target.value)}
                  className="input w-full"
                  placeholder={keysConfigured.enrichlayer ? 'Saved ✓ — leave blank to keep' : 'el-...'}
                  autoComplete="off"
                />
              </div>

              {/* GitHub */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="label mb-0">GitHub Token</label>
                  <span className="text-[10px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">Optional</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Increases GitHub API rate limits for builder signal detection.{' '}
                  <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600">
                    Create a token →
                  </a>
                </p>
                <input
                  type="password"
                  value={apiKeyGithub}
                  onChange={(e) => setApiKeyGithub(e.target.value)}
                  className="input w-full"
                  placeholder={keysConfigured.github ? 'Saved ✓ — leave blank to keep' : 'ghp_...'}
                  autoComplete="off"
                />
              </div>
            </div>
          </div>

          {/* Info callout */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex gap-3">
            <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-blue-900">Why do I need my own keys?</p>
              <p className="text-xs text-blue-700 mt-1 leading-relaxed">
                Sourcing, scoring, and enrichment use external APIs that bill by usage. By providing your own keys, you control costs and get direct access to your usage dashboards. Exa and Anthropic are required to run the sourcing engine.
              </p>
            </div>
          </div>

          {/* API Keys Actions */}
          <div className="flex items-center">
            <SaveButton onClick={saveApiKeys} saving={apiKeysSave.saving} saved={apiKeysSave.saved} />
          </div>
          {apiKeysSave.error && (
            <p className="text-sm text-red-600 mt-2">{apiKeysSave.error}</p>
          )}
        </div>
      )}

      {activeTab === 'mcp' && <McpAccessTab />}
    </div>
  );
}

// ── API & MCP Access tab ──
// Lets a user connect their own agent (Claude Desktop, Cursor, scripts) to Stu's
// Talent/Sourcing tools. Usage runs on the user's own keys.
function McpAccessTab() {
  const [info, setInfo] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [i, t] = await Promise.all([api.getMcpInfo(), api.getMcpTokens()]);
      setInfo(i); setTokens(t);
    } catch (e) { setErr(e.message || 'Failed to load'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setErr(''); setNewToken(null);
    try {
      const t = await api.createMcpToken(label || 'My agent');
      setNewToken(t.token); setLabel('');
      await load();
    } catch (e) { setErr(e.message || 'Failed to create token'); }
    finally { setBusy(false); }
  };
  const revoke = async (id) => {
    try { await api.revokeMcpToken(id); await load(); } catch (e) { setErr(e.message); }
  };
  const copy = (text) => {
    try { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <div className="space-y-6">
      {/* What this is */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-gray-900">Connect your agent to Stu</h2>
        <p className="text-sm text-gray-600 mt-2 leading-relaxed">
          Connect Claude Desktop, Cursor, or any MCP client to
          search your Talent candidates and sourced founders, filter by builder signals
          (e.g. <span className="font-mono text-xs bg-gray-100 px-1 rounded">just_departed</span>),
          and read your monitor alerts — straight from your own agent.
        </p>
        <div className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">MCP endpoint</p>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs text-gray-900 break-all">{info?.mcpUrl || '…'}</code>
              {info?.mcpUrl && (
                <button onClick={() => copy(info.mcpUrl)} className="text-xs text-blue-600 hover:underline flex-shrink-0">copy</button>
              )}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your keys, your cost</p>
            <p className="text-xs text-gray-600 mt-1">
              Search is free. Sourcing/AI run on the keys you add in the API Keys tab —
              {info?.byok?.anthropic_configured
                ? <span className="text-green-600"> Anthropic key detected.</span>
                : <span className="text-amber-600"> add your Anthropic key to enable AI features.</span>}
            </p>
          </div>
        </div>
      </div>

      {/* Quick start prompts */}
      {info?.quickStart?.length > 0 && (
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-900">Try these from your agent</h2>
          <p className="text-sm text-gray-500 mt-1">Works even on a brand-new account — discovery pulls fresh people from the web.</p>
          <div className="mt-3 space-y-2">
            {info.quickStart.map((q, i) => (
              <div key={i} className="flex items-start gap-2 bg-gray-50 rounded-lg p-3">
                <span className="text-gray-300 text-sm">›</span>
                <p className="text-sm text-gray-800">{q}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tokens */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-gray-900">Access tokens</h2>
        <p className="text-sm text-gray-500 mt-1">A token authenticates your agent. Shown once — store it safely. Revoke anytime.</p>

        <div className="flex gap-2 mt-4">
          <input
            value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. My laptop, Cursor)"
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
          <button onClick={create} disabled={busy}
            className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>

        {newToken && (
          <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-xs font-medium text-green-900">Copy this now — it won't be shown again:</p>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs text-green-900 break-all flex-1">{newToken}</code>
              <button onClick={() => copy(newToken)} className="text-xs text-green-700 font-medium hover:underline flex-shrink-0">
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 divide-y divide-gray-100">
          {tokens.length === 0 && <p className="text-sm text-gray-400 py-3">No tokens yet.</p>}
          {tokens.map(t => (
            <div key={t.id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm text-gray-900">{t.label || 'Untitled'}
                  {t.revoked_at && <span className="ml-2 text-xs text-red-500">revoked</span>}</p>
                <p className="text-xs text-gray-400">
                  {t.scopes} · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleDateString()}` : 'never used'}
                </p>
              </div>
              {!t.revoked_at && (
                <button onClick={() => revoke(t.id)} className="text-xs text-red-600 hover:underline">Revoke</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* What your agent can do */}
      {info && (
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-900">Builder-signal filters</h2>
          <p className="text-sm text-gray-500 mt-1">Filter Talent & Sourcing by these high-signal profile types — in the app or from your agent.</p>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {(info.builderSignals || []).map(s => (
              <div key={s.key} className="bg-gray-50 rounded-lg p-3">
                <p className="text-sm font-medium text-gray-900">{s.label}
                  <span className="ml-2 font-mono text-[11px] text-gray-400">{s.key}</span></p>
                <p className="text-xs text-gray-600 mt-0.5 leading-snug">{s.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  );
}
