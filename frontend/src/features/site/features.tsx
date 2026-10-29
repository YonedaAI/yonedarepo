// The platform's built features as the site describes them, each with a small static mock
// of its real output (CLI text and UI states copied from the product, with sample names).
import { Check, GitBranch, GitPullRequest, ScrollText, Search } from 'lucide-react';
import type { ReactNode } from 'react';

export type Feature = {
  id: string;
  title: string;
  summary: string;
  points: string[];
  mock: ReactNode;
  /** Shown as "Coming": part of the feature is not built yet. */
  coming?: string;
};

function Terminal({
  lines,
  label,
}: {
  lines: [kind: 'in' | 'out' | 'bad', text: string][];
  label: string;
}) {
  return (
    <figure className="site-mock site-terminal" aria-label={label}>
      <pre>
        {lines.map(([kind, text], n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed lines of a static mock.
          <span key={n} className={`term-${kind}`}>
            {kind === 'in' ? '$ ' : ''}
            {text}
            {'\n'}
          </span>
        ))}
      </pre>
    </figure>
  );
}

export const FEATURES: Feature[] = [
  {
    id: 'git-hosting',
    title: 'Git hosting',
    summary: 'Stock Git clones, fetches and pushes. Nothing new to learn.',
    points: [
      'Smart HTTP with protocol v2, partial clones (`blob:none`) and shallow clones.',
      'The `yoneda::` remote helper for large pushes and imported history.',
      'Git over SSH with Ed25519, ECDSA or RSA keys.',
      'A pushed commit keeps its id: the platform records it byte for byte.',
    ],
    mock: (
      <Terminal
        label="Cloning and pushing with stock Git"
        lines={[
          ['in', 'git clone yoneda::https://api.yonedarepo.com/r3f1…  demo'],
          ['in', 'git commit -am "Retry on 503" && git push origin main'],
          ['out', 'remote: main: landed with server merge, run git pull'],
          ['out', ' * [new branch]      main -> main'],
        ]}
      />
    ),
  },
  {
    id: 'landing',
    title: 'Server-side commits and landing',
    summary: 'Many writers, one main branch, no merge lock.',
    points: [
      'Commit through the API or MCP without a clone; every commit is a real Git object.',
      'Refs move by compare-and-swap. Edits to different parts of one file merge on the server.',
      'A push can declare the files it read: if one changed meanwhile, it is refused, not merged blind.',
      'A same-line overlap is refused with the path, never overwritten.',
    ],
    mock: (
      <Terminal
        label="A refused landing names the conflicting path"
        lines={[
          ['in', 'git push origin main'],
          ['bad', 'remote: conflict in src/retry.ts'],
          ['bad', ' ! [remote rejected] main -> main (conflict in src/retry.ts: run git pull)'],
          ['in', 'git pull --rebase && git push origin main'],
          ['out', ' * [new branch]      main -> main'],
        ]}
      />
    ),
  },
  {
    id: 'changes',
    title: 'Changes, reviews and checks',
    summary: 'Propose a branch, review it line by line, land it when the gates pass.',
    points: [
      'Change requests with line comments, from the web app, the CLI, the API or MCP.',
      'Approvals review the head commit, and an author can never approve their own.',
      'Checks run in an isolated container on the exact commit; model checks grade a diff against a rubric.',
      'Gates apply to protected branches (`main`, `release`, `release/*`).',
    ],
    mock: (
      <figure className="site-mock site-panel" aria-label="A change ready to land">
        <p className="mock-title">
          <GitPullRequest size={16} aria-hidden="true" /> #12 Retry on 503 <span>retry → main</span>
        </p>
        <ul className="mock-gates">
          <li>
            <Check size={15} aria-hidden="true" /> 1 of 1 approval
          </li>
          <li>
            <Check size={15} aria-hidden="true" /> check <code>test</code> passed
          </li>
          <li>
            <Check size={15} aria-hidden="true" /> model check <code>security</code> passed
          </li>
        </ul>
        <p className="mock-action">Ready to land</p>
      </figure>
    ),
  },
  {
    id: 'sessions',
    title: 'Agent sessions',
    summary: 'Which coding session produced which commit, what it read and what it said.',
    points: [
      'Each commit can carry its session: the agent CLI, model, summary and session id.',
      'Hooks for coding agents record the files a session read and declare them with the push.',
      'Full transcripts: prompts, tool calls and replies, with credentials redacted before storage.',
      'Browse sessions per repository, filtered by CLI, model or branch.',
    ],
    mock: (
      <figure className="site-mock site-panel" aria-label="Sessions recorded on a repository">
        <ul className="mock-rows">
          <li>
            <strong>Add retry helper</strong>
            <span>opencode · glm-5.3 · 3 declared reads</span>
          </li>
          <li>
            <strong>Document backoff limits</strong>
            <span>claude-code · 2 declared reads</span>
          </li>
          <li className="mock-transcript">
            <ScrollText size={15} aria-hidden="true" /> Transcript: 38 turns, 1 redacted
          </li>
        </ul>
      </figure>
    ),
  },
  {
    id: 'context',
    title: 'Repository context for agents',
    summary: '`yoneda context` tells a new session what the last ones did.',
    points: [
      'Recent sessions, open change requests, landing rules and symbol contracts, in one bounded text.',
      'Agent hooks put it at the start of every session automatically.',
      'Fits a byte budget (`--max-bytes`) and says what it left out.',
    ],
    mock: (
      <Terminal
        label="The context a new coding session starts with"
        lines={[
          ['in', 'yoneda context'],
          ['out', '# YonedaRepo context for this clone'],
          ['out', 'main at 4be81c2 (log version 212).'],
          ['out', '## Landing rules'],
          ['out', '- approvals required: 1; required checks: test'],
          ['out', '## Recent sessions (newest first)'],
          ['out', '- 2h ago · opencode glm-5.3 · 9d1e0a7 "Add retry helper": …'],
        ]}
      />
    ),
  },
  {
    id: 'code',
    title: 'Search, blame, history and Overview',
    summary: 'Read the code on the server, at any version.',
    points: [
      'Code search over an index rebuilt only where files changed.',
      'Blame, path history and diffs, each readable at an earlier landed version.',
      'Overview: a generated map of subsystems, their symbols and how they reference each other.',
    ],
    mock: (
      <figure className="site-mock site-panel" aria-label="Code search results">
        <p className="mock-search">
          <Search size={15} aria-hidden="true" /> backoff
        </p>
        <ul className="mock-rows">
          <li>
            <code>src/retry.ts:14</code>
            <span>export function backoff(attempt: number)</span>
          </li>
          <li>
            <code>docs/limits.md:3</code>
            <span>Backoff doubles up to 30 seconds.</span>
          </li>
        </ul>
      </figure>
    ),
  },
  {
    id: 'repositories',
    title: 'Repositories, forks and organizations',
    summary: 'Everything a team needs around the code.',
    points: [
      'Public repositories anyone can clone without signing in; private ones for members only.',
      'Forks that propose changes back to their parent.',
      'Organizations with owners, members and teams.',
      'Git LFS and releases with assets and their SHA-256.',
    ],
    mock: (
      <figure className="site-mock site-panel" aria-label="A public repository and its fork">
        <ul className="mock-rows">
          <li>
            <strong>
              <GitBranch size={15} aria-hidden="true" /> acme/retry-kit
            </strong>
            <span>Public · 3 releases · LFS</span>
          </li>
          <li>
            <strong>
              <GitBranch size={15} aria-hidden="true" /> you/retry-kit
            </strong>
            <span>Fork · change #4 open on the parent</span>
          </li>
        </ul>
      </figure>
    ),
  },
  {
    id: 'cli-mcp',
    title: 'The CLI and MCP',
    summary: 'Agents are ordinary clients, with the same tokens and rules as people.',
    points: [
      '`yoneda` signs in by device login and drives repositories, changes, releases and organizations.',
      'An MCP server per account and per repository, with every platform operation as a tool.',
      '`yoneda setup` installs a skill or plugin for popular coding agents.',
      'Tokens are scoped by operation, repository and directory.',
    ],
    mock: (
      <Terminal
        label="Signing in and connecting an agent"
        lines={[
          ['in', 'yoneda login'],
          ['out', 'Open https://yonedarepo.com/device and enter the code WDJB-MJHT'],
          ['in', 'yoneda setup claude'],
          ['in', 'yoneda change create retry --title "Retry on 503"'],
        ]}
      />
    ),
  },
];
