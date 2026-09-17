import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { fireConfettiCannons } from '../utils/confetti';

export default function AddFounder() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '', company: '', role: '', email: '', linkedin_url: '', twitter: '',
    github_url: '', website_url: '', location_city: '', location_state: '',
    stage: 'Pre-seed', domain: '', source: '', bio: '', chicago_connection: '',
    previous_companies: '', notable_background: '', company_one_liner: '', next_action: '',
    pipeline_tracks: '', resident_status: '', deal_status: '', desks_needed: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function toggleTrack(track) {
    const tracks = form.pipeline_tracks.split(',').filter(Boolean);
    let newTracks;
    if (tracks.includes(track)) {
      newTracks = tracks.filter(t => t !== track);
    } else {
      newTracks = [...tracks, track];
    }
    const updates = { pipeline_tracks: newTracks.join(',') };
    if (track === 'investment' && !tracks.includes('investment')) updates.deal_status = 'Under Consideration';
    if (track === 'resident' && !tracks.includes('resident')) updates.resident_status = 'Prospect';
    if (track === 'investment' && tracks.includes('investment')) updates.deal_status = '';
    if (track === 'resident' && tracks.includes('resident')) updates.resident_status = '';
    setForm(f => ({ ...f, ...updates }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const founder = await api.createFounder(form);
      fireConfettiCannons();
      navigate(`/founders/${founder.id}`);
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  }

  const tracks = form.pipeline_tracks.split(',').filter(Boolean);
  const isResident = tracks.includes('resident');
  const isInvestment = tracks.includes('investment');

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link to="/pipeline" className="hover:text-gray-600">Pipeline</Link>
        <span>/</span>
        <span className="text-gray-700">Add Founder</span>
      </div>

      <h1 className="text-xl font-bold text-gray-900 mb-6">Add Founder</h1>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 mb-4">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Basic Info</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Name *</label>
              <input value={form.name} onChange={e => update('name', e.target.value)} className="input w-full text-sm" required />
            </div>
            <div>
              <label className="label">Company</label>
              <input value={form.company} onChange={e => update('company', e.target.value)} className="input w-full text-sm" />
            </div>
            <div>
              <label className="label">Role</label>
              <input value={form.role} onChange={e => update('role', e.target.value)} className="input w-full text-sm" placeholder="Founder & CEO" />
            </div>
            <div>
              <label className="label">Email</label>
              <input type="email" value={form.email} onChange={e => update('email', e.target.value)} className="input w-full text-sm" />
            </div>
          </div>
          <div>
            <label className="label">Company One-Liner</label>
            <input value={form.company_one_liner} onChange={e => update('company_one_liner', e.target.value)} className="input w-full text-sm" placeholder="AI-powered security for cloud infrastructure" />
          </div>
        </div>

        {/* Pipeline Tracks */}
        <div className="card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Pipeline Tracks</h3>
          <p className="text-xs text-gray-400">Select which tracks this founder should be on. You can add/change tracks later.</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => toggleTrack('resident')}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                isResident ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-gray-200 text-gray-500 hover:border-purple-200'
              }`}
            >
              {isResident ? '✓ Resident' : 'Resident'}
            </button>
            <button
              type="button"
              onClick={() => toggleTrack('investment')}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                isInvestment ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-gray-200 text-gray-500 hover:border-emerald-200'
              }`}
            >
              {isInvestment ? '✓ Investment' : 'Investment'}
            </button>
          </div>
          {isResident && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Resident Status</label>
                <select value={form.resident_status} onChange={e => update('resident_status', e.target.value)} className="select w-full text-sm">
                  <option>Prospect</option>
                  <option>Tour Scheduled</option>
                  <option>Admitted</option>
                  <option>Active</option>
                  <option>Alumni</option>
                </select>
              </div>
              <div>
                <label className="label">Desks Needed</label>
                <input type="number" value={form.desks_needed} onChange={e => update('desks_needed', e.target.value)} className="input w-full text-sm" placeholder="1" />
              </div>
            </div>
          )}
          {isInvestment && (
            <div>
              <label className="label">Deal Status</label>
              <select value={form.deal_status} onChange={e => update('deal_status', e.target.value)} className="select w-full text-sm">
                <option>Under Consideration</option>
                <option>Active Diligence</option>
                <option>IC Review</option>
                <option>Committed</option>
                <option>Passed</option>
              </select>
            </div>
          )}
        </div>

        <div className="card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Location & Stage</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">City</label>
              <input value={form.location_city} onChange={e => update('location_city', e.target.value)} className="input w-full text-sm" placeholder="Chicago" />
            </div>
            <div>
              <label className="label">State</label>
              <input value={form.location_state} onChange={e => update('location_state', e.target.value)} className="input w-full text-sm" placeholder="IL" />
            </div>
            <div>
              <label className="label">Stage</label>
              <select value={form.stage} onChange={e => update('stage', e.target.value)} className="select w-full text-sm">
                <option>Pre-seed</option>
                <option>Seed</option>
                <option>Series A</option>
              </select>
            </div>
            <div>
              <label className="label">Domain</label>
              <select value={form.domain} onChange={e => update('domain', e.target.value)} className="select w-full text-sm">
                <option value="">Select...</option>
                <option>B2B SaaS</option>
                <option>AI Infrastructure</option>
                <option>Vertical Software</option>
                <option>Fintech</option>
                <option>Healthtech</option>
                <option>Marketplace</option>
                <option>Other</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Chicago Connection</label>
            <input value={form.chicago_connection} onChange={e => update('chicago_connection', e.target.value)} className="input w-full text-sm" placeholder="Born here, U of C, etc." />
          </div>
        </div>

        <div className="card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Links</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">LinkedIn URL</label>
              <input value={form.linkedin_url} onChange={e => update('linkedin_url', e.target.value)} className="input w-full text-sm" />
            </div>
            <div>
              <label className="label">Twitter</label>
              <input value={form.twitter} onChange={e => update('twitter', e.target.value)} className="input w-full text-sm" placeholder="@handle" />
            </div>
            <div>
              <label className="label">GitHub URL</label>
              <input value={form.github_url} onChange={e => update('github_url', e.target.value)} className="input w-full text-sm" />
            </div>
            <div>
              <label className="label">Website URL</label>
              <input value={form.website_url} onChange={e => update('website_url', e.target.value)} className="input w-full text-sm" />
            </div>
          </div>
        </div>

        <div className="card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Background</h3>
          <div>
            <label className="label">Bio</label>
            <textarea value={form.bio} onChange={e => update('bio', e.target.value)} className="input w-full text-sm min-h-[80px] resize-none" rows={3} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Previous Companies</label>
              <input value={form.previous_companies} onChange={e => update('previous_companies', e.target.value)} className="input w-full text-sm" placeholder="Google, Stripe, etc." />
            </div>
            <div>
              <label className="label">Notable Background</label>
              <input value={form.notable_background} onChange={e => update('notable_background', e.target.value)} className="input w-full text-sm" placeholder="YC W24, 2x founder, etc." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Source</label>
              <input value={form.source} onChange={e => update('source', e.target.value)} className="input w-full text-sm" placeholder="Density, referral, inbound, etc." />
            </div>
            <div>
              <label className="label">Next Action</label>
              <input value={form.next_action} onChange={e => update('next_action', e.target.value)} className="input w-full text-sm" placeholder="Schedule intro call" />
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving...' : 'Add Founder'}
          </button>
          <Link to="/pipeline" className="btn-secondary">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
