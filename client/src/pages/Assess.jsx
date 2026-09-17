import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { PageHeader, ConvictionBadge } from '../components/ui';
import FrameworksPanel from '../components/FrameworksPanel';

export default function Assess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedFounder = searchParams.get('founder');
  const rerunId = searchParams.get('rerun');
  const rerunGroupId = searchParams.get('group');
  const task = searchParams.get('task');
  // 'assessment' and 'memo' share the same lean intake (a deal memo needs the same inputs
  // as an assessment — it's the same engine, formatted differently on the results page).
  // 'prep' isn't built yet (see the build plan) — falls through to the full generic form.
  const isAssessmentTask = task === 'assessment';
  const isMemoTask = task === 'memo';
  const isPrepTask = task === 'prep';
  const isLeanIntakeTask = isAssessmentTask || isMemoTask || isPrepTask;

  const [assessments, setAssessments] = useState([]);
  const [founders, setFounders] = useState([]);
  const [showNew, setShowNew] = useState(!!preselectedFounder || !!rerunId || !!task);
  // Prep leads with website + uploads (no call has happened yet), so those stay expanded;
  // Assessment/Memo lead with the transcript and tuck decks/URLs behind a disclosure.
  const [showMoreMaterials, setShowMoreMaterials] = useState(!isLeanIntakeTask || isPrepTask);
  const [loading, setLoading] = useState(true);

  // Form state
  const [founderId, setFounderId] = useState(preselectedFounder || '');
  const [founderSearch, setFounderSearch] = useState('');
  const [showFounderDropdown, setShowFounderDropdown] = useState(false);
  const [creatingFounder, setCreatingFounder] = useState(false);
  const [decks, setDecks] = useState([]);
  const [transcripts, setTranscripts] = useState([]);
  const [urls, setUrls] = useState([]);
  const [notes, setNotes] = useState([]);
  const [urlInput, setUrlInput] = useState('');
  const [running, setRunning] = useState(false);

  // Re-run context
  const [rerunPreviousInputs, setRerunPreviousInputs] = useState([]);
  const [rerunMode, setRerunMode] = useState(false);
  const [rerunRubricName, setRerunRubricName] = useState(null);

  // Rubric picker — which yardstick this run is scored against.
  const [rubrics, setRubrics] = useState([]);
  const [rubricId, setRubricId] = useState('');

  // The Frameworks editor opens in-window (a modal) so editing how you assess
  // never navigates away from the Assess product.
  const [showFrameworks, setShowFrameworks] = useState(false);

  useEffect(() => {
    loadData();
    if (rerunId) loadRerunContext();
    // Assessment task mode: seed one transcript block so the primary "paste the call" textarea
    // is right there — no extra click needed to get to the thing you actually came here to do.
    // Prep is pre-meeting — there's usually no transcript yet, so don't auto-seed it;
    // website + materials (below, auto-expanded) are the primary inputs for that flow.
    if ((isAssessmentTask || isMemoTask) && !rerunId) setTranscripts([{ label: 'Call transcript / notes', content: '' }]);
  }, []);

  async function loadRubrics() {
    try {
      const { rubrics } = await api.getRubrics();
      setRubrics(rubrics || []);
    } catch (e) { console.error(e); }
  }

  async function loadData() {
    setLoading(true);
    try {
      const [a, f] = await Promise.all([api.getAssessments(), api.getFounders()]);
      setAssessments(a);
      setFounders(f);
      await loadRubrics();
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function loadRerunContext() {
    try {
      const [assessment, inputs] = await Promise.all([
        api.getAssessment(rerunId),
        api.getAssessmentInputs(rerunId),
      ]);
      if (assessment.founder_id) setFounderId(String(assessment.founder_id));
      setRerunPreviousInputs(inputs);
      setRerunMode(true);
      // A re-run re-scores against the SAME yardstick — surface which one.
      try {
        const snap = typeof assessment.rubric_snapshot === 'string' ? JSON.parse(assessment.rubric_snapshot) : assessment.rubric_snapshot;
        if (snap?.name) setRerunRubricName(snap.name);
      } catch { /* no snapshot — legacy run */ }
    } catch (err) {
      console.error('Failed to load rerun context:', err);
    }
  }

  function handleFileUpload(e) {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const name = (file.name || '').toLowerCase();
      const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
      const isPptx = name.endsWith('.pptx') || name.endsWith('.ppt') || (file.type || '').includes('presentation');
      const isText = name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || (file.type || '').startsWith('text/');

      if (isPptx) {
        // Decision 2: don't build a PPTX parser; reject loudly so we never score on garbage.
        alert(`PowerPoint isn't supported. Please export "${file.name}" to PDF and upload that — Stu won't run an assessment on a deck it can't read.`);
        continue;
      }
      const reader = new FileReader();
      if (isPdf) {
        // Send the real bytes (base64) so the server can extract text. readAsText would
        // corrupt the binary — the old bug that fed garbage to the agents.
        reader.onload = () => {
          const base64 = String(reader.result || '').split(',')[1] || '';
          setDecks(d => [...d, { label: file.name, fileName: file.name, mimeType: 'application/pdf', base64, content: '' }]);
        };
        reader.readAsDataURL(file);
      } else if (isText) {
        reader.onload = () => setDecks(d => [...d, { label: file.name, fileName: file.name, content: reader.result }]);
        reader.readAsText(file);
      } else {
        alert(`"${file.name}" is an unsupported file type. Upload a PDF or paste text — Stu won't assess a deck it can't read.`);
      }
    }
    e.target.value = '';
  }

  function addUrl() {
    const u = urlInput.trim();
    if (u && (u.startsWith('http://') || u.startsWith('https://'))) {
      setUrls(prev => [...prev, u]);
      setUrlInput('');
    }
  }

  function addTranscript() {
    setTranscripts(t => [...t, { label: `Call ${t.length + 1}`, content: '' }]);
  }

  function addNote() {
    setNotes(n => [...n, { label: `Note ${n.length + 1}`, content: '' }]);
  }

  // Set the initial search text when founders load and one is preselected
  useEffect(() => {
    if (founderId && founders.length > 0 && !founderSearch) {
      const f = founders.find(f => String(f.id) === String(founderId));
      if (f) setFounderSearch(`${f.name}${f.company ? ` (${f.company})` : ''}`);
    }
  }, [founderId, founders]);

  const filteredFounders = founderSearch.trim()
    ? founders.filter(f => {
        const q = founderSearch.toLowerCase();
        return f.name.toLowerCase().includes(q) || (f.company || '').toLowerCase().includes(q);
      })
    : founders;

  function selectFounder(f) {
    setFounderId(String(f.id));
    setFounderSearch(`${f.name}${f.company ? ` (${f.company})` : ''}`);
    setShowFounderDropdown(false);
  }

  async function createNewFounder() {
    const input = founderSearch.trim();
    if (!input) return;
    setCreatingFounder(true);
    try {
      // Parse "Name (Company)" or just "Name"
      const match = input.match(/^(.+?)\s*\((.+)\)$/);
      const name = match ? match[1].trim() : input;
      const company = match ? match[2].trim() : null;
      const newFounder = await api.createFounder({ name, company });
      setFounders(prev => [...prev, newFounder]);
      setFounderId(String(newFounder.id));
      setFounderSearch(`${newFounder.name}${newFounder.company ? ` (${newFounder.company})` : ''}`);
      setShowFounderDropdown(false);
    } catch (err) {
      alert('Failed to create founder: ' + err.message);
    }
    setCreatingFounder(false);
  }

  async function handleRunAssessment() {
    const totalInputs = decks.length + transcripts.filter(t => t.content).length + urls.length + notes.filter(n => n.content).length;
    if (totalInputs === 0) {
      alert('Add at least one input (deck, transcript, URL, or notes)');
      return;
    }

    setRunning(true);
    try {
      const payload = {
        founder_id: founderId ? parseInt(founderId) : null,
        assessment_type: isPrepTask ? 'meeting_prep' : 'assessment',
        // The yardstick. Empty → the user's default framework (→ Founder Rubric —
        // Pre-seed). Meeting Prep ignores this; re-runs carry the prior rubric.
        ...(rubricId && !isPrepTask && !rerunMode ? { rubric_id: parseInt(rubricId) } : {}),
        inputs: {
          decks: decks.map(d => ({ label: d.label, content: d.content, fileName: d.fileName, mimeType: d.mimeType, base64: d.base64 })),
          transcripts: transcripts.filter(t => t.content).map(t => ({ label: t.label, content: t.content })),
          urls: urls,
          notes: notes.filter(n => n.content).map(n => ({ label: n.label, content: n.content })),
        },
      };

      let result;
      if (rerunMode && rerunId) {
        result = await api.rerunAssessment(rerunId, payload);
      } else {
        if (rerunGroupId) payload.group_id = rerunGroupId;
        result = await api.createAssessment(payload);
      }
      navigate(`/assess/${result.id}${isMemoTask ? '?tab=memo' : ''}`);
    } catch (err) {
      console.error(err);
      alert('Failed to start assessment: ' + err.message);
    }
    setRunning(false);
  }

  async function handleDelete(assessmentId, e) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this assessment? This cannot be undone.')) return;
    try {
      await api.deleteAssessment(assessmentId);
      setAssessments(a => a.filter(x => x.id !== assessmentId));
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  }

  // Group assessments by group_id for display
  const grouped = {};
  for (const a of assessments) {
    const key = a.group_id || `single_${a.id}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(a);
  }
  const sortedGroups = Object.values(grouped).sort((a, b) => new Date(b[0].created_at) - new Date(a[0].created_at));

  return (
    <div>
      <PageHeader
        title={showNew && isAssessmentTask ? 'Founder Assessment' : showNew && isMemoTask ? 'Deal Memo' : showNew && isPrepTask ? 'Meeting Prep' : 'Assess'}
        subtitle={
          rerunMode ? 'Add new materials and re-evaluate'
          : showNew && isAssessmentTask ? 'Score a founder against your framework. A call transcript is what makes the questions answerable — a deck or a website alone cannot evidence most of them.'
          : showNew && isMemoTask ? 'Run the full multi-agent eval and get it formatted as your Recommendation › Management › Model › Market › Momentum › Malfeasance › Conditions memo.'
          : showNew && isPrepTask ? 'Founder, company, website, and any materials → a pre-meeting briefing: founder profile, thesis fit, questions to ask, and what to watch for.'
          : 'Multi-agent evaluations of your pipeline founders'
        }
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setShowFrameworks(true)} className="btn-secondary text-sm">
              Frameworks
            </button>
            <button onClick={() => { setShowNew(!showNew); if (showNew) { setRerunMode(false); setRerunPreviousInputs([]); } }} className="btn-primary text-sm">
              {showNew ? 'View history' : 'New assessment'}
            </button>
          </div>
        }
      />

      {/* The Frameworks editor, in-window. Saves land through the panel's own
          Save buttons; closing refreshes the picker so new frameworks appear. */}
      {showFrameworks && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 md:p-8" onClick={() => { setShowFrameworks(false); loadRubrics(); }}>
          <div className="relative w-full max-w-6xl bg-white rounded-xl shadow-2xl p-6 md:p-8 my-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold text-ink">Frameworks</h2>
                <p className="text-sm text-gray-500 mt-1">The yardsticks your assessments are scored against. Describe what matters — the architect drafts the questions, you keep the pen.</p>
              </div>
              <button onClick={() => { setShowFrameworks(false); loadRubrics(); }} className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-2" aria-label="Close">×</button>
            </div>
            <FrameworksPanel />
          </div>
        </div>
      )}

      {showNew ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {/* Founder selector */}
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Link to Founder (optional)</h3>
              <div className="relative">
                <input
                  type="text"
                  value={founderSearch}
                  onChange={e => { setFounderSearch(e.target.value); setFounderId(''); setShowFounderDropdown(true); }}
                  onFocus={() => setShowFounderDropdown(true)}
                  onBlur={() => setTimeout(() => setShowFounderDropdown(false), 200)}
                  placeholder="Search or type new founder name..."
                  className="input w-full text-sm"
                />
                {founderId && (
                  <button onClick={() => { setFounderId(''); setFounderSearch(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 text-xs">&times;</button>
                )}
                {showFounderDropdown && founderSearch.trim() && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {filteredFounders.slice(0, 20).map(f => (
                      <button key={f.id} onMouseDown={() => selectFounder(f)} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors">
                        {f.name}{f.company ? <span className="text-gray-400 ml-1">({f.company})</span> : ''}
                      </button>
                    ))}
                    {filteredFounders.length === 0 && (
                      <button onMouseDown={createNewFounder} disabled={creatingFounder} className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors">
                        {creatingFounder ? 'Creating...' : `+ Create "${founderSearch.trim()}"`}
                      </button>
                    )}
                    {filteredFounders.length > 0 && !filteredFounders.find(f => f.name.toLowerCase() === founderSearch.trim().toLowerCase()) && (
                      <button onMouseDown={createNewFounder} disabled={creatingFounder} className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100 transition-colors">
                        {creatingFounder ? 'Creating...' : `+ Create "${founderSearch.trim()}"`}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {founderId && <p className="text-xs text-gray-400 mt-2">CRM notes and call history will be automatically included.</p>}
            </div>

            {/* Rubric picker — not for Meeting Prep (a briefing, not an eval).
                In re-run mode the prior version's yardstick carries forward. */}
            {!isPrepTask && (rerunMode ? (
              <div className="card p-4 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-500 mb-1">Framework</h3>
                <p className="text-sm text-gray-600">
                  Re-scoring against <span className="font-medium">{rerunRubricName || 'the same framework as the previous version'}</span> — the yardstick doesn't change on a re-run.
                </p>
              </div>
            ) : (
              <div className="card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">Framework</h3>
                  <button onClick={() => setShowFrameworks(true)} className="text-xs text-blue-600 hover:underline">Build your own →</button>
                </div>
                <select
                  value={rubricId}
                  onChange={e => setRubricId(e.target.value)}
                  className="input w-full text-sm"
                >
                  <option value="">Default — {rubrics.find(r => r.is_default)?.name || 'Founder Rubric — Pre-seed'}</option>
                  {rubrics.filter(r => !r.is_default).map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.is_preset ? ' (preset)' : ''} — {r.dimensions?.length || 0} questions</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-2">What this run is scored against. A call transcript is what makes a framework scorable — a deck or a website alone can't evidence most questions.</p>
              </div>
            ))}

            {/* Previous inputs (re-run mode) */}
            {rerunMode && rerunPreviousInputs.length > 0 && (
              <div className="card p-4 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-500 mb-2">Previous Materials (carried forward)</h3>
                <div className="flex flex-wrap gap-2">
                  {rerunPreviousInputs.map((inp, i) => (
                    <span key={i} className="badge badge-gray text-xs">
                      {inp.input_type === 'deck' ? '\uD83D\uDCC4' : inp.input_type === 'transcript' ? '\uD83C\uDFA4' : inp.input_type === 'url' ? '\uD83D\uDD17' : '\uD83D\uDCDD'}
                      {' '}{inp.label || inp.input_type}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">Add new materials below. Everything will be evaluated together.</p>
              </div>
            )}

            {/* Transcripts — led first for Assessment/Memo (paste the call, that's the job);
                secondary/optional for Prep (there's usually no call yet). */}
            {!isPrepTask && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Call Transcript / Notes</h3>
                <button onClick={addTranscript} className="text-blue-600 text-xs hover:underline">+ Add another</button>
              </div>
              {/* This box is the one that unlocks a conviction score, and that is not
                  guessable from the UI. The Founder Rubric's two heaviest movements —
                  Earned Insight and Learning Velocity — are only readable once the founder
                  has answered a question ("how did you arrive at this problem?", "what did
                  you believe six months ago?"). A deck and a website cannot evidence them,
                  so without something here the run reports Insufficient Evidence by design.
                  Note the adjacent trap: call notes pasted into "Additional Notes" below are
                  stored as `notes`, which does NOT lift the evidence rung — say so here
                  rather than let someone conclude the tool is broken. */}
              <p className="text-xs text-gray-500 mb-2 leading-relaxed">
                <span className="font-semibold text-gray-700">This is the input that unlocks a conviction score.</span>{' '}
                The rubric can't read Earned Insight or Learning Velocity off a deck or a website —
                it needs the founder answering questions. Paste call notes <em>here</em>, not in
                Additional Notes below.
              </p>
              {transcripts.length === 0 ? (
                <button onClick={addTranscript} className="w-full border-2 border-dashed border-gray-200 rounded-lg py-3 text-xs text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors">
                  Click to paste a call transcript (Granola, Fireflies, etc.) or your own call notes
                </button>
              ) : (
                <div className="space-y-3">
                  {transcripts.map((t, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <input type="text" value={t.label} onChange={e => setTranscripts(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} className="text-xs text-gray-500 border-none bg-transparent focus:outline-none" placeholder="Label..." />
                        <button onClick={() => setTranscripts(prev => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 text-xs">Remove</button>
                      </div>
                      <textarea
                        autoFocus={i === 0 && isLeanIntakeTask}
                        value={t.content}
                        onChange={e => setTranscripts(prev => prev.map((x, j) => j === i ? { ...x, content: e.target.value } : x))}
                        placeholder="Paste the transcript or your call notes here..."
                        className="input w-full text-sm min-h-[160px] resize-y"
                        rows={7}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}

            {isLeanIntakeTask && !showMoreMaterials && (
              <button onClick={() => setShowMoreMaterials(true)} className="text-xs text-gray-400 hover:text-gray-600 underline">
                + Add a deck, links, or extra notes (optional)
              </button>
            )}

            {showMoreMaterials && (
            <>
            {/* URLs — for Prep this is the company website, the primary input, so it leads. */}
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">{isPrepTask ? 'Company Website' : 'Links & URLs'}</h3>
              <div className="flex gap-2">
                <input
                  autoFocus={isPrepTask}
                  type="url"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
                  placeholder={isPrepTask ? 'https://company.com' : 'https://company.com, LinkedIn, Crunchbase...'}
                  className="input flex-1 text-sm"
                />
                <button onClick={addUrl} className="btn-primary text-xs px-3">Add</button>
              </div>
              {urls.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {urls.map((u, i) => {
                    let host = u;
                    try { host = new URL(u).hostname; } catch {}
                    return (
                      <span key={i} className="badge badge-blue text-xs flex items-center gap-1">
                        {host}
                        <button onClick={() => setUrls(prev => prev.filter((_, j) => j !== i))} className="ml-1 hover:text-red-500">&times;</button>
                      </span>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-gray-400 mt-2">Content will be auto-fetched from each URL.</p>
            </div>

            {/* Files / Decks */}
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">{isPrepTask ? 'Upload Materials' : 'Pitch Decks & Files'}</h3>
              <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center hover:border-blue-400 transition-colors cursor-pointer">
                <input type="file" accept=".pdf,.txt,.doc,.docx" multiple onChange={handleFileUpload} className="hidden" id="file-upload" />
                <label htmlFor="file-upload" className="cursor-pointer">
                  <svg className="w-6 h-6 text-gray-400 mx-auto mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  <p className="text-xs text-gray-500">Drop files or click to upload (multiple OK)</p>
                </label>
              </div>
              {decks.length > 0 && (
                <div className="mt-3 space-y-2">
                  {decks.map((d, i) => (
                    <div key={i} className="flex items-center justify-between bg-blue-50 rounded-lg px-3 py-2">
                      <span className="text-sm text-blue-700 truncate">{d.label}</span>
                      <button onClick={() => setDecks(prev => prev.filter((_, j) => j !== i))} className="text-blue-400 hover:text-red-500 text-xs ml-2">Remove</button>
                    </div>
                  ))}
                </div>
              )}
              {decks.length === 0 && (
                <textarea
                  placeholder="Or paste deck text / content here..."
                  className="input w-full text-sm mt-3 min-h-[60px] resize-none"
                  rows={2}
                  onBlur={e => { if (e.target.value.trim()) { setDecks([{ label: 'Pasted Content', content: e.target.value, fileName: null }]); e.target.value = ''; } }}
                />
              )}
            </div>

            {/* Notes */}
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Additional Notes</h3>
                <button onClick={addNote} className="text-blue-600 text-xs hover:underline">+ Add note</button>
              </div>
              {/* The other half of the trap. These are stored as `notes` and do NOT lift the
                  evidence rung, because the server cannot tell from the row whether a human
                  wrote them after a call or jotted them off a website. Call notes belong in
                  the transcript box above. */}
              <p className="text-xs text-gray-400 mb-2">
                Your own context and takeaways. These don't unlock a conviction score —
                if you're pasting notes from a call, use the transcript box above.
              </p>
              {notes.length === 0 ? (
                <button onClick={addNote} className="w-full border-2 border-dashed border-gray-200 rounded-lg py-3 text-xs text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors">
                  Click to add notes, observations, or context
                </button>
              ) : (
                <div className="space-y-3">
                  {notes.map((n, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <input type="text" value={n.label} onChange={e => setNotes(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} className="text-xs text-gray-500 border-none bg-transparent focus:outline-none" placeholder="Label..." />
                        <button onClick={() => setNotes(prev => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 text-xs">Remove</button>
                      </div>
                      <textarea value={n.content} onChange={e => setNotes(prev => prev.map((x, j) => j === i ? { ...x, content: e.target.value } : x))} placeholder="Your observations, takeaways, questions..." className="input w-full text-sm min-h-[60px] resize-none" rows={2} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            </>
            )}

            {/* Run button */}
            <button onClick={handleRunAssessment} disabled={running} className="btn-accent w-full justify-center text-sm py-3">
              {running ? (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  Starting agents...
                </span>
              ) : rerunMode ? 'Re-run Assessment with New Info' : isAssessmentTask ? 'Run Founder Assessment' : isMemoTask ? 'Generate Deal Memo' : isPrepTask ? 'Prepare Briefing' : 'Run Assessment'}
            </button>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Materials Added</h3>
              <div className="space-y-2">
                <InputCount label="Pitch decks / files" count={decks.length + (rerunMode ? rerunPreviousInputs.filter(i => i.input_type === 'deck').length : 0)} />
                <InputCount label="URLs / links" count={urls.length + (rerunMode ? rerunPreviousInputs.filter(i => i.input_type === 'url').length : 0)} />
                <InputCount label="Call transcripts" count={transcripts.filter(t => t.content).length + (rerunMode ? rerunPreviousInputs.filter(i => i.input_type === 'transcript').length : 0)} />
                <InputCount label="Notes" count={notes.filter(n => n.content).length + (rerunMode ? rerunPreviousInputs.filter(i => i.input_type === 'notes').length : 0)} />
                <InputCount label="Founder linked" count={founderId ? 1 : 0} />
              </div>
            </div>
            <div className="card p-4">
              {isPrepTask ? (
                <>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">The Briefing</h3>
                  <ul className="text-xs text-gray-500 space-y-1.5">
                    <li>Founder Profile</li>
                    <li>Company Snapshot</li>
                    <li>Thesis Fit</li>
                    <li>Market Context</li>
                    <li>Questions to Ask</li>
                    <li>Danny's Angle</li>
                  </ul>
                  <p className="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100">One pass from what's provided — no live web/LinkedIn search. Anything unverifiable is flagged explicitly, never invented.</p>
                </>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Evaluation Agents</h3>
                  <ul className="text-xs text-gray-500 space-y-2">
                    <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-gray-700 font-medium">Founder Evaluator</span> — team, DNA, traits, stage</li>
                    <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-gray-700 font-medium">Product Evaluator</span> — instincts, execution, defensibility</li>
                    <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-gray-700 font-medium">Market Analyst</span> — TAM, timing, why now</li>
                    <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-gray-700 font-medium">The Bear</span> — adversarial risk analysis</li>
                  </ul>
                  {/* This used to read "All 4 agents run in parallel (Team 45% /
                      Product 25% / Market 30%, then a Bear risk adjustment)".
                      That weighting was RETIRED — correctSynthesisScores()
                      documents killing it, because a flat weighted mean inverted
                      the rubric: 10,10,1,1 scored 6.4 "Monitor" while 5,5,10,10
                      scored 7.0 "write a memo". The intake page was describing an
                      engine that no longer exists, which is worse than describing
                      nothing: it tells Danny the score means something it doesn't. */}
                  <p className="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100">
                    The rubric agent runs first and alone — it sets the score from the four movements.
                    Team, Product, Market and the Bear then run in parallel; their job is commentary and
                    risk, and they can only ever dock the score, never raise it.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {loading ? (
            <div className="text-center py-12 text-gray-500 text-sm">Loading assessments...</div>
          ) : sortedGroups.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm">No assessments yet</p>
              <button onClick={() => setShowNew(true)} className="text-blue-600 text-sm mt-2 hover:underline">Run your first assessment</button>
            </div>
          ) : (
            <div className="space-y-3">
              {sortedGroups.map((group) => {
                const latest = group[0];
                const hasVersions = group.length > 1;
                return (
                  <div key={latest.group_id || latest.id} className="card overflow-hidden">
                    <Link to={`/assess/${latest.id}`} className="block px-4 py-3 hover:bg-gray-50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {latest.founder_name || 'Unnamed Opportunity'}
                              {latest.founder_company && <span className="text-gray-400 ml-1">({latest.founder_company})</span>}
                            </p>
                            {hasVersions && <span className="badge badge-gray text-[10px]">v{latest.version_number || group.length}</span>}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {new Date(latest.created_at).toLocaleDateString()}
                            {hasVersions && ` \u00B7 ${group.length} versions`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <ConvictionBadge assessment={latest} />
                          <button onClick={(e) => handleDelete(latest.id, e)} className="text-gray-300 hover:text-red-500 p-1" title="Delete">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                          </button>
                        </div>
                      </div>
                    </Link>
                    {hasVersions && group.slice(1).map(v => (
                      <Link key={v.id} to={`/assess/${v.id}`} className="block px-4 py-2 bg-gray-50 border-t border-gray-100 hover:bg-gray-100 transition-colors">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-gray-500">v{v.version_number || '1'} — {new Date(v.created_at).toLocaleDateString()}</p>
                          <ConvictionBadge assessment={v} size="xs" />
                        </div>
                      </Link>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function InputCount({ label, count }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-sm ${count > 0 ? 'text-gray-700' : 'text-gray-400'}`}>{label}</span>
      {count > 0 ? <span className="badge badge-green text-xs">{count}</span> : <span className="text-xs text-gray-300">0</span>}
    </div>
  );
}
