// Context: what `yoneda context` (MCP `git_context`) gives a coding agent starting a
// session in this repository: main's head, the landing rules, the newest sessions, the open
// changes and the authored symbol contracts. One read of the authority.

import type { Policy } from '../repo-settings/policy';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { SessionRecord } from './agentModel';
import type { Change } from './changeModel';
import { landingNeeds } from './repoStatus';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { useSource } from './useSource';

type ContextRecord = {
  path: string;
  symbol_path: string;
  commit: string;
  contract: { summary?: string } & Record<string, unknown>;
  recorded_at: number;
};

export type AgentContext = {
  version: number;
  main: string | null;
  policy: Policy;
  sessions: SessionRecord[];
  changes: Change[];
  contracts: ContextRecord[];
};

export const contextPath = (repo: string) =>
  `/repos/${repo}/context?branch=main&sessions=8&changes=20&contracts=10`;

export function RepoContext({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const read = useSource<AgentContext>(contextPath(repo));
  if (read.error) return <Failure error={read.error} onRetry={read.reload} />;
  if (!read.data) return <Loading what="the agent context" />;
  const context = read.data;
  const needs = landingNeeds(context.policy);
  return (
    <div className="repo-context">
      <p className="source-meta">
        What an agent starting a session here reads first: <code>yoneda context</code> in a clone,
        or MCP <code>git_context</code>.
      </p>
      <section aria-labelledby="context-main">
        <h2 id="context-main">Main and landing rules</h2>
        <p>
          {context.main ? (
            <>
              main is at{' '}
              <a {...linkTo({ view: 'commit', repo, commit: context.main }, navigate)}>
                <code>{shortSha(context.main)}</code>
              </a>
              , log version {context.version}.
            </>
          ) : (
            'main has no commits yet.'
          )}
        </p>
        <p>Landing on main needs {needs.length ? needs.join(' · ') : 'nothing (lands at once)'}.</p>
      </section>
      <section aria-labelledby="context-sessions">
        <h2 id="context-sessions">Recent sessions</h2>
        {context.sessions.length ? (
          <ul className="context-list">
            {context.sessions.map((s) => (
              <li key={s.id}>
                <a {...linkTo({ view: 'session', repo, id: s.id }, navigate)}>
                  {s.summary || s.subject}
                </a>
                <small>
                  {s.cli}
                  {s.model ? ` · ${s.model}` : ''} · {when(s.at)}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="source-empty">No sessions recorded yet.</p>
        )}
      </section>
      <section aria-labelledby="context-changes">
        <h2 id="context-changes">Open changes</h2>
        {context.changes.length ? (
          <ul className="context-list">
            {context.changes.map((c) => (
              <li key={c.number}>
                <a {...linkTo({ view: 'change', repo, number: c.number }, navigate)}>
                  #{c.number} {c.title}
                </a>
                <small>
                  {c.branch} → {c.base}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="source-empty">No open changes.</p>
        )}
      </section>
      <section aria-labelledby="context-contracts">
        <h2 id="context-contracts">Contracts</h2>
        {context.contracts.length ? (
          <ul className="context-list">
            {context.contracts.map((c) => (
              <li key={`${c.path}\u0000${c.symbol_path}`}>
                <code>
                  {c.path} · {c.symbol_path}
                </code>
                {c.contract.summary && <span>{c.contract.summary}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="source-empty">No symbol contracts authored yet.</p>
        )}
      </section>
    </div>
  );
}
