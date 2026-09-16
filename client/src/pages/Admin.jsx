import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

function StatCard({ label, value, sub }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function FunnelBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-24 text-right">{label}</span>
      <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-700 w-16">{count} ({pct}%)</span>
    </div>
  );
}

function TimeAgo({ date }) {
  if (!date) return <span className="text-gray-400">Never</span>;
  const d = new Date(date);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return <span>{diff}s ago</span>;
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m ago</span>;
  if (diff < 86400) return <span>{Math.floor(diff / 3600)}h ago</span>;
  if (diff < 604800) return <span>{Math.floor(diff / 86400)}d ago</span>;
  return <span>{d.toLocaleDateString()}</span>;
}

function KeyBadge({ name }) {
  const colors = {
    exa: 'bg-blue-50 text-blue-700',
    anthropic: 'bg-purple-50 text-purple-700',
    enrichlayer: 'bg-amber-50 text-amber-700',
    github: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors[name] || 'bg-gray-100 text-gray-600'}`}>
      {name}
    </span>
  );
}

export default function Admin() {
  const { user: currentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState(null);
  const [users, setUsers] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetail, setUserDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [dash, userList] = await Promise.all([
          api.adminDashboard(),
          api.adminUsers(),
        ]);
        setDashboard(dash);
        setUsers(userList);
      } catch (err) {
        setError(err.message || 'Failed to load admin data');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function loadUserDetail(userId) {
    setSelectedUser(userId);
    setDetailLoading(true);
    try {
      const detail = await api.adminUserDetail(userId);
      setUserDetail(detail);
    } catch (err) {
      setUserDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleDeleteUser(userId, userName) {
    // Open the in-app confirmation modal (native window.confirm is unreliable
    // in automated browsers and offers poor UX).
    setDeleteError('');
    setDeleteTarget({ id: userId, name: userName });
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.adminDeleteUser(deleteTarget.id);
      setUsers(prev => prev.filter(u => u.id !== deleteTarget.id));
      setSelectedUser(null);
      setUserDetail(null);
      setDeleteTarget(null);
      // Refresh dashboard metrics
      const dash = await api.adminDashboard();
      setDashboard(dash);
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete user');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-gray-500">Loading admin panel...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-red-600">{error}</div>
      </div>
    );
  }

  const { metrics, funnel, activity } = dashboard;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: `Users (${metrics.totalUsers})` },
  ];

  return (
    <>
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Admin</h1>
        <p className="text-sm text-gray-500 mt-1">Platform metrics and user management.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); setSelectedUser(null); }}
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

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Key Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Total Users" value={metrics.totalUsers} />
            <StatCard label="Paid Users" value={metrics.paidUsers} sub={`${funnel.conversion_rate}% conversion`} />
            <StatCard label="Revenue" value={`$${metrics.totalRevenue.toLocaleString()}`} sub="Lifetime" />
            <StatCard label="Onboarded" value={metrics.completedOnboarding} />
          </div>

          {/* Conversion Funnel */}
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Conversion Funnel</h2>
            <div className="space-y-3">
              <FunnelBar label="Registered" count={funnel.registered} total={funnel.registered} color="bg-gray-300" />
              <FunnelBar label="Paid" count={funnel.paid} total={funnel.registered} color="bg-blue-500" />
              <FunnelBar label="Onboarded" count={funnel.onboarded} total={funnel.registered} color="bg-emerald-500" />
            </div>
          </div>

          {/* Platform Activity */}
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Platform Activity (All Users)</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500">Pipeline Founders</p>
                <p className="text-lg font-semibold text-gray-900">{activity.totalFounders.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Sourced Candidates</p>
                <p className="text-lg font-semibold text-gray-900">{activity.totalSourced.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Assessments Run</p>
                <p className="text-lg font-semibold text-gray-900">{activity.totalAssessments.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Sourcing Runs</p>
                <p className="text-lg font-semibold text-gray-900">{activity.totalSourcingRuns.toLocaleString()}</p>
              </div>
            </div>
          </div>

          {/* Signup Trend */}
          {dashboard.signupsByDay.length > 0 && (
            <div className="card p-6">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">Signups (Last 30 Days)</h2>
              <div className="flex items-end gap-1 h-24">
                {dashboard.signupsByDay.map((d, i) => {
                  const max = Math.max(...dashboard.signupsByDay.map(x => x.count));
                  const height = max > 0 ? (d.count / max) * 100 : 0;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.day}: ${d.count}`}>
                      <div className="w-full bg-blue-500 rounded-t" style={{ height: `${Math.max(height, 4)}%` }} />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-2">
                <span className="text-[10px] text-gray-400">{dashboard.signupsByDay[0]?.day}</span>
                <span className="text-[10px] text-gray-400">{dashboard.signupsByDay[dashboard.signupsByDay.length - 1]?.day}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="flex gap-6">
          {/* User List */}
          <div className={`${selectedUser ? 'w-1/2' : 'w-full'} transition-all`}>
            <div className="card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2.5">User</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2.5">Status</th>
                    <th className="text-left text-xs font-medium text-gray-500 px-4 py-2.5">API Keys</th>
                    <th className="text-right text-xs font-medium text-gray-500 px-4 py-2.5">Usage</th>
                    <th className="text-right text-xs font-medium text-gray-500 px-4 py-2.5">Last Active</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr
                      key={u.id}
                      onClick={() => loadUserDetail(u.id)}
                      className={`border-b border-gray-50 cursor-pointer transition-colors ${
                        selectedUser === u.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{u.name}</p>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.has_paid ? (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">Paid</span>
                          ) : (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Unpaid</span>
                          )}
                          {u.onboarding_complete ? (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Active</span>
                          ) : (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Setup</span>
                          )}
                          {u.role === 'admin' && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">Admin</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.api_keys_configured.length > 0
                            ? u.api_keys_configured.map(k => <KeyBadge key={k} name={k} />)
                            : <span className="text-xs text-gray-400">None</span>
                          }
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <p className="text-xs text-gray-700">{u.founder_count} founders</p>
                        <p className="text-xs text-gray-400">{u.sourced_count} sourced · {u.assessment_count} assessed</p>
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-gray-500">
                        <TimeAgo date={u.last_login} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* User Detail Panel */}
          {selectedUser && (
            <div className="w-1/2">
              {detailLoading ? (
                <div className="card p-6 text-center text-sm text-gray-500">Loading...</div>
              ) : userDetail ? (
                <div className="space-y-4">
                  {/* User Info */}
                  <div className="card p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-900">{userDetail.user.name}</h3>
                      <button onClick={() => setSelectedUser(null)} className="text-gray-400 hover:text-gray-600">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="space-y-1.5 text-xs">
                      <p><span className="text-gray-500">Email:</span> <span className="text-gray-900">{userDetail.user.email}</span></p>
                      <p><span className="text-gray-500">Joined:</span> <span className="text-gray-900">{new Date(userDetail.user.created_at).toLocaleDateString()}</span></p>
                      {userDetail.user.payment_date && (
                        <p><span className="text-gray-500">Paid:</span> <span className="text-gray-900">{new Date(userDetail.user.payment_date).toLocaleDateString()}</span></p>
                      )}
                      {userDetail.user.stripe_customer_id && (
                        <p><span className="text-gray-500">Stripe:</span> <span className="text-gray-900 font-mono">{userDetail.user.stripe_customer_id}</span></p>
                      )}
                    </div>

                    {/* Delete button — not for your own account */}
                    {userDetail.user.id !== currentUser?.id && (
                      <button
                        onClick={() => handleDeleteUser(userDetail.user.id, userDetail.user.name)}
                        className="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-lg hover:bg-red-100 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                        Remove user and all data
                      </button>
                    )}
                  </div>

                  {/* Sourcing Criteria */}
                  {Object.keys(userDetail.criteria).length > 0 && (
                    <div className="card p-5">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Sourcing Criteria</h3>
                      <div className="space-y-2">
                        {Object.entries(userDetail.criteria).map(([key, val]) => (
                          <div key={key} className="flex items-start gap-2">
                            <span className="text-xs text-gray-500 min-w-[120px]">{key.replace('sourcing_', '').replace(/_/g, ' ')}</span>
                            <span className="text-xs text-gray-900">
                              {Array.isArray(val) ? val.join(', ') || '—' : typeof val === 'string' ? val : JSON.stringify(val)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent Sourcing Runs */}
                  {userDetail.recentRuns.length > 0 && (
                    <div className="card p-5">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Sourcing Runs</h3>
                      <div className="space-y-2">
                        {userDetail.recentRuns.map(r => (
                          <div key={r.id} className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">{new Date(r.run_at).toLocaleDateString()}</span>
                            <span className="text-gray-700">
                              {r.founders_found} found · {r.founders_added} added · {r.founders_deduplicated} deduped
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent Founders */}
                  {userDetail.recentFounders.length > 0 && (
                    <div className="card p-5">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Founders</h3>
                      <div className="space-y-1.5">
                        {userDetail.recentFounders.map(f => (
                          <div key={f.id} className="flex items-center justify-between text-xs">
                            <span className="text-gray-900 font-medium">{f.name}</span>
                            <span className="text-gray-500">{f.company || f.stage || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="card p-6 text-center text-sm text-gray-500">Failed to load user details</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative card p-6 w-full max-w-sm">
            <h3 className="text-sm font-semibold text-gray-900">Delete user?</h3>
            <p className="mt-2 text-sm text-gray-600">
              Permanently delete <span className="font-medium text-gray-900">{deleteTarget.name}</span> and all their data? This cannot be undone.
            </p>
            {deleteError && (
              <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{deleteError}</p>
            )}
            <div className="mt-5 flex gap-2 justify-end">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-3 py-2 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteUser}
                disabled={deleting}
                className="px-3 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
