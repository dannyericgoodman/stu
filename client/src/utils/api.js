const API_BASE = '/api';

// Public health/version check (no auth) — used to detect new deploys.
export function fetchAppVersion() {
  return fetch(`${API_BASE}/health`, { cache: 'no-store' })
    .then(r => r.json())
    .then(d => d.version)
    .catch(() => null);
}

function getToken() {
  return localStorage.getItem('stu_token');
}

export function setToken(token) {
  // Any auth transition (login, logout, session-expiry) can mean a different user on
  // this browser, so drop the persisted response cache — otherwise the next user could
  // see the previous user's cached inbox/pipeline for a beat before it revalidates.
  // Only fires on real auth changes; a normal reload of an already-logged-in session
  // does not call setToken, so the persisted cache survives reloads (the whole point).
  lsPurge();
  if (token) {
    localStorage.setItem('stu_token', token);
  } else {
    localStorage.removeItem('stu_token');
  }
}

export function getUser() {
  try {
    const raw = localStorage.getItem('stu_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    localStorage.removeItem('stu_user'); // corrupt value → clear, don't crash the app
    return null;
  }
}

export function setUser(user) {
  if (user) {
    localStorage.setItem('stu_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('stu_user');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Stale-while-revalidate, in ~30 lines instead of a dependency.
//
// Danny: "it's very laggy. Takes time to load info in." Every page owned a raw
// useState(null) + useEffect + fetch, so Home -> Pipeline -> Home was 8 requests
// where 4 would do, and every one of them repainted through a skeleton. Nothing
// was ever retained between route changes.
//
// The rule: a GET that's been seen recently returns its cached value SYNCHRONOUSLY
// on the next call and revalidates in the background. Navigation feels instant
// because the data is already there — which is what Linear and Superhuman are
// actually doing when they feel fast. It isn't a faster network, it's not
// throwing the answer away.
//
// Deliberately not react-query: this needs a Map and a timestamp, and the whole
// app is 4 screens. A cache invalidated by hand at 4 call sites is easier to
// reason about than a library nobody here has configured.
// ══════════════════════════════════════════════════════════════════════════
const CACHE = new Map(); // path -> { at, data, inflight }
const FRESH_MS = 30_000; // under 30s, don't even revalidate — he's just toggling

// ── Persist cached GETs across logins/reloads ──────────────────────────────
// The in-memory CACHE is empty on every fresh page load, so the FIRST visit to a
// slow screen (the Sourcing inbox — a heavy /pipeline/inbox query) blocks on the
// cold request, which is why it "takes forever, then populates when you come back":
// the second visit finds the warm cache. Persisting to localStorage makes that
// automatic — on login the screen shows the last-known data instantly (stale) and
// revalidates underneath. Best-effort: guarded by size, age, and try/catch so a
// quota error, private mode, or an oversized payload silently falls back to cold.
const LS_PREFIX = 'sg_cache:';
const LS_MAX_BYTES = 2_000_000;            // don't persist a single entry over ~2MB
const LS_MAX_AGE_MS = 12 * 60 * 60 * 1000; // ignore persisted entries older than 12h

function lsPurge() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
function lsSet(path, at, data) {
  let s;
  try {
    s = JSON.stringify({ at, data });
    if (s.length > LS_MAX_BYTES) { localStorage.removeItem(LS_PREFIX + path); return; }
    localStorage.setItem(LS_PREFIX + path, s);
  } catch {
    // Likely a full quota. Purge our own cache and retry once so persistence self-heals
    // instead of silently staying dead. (Also covers private mode / non-serialisable —
    // in which case the retry no-ops too. Persistence is a bonus, never load-bearing.)
    try { lsPurge(); if (s) localStorage.setItem(LS_PREFIX + path, s); } catch { /* give up quietly */ }
  }
}
function lsGet(path) {
  try {
    const s = localStorage.getItem(LS_PREFIX + path);
    if (!s) return null;
    const e = JSON.parse(s);
    if (!e || e.data === undefined || (Date.now() - (e.at || 0)) > LS_MAX_AGE_MS) return null;
    return { at: e.at, data: e.data };
  } catch { return null; }
}
function lsDel(path) { try { localStorage.removeItem(LS_PREFIX + path); } catch { /* ignore */ } }
// Store real data (never the cold in-flight placeholder) both in memory and on disk.
function cacheSet(path, data) { CACHE.set(path, { at: Date.now(), data }); lsSet(path, Date.now(), data); }

/** Drop cached GETs whose path contains `fragment`. Call after any write. */
export function invalidate(fragment = '') {
  for (const k of [...CACHE.keys()]) if (!fragment || k.includes(fragment)) { CACHE.delete(k); lsDel(k); }
  // Persisted entries with no live in-memory twin (e.g. seeded from a prior session
  // but not yet read this session) must be cleared too, or a stale row could survive
  // a mutation until its 12h expiry.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX) && (!fragment || key.slice(LS_PREFIX.length).includes(fragment))) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}

/**
 * Run a write, then invalidate. The single most likely way a hand-rolled cache
 * goes wrong is a mutation that forgets to clear it, so every write goes through
 * here rather than relying on anyone remembering at the call site.
 * Invalidates on success only — a failed write changed nothing.
 */
function after(promise, ...fragments) {
  return promise.then((r) => {
    for (const f of fragments.length ? fragments : ['']) invalidate(f);
    return r;
  });
}

/**
 * A cached GET. Returns cached data immediately when warm, and revalidates behind
 * it. `onUpdate` fires only if the revalidated payload actually differs, so a
 * background refresh never causes a pointless repaint.
 */
async function cachedGet(path, { onUpdate } = {}) {
  // Seed memory from the persisted cache on a cold miss, so the very first visit
  // after login shows last-known data instantly and revalidates underneath.
  if (!CACHE.has(path)) { const p = lsGet(path); if (p) CACHE.set(path, p); }
  const hit = CACHE.get(path);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (hit && age < FRESH_MS) return hit.data;

  // ── A COLD ENTRY IN FLIGHT IS NOT A "WARM BUT STALE" ENTRY ──
  // The cold path below parks { at: 0, data: undefined, inflight } in the cache and
  // returns the promise. A second caller arriving before it lands used to find that
  // entry, compute age = Date.now() - 0 (i.e. 56 years, definitively stale), fall
  // into the revalidate branch below, and return `hit.data` — which is undefined,
  // because the first request hasn't come back yet.
  //
  // React StrictMode double-invokes effects in dev, so the SECOND call is the one
  // whose .then() survives the cleanup. It set the page's state to undefined and the
  // Pipeline board sat on its skeleton forever, over a request that returned 200.
  //
  // Same shape as every other bug in this codebase: a record that claims to describe
  // something ("here is the cached data") while describing nothing. Dedupe onto the
  // inflight promise instead — which is what the cold path already intended.
  if (hit && hit.inflight && hit.data === undefined) return hit.inflight;

  if (hit) {
    // Warm but stale: hand back what we have, refresh underneath.
    if (!hit.inflight) {
      hit.inflight = request(path)
        .then((fresh) => {
          const changed = JSON.stringify(fresh) !== JSON.stringify(hit.data);
          cacheSet(path, fresh);
          if (changed && onUpdate) onUpdate(fresh);
          return fresh;
        })
        .catch(() => hit.data) // a failed revalidate must never blank a good screen
        .finally(() => { const c = CACHE.get(path); if (c) delete c.inflight; });
    }
    return hit.data;
  }

  // Cold: one request, and dedupe concurrent callers onto it.
  const inflight = request(path).then((data) => {
    cacheSet(path, data);
    return data;
  });
  CACHE.set(path, { at: 0, data: undefined, inflight });
  return inflight;
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    setToken(null);
    setUser(null);
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const e = new Error(err.error || 'Request failed');
    if (err.code) e.code = err.code; // preserve backend codes (no_key, spend_cap_exceeded, …)
    e.status = res.status;
    throw e;
  }

  return res.json();
}

export const api = {
  // Auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (name, email, password) => request('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  me: () => request('/auth/me'),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  invite: (email, name, role) => request('/auth/invite', { method: 'POST', body: JSON.stringify({ email, name, role }) }),
  team: () => request('/auth/team'),

  // Payments
  createCheckoutSession: () => request('/payments/create-checkout-session', { method: 'POST' }),
  getPaymentStatus: () => request('/payments/status'),

  // Admin
  adminDashboard: () => request('/admin/dashboard'),
  adminUsers: () => request('/admin/users'),
  adminUserDetail: (id) => request(`/admin/user/${id}`),
  adminDeleteUser: (id) => request(`/admin/user/${id}`, { method: 'DELETE' }),

  // Founders
  getFounders: (params) => request('/founders?' + new URLSearchParams(params || {})),
  getFounderStats: () => request('/founders/stats'),
  getFounder: (id) => request(`/founders/${id}`),
  createFounder: (data) => request('/founders', { method: 'POST', body: JSON.stringify(data) }),
  // Editing a founder changes the board (name, stage, deal_status) and the card.
  updateFounder: (id, data) => after(request(`/founders/${id}`, { method: 'PUT', body: JSON.stringify(data) }), '/pipeline'),
  deleteFounder: (id) => request(`/founders/${id}`, { method: 'DELETE' }),

  // Notes
  getNotes: (founderId) => request(`/notes/${founderId}`),
  createNote: (founderId, content) => request(`/notes/${founderId}`, { method: 'POST', body: JSON.stringify({ content }) }),
  updateNote: (noteId, content) => request(`/notes/${noteId}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteNote: (noteId) => request(`/notes/${noteId}`, { method: 'DELETE' }),

  // Sourcing
  getSourcingQueue: (params) => request('/sourcing/queue?' + new URLSearchParams(params || {})),
  getSourcingStarred: () => request('/sourcing/starred'),
  getSourcingStats: () => request('/sourcing/stats'),
  getSourcingRuns: () => request('/sourcing/runs'),
  // Triage mutates BOTH the inbox and the board — approving creates the company
  // card. A stale cache here would show a founder you just added as still
  // waiting, or worse, not on the pipeline. Invalidate both, always.
  approveSourced: (id) => after(request(`/sourcing/approve/${id}`, { method: 'POST' }), '/pipeline'),
  dismissSourced: (id) => after(request(`/sourcing/dismiss/${id}`, { method: 'POST' }), '/pipeline/inbox'),
  hideForeverSourced: (id) => after(request(`/sourcing/hide-forever/${id}`, { method: 'POST' }), '/pipeline/inbox'),
  starSourced: (id) => request(`/sourcing/star/${id}`, { method: 'POST' }),
  unstarSourced: (id) => request(`/sourcing/unstar/${id}`, { method: 'POST' }),
  triggerSourcing: () => request('/sourcing/run', { method: 'POST' }),
  getSourcingTasteProfile: () => request('/sourcing/taste-profile'),

  // Calls
  getCalls: (founderId) => request(`/calls/${founderId}`),
  logCall: (founderId, transcript) => request(`/calls/${founderId}`, { method: 'POST', body: JSON.stringify({ transcript }) }),

  // Assessments
  getAssessments: () => request('/assessments'),
  getAssessment: (id) => request(`/assessments/${id}`),
  // Danny's call. Invalidates the assessment (his decision unlocks Stu's column),
  // the pipeline (the Call column and the derived funnel stage), and today (the
  // undecided lane and the predictions-due check).
  createDecision: (body) =>
    after(request('/today/decisions', { method: 'POST', body: JSON.stringify(body) }), '/assessments', '/pipeline', '/today'),
  deleteDecision: (id) =>
    after(request(`/today/decisions/${id}`, { method: 'DELETE' }), '/assessments', '/pipeline', '/today'),
  getAssessmentInputs: (id) => request(`/assessments/${id}/inputs`),
  getAssessmentTasteDivergence: (id) => request(`/assessments/${id}/taste-divergence`),
  getAssessmentGroup: (groupId) => request(`/assessments/group/${groupId}`),
  createAssessment: (data) => request('/assessments', { method: 'POST', body: JSON.stringify(data) }),
  updateAssessment: (id, data) => request(`/assessments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAssessment: (id) => request(`/assessments/${id}`, { method: 'DELETE' }),
  cancelAssessment: (id) => request(`/assessments/${id}/cancel`, { method: 'POST' }),
  rerunAssessment: (id, data) => request(`/assessments/${id}/rerun`, { method: 'POST', body: JSON.stringify(data) }),
  getStewardOperator: (id) => request(`/assessments/${id}/steward-operator`),
  runStewardOperator: (id) => request(`/assessments/${id}/steward-operator`, { method: 'POST' }),
  pushAssessmentToNotion: (id) => request(`/assessments/${id}/push-to-notion`, { method: 'POST' }),

  // Memos
  getMemos: (founderId) => request(`/memos/${founderId}`),
  generateMemo: (founderId) => request(`/memos/${founderId}`, { method: 'POST' }),
  deleteMemo: (founderId, memoId) => request(`/memos/${founderId}/${memoId}`, { method: 'DELETE' }),

  // Files
  getFiles: (founderId) => request(`/files/${founderId}`),
  addFile: (founderId, data) => request(`/files/${founderId}`, { method: 'POST', body: JSON.stringify(data) }),
  deleteFile: (founderId, fileId) => request(`/files/${founderId}/${fileId}`, { method: 'DELETE' }),

  // Import
  uploadFile: async (file) => {
    const token = getToken();
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/import/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });
    if (res.status === 401) { setToken(null); setUser(null); window.location.href = '/login'; throw new Error('Session expired'); }
    if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Upload failed' })); throw new Error(err.error || 'Upload failed'); }
    return res.json();
  },
  remapImport: (rows, mappings) => request('/import/remap', { method: 'POST', body: JSON.stringify({ rows, mappings }) }),
  confirmImport: (founders, source) => request('/import/confirm', { method: 'POST', body: JSON.stringify({ founders, source }) }),
  enrichImported: (founderIds) => request('/import/enrich', { method: 'POST', body: JSON.stringify({ founderIds }) }),
  getImportFields: () => request('/import/fields'),

  // Search
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),

  // AI
  fitScore: (founderId) => request('/ai/fit-score', { method: 'POST', body: JSON.stringify({ founderId }) }),

  // Settings
  getSettings: () => request('/settings'),
  updateSetting: (key, value) => request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  testAnthropic: () => request('/settings/test-anthropic'),
  getPipelineConfig: () => request('/settings/pipeline-config'),
  getSourcingCriteria: () => request('/settings/sourcing-criteria'),
  completeOnboarding: () => request('/settings/complete-onboarding', { method: 'POST' }),

  // Home dashboard

  // ── Today — the surface ──
  // Pipeline — the front door. One connected read over the founders spine.
  // Cached: toggling track or bouncing Home <-> Pipeline must not repaint through
  // a skeleton to arrive at rows we already had. 136KB a visit, now 0 when warm.
  getPipeline: (params, opts) => cachedGet('/pipeline?' + new URLSearchParams(params || {}), opts),

  // ── The merged board's two writes ──
  // Separate from updateFounder because these are not field edits: each one also
  // pushes to the team's Airtable base and returns what Airtable said. The caller
  // has to be able to read `.airtable` and tell Danny if the push was refused.
  setPipelineStage: (id, stage) =>
    after(request(`/pipeline/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) }), '/pipeline'),
  setPipelineTracks: (id, tracks) =>
    after(request(`/pipeline/${id}/tracks`, { method: 'PATCH', body: JSON.stringify({ tracks }) }), '/pipeline'),

  // Fold a co-founder's row into their company's card, or (by: null) put it back on
  // the board. Invalidates the board AND the card — the card gains/loses a
  // co-founder block, and a stale card would show a fold that isn't there.
  setRepresentedBy: (id, by) =>
    after(request(`/pipeline/${id}/represented-by`, { method: 'PATCH', body: JSON.stringify({ by }) }), '/pipeline'),
  getPipelineCompany: (id, opts) => cachedGet(`/pipeline/${id}`, opts),
  // The card's writes. Each invalidates the card AND the board — editing a
  // company name or stage changes both, and a cache that forgets that shows him
  // an edit that appears to have not saved.
  updatePipelineCompany: (id, body) =>
    after(request(`/pipeline/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), '/pipeline'),
  // Create / delete the cards themselves, from the board where the work happens.
  createPipelineCompany: (body) => after(request('/pipeline', { method: 'POST', body: JSON.stringify(body) }), '/pipeline'),
  deletePipelineCompany: (id) => after(request(`/pipeline/${id}`, { method: 'DELETE' }), '/pipeline'),
  restorePipelineCompany: (id) => after(request(`/pipeline/${id}/restore`, { method: 'POST' }), '/pipeline'),

  enrichPipelineCompany: (id) => after(request(`/pipeline/${id}/enrich`, { method: 'POST' }), `/pipeline/${id}`),
  // The free read — Form D + open roles. Separate call from enrich because it
  // spends nothing and needs no LinkedIn URL.
  readPublicRecord: (id) => after(request(`/pipeline/${id}/public`, { method: 'POST' }), `/pipeline/${id}`),

  // ── The source log: everything Danny feeds a company. ──
  // These endpoints existed for hours with no UI on top — the honesty gate, the
  // extractor and four ingest pipes were reachable only by curl. A substrate
  // nobody can drive is a substrate that doesn't exist.
  getCompanySources: (id, opts) => cachedGet(`/companies/${id}/sources`, opts),
  addSourceUrl: (id, url) =>
    after(request(`/companies/${id}/sources/url`, { method: 'POST', body: JSON.stringify({ url }) }), `/companies/${id}`),
  addSourceNote: (id, body) =>
    after(request(`/companies/${id}/sources/note`, { method: 'POST', body: JSON.stringify(body) }), `/companies/${id}`),
  // multipart — NOT request(), which forces Content-Type: application/json and
  // would strip the boundary, so multer sees no file and every upload 400s.
  uploadDeck: async (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_BASE}/companies/${id}/sources/deck`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: fd,
    });
    if (res.status === 401) { setToken(null); setUser(null); window.location.href = '/login'; throw new Error('Session expired'); }
    const d = await res.json().catch(() => ({ error: 'Upload failed' }));
    if (!res.ok) { const e = new Error(d.error || 'Upload failed'); e.detail = d.detail; throw e; }
    invalidate(`/companies/${id}`);
    return d;
  },
  // Data room — many files at once. Same multipart caveat as uploadDeck.
  uploadDataRoom: async (id, files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${API_BASE}/companies/${id}/sources/dataroom`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: fd,
    });
    if (res.status === 401) { setToken(null); setUser(null); window.location.href = '/login'; throw new Error('Session expired'); }
    const d = await res.json().catch(() => ({ error: 'Upload failed' }));
    if (!res.ok) { const e = new Error(d.error || 'Upload failed'); e.detail = d.detail; throw e; }
    invalidate(`/companies/${id}`);
    return d;
  },
  extractSignals: (id, sourceId) =>
    after(request(`/companies/${id}/sources/${sourceId}/extract`, { method: 'POST' }), `/companies/${id}`),
  deleteSource: (id, sourceId) =>
    after(request(`/companies/${id}/sources/${sourceId}`, { method: 'DELETE' }), `/companies/${id}`),
  // Run a conviction read from the sources already on the card — no re-uploading.
  runCardRead: (id) =>
    after(request(`/companies/${id}/read`, { method: 'POST' }), '/pipeline', '/assessments'),
  // Triage — the sourcing feedback loop. Invalidates /pipeline so the row's own
  // verdict comes back from the server rather than being guessed locally.
  triageFounder: (id, verdict, reason) =>
    after(request(`/pipeline/${id}/triage`, { method: 'POST', body: JSON.stringify({ verdict, reason }) }),
      '/pipeline', '/pipeline/learning'),
  getPipelineLearning: () => request('/pipeline/learning'),
  addCompanyNote: (id, body) =>
    after(request(`/pipeline/${id}/notes`, { method: 'POST', body: JSON.stringify(body) }), `/pipeline/${id}`),
  updateCompanyNote: (id, noteId, body) =>
    after(request(`/pipeline/${id}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(body) }), `/pipeline/${id}`),
  deleteCompanyNote: (id, noteId) =>
    after(request(`/pipeline/${id}/notes/${noteId}`, { method: 'DELETE' }), `/pipeline/${id}`),
  // The inbox — the seam between the sourcing engine and the tracker. Approving
  // promotes in one transaction and keeps the source chain intact.
  getPipelineInbox: (params, opts) => cachedGet('/pipeline/inbox?' + new URLSearchParams(params || {}), opts),
  // Funnel STATE for the Home dashboard — never a pipeline-size scoreboard.
  getPipelineStats: (opts) => cachedGet('/pipeline/stats', opts),

  // The attention engine — cross-stage integrity checks, computed from pipeline state.
  getAttention: (opts) => cachedGet('/today/attention', opts),

  getToday: (opts) => cachedGet('/today', opts),
  // What Danny can set running from Home, on what, and what's running now. Read-only —
  // dispatch goes through each product's own existing route so there is one code path
  // per agent, not a home-screen copy of three workflows.
  getAgents: (opts) => cachedGet('/today/agents', opts),
  // The morning ranked list. Capped and evaluated at read time — see routes/pipeline.js.
  getShortlist: (opts) => cachedGet('/pipeline/shortlist', opts),

  // The memo download. A plain <a href> cannot carry the Bearer token, so this
  // fetches the bytes, hands the browser a blob URL, and revokes it — otherwise the
  // request 401s and the button looks broken for a reason nobody can see.
  downloadMemoDocx: async (assessmentId) => {
    const r = await fetch(`${API_BASE}/assessments/${assessmentId}/memo.docx`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!r.ok) {
      let msg = `Export failed (${r.status})`;
      try { const b = await r.json(); if (b.error) msg = b.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    // Prefer the filename the server chose (RFC 5987), so the em dash survives.
    const cd = r.headers.get('Content-Disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/i.exec(cd);
    const filename = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : 'Investment Memo.docx');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url; el.download = filename;
    document.body.appendChild(el); el.click(); el.remove();
    URL.revokeObjectURL(url);
    return filename;
  },
  addTodayItem: (body) => after(request('/today/items', { method: 'POST', body: JSON.stringify(body) }), '/today'),
  updateTodayItem: (id, body) => after(request(`/today/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), '/today'),
  deleteTodayItem: (id) => after(request(`/today/items/${id}`, { method: 'DELETE' }), '/today'),
  decide: (body) => request('/today/decisions', { method: 'POST', body: JSON.stringify(body) }),
  getCalibration: () => request('/today/decisions/calibration'),
  resolveDecision: (id, outcome) => request(`/today/decisions/${id}/resolve`, { method: 'PATCH', body: JSON.stringify({ outcome }) }),
  getCommitments: (days) => request(`/today/commitments${days ? `?days=${days}` : ''}`),
  getFounderDelta: (founderId) => request(`/today/commitments/founder/${founderId}`),
  closeCommitment: (id, status) => request(`/today/commitments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  // Healthcheck board
  getHealthFull: () => request('/health/full'),
  checkNotionDrift: (repair) => request('/health/drift' + (repair ? '?repair=1' : '')),

  // Newsletter / Daily Brief
  getNewsletterBrief: (days) => request('/newsletter/brief' + (days ? `?days=${days}` : '')),
  getNewsletterStatus: () => request('/newsletter/status'),
  syncNewsletter: () => request('/newsletter/sync', { method: 'POST' }),
  dismissNewsletterItem: (id) => request(`/newsletter/${id}`, { method: 'DELETE' }),
  getNewsletterSources: () => request('/newsletter/sources'),
  addNewsletterSource: (data) => request('/newsletter/sources', { method: 'POST', body: JSON.stringify(data) }),
  updateNewsletterSource: (id, data) => request(`/newsletter/sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNewsletterSource: (id) => request(`/newsletter/sources/${id}`, { method: 'DELETE' }),
  getBriefToday: () => request('/newsletter/today'),
  rebuildBrief: () => request('/newsletter/rebuild', { method: 'POST' }),
  seedBriefDefaults: () => request('/newsletter/seed-defaults', { method: 'POST' }),
  sendBriefNow: () => request('/newsletter/send-now', { method: 'POST' }),
  getBriefDigestPreview: () => request('/newsletter/digest-preview'),
  getBriefArchive: () => request('/newsletter/archive'),

  // Stu tool-use chat
  stuChat: async function* (messages, mode) {
    const token = getToken();
    const res = await fetch(`${API_BASE}/stu/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(mode ? { messages, mode } : { messages })
    });

    if (res.status === 401) {
      setToken(null);
      setUser(null);
      window.location.href = '/login';
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      yield { type: 'error', error: err.error || `Server error (${res.status})` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            yield data;
          } catch {}
        }
      }
    }
  },

  // Talent — Portfolio companies
  getTalentPortfolio: () => request('/talent/portfolio'),
  getTalentCompany: (id) => request(`/talent/portfolio/${id}`),
  createTalentCompany: (data) => request('/talent/portfolio', { method: 'POST', body: JSON.stringify(data) }),
  updateTalentCompany: (id, data) => request(`/talent/portfolio/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTalentCompany: (id) => request(`/talent/portfolio/${id}`, { method: 'DELETE' }),
  bulkDeleteTalentCompanies: (ids) => request('/talent/portfolio/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  // Talent — Roles
  getTalentRoles: (params) => request('/talent/roles?' + new URLSearchParams(params || {})),
  getTalentRole: (id) => request(`/talent/roles/${id}`),
  getRoleLastRun: (roleId) => request(`/talent/sourcing/last-run/${roleId}`),
  createTalentRole: (data) => request('/talent/roles', { method: 'POST', body: JSON.stringify(data) }),
  updateTalentRole: (id, data) => request(`/talent/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTalentRole: (id) => request(`/talent/roles/${id}`, { method: 'DELETE' }),
  bulkUpdateTalentRoles: (ids, patch) => request('/talent/roles/bulk/update', { method: 'POST', body: JSON.stringify({ ids, patch }) }),
  bulkDeleteTalentRoles: (ids) => request('/talent/roles/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  // Talent — Candidates
  getTalentCandidates: (params) => request('/talent/candidates?' + new URLSearchParams(params || {})),
  getTalentCandidate: (id) => request(`/talent/candidates/${id}`),
  getTalentCandidateStats: () => request('/talent/candidates/stats'),
  createTalentCandidate: (data) => request('/talent/candidates', { method: 'POST', body: JSON.stringify(data) }),
  updateTalentCandidate: (id, data) => request(`/talent/candidates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTalentCandidate: (id) => request(`/talent/candidates/${id}`, { method: 'DELETE' }),
  starTalentCandidate: (id) => request(`/talent/candidates/${id}/star`, { method: 'POST' }),
  unstarTalentCandidate: (id) => request(`/talent/candidates/${id}/unstar`, { method: 'POST' }),
  dismissTalentCandidate: (id) => request(`/talent/candidates/${id}/dismiss`, { method: 'POST' }),
  shortlistTalentCandidate: (id) => request(`/talent/candidates/${id}/shortlist`, { method: 'POST' }),
  bulkUpdateTalentCandidates: (ids, patch) => request('/talent/candidates/bulk/update', { method: 'POST', body: JSON.stringify({ ids, patch }) }),
  bulkDeleteTalentCandidates: (ids) => request('/talent/candidates/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  // Talent — Matches
  getTalentMatches: (params) => request('/talent/matches?' + new URLSearchParams(params || {})),
  getTalentMatch: (id) => request(`/talent/matches/${id}`),
  getTalentMatchStats: (params) => request('/talent/matches/stats?' + new URLSearchParams(params || {})),
  updateTalentMatch: (id, data) => request(`/talent/matches/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTalentMatch: (id) => request(`/talent/matches/${id}`, { method: 'DELETE' }),
  bulkUpdateTalentMatches: (ids, patch) => request('/talent/matches/bulk/update', { method: 'POST', body: JSON.stringify({ ids, patch }) }),

  // Talent — Criteria
  getTalentCriteria: (scope = 'global') => request(`/talent/criteria?scope=${scope}`),
  updateTalentCriteria: (key, value, scope = 'global') => request(`/talent/criteria/${key}?scope=${scope}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  resetTalentCriteria: (key, scope = 'global') => request(`/talent/criteria/${key}?scope=${scope}`, { method: 'DELETE' }),

  // Talent — Sourcing
  getTalentSourcingStats: () => request('/talent/sourcing/stats'),
  getTalentSourcingRuns: () => request('/talent/sourcing/runs'),
  triggerTalentSourcing: (opts = {}) => {
    // Back-compat: old call was triggerTalentSourcing(true) for fullSweep
    const body = typeof opts === 'boolean' ? { fullSweep: opts } : opts;
    return request('/talent/sourcing/run', { method: 'POST', body: JSON.stringify(body) });
  },
  triggerTalentMatching: (params = {}) => request('/talent/sourcing/match', { method: 'POST', body: JSON.stringify(params) }),

  // Talent — Trash
  getTalentTrash: () => request('/talent/trash'),
  restoreTalentTrash: (type, ids) => request('/talent/trash/restore', { method: 'POST', body: JSON.stringify({ type, ids }) }),
  purgeTalentTrash: (type, ids) => request('/talent/trash/purge', { method: 'POST', body: JSON.stringify({ type, ids }) }),
  emptyTalentTrash: () => request('/talent/trash/empty', { method: 'POST' }),

  // ── Hiring (greenfield — "know anyone good for this role?") ──
  getHiringCompanies: () => request('/hiring/companies'),
  pickHiringCompanies: (search = '') => request('/hiring/companies/pick?' + new URLSearchParams(search ? { search } : {})),
  getHiringRoles: (params) => request('/hiring/roles?' + new URLSearchParams(params || {})),
  getHiringRole: (id) => request(`/hiring/roles/${id}`),
  updateHiringRole: (id, data) => request(`/hiring/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteHiringRole: (id) => request(`/hiring/roles/${id}`, { method: 'DELETE' }),
  exportHiringRole: (id, status) => request(`/hiring/roles/${id}/export?` + new URLSearchParams(status ? { status } : {})),
  // JD ingest — sentence/link go as JSON; a PDF goes as multipart (same caveat as
  // uploadDeck: don't force application/json, or multer sees no file).
  ingestHiringRole: async (payload, file) => {
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      for (const [k, v] of Object.entries(payload || {})) if (v != null) fd.append(k, v);
      const res = await fetch(`${API_BASE}/hiring/roles/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd });
      if (res.status === 401) { setToken(null); setUser(null); window.location.href = '/login'; throw new Error('Session expired'); }
      const d = await res.json().catch(() => ({ error: 'Ingest failed' }));
      if (!res.ok) { const e = new Error(d.error || 'Ingest failed'); e.detail = d.detail; throw e; }
      return d;
    }
    return request('/hiring/roles/ingest', { method: 'POST', body: JSON.stringify(payload) });
  },
  getHiringCandidates: (params) => request('/hiring/candidates?' + new URLSearchParams(params || {})),
  getHiringMatches: (params) => request('/hiring/matches?' + new URLSearchParams(params || {})),
  updateHiringMatch: (id, data) => request(`/hiring/matches/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteHiringMatch: (id) => request(`/hiring/matches/${id}`, { method: 'DELETE' }),
  runHiringMatch: (roleId, opts = {}) => request('/hiring/matches/run', { method: 'POST', body: JSON.stringify({ role_id: roleId, ...opts }) }),
  sourceHiringRole: (roleId) => request(`/hiring/roles/${roleId}/source`, { method: 'POST' }),
  getHiringSourceStatus: (roleId) => request(`/hiring/roles/${roleId}/source-status`),
  runHiringDiscovery: (roleId, opts = {}) => request('/hiring/discovery/run', { method: 'POST', body: JSON.stringify({ role_id: roleId, ...opts }) }),
  importHiringWarm: () => request('/hiring/warm/import', { method: 'POST' }),
  getHiringWarmStatus: () => request('/hiring/warm/status'),

  // MCP / API access
  getMcpInfo: () => request('/mcp/info'),
  getMcpTokens: () => request('/mcp/tokens'),
  createMcpToken: (label, scopes) => request('/mcp/tokens', { method: 'POST', body: JSON.stringify({ label, scopes }) }),
  revokeMcpToken: (id) => request(`/mcp/tokens/${id}`, { method: 'DELETE' }),

  // Active discovery + outreach
  discover: (data) => request('/discover', { method: 'POST', body: JSON.stringify(data) }),
  draftOutreach: (data) => request('/outreach/draft', { method: 'POST', body: JSON.stringify(data) }),

  // Signal monitors
  getMonitorTypes: () => request('/monitors/types'),
  getMonitors: () => request('/monitors'),
  createMonitor: (data) => request('/monitors', { method: 'POST', body: JSON.stringify(data) }),
  deleteMonitor: (id) => request(`/monitors/${id}`, { method: 'DELETE' }),
  setMonitorEnabled: (id, enabled) => request(`/monitors/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  runMonitors: () => request('/monitors/run', { method: 'POST' }),
  getMonitorHits: (params) => request('/monitors/hits?' + new URLSearchParams(params || {})),
  dismissMonitorHit: (id) => request(`/monitors/hits/${id}/dismiss`, { method: 'POST' }),

  // Streaming chat (sidebar)
  chat: async function* (messages, context) {
    const token = getToken();
    const res = await fetch(`${API_BASE}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ messages, context })
    });

    if (res.status === 401) { setToken(null); setUser(null); window.location.href = '/login'; return; }
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: 'Chat unavailable' }));
      throw new Error(err.error || 'Chat unavailable');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            yield data;
          } catch {}
        }
      }
    }
  }
};
