// URL state for the source platform UI: every view is addressable and survives reload.
import { normalizeUserCode } from './connect';

export type SourceRoute =
  | { view: 'repos' }
  | { view: 'tokens' }
  | { view: 'device'; code: string }
  | { view: 'connect'; repo: string }
  | { view: 'files'; repo: string; path: string; ref: string; at?: number }
  | { view: 'overview'; repo: string; path: string; ref: string; at?: number }
  | { view: 'history'; repo: string; ref: string }
  | { view: 'commit'; repo: string; commit: string }
  | { view: 'transactions'; repo: string }
  | { view: 'search'; repo: string; query: string };

const REPO = /^r[0-9a-f]{20}$/;
const SHA = /^[0-9a-f]{40}$/;

export function parseSourceRoute(pathname: string, search: string): SourceRoute {
  const params = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [root, repo, view, ...rest] = parts;
  if (root === 'device')
    return { view: 'device', code: normalizeUserCode(params.get('code') ?? '') };
  if (root === 'source' && repo === 'tokens' && !view) return { view: 'tokens' };
  if (root !== 'source' || !repo || !REPO.test(repo)) return { view: 'repos' };
  const ref = params.get('ref') || 'main';
  if (view === 'history') return { view: 'history', repo, ref };
  if (view === 'transactions') return { view: 'transactions', repo };
  if (view === 'connect') return { view: 'connect', repo };
  if (view === 'search') return { view: 'search', repo, query: params.get('q') ?? '' };
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
  if (route.view === 'repos') return '/source';
  if (route.view === 'tokens') return '/source/tokens';
  if (route.view === 'device')
    return route.code ? `/device?code=${encodeURIComponent(route.code)}` : '/device';
  const base = `/source/${route.repo}`;
  if (route.view === 'history')
    return route.ref === 'main'
      ? `${base}/history`
      : `${base}/history?ref=${encodeURIComponent(route.ref)}`;
  if (route.view === 'transactions') return `${base}/transactions`;
  if (route.view === 'connect') return `${base}/connect`;
  if (route.view === 'search')
    return route.query ? `${base}/search?q=${encodeURIComponent(route.query)}` : `${base}/search`;
  if (route.view === 'commit') return `${base}/commit/${route.commit}`;
  const query = new URLSearchParams();
  if (route.ref !== 'main') query.set('ref', route.ref);
  if (route.at !== undefined) query.set('at', String(route.at));
  const path = route.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const suffix = query.size ? `?${query}` : '';
  if (route.view === 'overview')
    return path ? `${base}/overview/${path}${suffix}` : `${base}/overview${suffix}`;
  return path ? `${base}/files/${path}${suffix}` : `${base}${suffix}`;
}
