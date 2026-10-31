// The shell's sidebar: Browse (Home, Repositories, Explore, Agents: the workspace's managed
// agents, their runs and settings; Admin for operators), then on a settings page Account (those
// pages); elsewhere Repository (the picker and the open repository's pages), then the account's
// organizations. On a phone it is the navigation menu the top bar opens.
import {
  BookOpenText,
  Bot,
  Building2,
  Compass,
  CreditCard,
  FolderGit2,
  GitCommitHorizontal,
  GitPullRequest,
  House,
  KeyRound,
  LayoutDashboard,
  NotebookPen,
  Plus,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Terminal,
  UserRound,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import {
  ACCOUNT_SECTION_TITLES,
  ACCOUNT_SECTIONS,
  type AccountSection,
} from '../account-settings/settingsRoute';
import { unreadLabel } from '../admin/adminModel';
import type { OrgSummary } from '../source-platform/orgModel';
import { Failure } from '../source-platform/SourceStatus';
import {
  isAgentsRoute,
  type RepoTab,
  routeRepo,
  routeTab,
  type SourceRoute,
  tabRoute,
} from '../source-platform/sourceRoute';
import { RepoPicker } from './RepoPicker';
import type { RepoRow } from './repoRows';
import type { Favorites } from './useFavorites';
import { linkTo, type Navigate } from './useRoute';

/** A row's spoken name: "acme, owner", not the name and its small label run together. */
export const labelled = (name: string, label?: string) => (label ? `${name}, ${label}` : undefined);

export const REPO_PAGES: { id: RepoTab; label: string; Icon: typeof House }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'changes', label: 'Changes', Icon: GitPullRequest },
  { id: 'commits', label: 'Commits', Icon: GitCommitHorizontal },
  { id: 'sessions', label: 'Sessions', Icon: ScrollText },
  { id: 'memories', label: 'Memories', Icon: NotebookPen },
  { id: 'context', label: 'Context', Icon: BookOpenText },
  { id: 'agents', label: 'Agent tools', Icon: Bot },
  { id: 'releases', label: 'Releases', Icon: Tag },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

const ACCOUNT_ICONS: Record<AccountSection, typeof House> = {
  general: UserRound,
  billing: CreditCard,
  tokens: KeyRound,
  'ssh-keys': Terminal,
  organizations: Building2,
};

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
  favorites,
  picking = false,
  onPicking = () => {},
  orgs = [],
  route,
  repoName,
  missing = false,
  settings = false,
  navigate = () => {},
  onNew,
  onRetry,
  admin,
}: {
  authenticated: boolean;
  loading: boolean;
  rows?: RepoRow[];
  rowsError?: string;
  favorites?: Favorites;
  /** The repository picker is open. */
  picking?: boolean;
  onPicking?: (open: boolean) => void;
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
  /** The viewer is an operator (the session's hint): the Admin entry, with sign-ups since
   * this browser last looked. */
  admin?: { unread: number };
}) {
  const repo = missing ? undefined : routeRepo(route);
  const page = routeTab(route);
  const pages = REPO_PAGES.filter((p) => p.id !== 'settings' || settings);
  // The settings pages are about the account: its groups replace the repository ones.
  const onAccount = route.view === 'settings';
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
        {authenticated && (
          <a
            {...current(isAgentsRoute(route))}
            {...linkTo(
              {
                view: 'agents-home',
                ...(isAgentsRoute(route) && route.workspace ? { workspace: route.workspace } : {}),
              },
              navigate,
            )}
          >
            <Sparkles size={16} aria-hidden="true" />
            <span className="side-text">Agents</span>
          </a>
        )}
        {authenticated && admin && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link.
          <a
            {...current(route.view === 'admin')}
            aria-label={admin.unread > 0 ? `Admin, ${admin.unread} new sign-ups` : undefined}
            {...linkTo({ view: 'admin', section: 'overview' }, navigate)}
          >
            <ShieldCheck size={16} aria-hidden="true" />
            <span className="side-text">Admin</span>
            {admin.unread > 0 && (
              <small className="side-badge" aria-hidden="true">
                {unreadLabel(admin.unread)}
              </small>
            )}
          </a>
        )}
      </nav>
      {authenticated && onAccount && (
        <nav className="side-nav" aria-label="Account" onKeyDown={arrowKeys}>
          <p className="side-label">Account</p>
          {ACCOUNT_SECTIONS.map((section) => {
            const Icon = ACCOUNT_ICONS[section];
            return (
              <a
                key={section}
                {...current(section === route.section)}
                {...linkTo({ view: 'settings', section }, navigate)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="side-text">{ACCOUNT_SECTION_TITLES[section]}</span>
              </a>
            );
          })}
        </nav>
      )}
      {(picking || ((authenticated || repo) && !onAccount)) && (
        <div className="side-section">
          <p className="side-label">Repository</p>
          {authenticated && onNew && !rows.length && !loading && !rowsError && !repo && !picking ? (
            <button type="button" className="side-new" onClick={onNew}>
              <Plus size={16} aria-hidden="true" />
              New repository
            </button>
          ) : (
            <RepoPicker
              rows={rows}
              current={repo}
              currentName={repoName}
              loading={loading}
              error={rowsError}
              favorites={authenticated ? favorites : undefined}
              open={picking}
              onOpenChange={onPicking}
              navigate={navigate}
              onNew={onNew}
            />
          )}
          {!rows.length && rowsError && (
            <Failure error={rowsError} what="your repositories" onRetry={onRetry} />
          )}
          {repo && !onAccount && (
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
      {orgs.length > 0 && !onAccount && (
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
      <p className="sidebar-foot">
        <i aria-hidden="true" />
        Built on Cloudflare
      </p>
    </aside>
  );
}
