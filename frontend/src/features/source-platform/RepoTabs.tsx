// The repository's tabs and status chips. Left and Right (Home, End) move between tabs.
import {
  Code2,
  GitCommitVertical,
  GitPullRequest,
  History,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { landingNeeds, type RepoStatus } from './repoStatus';
import { type RepoTab, tabRoute } from './sourceRoute';

const TABS: { id: RepoTab; label: string; Icon: typeof Code2 }[] = [
  { id: 'code', label: 'Code', Icon: Code2 },
  { id: 'history', label: 'History', Icon: History },
  { id: 'changes', label: 'Changes', Icon: GitPullRequest },
  { id: 'runs', label: 'Runs', Icon: GitCommitVertical },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

function arrowKeys(event: KeyboardEvent<HTMLElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>('a')];
  const at = links.indexOf(document.activeElement as HTMLElement);
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? links.length - 1
        : step === undefined || at < 0
          ? -1
          : (at + step + links.length) % links.length;
  if (next < 0) return;
  event.preventDefault();
  links[next]?.focus();
}

export function RepoTabs({
  repo,
  current,
  runs,
  settings,
  navigate,
}: {
  repo: string;
  current?: RepoTab;
  /** Runs exist only for a repository with an agent project. */
  runs: boolean;
  /** Settings are the owner's and admins'. */
  settings: boolean;
  navigate: Navigate;
}) {
  const shown = TABS.filter((t) => (t.id !== 'runs' || runs) && (t.id !== 'settings' || settings));
  return (
    <nav className="repo-tabs" aria-label="Repository" onKeyDown={arrowKeys}>
      {shown.map(({ id, label, Icon }) => (
        <a
          key={id}
          aria-current={id === current ? 'page' : undefined}
          {...linkTo(tabRoute(id, repo), navigate)}
        >
          <Icon size={16} aria-hidden="true" />
          {label}
        </a>
      ))}
    </nav>
  );
}

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
