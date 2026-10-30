// What agents record on the repository, under /agents. Sessions (which coding session
// produced which commit) and memories (what later sessions should know) are sidebar pages
// of their own; the Agent tools page tabs between contracts (notes on functions and types),
// kept commits (pins) and searches for a breaking commit (bisects). The URL slugs keep the
// API names. Plans (`git_plan`) and
// codemods (`git_codemod`) have no page: a plan is computed per request and never stored,
// and a codemod's result is an ordinary commit, shown in History like any other. The managed
// agents reviewing the repository (`reviewers`) are a page linked from Agent tools, not a tab.
import { RepoManagedAgents } from '../agents/RepoManagedAgents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { AgentContracts } from './AgentContracts';
import { AgentMemories } from './AgentMemories';
import { AgentSessions } from './AgentSessions';
import { AgentBisects, AgentPins } from './AgentUpkeep';
import type { AgentSection } from './agentModel';

/** The Agent tools page's tabs. */
const TOOLS = ['contracts', 'pins', 'bisects'] as const satisfies readonly AgentSection[];
const LABELS: Record<(typeof TOOLS)[number], string> = {
  contracts: 'Contracts',
  pins: 'Kept commits',
  bisects: 'Find a breaking commit',
};

export function RepoAgents({
  repo,
  section,
  branches,
  owner,
  account,
  navigate,
}: {
  repo: string;
  section: AgentSection;
  branches: string[];
  /** The repository's workspace, for its managed agents. */
  owner?: string;
  account?: string;
  navigate: Navigate;
}) {
  const tools = (TOOLS as readonly AgentSection[]).includes(section);
  return (
    <div className="repo-agents">
      {tools && (
        <p className="repo-agents-reviewers">
          <a {...linkTo({ view: 'agents', repo, section: 'reviewers' }, navigate)}>
            Managed agents reviewing this repository
          </a>
        </p>
      )}
      {tools && (
        <nav className="segmented agent-sections" aria-label="Agent tools">
          {TOOLS.map((s) => (
            <a
              key={s}
              aria-current={s === section ? 'page' : undefined}
              {...linkTo({ view: 'agents', repo, section: s }, navigate)}
            >
              {LABELS[s]}
            </a>
          ))}
        </nav>
      )}
      {section === 'sessions' && (
        <AgentSessions repo={repo} branches={branches} navigate={navigate} />
      )}
      {section === 'memories' && <AgentMemories repo={repo} navigate={navigate} />}
      {section === 'contracts' && <AgentContracts repo={repo} navigate={navigate} />}
      {section === 'pins' && <AgentPins repo={repo} navigate={navigate} />}
      {section === 'bisects' && <AgentBisects repo={repo} navigate={navigate} />}
      {section === 'reviewers' && (
        <RepoManagedAgents repo={repo} workspace={owner} account={account} navigate={navigate} />
      )}
    </div>
  );
}
