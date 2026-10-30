// URL state for the one app shell: every view is addressable and survives reload. Public
// repositories are listed at `/source/explore` (the platform host redirects `/explore` there;
// the bare path parses too, for a host that does not). Older
// addresses (`/source`, `/source/tokens`, a repository's `/connect`, `/members` and
// `/settings/branches`) still parse, into the view that replaced them. The public site's
// pages (`site/siteRoute.ts`) parse here too, as one `site` view.
import { isCanonicalAccountIdentifier } from '../../../../shared/account';
import { formatSitePage, parseSitePath, type SitePage } from '../site/siteRoute';
import { AGENT_SECTIONS, type AgentSection } from './agentModel';
import { normalizeUserCode } from './connect';

export const REPO_SETTINGS_SECTIONS = [
  'rules',
  'checks',
  'secrets',
  'webhooks',
  'plugins',
  'members',
  'tokens',
  'lfs',
  'visibility',
  'connect',
  'delete',
] as const;
export type RepoSettingsSection = (typeof REPO_SETTINGS_SECTIONS)[number];

export type SourceRoute =
  | { view: 'home' }
  | { view: 'repositories' }
  | { view: 'explore' }
  | { view: 'settings' }
  | { view: 'device'; code: string }
  /** The contact email's confirmation page (the emailed link; its button confirms). */
  | { view: 'verify-email'; account: string; token: string }
  | { view: 'org'; org: string }
  /** The workspace's managed agents (`/agents`); `workspace` (an org) defaults to the account. */
  | { view: 'agents-home'; workspace?: string }
  /** One agent's page (`/agents/<id>`): its runs and setup, or a new custom agent (`/agents/new`). */
  | { view: 'agent-settings'; agent: string; workspace?: string }
  /** Set up or configure one agent (`/agents/<id>/configure`). */
  | { view: 'agent-configure'; agent: string; workspace?: string }
  | { view: 'agent-runs'; agent?: string; workspace?: string }
  /** One run's detail; `runRepo`, not `repo`, so the repository shell stays out of it. */
  | { view: 'agent-run'; runRepo: string; run: string; workspace?: string }
  | { view: 'site'; site: SitePage }
  | { view: 'files'; repo: string; path: string; ref: string; at?: number }
  | { view: 'overview'; repo: string; path: string; ref: string; at?: number }
  | { view: 'history'; repo: string; ref: string }
  | { view: 'commit'; repo: string; commit: string }
  | { view: 'transactions'; repo: string }
  | { view: 'branches'; repo: string }
  | { view: 'search'; repo: string; query: string; word?: boolean }
  | { view: 'changes'; repo: string }
  | { view: 'change'; repo: string; number: number }
  | { view: 'releases'; repo: string }
  | { view: 'release'; repo: string; tag: string }
  | { view: 'agents'; repo: string; section: AgentSection }
  | { view: 'session'; repo: string; id: number }
  | { view: 'context'; repo: string }
  | { view: 'repo-settings'; repo: string; section: RepoSettingsSection };

/** The repository's sidebar pages. Overview is the code browser (`files`, `overview`);
 * Commits holds `history`, `transactions`, `branches` and `commit`; Changes holds `change`;
 * Releases holds `release`; Sessions holds the agent sessions and each `session`; Memories
 * the agent memories; Agent tools (`agents`) the other agent records (contracts, pins,
 * bisects). Each page has one sidebar entry, highlighted on every route it holds. */
export type RepoTab =
  | 'overview'
  | 'changes'
  | 'agents'
  | 'commits'
  | 'sessions'
  | 'context'
  | 'memories'
  | 'releases'
  | 'search'
  | 'settings';

const REPO = /^r[0-9a-f]{20}$/;
/** An organization's name: an account name without email (the two share one namespace). */
export const ORG_NAME = /^[a-z][a-z0-9_]{2,31}$/;
const SHA = /^[0-9a-f]{40}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{1,40}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,120}$/;
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
  if (root === 'verify-email' && !repo)
    return {
      view: 'verify-email',
      account: params.get('account') ?? '',
      token: params.get('token') ?? '',
    };
  if (root === 'settings' && !repo) return { view: 'settings' };
  if (root === 'repositories' && !repo) return { view: 'repositories' };
  if (root === 'orgs' && repo && ORG_NAME.test(repo) && !view) return { view: 'org', org: repo };
  if (root === 'agents') return parseAgentsRoute(parts.slice(1), params);
  if (root === 'source' && repo === 'tokens' && !view) return { view: 'settings' };
  if ((root === 'source' && repo === 'explore' && !view) || (root === 'explore' && !repo))
    return { view: 'explore' };
  const site = parseSitePath(parts);
  if (site) return { view: 'site', site };
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
  if (view === 'search') {
    const query = params.get('q') ?? '';
    return params.get('word') === '1'
      ? { view: 'search', repo, query, word: true }
      : { view: 'search', repo, query };
  }
  if (view === 'context') return { view: 'context', repo };
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

/** `/agents[/new|/<agent>[/configure]|/runs[/<repo>/<run>]]`, with `?workspace=` for an org. */
function parseAgentsRoute(parts: string[], params: URLSearchParams): SourceRoute {
  const named = params.get('workspace');
  // Any account identifier (an org, a username or an email-named account), as the API takes it.
  const space = named && isCanonicalAccountIdentifier(named) ? { workspace: named } : {};
  const [first, repo, run] = parts;
  if (first === 'runs') {
    if (repo && REPO.test(repo) && run && RUN_ID.test(run))
      return { view: 'agent-run', runRepo: repo, run, ...space };
    const agent = params.get('agent');
    return agent && AGENT_ID.test(agent)
      ? { view: 'agent-runs', agent, ...space }
      : { view: 'agent-runs', ...space };
  }
  if (first && AGENT_ID.test(first) && repo === 'configure' && !run)
    return { view: 'agent-configure', agent: first, ...space };
  if (first && AGENT_ID.test(first) && !repo)
    return { view: 'agent-settings', agent: first, ...space };
  return { view: 'agents-home', ...space };
}

export type AgentsRoute = Extract<
  SourceRoute,
  { view: 'agents-home' | 'agent-settings' | 'agent-configure' | 'agent-runs' | 'agent-run' }
>;
const AGENT_VIEWS: readonly string[] = [
  'agents-home',
  'agent-settings',
  'agent-configure',
  'agent-runs',
  'agent-run',
];
/** The workspace Agents pages (one Browse entry holds them all). */
export const isAgentsRoute = (route: SourceRoute): route is AgentsRoute =>
  AGENT_VIEWS.includes(route.view);

function formatAgentsRoute(route: AgentsRoute): string {
  const query = new URLSearchParams();
  let path: string;
  if (route.view === 'agents-home') path = '/agents';
  else if (route.view === 'agent-settings') path = `/agents/${route.agent}`;
  else if (route.view === 'agent-configure') path = `/agents/${route.agent}/configure`;
  else if (route.view === 'agent-runs') {
    path = '/agents/runs';
    if (route.agent) query.set('agent', route.agent);
  } else path = `/agents/runs/${route.runRepo}/${route.run}`;
  if (route.workspace) query.set('workspace', route.workspace);
  return query.size ? `${path}?${query}` : path;
}

export function formatSourceRoute(route: SourceRoute): string {
  if (isAgentsRoute(route)) return formatAgentsRoute(route);
  if (route.view === 'home') return '/';
  if (route.view === 'settings') return '/settings';
  if (route.view === 'repositories') return '/repositories';
  if (route.view === 'explore') return '/source/explore';
  if (route.view === 'org') return `/orgs/${route.org}`;
  if (route.view === 'site') return formatSitePage(route.site);
  if (route.view === 'device')
    return route.code ? `/device?code=${encodeURIComponent(route.code)}` : '/device';
  if (route.view === 'verify-email')
    return `/verify-email?account=${encodeURIComponent(route.account)}&token=${encodeURIComponent(route.token)}`;
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
    return route.query
      ? `${base}/search?q=${encodeURIComponent(route.query)}${route.word ? '&word=1' : ''}`
      : `${base}/search`;
  if (route.view === 'commit') return `${base}/commit/${route.commit}`;
  if (route.view === 'changes') return `${base}/changes`;
  if (route.view === 'change') return `${base}/changes/${route.number}`;
  if (route.view === 'releases') return `${base}/releases`;
  if (route.view === 'release') return `${base}/releases/${encodeURIComponent(route.tag)}`;
  if (route.view === 'agents')
    return route.section === 'sessions' ? `${base}/agents` : `${base}/agents/${route.section}`;
  if (route.view === 'session') return `${base}/agents/sessions/${route.id}`;
  if (route.view === 'context') return `${base}/context`;
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

/** The sidebar page a repository route belongs to. */
export function routeTab(route: SourceRoute): RepoTab | undefined {
  switch (route.view) {
    case 'files':
    case 'overview':
      return 'overview';
    case 'history':
    case 'transactions':
    case 'branches':
    case 'commit':
      return 'commits';
    case 'changes':
    case 'change':
      return 'changes';
    case 'releases':
    case 'release':
      return 'releases';
    case 'agents':
      return route.section === 'sessions'
        ? 'sessions'
        : route.section === 'memories'
          ? 'memories'
          : 'agents';
    case 'session':
      return 'sessions';
    case 'context':
      return 'context';
    case 'search':
      return 'search';
    case 'repo-settings':
      return 'settings';
    default:
      return undefined;
  }
}

/** Where a page starts. */
export function tabRoute(tab: RepoTab, repo: string): SourceRoute {
  if (tab === 'overview') return { view: 'files', repo, path: '', ref: 'main' };
  if (tab === 'commits') return { view: 'history', repo, ref: 'main' };
  if (tab === 'changes') return { view: 'changes', repo };
  if (tab === 'releases') return { view: 'releases', repo };
  if (tab === 'sessions') return { view: 'agents', repo, section: 'sessions' };
  if (tab === 'agents') return { view: 'agents', repo, section: 'contracts' };
  if (tab === 'context') return { view: 'context', repo };
  if (tab === 'memories') return { view: 'agents', repo, section: 'memories' };
  if (tab === 'search') return { view: 'search', repo, query: '' };
  return { view: 'repo-settings', repo, section: 'rules' };
}
