import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import StuLogo from '../components/StuLogo';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <StuLogo size={40} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Stu</h1>
          <p className="text-sm text-gray-500 mt-1">Founder Sourcing OS</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 shadow-sm">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <div>
            <label className="label">Email</label>
            <input
              type="email"
              name="email"
              id="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="input w-full"
              placeholder="you@example.com"
              required
            />
          </div>

          <div>
            <label className="label">Password</label>
            <input
              type="password"
              name="password"
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="input w-full"
              required
            />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-4">
          Don't have an account?{' '}
          <Link to="/signup" className="text-blue-600 hover:text-blue-700 font-medium">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
