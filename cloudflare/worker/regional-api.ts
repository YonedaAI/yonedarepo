// Execution placement is independent of repository/account authority. Only trusted
// runtime geography selects an API binding; incoming headers never select a backend.
import { forwardRequest } from './forward-request';
import { error } from './http';
import { GIT_PATH } from './readable-paths';
import { regionOfRequest } from './region';
import { carriedRequest } from './request-scope';
import type { Env } from './types';

const BINDINGS = {
  enam: 'API_ENAM',
  weur: 'API_WEUR',
  apac: 'API_APAC',
  oc: 'API_OC',
  sam: 'API_SAM',
  afr: 'API_AFR',
} as const;
type ApiRegion = keyof typeof BINDINGS;
export const API_DISPATCH_HEADER = 'x-yoneda-api-hop';
const isRegion = (region: string | undefined): region is ApiRegion =>
  region !== undefined && Object.hasOwn(BINDINGS, region);

export const regionalApiPath = (path: string) =>
  path.startsWith('/api/v1/') ||
  path.startsWith('/api/auth/') ||
  path.startsWith('/git/') ||
  GIT_PATH.test(path);

/** Unknown runtime geography uses the declared North America default. A known
 * geography with no binding refuses rather than silently sending it elsewhere. */
export function requestedApiRegion(req: Request): ApiRegion {
  const region = regionOfRequest(req);
  return isRegion(region) ? region : 'enam';
}

/** One dispatch from an entry only. The destination's configured identity prevents
 * redispatch; repository forwarding there retains existing authority admission. */
export function regionalDispatch(req: Request, env: Env): Promise<Response> | null {
  if (env.REGIONAL_API !== 'on' || env.API_REGION || !regionalApiPath(new URL(req.url).pathname))
    return null;
  // A marker can only refuse another entry dispatch, never grant access or select
  // its destination. A forged marker therefore only refuses the client's own request.
  if (req.headers.has(API_DISPATCH_HEADER))
    return Promise.resolve(
      error('REGION_UNAVAILABLE', 'This region is temporarily unavailable', 503),
    );
  const region = requestedApiRegion(req);
  const service = env[BINDINGS[region]];
  if (!service)
    return Promise.resolve(
      error('REGION_UNAVAILABLE', 'This region is temporarily unavailable', 503),
    );
  const headers = new Headers(req.headers);
  headers.set(API_DISPATCH_HEADER, '1');
  const forwarded = new Request(req, { headers, cf: req.cf });
  return forwardRequest(service, carriedRequest(forwarded)).then((res) => {
    if (res.status === 101) return res;
    const answer = new Response(res.body, res);
    answer.headers.set('x-yoneda-entry-region', region);
    return answer;
  });
}

/** Set only where this API actually serves the request. A forwarding Worker must
 * preserve the destination's serving label, separately from the selected entry. */
export function withApiRegion(res: Response, env: Env): Response {
  if (!isRegion(env.API_REGION) || res.status === 101) return res;
  // Account-home and readable-path forwarding can happen inside a route. Their
  // trusted response already identifies the handler that actually served it.
  if (isRegion(res.headers.get('x-yoneda-api-region') ?? undefined)) return res;
  const answer = new Response(res.body, res);
  answer.headers.set('x-yoneda-api-region', env.API_REGION);
  return answer;
}
