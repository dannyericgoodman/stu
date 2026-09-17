import { PageHeader } from '../components/ui';
import FrameworksPanel from '../components/FrameworksPanel';

// The /frameworks route — the same builder that opens as a modal from Assess.
export default function Frameworks() {
  return (
    <div>
      <PageHeader
        title="Frameworks"
        subtitle="The yardsticks your assessments are scored against. Describe what matters to you — the architect drafts the questions, you keep the pen."
      />
      <FrameworksPanel />
    </div>
  );
}
