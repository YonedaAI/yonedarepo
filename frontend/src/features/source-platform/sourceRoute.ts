// URL state for the one app shell: every view is addressable and survives reload. Older
// addresses (`/source`, `/source/tokens`, a repository's `/connect`, `/members` and
// `/settings/branches`) still parse, into the view that replaced them.
import { AGENT_SECTIONS, type AgentSection } from './agentModel';
import { normalizeUserCode } from './connect';

export const REPO_SETTINGS_SECTIONS = [
  'rules',
  'checks',
  'secrets',
  'webhooks',
  'members',
  'tokens',
  'lfs',
  'connect',
  'delete',
] as const;
export type RepoSettingsSection = (typeof REPO_SETTINGS_SECTIONS)[number];

export type SourceRoute =
  | { view: 'home' }
  | { view: 'settings' }
  | { view: 'device'; code: string }
  | { view: 'org'; org: string }
  | { view: 'files'; repo: string; path: string; ref: string; at?: number }
  | { view: 'overview'; repo: string; path: string; ref: string; at?: number }
  | { view: 'history'; repo: string; ref: string }
  | { view: 'commit'; repo: string; commit: string }
  | { view: 'transactions'; repo: string }
  | { view: 'branches'; repo: string }
  | { view: 'search'; repo: string; query: string }
  | { view: 'changes'; repo: string }
  | { view: 'change'; repo: string; number: number }
  | { view: 'releases'; repo: string }
  | { view: 'release'; repo: string; tag: string }
  | { view: 'agents'; repo: string; section: AgentSection }
  | { view: 'session'; repo: string; id: number }
  | { view: 'repo-settings'; repo: string; section: RepoSettingsSection };

/** The repository tabs; `transactions`, `branches` and `commit` belong to History, `overview` to Code,
 * `change` to Changes, `release` to Releases, `session` to Agents. */
export type RepoTab =
  | 'code'
  | 'history'
  | 'changes'
  | 'agents'
  | 'releases'
  | 'search'
  | 'settings';

const REPO = /^r[0-9a-f]{20}$/;
/** An organization's name: an account name without email (the two share one namespace). */
export const ORG_NAME = /^[a-z][a-z0-9_]{2,31}$/;
const SHA = /^[0-9a-f]{40}$/;
const isSection = (value: string | undefined): value is RepoSettingsSection =>
  (REPO_SETTINGS_SECTIONS as readonly string[]).includes(value ?? '');
const isAgentSection = (value: string | undefined): value is AgentSection =>
  (AGENT_SECTIONS as readonly string[]).includes(value ?? '');

export function parseSourceRoute(pathname: string, search: string): SourceRoute {
  const params = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [root, repo, view, ...rest] = parts;
  if (root === 'device')
    return { view: 'device', code: normalizeUserCode(params.get('code') ?? '') };
  if (root === 'settings' && !repo) return { view: 'settings' };
  if (root === 'orgs' && repo && ORG_NAME.test(repo) && !view) return { view: 'org', org: repo };
  if (root === 'source' && repo === 'tokens' && !view) return { view: 'settings' };
  if (root !== 'source' || !repo || !REPO.test(repo)) return { view: 'home' };
  const ref = params.get('ref') || 'main';
  if (view === 'history') return { view: 'history', repo, ref };
  if (view === 'transactions') return { view: 'transactions', repo };
  if (view === 'branches' || (view === 'settings' && rest[0] === 'branches'))
    return { view: 'branches', repo };
  if (view === 'connect') return { view: 'repo-settings', repo, section: 'connect' };
  if (view === 'members') return { view: 'repo-settings', repo, section: 'members' };
  if (view === 'settings')
    return { view: 'repo-settings', repo, section: isSection(rest[0]) ? rest[0] : 'rules' };
  if (view === 'search') return { view: 'search', repo, query: params.get('q') ?? '' };
  if (view === 'changes') {
    const number = Number(rest[0]);
    return rest[0] && /^[1-9][0-9]*$/.test(rest[0]) && Number.isSafeInteger(number)
      ? { view: 'change', repo, number }
      : { view: 'changes', repo };
  }
  if (view === 'agents') {
    const id = Number(rest[1]);
    if (rest[0] === 'sessions' && /^[1-9][0-9]*$/.test(rest[1] ?? '') && Number.isSafeInteger(id))
      return { view: 'session', repo, id };
    return { view: 'agents', repo, section: isAgentSection(rest[0]) ? rest[0] : 'sessions' };
  }
  // A tag may hold slashes, as segments or encoded.
  if (view === 'releases')
    return rest.length
      ? { view: 'release', repo, tag: rest.join('/') }
      : { view: 'releases', repo };
  if (view === 'commit' && rest[0] && SHA.test(rest[0]))
    return { view: 'commit', repo, commit: rest[0] };
  const at = Number(params.get('at'));
  const path = view === 'files' || view === 'overview' ? rest.join('/') : '';
  return {
    view: view === 'overview' ? 'overview' : 'files',
    repo,
    path,
    ref,
    ...(params.has('at') && Number.isSafeInteger(at) && at >= 0 ? { at } : {}),
  };
}

export function formatSourceRoute(route: SourceRoute): string {
  if (route.view === 'home') return '/';
  if (route.view === 'settings') return '/settings';
  if (route.view === 'org') return `/orgs/${route.org}`;
  if (route.view === 'device')
    return route.code ? `/device?code=${encodeURIComponent(route.code)}` : '/device';
  const base = `/source/${route.repo}`;
  if (route.view === 'history')
    return route.ref === 'main'
      ? `${base}/history`
      : `${base}/history?ref=${encodeURIComponent(route.ref)}`;
  if (route.view === 'transactions') return `${base}/transactions`;
  if (route.view === 'branches') return `${base}/branches`;
  if (route.view === 'repo-settings')
    return route.section === 'rules' ? `${base}/settings` : `${base}/settings/${route.section}`;
  if (route.view === 'search')
    return route.query ? `${base}/search?q=${encodeURIComponent(route.query)}` : `${base}/search`;
  if (route.view === 'commit') return `${base}/commit/${route.commit}`;
  if (route.view === 'changes') return `${base}/changes`;
  if (route.view === 'change') return `${base}/changes/${route.number}`;
  if (route.view === 'releases') return `${base}/releases`;
  if (route.view === 'release') return `${base}/releases/${encodeURIComponent(route.tag)}`;
  if (route.view === 'agents')
    return route.section === 'sessions' ? `${base}/agents` : `${base}/agents/${route.section}`;
  if (route.view === 'session') return `${base}/agents/sessions/${route.id}`;
  const query = new URLSearchParams();
  if (route.ref !== 'main') query.set('ref', route.ref);
  if (route.at !== undefined) query.set('at', String(route.at));
  const path = route.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const suffix = query.size ? `?${query}` : '';
  if (route.view === 'overview')
    return path ? `${base}/overview/${path}${suffix}` : `${base}/overview${suffix}`;
  return path ? `${base}/files/${path}${suffix}` : `${base}${suffix}`;
}

/** The repository a route shows, if any. */
export const routeRepo = (route: SourceRoute): string | undefined =>
  'repo' in route ? route.repo : undefined;

/** The tab a repository route belongs to. */
export function routeTab(route: SourceRoute): RepoTab | undefined {
  switch (route.view) {
    case 'files':
    case 'overview':
      return 'code';
    case 'history':
    case 'transactions':
    case 'branches':
    case 'commit':
      return 'history';
    case 'changes':
    case 'change':
      return 'changes';
    case 'releases':
    case 'release':
      return 'releases';
    case 'agents':
    case 'session':
      return 'agents';
    case 'search':
      return 'search';
    case 'repo-settings':
      return 'settings';
    default:
      return undefined;
  }
}

/** Where a tab starts. */
export function tabRoute(tab: RepoTab, repo: string): SourceRoute {
  if (tab === 'code') return { view: 'files', repo, path: '', ref: 'main' };
  if (tab === 'history') return { view: 'history', repo, ref: 'main' };
  if (tab === 'changes') return { view: 'changes', repo };
  if (tab === 'releases') return { view: 'releases', repo };
  if (tab === 'agents') return { view: 'agents', repo, section: 'sessions' };
  if (tab === 'search') return { view: 'search', repo, query: '' };
  return { view: 'repo-settings', repo, section: 'rules' };
}
