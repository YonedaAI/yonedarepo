// A repository's Settings tab (owner and admins): landing rules, checks, secret exceptions,
// webhooks, members, repository tokens, connect, and deleting it.
import type { Repository } from '../../lib/types';
import { linkTo, type Navigate } from '../shell/useRoute';
import { ConnectPanel, DeleteRepository } from '../source-platform/ConnectPanel';
import { currentApiOrigin } from '../source-platform/connect';
import { RepoMembers } from '../source-platform/RepoMembers';
import { RepoTokens } from '../source-platform/RepoTokens';
import type { RepoStatus } from '../source-platform/repoStatus';
import { Loading } from '../source-platform/SourceStatus';
import type { RepoSettingsSection } from '../source-platform/sourceRoute';
import { ChecksSettings } from './ChecksSettings';
import { LandingRules } from './LandingRules';
import { PolicyForm } from './PolicyForm';
import { RepoWebhooks } from './RepoWebhooks';
import { SecretExceptions } from './SecretExceptions';

export const SECTION_TITLES: Record<RepoSettingsSection, string> = {
  rules: 'Landing rules',
  checks: 'Checks',
  secrets: 'Secret exceptions',
  webhooks: 'Webhooks',
  members: 'Members',
  tokens: 'Repository tokens',
  connect: 'Connect',
  delete: 'Delete repository',
};

export function RepoSettings({
  repo,
  section,
  status,
  project,
  navigate,
  onPolicySaved,
  onDeleted,
  onDeleteProject,
}: {
  repo: string;
  section: RepoSettingsSection;
  status?: RepoStatus;
  /** The repository's agent project: it is removed first, then the repository. */
  project?: Repository;
  navigate: Navigate;
  onPolicySaved: () => void;
  onDeleted: () => void;
  onDeleteProject: (project: Repository) => void;
}) {
  if (!status) return <Loading what="settings" />;
  if (!status.viewer?.owner)
    return (
      <p className="source-empty">Only the owner and admins see this repository&apos;s settings.</p>
    );
  const policy = (label: string) => ({
    repo,
    policy: status.policy,
    label,
    onSaved: onPolicySaved,
  });
  return (
    <div className="repo-settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {(Object.keys(SECTION_TITLES) as RepoSettingsSection[]).map((id) => (
          <a
            key={id}
            aria-current={id === section ? 'page' : undefined}
            {...linkTo({ view: 'repo-settings', repo, section: id }, navigate)}
          >
            {SECTION_TITLES[id]}
          </a>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'rules' && (
          <section aria-labelledby="rules-heading">
            <h2 id="rules-heading">Landing rules</h2>
            <PolicyForm {...policy('landing rules')}>
              {(draft, change) => <LandingRules draft={draft} change={change} />}
            </PolicyForm>
          </section>
        )}
        {section === 'checks' && (
          <section aria-labelledby="checks-heading">
            <h2 id="checks-heading">Checks</h2>
            <PolicyForm {...policy('checks')}>
              {(draft, change) => <ChecksSettings draft={draft} change={change} />}
            </PolicyForm>
          </section>
        )}
        {section === 'secrets' && (
          <section aria-labelledby="secrets-heading">
            <h2 id="secrets-heading">Secret exceptions</h2>
            <PolicyForm {...policy('secret exceptions')}>
              {(draft, change) => <SecretExceptions draft={draft} change={change} />}
            </PolicyForm>
          </section>
        )}
        {section === 'webhooks' && <RepoWebhooks repo={repo} />}
        {section === 'members' && <RepoMembers repo={repo} viewer={status.viewer} />}
        {section === 'tokens' && <RepoTokens repo={repo} />}
        {section === 'connect' && (
          <ConnectPanel repo={repo} name={status.name} origin={currentApiOrigin()} />
        )}
        {section === 'delete' &&
          (project ? (
            <section aria-labelledby="delete-heading" className="source-danger">
              <h2 id="delete-heading">Delete repository</h2>
              <p>
                <strong>{project.name}</strong> has an agent project (its runs, context graph and
                agent access). Remove the project first; the repository stays until you delete it
                here afterwards.
              </p>
              <button type="button" className="danger" onClick={() => onDeleteProject(project)}>
                Remove the agent project
              </button>
            </section>
          ) : (
            <DeleteRepository repo={repo} name={status.name} onDeleted={onDeleted} />
          ))}
      </div>
    </div>
  );
}
