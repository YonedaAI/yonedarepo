// A repository's managed agents (`/source/<repo>/agents/reviewers`, linked from Agent tools):
// each agent YonedaRepo maintains with its status here, harness and latest review, and a link
// to manage them on the workspace's Agents page. Only the workspace's owner can read them.
import type { RepoAgentRow } from '../../../../shared/managed-agents';
import { HARNESS_LABELS } from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { useSource } from '../source-platform/useSource';
import { loadState, ResultTile } from './agentParts';
import { formatUtc, REPO_STATUS_LABELS, repoAgentsPath } from './agentsModel';

export function RepoManagedAgents({
  repo,
  workspace,
  account,
  navigate,
}: {
  repo: string;
  /** The repository's owner (its workspace); unknown while its status loads. */
  workspace?: string;
  account?: string;
  navigate: Navigate;
}) {
  const loaded = useSource<{ agents: RepoAgentRow[] }>(
    workspace ? repoAgentsPath(workspace, repo) : null,
    '/api/managed',
  );
  const space = workspace && workspace !== account ? { workspace } : {};
  const manage = linkTo({ view: 'agents-home', ...space }, navigate);
  const rows = loaded.data?.agents ?? [];
  const on = rows.filter((r) => r.status !== 'off');
  return (
    <section className="repo-managed-agents" aria-labelledby="repo-agents-heading">
      <div className="repo-managed-head">
        <h2 id="repo-agents-heading">Managed agents</h2>
        <a className="button-link quiet" {...manage}>
          Manage agents
        </a>
      </div>
      {loadState(loaded, 'agents') ??
        (on.length === 0 ? (
          <p className="source-empty">
            No managed agent reviews this repository yet. Add one from the Agents page to review
            every change.
          </p>
        ) : (
          <div className="source-table-wrap">
            <table className="source-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Harness</th>
                  <th>Latest review</th>
                </tr>
              </thead>
              <tbody>
                {on.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <a {...linkTo({ view: 'agent-settings', agent: row.id, ...space }, navigate)}>
                        {row.name}
                      </a>
                    </td>
                    <td>
                      <span
                        className={`chip ${row.status === 'active' ? 'run-good' : 'run-neutral'}`}
                      >
                        {REPO_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td>{HARNESS_LABELS[row.harness]}</td>
                    <td>
                      {row.latest ? (
                        <span className="repo-agent-latest">
                          <ResultTile tile={row.latest} />{' '}
                          <a
                            {...linkTo(
                              { view: 'change', repo, number: row.latest.change },
                              navigate,
                            )}
                          >
                            #{row.latest.change}
                          </a>{' '}
                          <span className="source-meta">{formatUtc(row.latest.created_at)}</span>
                        </span>
                      ) : (
                        <span className="source-meta">No review yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
