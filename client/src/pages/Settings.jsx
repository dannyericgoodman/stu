import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const COLORS = ['gray', 'blue', 'amber', 'green', 'red', 'purple'];

const COLOR_CLASSES = {
  gray: 'bg-gray-100 text-gray-600',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  green: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  purple: 'bg-purple-50 text-purple-700',
};

const DEFAULT_ADMISSIONS = [
  { name: 'Sourced', color: 'gray' },
  { name: 'Outreach', color: 'blue' },
  { name: 'First Call Scheduled', color: 'blue' },
  { name: 'First Call Complete', color: 'blue' },
  { name: 'Second Call Scheduled', color: 'amber' },
  { name: 'Second Call Complete', color: 'amber' },
  { name: 'Admitted', color: 'green' },
  { name: 'Active Resident', color: 'green' },
  { name: 'Density Resident', color: 'green' },
  { name: 'Alumni', color: 'gray' },
  { name: 'Hold/Nurture', color: 'amber' },
  { name: 'Not Admitted', color: 'red' },
];

const DEFAULT_DEALS = [
  { name: 'Under Consideration', color: 'blue' },
  { name: 'First Meeting', color: 'blue' },
  { name: 'Partner Call', color: 'amber' },
  { name: 'Memo Draft', color: 'amber' },
  { name: 'IC Review', color: 'amber' },
  { name: 'Committed', color: 'green' },
  { name: 'Passed', color: 'red' },
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

function StageRow({ stage, index, total, onChange, onMove, onDelete }) {
  return (
    <div className="flex items-center gap-2 group">
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          disabled={index === 0}
          className="text-gray-300 hover:text-gray-500 disabled:opacity-30 disabled:cursor-default p-0.5"
          title="Move up"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          disabled={index === total - 1}
          className="text-gray-300 hover:text-gray-500 disabled:opacity-30 disabled:cursor-default p-0.5"
          title="Move down"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
      <span className="text-xs text-gray-400 w-5 text-right tabular-nums">{index + 1}</span>
      <input
        type="text"
        value={stage.name}
        onChange={(e) => onChange(index, 'name', e.target.value)}
        className="input flex-1"
        placeholder="Stage name"
      />
      <select
        value={stage.color}
        onChange={(e) => onChange(index, 'color', e.target.value)}
        className="select w-28"
      >
        {COLORS.map(c => (
          <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
        ))}
      </select>
      <span className={`badge ${COLOR_CLASSES[stage.color]} w-16 justify-center text-[10px]`}>
        Preview
      </span>
      <button
        type="button"
        onClick={() => onDelete(index)}
        className="text-gray-300 hover:text-red-500 transition-colors p-1 opacity-0 group-hover:opacity-100"
        title="Remove stage"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
      </button>
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

  // Pipeline state
  const [admissionsStages, setAdmissionsStages] = useState([]);
  const [dealStages, setDealStages] = useState([]);
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

  // Newsletter (Daily Brief) state
  const [gmailAddress, setGmailAddress] = useState('');
  const [gmailAppPassword, setGmailAppPassword] = useState('');
  const [newsletterLabel, setNewsletterLabel] = useState('Stu/News');
  const newsletterSave = useSaveState();

  // Newsletter sources
  const [sources, setSources] = useState([]);
  const [srcUrl, setSrcUrl] = useState('');
  const [srcName, setSrcName] = useState('');
  const [srcSender, setSrcSender] = useState('');
  const [srcMode, setSrcMode] = useState('rss'); // 'rss' | 'email'
  const [srcAdding, setSrcAdding] = useState(false);
  const [srcError, setSrcError] = useState('');

  async function loadSources() {
    try { setSources(await api.getNewsletterSources()); } catch { /* ignore */ }
  }
  async function addSource() {
    setSrcAdding(true); setSrcError('');
    try {
      if (srcMode === 'rss') {
        if (!srcUrl.trim()) { setSrcError('Enter the newsletter URL or RSS feed.'); setSrcAdding(false); return; }
        await api.addNewsletterSource({ type: 'rss', url: srcUrl.trim(), name: srcName.trim() || undefined });
      } else {
        if (!srcSender.trim()) { setSrcError('Enter the sender email.'); setSrcAdding(false); return; }
        await api.addNewsletterSource({ type: 'email', sender: srcSender.trim(), name: srcName.trim() || undefined });
      }
      setSrcUrl(''); setSrcName(''); setSrcSender('');
      await loadSources();
    } catch (err) {
      setSrcError(err.message || 'Could not add source');
    } finally { setSrcAdding(false); }
  }
  async function toggleSource(s) {
    await api.updateNewsletterSource(s.id, { enabled: s.enabled ? 0 : 1 });
    loadSources();
  }
  async function removeSource(s) {
    await api.deleteNewsletterSource(s.id);
    loadSources();
  }

  useEffect(() => {
    async function load() {
      try {
        const settings = await api.getSettings();
        setAdmissionsStages(settings.pipeline_admissions_stages || DEFAULT_ADMISSIONS);
        setDealStages(settings.pipeline_deal_stages || DEFAULT_DEALS);
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
          gmail: isSet(settings.newsletter_gmail_app_password),
        });
        setGmailAddress(settings.newsletter_gmail_address || '');
        setGmailAppPassword(asStr(settings.newsletter_gmail_app_password));
        setNewsletterLabel(settings.newsletter_label || 'Stu/News');
        setFundName(settings.profile_fund_name || '');
        loadSources();
      } catch (err) {
        setLoadError(err.message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Pipeline handlers
  function updateStage(type, index, field, value) {
    const setter = type === 'admissions' ? setAdmissionsStages : setDealStages;
    setter(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }

  function moveStage(type, index, direction) {
    const setter = type === 'admissions' ? setAdmissionsStages : setDealStages;
    setter(prev => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function deleteStage(type, index) {
    const setter = type === 'admissions' ? setAdmissionsStages : setDealStages;
    setter(prev => prev.filter((_, i) => i !== index));
  }

  function addStage(type) {
    const setter = type === 'admissions' ? setAdmissionsStages : setDealStages;
    setter(prev => [...prev, { name: '', color: 'gray' }]);
  }

  function resetPipeline() {
    setAdmissionsStages([...DEFAULT_ADMISSIONS]);
    setDealStages([...DEFAULT_DEALS]);
  }

  async function savePipeline() {
    await pipelineSave.doSave(async () => {
      await api.updateSetting('pipeline_admissions_stages', admissionsStages);
      await api.updateSetting('pipeline_deal_stages', dealStages);
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

  async function saveNewsletter() {
    await newsletterSave.doSave(async () => {
      const puts = [
        api.updateSetting('newsletter_gmail_address', gmailAddress.trim()),
        api.updateSetting('newsletter_label', newsletterLabel.trim() || 'Stu/News'),
      ];
      // Same rule for the app password — only overwrite when a new one is entered.
      if (gmailAppPassword.replace(/\s+/g, '')) puts.push(api.updateSetting('newsletter_gmail_app_password', gmailAppPassword.replace(/\s+/g, '')));
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
    { id: 'newsletter', label: 'Newsletters' },
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

      {/* Pipeline Tab */}
      {activeTab === 'pipeline' && (
        <div className="space-y-6">
          {/* Admissions Pipeline */}
          <div className="card p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Admissions Pipeline</h2>
              <p className="text-xs text-gray-500 mt-0.5">Stages for tracking founder/resident admissions.</p>
            </div>
            <div className="space-y-2">
              {admissionsStages.map((stage, i) => (
                <StageRow
                  key={i}
                  stage={stage}
                  index={i}
                  total={admissionsStages.length}
                  onChange={(idx, field, val) => updateStage('admissions', idx, field, val)}
                  onMove={(idx, dir) => moveStage('admissions', idx, dir)}
                  onDelete={(idx) => deleteStage('admissions', idx)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => addStage('admissions')}
              className="btn-ghost mt-3 text-xs"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add stage
            </button>
          </div>

          {/* Deal Pipeline */}
          <div className="card p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Deal Pipeline</h2>
              <p className="text-xs text-gray-500 mt-0.5">Stages for tracking investment deal flow.</p>
            </div>
            <div className="space-y-2">
              {dealStages.map((stage, i) => (
                <StageRow
                  key={i}
                  stage={stage}
                  index={i}
                  total={dealStages.length}
                  onChange={(idx, field, val) => updateStage('deals', idx, field, val)}
                  onMove={(idx, dir) => moveStage('deals', idx, dir)}
                  onDelete={(idx) => deleteStage('deals', idx)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => addStage('deals')}
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

      {/* Newsletters Tab */}
      {activeTab === 'newsletter' && (
        <div className="space-y-6 max-w-2xl">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Daily Brief — newsletter sources</h2>
            <p className="text-xs text-gray-500 mt-1">
              Add a newsletter once and it flows into your brief automatically — no Gmail labeling. Paste a
              newsletter's website or Substack URL and Stu finds its RSS feed. For email-only newsletters, add the sender address.
            </p>
          </div>

          {/* Add source */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-1 p-0.5 bg-gray-100 rounded-lg w-fit">
              {[['rss', 'By URL / RSS'], ['email', 'By sender email']].map(([m, lbl]) => (
                <button key={m} onClick={() => { setSrcMode(m); setSrcError(''); }}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${srcMode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                  {lbl}
                </button>
              ))}
            </div>
            {srcMode === 'rss' ? (
              <input className="input w-full" placeholder="https://www.notboring.co  (or any newsletter/Substack URL)"
                value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} />
            ) : (
              <input className="input w-full" placeholder="sender@substack.com  (the address the newsletter comes from)"
                value={srcSender} onChange={(e) => setSrcSender(e.target.value)} />
            )}
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="Name (optional)" value={srcName} onChange={(e) => setSrcName(e.target.value)} />
              <button onClick={addSource} disabled={srcAdding} className="btn-primary text-xs px-4 disabled:opacity-50">
                {srcAdding ? 'Adding…' : 'Add source'}
              </button>
            </div>
            {srcError && <p className="text-xs text-red-600">{srcError}</p>}
          </div>

          {/* Source list */}
          {sources.length > 0 && (
            <div className="space-y-2">
              {sources.map(s => (
                <div key={s.id} className="flex items-center justify-between gap-3 card px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{s.name || s.feed_url || s.sender_match}</span>
                      <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${s.type === 'rss' ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                        {s.type === 'rss' ? 'RSS' : 'EMAIL'}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-400 truncate">{s.feed_url || s.sender_match}{s.last_status ? ` · ${s.last_status}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => toggleSource(s)} className={`text-[11px] px-2 py-1 rounded border ${s.enabled ? 'border-emerald-200 text-emerald-700 bg-emerald-50' : 'border-gray-200 text-gray-400'}`}>
                      {s.enabled ? 'On' : 'Off'}
                    </button>
                    <button onClick={() => removeSource(s)} className="text-[11px] text-gray-300 hover:text-red-500">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Gmail (optional, for email senders) */}
          <details className="border-t border-gray-100 pt-4">
            <summary className="text-xs font-semibold text-gray-700 cursor-pointer">Gmail connection (only needed for email-sender sources)</summary>
            <div className="space-y-3 mt-3">
              <p className="text-[11px] text-gray-400">
                Required only if you add "By sender email" sources. Turn on 2-Step Verification, create a Gmail App Password
                (Google Account → Security → App passwords), and paste it here.
              </p>
              <div>
                <label className="label">Gmail address</label>
                <input type="email" className="input w-full" placeholder="you@gmail.com" value={gmailAddress} onChange={(e) => setGmailAddress(e.target.value)} />
              </div>
              <div>
                <label className="label">Gmail App Password</label>
                <input type="password" className="input w-full" placeholder={keysConfigured.gmail ? 'Saved ✓ — leave blank to keep' : '16-character app password'} autoComplete="new-password" value={gmailAppPassword} onChange={(e) => setGmailAppPassword(e.target.value)} />
              </div>
              <div className="flex items-center">
                <SaveButton onClick={saveNewsletter} saving={newsletterSave.saving} saved={newsletterSave.saved} />
              </div>
              {newsletterSave.error && <p className="text-sm text-red-600 mt-2">{newsletterSave.error}</p>}
            </div>
          </details>
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
// Talent/Sourcing tools. Stu is free with an account; usage runs on the user's own keys.
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
          Stu is free with an account. Connect Claude Desktop, Cursor, or any MCP client to
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
