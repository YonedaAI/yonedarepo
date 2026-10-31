// Readable addresses: `/<handle>` is a profile and `/<handle>/<repository>[/…]` a repository,
// beside the permanent `/source/<id>[/…]`, which keeps parsing everywhere. The app learns each
// repository's owner handle and name from the lists and statuses it reads (rememberRepoName),
// and formats a repository's routes under its readable base once it knows them. A readable
// address the app has not resolved yet parses as `repo-name`, which the shell resolves to the
// repository's id (`GET /resolve/<handle>/<name>`) and then shows as usual.

/** A handle: a username's shape (yoneda-core `normalize_handle`), never an email address. */
export const HANDLE = /^[a-z][a-z0-9_]{2,31}$/;
/** A repository's name (repo_store `repo_init`): 1–100 of [A-Za-z0-9._-], not starting with a dot. */
export const REPO_NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;

/**
 * The app's and the site's own first path segments: never a handle here, so a malformed
 * address under one (`/orgs/Acme`) stays the app's. The platform refuses them as handles too
 * (yoneda-core `RESERVED_HANDLES`).
 */
const OWN_ROOTS = new Set([
  'agents',
  'blog',
  'company',
  'device',
  'docs',
  'explore',
  'features',
  'orgs',
  'pricing',
  'privacy',
  'repositories',
  'settings',
  'signin',
  'signup',
  'source',
  'terms',
]);

export type NamedRoute =
  /** A person's or an org's page; `tab` is its Repositories tab (`?tab=repositories`). */
  | { view: 'profile'; handle: string; tab?: 'repositories' }
  /** A readable repository address not resolved to an id yet; `rest` is what follows the name. */
  | { view: 'repo-name'; owner: string; name: string; rest: string; search: string };

/** A repository's id, as an address carries it. */
export const REPO_ID = /^r[0-9a-f]{20}$/;

const names = new Map<string, { owner: string; name: string }>();

/** Records that repository `repo` is `/<owner>/<name>`; an owner without a handle is ignored. */
export function rememberRepoName(repo: string, owner: string | null | undefined, name: string) {
  if (owner && HANDLE.test(owner) && REPO_NAME.test(name)) names.set(repo, { owner, name });
}

/** The owner handle and name remembered for `repo`, if any. */
export const repoNameOf = (repo: string) => names.get(repo);

/** Forgets every remembered name (a renamed or deleted repository, a signed-out session, tests). */
export const forgetRepoNames = () => names.clear();

/** The path every route of `repo` starts with: readable once its name is known. */
export function repoBase(repo: string): string {
  const named = names.get(repo);
  return named ? `/${named.owner}/${encodeURIComponent(named.name)}` : `/source/${repo}`;
}

/** `/<handle>` or `/<handle>/<name>[/…]`, from a path's segments the app does not route itself. */
export function parseNamedPath(parts: string[], search: string): NamedRoute | undefined {
  const [handle, name, ...rest] = parts;
  if (!handle || !HANDLE.test(handle) || OWN_ROOTS.has(handle)) return undefined;
  if (name === undefined)
    return new URLSearchParams(search).get('tab') === 'repositories'
      ? { view: 'profile', handle, tab: 'repositories' }
      : { view: 'profile', handle };
  if (!REPO_NAME.test(name)) return undefined;
  return {
    view: 'repo-name',
    owner: handle,
    name,
    rest: rest.map(encodeURIComponent).join('/'),
    search,
  };
}

export function formatNamedRoute(route: NamedRoute): string {
  if (route.view === 'profile')
    return route.tab ? `/${route.handle}?tab=${route.tab}` : `/${route.handle}`;
  const base = `/${route.owner}/${encodeURIComponent(route.name)}`;
  return `${route.rest ? `${base}/${route.rest}` : base}${route.search}`;
}
