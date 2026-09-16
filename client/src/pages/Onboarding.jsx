import { useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../utils/api';
import StuLogo from '../components/StuLogo';

const STAGE_OPTIONS = ['Pre-seed', 'Seed', 'Series A', 'Any'];

function TagInput({ tags, onAdd, onRemove, placeholder }) {
  const [value, setValue] = useState('');

  function handleKeyDown(e) {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      const trimmed = value.trim();
      if (!tags.includes(trimmed)) onAdd(trimmed);
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
          <button type="button" onClick={() => onRemove(i)} className="text-gray-400 hover:text-gray-600 ml-0.5">
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

const STEPS = [
  {
    id: 'geography',
    title: 'Where do you source?',
    subtitle: 'Add cities, regions, or metro areas — or skip if you source everywhere.',
  },
  {
    id: 'signals',
    title: 'What signals matter?',
    subtitle: 'Schools, companies, builder signals — add what matters to you, skip what doesn\'t.',
  },
  {
    id: 'focus',
    title: 'What do you invest in?',
    subtitle: 'Sector focus and preferred stage. Leave blank if you\'re thesis-agnostic.',
  },
  {
    id: 'keys',
    title: 'Connect your API keys',
    subtitle: 'Stu runs on your keys, so you control costs directly. Exa and Anthropic power the nightly scout — without them Stu can\'t find or score founders.',
  },
  {
    id: 'review',
    title: 'You\'re all set',
    subtitle: 'Here\'s your setup. Everything can be changed in Settings anytime.',
  },
];

export default function Onboarding() {
  const { refreshUser } = useAuth();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Sourcing criteria state
  const [locations, setLocations] = useState([]);
  const [schools, setSchools] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [builderSignals, setBuilderSignals] = useState([]);
  const [domains, setDomains] = useState([]);
  const [stageFilter, setStageFilter] = useState('Pre-seed');

  // API keys (BYOK — saved encrypted, same as Settings)
  const [apiKeyExa, setApiKeyExa] = useState('');
  const [apiKeyAnthropic, setApiKeyAnthropic] = useState('');
  const [apiKeyEnrichlayer, setApiKeyEnrichlayer] = useState('');
  const [apiKeyGithub, setApiKeyGithub] = useState('');
  const keysReady = apiKeyExa.trim().length > 0 && apiKeyAnthropic.trim().length > 0;

  async function saveKeys() {
    const puts = [];
    if (apiKeyExa.trim()) puts.push(api.updateSetting('api_key_exa', apiKeyExa.trim()));
    if (apiKeyAnthropic.trim()) puts.push(api.updateSetting('api_key_anthropic', apiKeyAnthropic.trim()));
    if (apiKeyEnrichlayer.trim()) puts.push(api.updateSetting('api_key_enrichlayer', apiKeyEnrichlayer.trim()));
    if (apiKeyGithub.trim()) puts.push(api.updateSetting('api_key_github', apiKeyGithub.trim()));
    if (puts.length) await Promise.all(puts);
  }

  const addTag = useCallback((setter) => (tag) => setter(prev => [...prev, tag]), []);
  const removeTag = useCallback((setter) => (index) => setter(prev => prev.filter((_, i) => i !== index)), []);

  const canProceed = () => true; // All fields optional — users configure what matters to them

  async function handleComplete() {
    setSaving(true);
    setError('');
    try {
      await saveKeys();
      // Save all criteria
      await Promise.all([
        api.updateSetting('sourcing_locations', locations),
        api.updateSetting('sourcing_schools', schools),
        api.updateSetting('sourcing_companies', companies),
        api.updateSetting('sourcing_builder_signals', builderSignals),
        api.updateSetting('sourcing_domains', domains),
        api.updateSetting('sourcing_stage_filter', stageFilter),
      ]);
      // Mark onboarding complete
      await api.completeOnboarding();
      // Refresh user state to pick up onboarding_complete = 1
      await refreshUser();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  async function handleKeysContinue() {
    setSaving(true);
    setError('');
    try {
      await saveKeys();
      setStep(s => s + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const currentStep = STEPS[step];

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-xl">
        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i <= step ? 'bg-gray-900 w-10' : 'bg-gray-200 w-6'
              }`}
            />
          ))}
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <StuLogo size={36} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{currentStep.title}</h1>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">{currentStep.subtitle}</p>
        </div>

        {/* Content */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 mb-4">
              {error}
            </div>
          )}

          {step === 0 && (
            <div className="space-y-4">
              <div>
                <label className="label">Target Locations <span className="text-gray-400 font-normal">· optional</span></label>
                <TagInput
                  tags={locations}
                  onAdd={addTag(setLocations)}
                  onRemove={removeTag(setLocations)}
                  placeholder="e.g. Chicago, New York, San Francisco..."
                />
                <p className="text-xs text-gray-400 mt-1.5">Leave blank to source everywhere. You can always narrow later in Settings.</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div>
                <label className="label">Target Schools <span className="text-gray-400 font-normal">· optional</span></label>
                <TagInput
                  tags={schools}
                  onAdd={addTag(setSchools)}
                  onRemove={removeTag(setSchools)}
                  placeholder="e.g. Stanford, MIT, University of Chicago..."
                />
              </div>
              <div>
                <label className="label">Target Companies <span className="text-gray-400 font-normal">· optional</span></label>
                <TagInput
                  tags={companies}
                  onAdd={addTag(setCompanies)}
                  onRemove={removeTag(setCompanies)}
                  placeholder="e.g. Google, Stripe, Palantir..."
                />
              </div>
              <div>
                <label className="label">Builder Signals <span className="text-gray-400 font-normal">· optional</span></label>
                <TagInput
                  tags={builderSignals}
                  onAdd={addTag(setBuilderSignals)}
                  onRemove={removeTag(setBuilderSignals)}
                  placeholder="e.g. YC Alum, Previous Exit, PhD..."
                />
              </div>
              <p className="text-xs text-gray-400">These tune your sourcing results. Skip any that don't apply to your thesis.</p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label className="label">Focus Domains <span className="text-gray-400 font-normal">· optional</span></label>
                <TagInput
                  tags={domains}
                  onAdd={addTag(setDomains)}
                  onRemove={removeTag(setDomains)}
                  placeholder="e.g. AI/ML, Fintech, Developer Tools..."
                />
                <p className="text-xs text-gray-400 mt-1.5">Leave blank if you're sector-agnostic</p>
              </div>
              <div>
                <label className="label">Stage Filter <span className="text-gray-400 font-normal">· optional</span></label>
                <select
                  value={stageFilter}
                  onChange={(e) => setStageFilter(e.target.value)}
                  className="select w-full"
                >
                  {STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <KeyInput
                label="Exa API key"
                required
                value={apiKeyExa}
                onChange={setApiKeyExa}
                placeholder="Paste your Exa key"
                enables="Web discovery — the nightly scout's eyes on the open web."
              />
              <KeyInput
                label="Anthropic API key"
                required
                value={apiKeyAnthropic}
                onChange={setApiKeyAnthropic}
                placeholder="Paste your Anthropic key"
                enables="Founder scoring, AI assessments, and Ask Stu."
              />
              <KeyInput
                label="EnrichLayer API key"
                value={apiKeyEnrichlayer}
                onChange={setApiKeyEnrichlayer}
                placeholder="Optional — paste your EnrichLayer key"
                enables="LinkedIn employment history, so scores read real careers instead of 195-character bios."
              />
              <KeyInput
                label="GitHub token"
                value={apiKeyGithub}
                onChange={setApiKeyGithub}
                placeholder="Optional — paste a GitHub personal access token"
                enables="Builder radar: GitHub trajectory for founder-slope scoring."
              />
              <p className="text-xs text-gray-400 leading-relaxed">
                Keys are encrypted and stored per-user — Stu never shares them and never
                bills you through them. Add the optional ones later in Settings anytime.
              </p>
              {!keysReady && (
                <button
                  onClick={async () => { await saveKeys(); setStep(s => s + 1); }}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Continue without keys (limited mode — browsing only, no sourcing or scoring)
                </button>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <SummaryRow label="Locations" items={locations} />
              <SummaryRow label="Schools" items={schools} />
              <SummaryRow label="Companies" items={companies} />
              <SummaryRow label="Builder Signals" items={builderSignals} />
              <SummaryRow label="Domains" items={domains} />
              <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <span className="text-sm font-medium text-gray-500">Stage</span>
                <span className="text-sm text-gray-900">{stageFilter}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <span className="text-sm font-medium text-gray-500">API keys</span>
                <span className="text-sm text-gray-900">
                  {keysReady
                    ? 'Exa + Anthropic connected'
                    : 'Not added yet — limited mode'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            className="btn-ghost disabled:opacity-0"
          >
            Back
          </button>

          {step < STEPS.length - 1 ? (
            step === 3 ? (
              <button
                onClick={handleKeysContinue}
                disabled={saving || !keysReady}
                className="btn-primary disabled:opacity-40"
                title={!keysReady ? 'Add your Exa and Anthropic keys to continue, or use the limited-mode link above' : ''}
              >
                {saving ? 'Saving...' : 'Save keys & continue'}
              </button>
            ) : (
              <button
                onClick={() => setStep(s => s + 1)}
                className="btn-primary"
              >
                {step === 0 && locations.length === 0 ? 'Skip' :
                 step === 1 && schools.length === 0 && companies.length === 0 && builderSignals.length === 0 ? 'Skip' :
                 step === 2 && domains.length === 0 ? 'Skip' : 'Continue'}
              </button>
            )
          ) : (
            <button
              onClick={handleComplete}
              disabled={saving}
              className="btn-accent"
            >
              {saving ? 'Setting up...' : 'Launch Stu'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyInput({ label, required, value, onChange, placeholder, enables }) {
  return (
    <div>
      <label className="label">
        {label}{' '}
        {required
          ? <span className="text-red-500 font-normal">· required</span>
          : <span className="text-gray-400 font-normal">· optional</span>}
      </label>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="input w-full font-mono"
      />
      <p className="text-xs text-gray-400 mt-1.5">{enables}</p>
    </div>
  );
}

function SummaryRow({ label, items }) {  return (
    <div className="py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm font-medium text-gray-500 block mb-1.5">{label}</span>
      {items && items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span key={i} className="inline-flex px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-md">
              {item}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-xs text-gray-400 italic">No preference — sourcing broadly</span>
      )}
    </div>
  );
}
