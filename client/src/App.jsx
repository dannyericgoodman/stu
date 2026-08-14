import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';
import Layout from './components/Layout';

// ══════════════════════════════════════════════════════════════════════════
// EAGER — the three screens Danny actually opens, plus auth.
//
// Everything else is lazy. This file used to statically import all 24 pages, so
// AssessmentDetail (73KB), Settings (46KB), FounderDetail (45KB), Releases
// (33KB), Assess (32KB) and the entire talent/* tree — ~250KB of source for
// pages he isn't looking at — had to be parsed before Home could paint.
//
// Paired with gzip on the server (593KB -> 160KB), first load goes from ~790KB
// to roughly 90KB. That, not the SQL, is "it's very laggy."
// ══════════════════════════════════════════════════════════════════════════
import Login from './pages/Login';
import Home from './pages/Home';
import Sourcing from './pages/Sourcing';
import Pipeline from './pages/Pipeline';

// ── LAZY — everything below loads on first visit to its route ──
const Landing = lazy(() => import('./pages/Landing'));
const Signup = lazy(() => import('./pages/Signup'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
// The company card — the destination from Pipeline. Replaces FounderDetail,
// which was built around a founder row rather than the company Danny is tracking.
// FounderDetail stays on disk and routed at /founders/legacy/:id until he
// confirms nothing in its 720 lines is worth salvaging.
const CompanyCard = lazy(() => import('./pages/CompanyCard'));
const FounderDetail = lazy(() => import('./pages/FounderDetail'));
const AddFounder = lazy(() => import('./pages/AddFounder'));
const Assess = lazy(() => import('./pages/Assess'));
// The Read — two columns that never merge, blind-first. Replaces AssessmentDetail,
// which was 1,541 lines with zero inputs and a "Personal conviction / Unanswered"
// slot that rendered the same on every assessment forever. The old page stays
// routed at /assess/:id/full until Danny confirms nothing in it is worth keeping —
// it holds the depth layer and the materials list this doesn't surface yet.
const Read = lazy(() => import('./pages/Read'));
const AssessmentDetail = lazy(() => import('./pages/AssessmentDetail'));
const AskStu = lazy(() => import('./pages/AskStu'));
// Discover is gone — /discover redirects to /sourcing. It was a search box you had
// to operate whose engine never once ran, and Harmonic's own lesson is that the
// alert is the product and the search bar is its config UI. The file stays on disk
// until Danny confirms nothing in it is worth salvaging.
const Placeholder = lazy(() => import('./pages/Placeholder'));
const Settings = lazy(() => import('./pages/Settings'));
const Brief = lazy(() => import('./pages/Brief'));
const Releases = lazy(() => import('./pages/Releases'));
const Health = lazy(() => import('./pages/Health'));
const Admin = lazy(() => import('./pages/Admin'));
const HiringHome = lazy(() => import('./pages/hiring/HiringHome'));
const HiringRole = lazy(() => import('./pages/hiring/HiringRole'));
const TalentLayout = lazy(() => import('./components/TalentLayout'));
const TalentHome = lazy(() => import('./pages/talent/TalentHome'));
const TalentCriteria = lazy(() => import('./pages/talent/TalentCriteria'));
const TalentPortfolio = lazy(() => import('./pages/talent/TalentPortfolio'));
const TalentPortfolioDetail = lazy(() => import('./pages/talent/TalentPortfolioDetail'));
const TalentRoles = lazy(() => import('./pages/talent/TalentRoles'));
const TalentRoleDetail = lazy(() => import('./pages/talent/TalentRoleDetail'));
const TalentCandidates = lazy(() => import('./pages/talent/TalentCandidates'));
const TalentCandidateDetail = lazy(() => import('./pages/talent/TalentCandidateDetail'));
const TalentMatches = lazy(() => import('./pages/talent/TalentMatches'));
const TalentTrash = lazy(() => import('./pages/talent/TalentTrash'));

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  // Payment gate — disabled until Stripe is configured
  // if (!user.has_paid) return <Navigate to="/payment" replace />;
  if (!user.onboarding_complete) return <Navigate to="/onboarding" replace />;
  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    // fallback={null} on purpose. A lazy chunk on a warm connection resolves in
    // tens of ms, and a spinner that flashes for 40ms reads as SLOWER than
    // nothing — it draws the eye to a wait that hadn't registered. Superhuman's
    // rule: precompute, never spin. Each page already renders its own skeleton
    // while its data loads, which is the honest place for a loading state.
    <Suspense fallback={null}>
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
      {/* Payment routes — disabled until Stripe is configured
      <Route path="/payment" element={
        !user ? <Navigate to="/login" replace /> :
        user.has_paid ? <Navigate to="/" replace /> :
        <Payment />
      } />
      <Route path="/payment/success" element={
        !user ? <Navigate to="/login" replace /> :
        <PaymentSuccess />
      } /> */}
      <Route path="/onboarding" element={
        !user ? <Navigate to="/login" replace /> :
        user.onboarding_complete ? <Navigate to="/" replace /> :
        <Onboarding />
      } />
      <Route path="/ask" element={<ProtectedRoute><AskStu /></ProtectedRoute>} />
      {/* THREE SURFACES OVER ONE SUBSTRATE.
          Danny, after seeing sourcing and the board stacked on one screen: "we're
          conflating two actions here: 1) I need an inbox to study and triage new
          founders and 2) the ability to manage a pipeline (like a kanban)... right
          now, this screen is a jumble."
          The one-record insight is about the DATA, not the screens — Affinity and
          Attio have one substrate and separate surfaces. So:
            /          Home     — Today's Tasks + where the funnel stands
            /sourcing  Sourcing — the inbox: study a stranger, triage, move on
            /pipeline  Pipeline — the kanban: move companies you know through stages
          Track in Sourcing promotes the SAME record onto the board, in one
          transaction, keeping the source chain — that's the connective tissue. */}
      <Route path="/" element={user ? <ProtectedRoute><Home /></ProtectedRoute> : <Landing />} />
      <Route path="/sourcing" element={<ProtectedRoute><Sourcing /></ProtectedRoute>} />
      <Route path="/pipeline" element={<ProtectedRoute><Pipeline /></ProtectedRoute>} />
      <Route path="/discover" element={<Navigate to="/sourcing" replace />} />
      <Route path="/founders/new" element={<ProtectedRoute><AddFounder /></ProtectedRoute>} />
      <Route path="/founders/:id" element={<ProtectedRoute><CompanyCard /></ProtectedRoute>} />
      <Route path="/founders/legacy/:id" element={<ProtectedRoute><FounderDetail /></ProtectedRoute>} />
      <Route path="/assess" element={<ProtectedRoute><Assess /></ProtectedRoute>} />
      <Route path="/assess/:id" element={<ProtectedRoute><Read /></ProtectedRoute>} />
      <Route path="/assess/:id/full" element={<ProtectedRoute><AssessmentDetail /></ProtectedRoute>} />
      <Route path="/hiring" element={<ProtectedRoute><HiringHome /></ProtectedRoute>} />
      <Route path="/hiring/:id" element={<ProtectedRoute><HiringRole /></ProtectedRoute>} />
      <Route path="/portfolio" element={<ProtectedRoute><Placeholder title="Portfolio" /></ProtectedRoute>} />
      <Route path="/fund" element={<ProtectedRoute><Placeholder title="Fund Analytics" /></ProtectedRoute>} />
      <Route path="/brief" element={<ProtectedRoute><Brief /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
      <Route path="/releases" element={<ProtectedRoute><Releases /></ProtectedRoute>} />
      <Route path="/health" element={<ProtectedRoute><Health /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
      <Route path="/talent" element={<ProtectedRoute><TalentLayout /></ProtectedRoute>}>
        <Route index element={<TalentHome />} />
        <Route path="portfolio" element={<TalentPortfolio />} />
        <Route path="portfolio/:id" element={<TalentPortfolioDetail />} />
        <Route path="roles" element={<TalentRoles />} />
        <Route path="roles/:id" element={<TalentRoleDetail />} />
        <Route path="candidates" element={<TalentCandidates />} />
        <Route path="candidates/:id" element={<TalentCandidateDetail />} />
        <Route path="matches" element={<TalentMatches />} />
        <Route path="criteria" element={<TalentCriteria />} />
        <Route path="trash" element={<TalentTrash />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
