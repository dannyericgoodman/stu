import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import StuLogo from '../components/StuLogo';

const FEATURES = [
  'Automated founder discovery from configurable signals',
  'AI-scored, geography-weighted candidate pipeline',
  'Customizable pipeline stages with kanban and list views',
  'Multi-agent AI assessment (team, market, economics)',
  'Ask Stu — natural language queries across your pipeline',
  'Unlimited sourcing runs, founders, and assessments',
];

export default function Payment() {
  const { logout } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [seats, setSeats] = useState(null);

  useEffect(() => {
    api.getSeatAvailability().then(setSeats).catch(() => {});
  }, []);

  async function handleCheckout() {
    setLoading(true);
    setError('');
    try {
      const result = await api.createCheckoutSession();
      if (result.already_paid) {
        window.location.reload();
        return;
      }
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <StuLogo size={40} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Get access to Stu</h1>
          <p className="text-sm text-gray-500 mt-1">One payment. Yours to keep.</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          {/* Price */}
          <div className="text-center mb-6">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-4xl font-bold text-gray-900">$349</span>
            </div>
            <p className="text-sm text-gray-500 mt-1">One-time payment — no subscriptions, no recurring fees</p>
            {seats && (
              <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mt-3 inline-block">
                {seats.remaining > 0
                  ? `${seats.remaining} of ${seats.total} seats remaining`
                  : 'All seats are claimed'}
              </p>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-100 my-5" />

          {/* Features */}
          <div className="space-y-3 mb-6">
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-gray-700">{f}</span>
              </div>
            ))}
          </div>

          {/* BYOK note */}
          <div className="bg-gray-50 rounded-lg px-3 py-2.5 mb-5">
            <p className="text-xs text-gray-500 leading-relaxed">
              <span className="font-medium text-gray-600">Bring your own keys.</span>{' '}
              Stu uses your Exa and Anthropic API keys so you control costs and usage directly.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 mb-4">
              {error}
            </div>
          )}

          <button
            onClick={handleCheckout}
            disabled={loading}
            className="btn-primary w-full justify-center text-base py-3"
          >
            {loading ? 'Redirecting to checkout...' : 'Get access — $349'}
          </button>

          <div className="flex items-center justify-center gap-4 mt-4">
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-xs text-gray-400">Secure checkout via Stripe</span>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">
          <button
            onClick={logout}
            className="text-gray-500 hover:text-gray-700 underline"
          >
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
