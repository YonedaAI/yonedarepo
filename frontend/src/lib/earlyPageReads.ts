/** Exact document defaults only: no bulk tab prefetch, query guessing or user input in URLs. */
export function earlyPageReads(documentKey: string, seen = 0): string[] {
  const reports: Record<string, string> = {
    '/admin': '/admin/overview',
    '/admin/overview': '/admin/overview',
    '/admin/users': '/admin/accounts',
    '/admin/repos': '/admin/repos?sort=database&direction=desc',
    '/admin/audit': '/admin/audit?view=people',
    '/admin/traffic': '/admin/traffic?range=7d&class=humans',
    '/admin/visitors': '/admin/visitors?range=30d',
    '/admin/agents': '/admin/agents?range=7d',
    '/admin/operations': '/admin/operations?range=7d',
    '/admin/infrastructure': '/admin/infrastructure',
  };
  const signups = `/api/v1/admin/signups?since=${seen}`;
  const report = reports[documentKey];
  if (report) return [`/api/v1${report}`, signups];
  if (documentKey === '/admin/signups') return [signups];
  if (documentKey === '/repositories') return ['/api/v1/repos'];
  if (documentKey === '/source/explore' || documentKey === '/explore')
    return ['/api/v1/explore?limit=50'];
  return [];
}
