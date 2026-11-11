/** Allow-listed route shapes: never retain a repository name, file path or query string. */
export function performanceRoute(path: string): string | null {
  if (
    path.length > 2048 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls in client supplied routes.
    /[?#\\\x00-\x20]/.test(path)
  )
    return null;
  const p = path.split('/').filter(Boolean);
  const exact = [
    '/',
    '/home',
    '/pricing',
    '/explore',
    '/repositories',
    '/agents',
    '/login',
    '/signup',
  ];
  if (exact.includes(path)) return path;
  const admin = new Set([
    'overview',
    'users',
    'signups',
    'repositories',
    'audit',
    'traffic',
    'visitors',
    'agents',
    'operations',
    'infrastructure',
  ]);
  const views = new Set([
    'overview',
    'files',
    'commit',
    'commits',
    'history',
    'activity',
    'settings',
    'sessions',
    'changes',
    'branches',
    'tags',
    'insights',
    'tokens',
    'hooks',
    'checks',
    'landings',
    'blob',
    'tree',
    'compare',
  ]);
  const view = views.has(p[2]) ? p[2] : ':view';
  if (p[0] === 'admin') return `/admin/${admin.has(p[1]) ? p[1] : ':section'}`;
  if (p[0] === 'settings') return '/settings/:section';
  if (p[0] === 'docs') return '/docs/:page';
  if (p[0] === 'source') return p.length > 2 ? `/source/:repo/${view}` : '/source/:page';
  if (p[0] === 'git') return '/git/:repo';
  if (p[0] === 'api') return null;
  if (p.length >= 2) return `/:owner/:repo/${view}`;
  return p.length === 1 ? '/:profile' : null;
}
