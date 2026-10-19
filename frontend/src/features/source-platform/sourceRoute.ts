// URL state for the source platform UI: every view is addressable and survives reload.
export type SourceRoute =
  | { view: 'repos' }
  | { view: 'files'; repo: string; path: string; ref: string; at?: number }
  | { view: 'history'; repo: string; ref: string }
  | { view: 'commit'; repo: string; commit: string }
  | { view: 'transactions'; repo: string };

const REPO = /^r[0-9a-f]{20}$/;
const SHA = /^[0-9a-f]{40}$/;

export function parseSourceRoute(pathname: string, search: string): SourceRoute {
  const params = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [root, repo, view, ...rest] = parts;
  if (root !== 'source' || !repo || !REPO.test(repo)) return { view: 'repos' };
  const ref = params.get('ref') || 'main';
  if (view === 'history') return { view: 'history', repo, ref };
  if (view === 'transactions') return { view: 'transactions', repo };
  if (view === 'commit' && rest[0] && SHA.test(rest[0]))
    return { view: 'commit', repo, commit: rest[0] };
  const at = Number(params.get('at'));
  const path = view === 'files' ? rest.join('/') : '';
  return {
    view: 'files',
    repo,
    path,
    ref,
    ...(params.has('at') && Number.isSafeInteger(at) && at >= 0 ? { at } : {}),
  };
}

export function formatSourceRoute(route: SourceRoute): string {
  if (route.view === 'repos') return '/source';
  const base = `/source/${route.repo}`;
  if (route.view === 'history')
    return route.ref === 'main'
      ? `${base}/history`
      : `${base}/history?ref=${encodeURIComponent(route.ref)}`;
  if (route.view === 'transactions') return `${base}/transactions`;
  if (route.view === 'commit') return `${base}/commit/${route.commit}`;
  const query = new URLSearchParams();
  if (route.ref !== 'main') query.set('ref', route.ref);
  if (route.at !== undefined) query.set('at', String(route.at));
  const path = route.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const suffix = query.size ? `?${query}` : '';
  return path ? `${base}/files/${path}${suffix}` : `${base}${suffix}`;
}
