// The Agents tab: what agents record on the repository. Sessions (which coding session
// produced which commit), symbol contracts, pins and bisects. Plans (`git_plan`) and
// codemods (`git_codemod`) have no page: a plan is computed per request and never stored,
// and a codemod's result is an ordinary commit, shown in History like any other.
import { linkTo, type Navigate } from '../shell/useRoute';
import { AgentContracts } from './AgentContracts';
import { AgentSessions } from './AgentSessions';
import { AgentBisects, AgentPins } from './AgentUpkeep';
import { AGENT_SECTIONS, type AgentSection } from './agentModel';

const LABELS: Record<AgentSection, string> = {
  sessions: 'Sessions',
  contracts: 'Contracts',
  pins: 'Pins',
  bisects: 'Bisects',
};

export function RepoAgents({
  repo,
  section,
  branches,
  navigate,
}: {
  repo: string;
  section: AgentSection;
  branches: string[];
  navigate: Navigate;
}) {
  return (
    <div className="repo-agents">
      <nav className="segmented agent-sections" aria-label="Agent records">
        {AGENT_SECTIONS.map((s) => (
          <a
            key={s}
            aria-current={s === section ? 'page' : undefined}
            {...linkTo({ view: 'agents', repo, section: s }, navigate)}
          >
            {LABELS[s]}
          </a>
        ))}
      </nav>
      {section === 'sessions' && (
        <AgentSessions repo={repo} branches={branches} navigate={navigate} />
      )}
      {section === 'contracts' && <AgentContracts repo={repo} navigate={navigate} />}
      {section === 'pins' && <AgentPins repo={repo} navigate={navigate} />}
      {section === 'bisects' && <AgentBisects repo={repo} navigate={navigate} />}
    </div>
  );
}
