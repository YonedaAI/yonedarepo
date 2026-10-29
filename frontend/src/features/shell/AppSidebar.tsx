// The shell's sidebar: Browse (Home, Repositories, Explore, the account's repositories and
// organizations), then Repository: the switcher and the open repository's pages. On a
// phone it is the navigation menu the top bar opens.
import {
  BookOpenText,
  Bot,
  Building2,
  Compass,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  House,
  LayoutDashboard,
  NotebookPen,
  Plus,
  ScrollText,
  Search,
  Settings,
  Tag,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { OrgSummary } from '../source-platform/orgModel';
import { Failure } from '../source-platform/SourceStatus';
import {
  type RepoTab,
  routeRepo,
  routeTab,
  type SourceRoute,
  tabRoute,
} from '../source-platform/sourceRoute';
import { RepoSwitcher } from './RepoSwitcher';
import { type RepoRow, rowLabel } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

/** A row's spoken name: "acme, owner", not the name and its small label run together. */
export const labelled = (name: string, label?: string) => (label ? `${name}, ${label}` : undefined);

export const REPO_PAGES: { id: RepoTab; label: string; Icon: typeof House }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'changes', label: 'Changes', Icon: GitPullRequest },
  { id: 'agents', label: 'Agents', Icon: Bot },
  { id: 'commits', label: 'Commits', Icon: GitCommitHorizontal },
  { id: 'sessions', label: 'Sessions', Icon: ScrollText },
  { id: 'context', label: 'Context', Icon: BookOpenText },
  { id: 'memories', label: 'Memories', Icon: NotebookPen },
  { id: 'releases', label: 'Releases', Icon: Tag },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

/** Up and Down (Home, End) move between a navigation's links. */
function arrowKeys(event: KeyboardEvent<HTMLElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>('a')];
  const at = links.indexOf(document.activeElement as HTMLElement);
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
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

const current = (on: boolean) =>
  on ? { 'aria-current': 'page' as const, className: 'active' } : {};

export function AppSidebar({
  authenticated,
  loading,
  rows = [],
  rowsError = '',
  orgs = [],
  route,
  repoName,
  missing = false,
  settings = false,
  navigate = () => {},
  onNew,
  onRetry,
}: {
  authenticated: boolean;
  loading: boolean;
  rows?: RepoRow[];
  rowsError?: string;
  /** The account's organizations. */
  orgs?: OrgSummary[];
  route: SourceRoute;
  /** The open repository's name, once its status loaded. */
  repoName?: string;
  /** The open repository is gone (deleted, or a stale link): no Repository pages. */
  missing?: boolean;
  /** The viewer may change the open repository's settings. */
  settings?: boolean;
  navigate?: Navigate;
  onNew?: () => void;
  /** Reads the repositories again after a failed read. */
  onRetry?: () => void;
}) {
  const repo = missing ? undefined : routeRepo(route);
  const page = routeTab(route);
  const pages = REPO_PAGES.filter((p) => p.id !== 'settings' || settings);
  return (
    <aside className="sidebar" id="app-sidebar" aria-label="Sidebar">
      <a className="sidebar-brand" {...linkTo({ view: 'home' }, navigate)}>
        YonedaRepo
      </a>
      <nav className="side-nav" aria-label="Browse" onKeyDown={arrowKeys}>
        <p className="side-label">Browse</p>
        <a {...current(route.view === 'home')} {...linkTo({ view: 'home' }, navigate)}>
          <House size={16} aria-hidden="true" />
          <span className="side-text">Home</span>
        </a>
        {authenticated && (
          <a
            {...current(route.view === 'repositories')}
            {...linkTo({ view: 'repositories' }, navigate)}
          >
            <FolderGit2 size={16} aria-hidden="true" />
            <span className="side-text">Repositories</span>
          </a>
        )}
        <a {...current(route.view === 'explore')} {...linkTo({ view: 'explore' }, navigate)}>
          <Compass size={16} aria-hidden="true" />
          <span className="side-text">Explore</span>
        </a>
      </nav>
      {authenticated && (
        <nav className="side-nav side-repos" aria-label="Repositories" onKeyDown={arrowKeys}>
          <p className="side-label">Your repositories</p>
          <div className="side-scroll">
            {rows.map((row) => (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link.
              <a
                key={row.repo}
                {...current(row.repo === repo)}
                title={row.shared ? `${row.name} (${row.shared})` : row.name}
                aria-label={rowLabel(row)}
                {...linkTo({ view: 'files', repo: row.repo, path: '', ref: 'main' }, navigate)}
              >
                <GitBranch size={15} aria-hidden="true" />
                <span className="rail-repo-name">{row.name}</span>
                {row.shared && <small className="rail-repo-shared">{row.shared}</small>}
                {row.public && (
                  <small className="rail-repo-public" aria-hidden="true">
                    Public
                  </small>
                )}
              </a>
            ))}
            {!rows.length &&
              (rowsError ? (
                <Failure error={rowsError} what="your repositories" onRetry={onRetry} />
              ) : (
                <span className="side-empty">
                  {loading ? 'Loading repositories…' : 'No repositories yet'}
                </span>
              ))}
          </div>
          {onNew && (
            <button type="button" className="side-new" onClick={onNew}>
              <Plus size={16} aria-hidden="true" />
              New repository
            </button>
          )}
        </nav>
      )}
      {orgs.length > 0 && (
        <nav className="side-nav" aria-label="Organizations" onKeyDown={arrowKeys}>
          <p className="side-label">Organizations</p>
          {orgs.map((o) => (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link.
            <a
              key={o.org}
              {...current(route.view === 'org' && route.org === o.org)}
              aria-label={labelled(o.org, o.role)}
              {...linkTo({ view: 'org', org: o.org }, navigate)}
            >
              <Building2 size={16} aria-hidden="true" />
              <span className="rail-repo-name">{o.org}</span>
              <small className="rail-repo-shared">{o.role}</small>
            </a>
          ))}
        </nav>
      )}
      {(authenticated || repo) && (
        <div className="side-section">
          <p className="side-label">Repository</p>
          <RepoSwitcher rows={rows} current={repo} currentName={repoName} navigate={navigate} />
          {repo && (
            <nav className="side-nav" aria-label="Repository" onKeyDown={arrowKeys}>
              {pages.map(({ id, label, Icon }) => (
                <a key={id} {...current(id === page)} {...linkTo(tabRoute(id, repo), navigate)}>
                  <Icon size={16} aria-hidden="true" />
                  <span className="side-text">{label}</span>
                </a>
              ))}
            </nav>
          )}
        </div>
      )}
      <p className="sidebar-foot">
        <i aria-hidden="true" />
        Built on Cloudflare
      </p>
    </aside>
  );
}
