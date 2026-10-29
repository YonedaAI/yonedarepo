// The repository's status chips: `main @ v3` and what landing needs, each linking to where
// it is changed.
import { GitCommitVertical, ShieldCheck } from 'lucide-react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { landingNeeds, type RepoStatus } from './repoStatus';

/** `main @ v3` and what landing needs, each linking to where it is changed. */
export function StatusChips({
  repo,
  status,
  owner,
  navigate,
}: {
  repo: string;
  status: RepoStatus;
  owner: boolean;
  navigate: Navigate;
}) {
  const needs = landingNeeds(status.policy);
  const text = `Landing needs: ${needs.length ? needs.join(' · ') : 'nothing (lands at once)'}`;
  return (
    <div className="status-chips">
      <a className="chip" {...linkTo({ view: 'transactions', repo }, navigate)}>
        <GitCommitVertical size={14} aria-hidden="true" />
        main @ v{status.version}
      </a>
      {owner ? (
        <a
          className="chip"
          title="Change in Settings"
          {...linkTo({ view: 'repo-settings', repo, section: 'rules' }, navigate)}
        >
          <ShieldCheck size={14} aria-hidden="true" />
          {text}
        </a>
      ) : (
        <span className="chip">
          <ShieldCheck size={14} aria-hidden="true" />
          {text}
        </span>
      )}
    </div>
  );
}
