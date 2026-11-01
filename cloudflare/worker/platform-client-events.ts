// Platform use by client kind (platform Worker, for the admin Traffic page): agents mostly use
// Git, the CLI and MCP, not web pages. Every request passes through here once, after its answer:
// one sampled Analytics Engine point, written without waiting, in the same dataset as the site's
// events. A point holds the client kind, country, operation class and whether a token held, never
// a repository, account, token, address or user agent. With TRAFFIC_REPORT on it also holds the
// outcome and how long the answer took, and an account that's ours leaves no point. Budget:
// docs/load-testing.md. Off unless TRAFFIC_EVENTS is `on`. A browser session is not a client here:
// it counts on the site.
import { afterAnswer } from './background';
import { isInternal, requestAccount } from './internal-accounts';
import { GIT_PATH } from './readable-paths';
import { countryOf, isOwnTraffic } from './site-events';
import type { Env } from './types';

export type ClientKind = 'cli' | 'git' | 'mcp' | 'token';
export type Operation = 'clone' | 'push' | 'land' | 'mcp' | 'read' | 'write';
export type Outcome = 'success' | 'failed' | 'unauthorized' | 'rate_limited';
type ClientRequest = { client: ClientKind; operation: Operation };

/** One point per this many requests: only reads are many enough to sample. */
const EVERY: Record<Operation, number> = {
  clone: 1,
  push: 1,
  land: 1,
  mcp: 1,
  read: 10,
  write: 1,
};
const MCP = /^\/api\/v1\/(?:repos\/r[0-9a-f]{20}\/)?mcp$/;
const CLI_AGENT = /^yoneda-cli\//;

const plain = (method: string): Operation =>
  method === 'GET' || method === 'HEAD' ? 'read' : 'write';

/** What a request is, or null for anything but a client of the platform. */
export function clientRequest(req: Request, url: URL): ClientRequest | null {
  const { pathname } = url;
  const post = req.method === 'POST';
  if (pathname.startsWith('/git/') || GIT_PATH.test(pathname)) {
    // Git lists references before every operation: the POST that follows is the one to count.
    if (pathname.endsWith('/info/refs')) return null;
    if (post && pathname.endsWith('/git-upload-pack')) return { client: 'git', operation: 'clone' };
    if (post && pathname.endsWith('/git-receive-pack')) return { client: 'git', operation: 'push' };
    return { client: 'git', operation: plain(req.method) };
  }
  if (!pathname.startsWith('/api/v1/')) return null;
  if (MCP.test(pathname)) return { client: 'mcp', operation: 'mcp' };
  const cli = CLI_AGENT.test(req.headers.get('user-agent') ?? '');
  if (!cli && !req.headers.has('authorization')) return null;
  const operation = post && pathname.endsWith('/land') ? 'land' : plain(req.method);
  return { client: cli ? 'cli' : 'token', operation };
}

/** What became of a request, from its status. A push Git refuses inside a 200 reads as success. */
export function outcomeOf(status: number): Outcome {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return status < 400 ? 'success' : 'failed';
}

/** Counts a finished request. It holds no work open and can't fail one; a D1 read for the internal
 * list, when one is due, happens after the answer. */
export function recordClient(
  req: Request,
  res: Response,
  env: Env,
  random = Math.random,
  started = Date.now(),
): Promise<unknown> | undefined {
  if (env.TRAFFIC_EVENTS !== 'on' || !env.SITE_EVENTS) return;
  try {
    if (isOwnTraffic(req)) return;
    const seen = clientRequest(req, new URL(req.url));
    if (!seen) return;
    const every = EVERY[seen.operation];
    if (random() * every >= 1) return;
    const report = env.TRAFFIC_REPORT === 'on';
    const held = req.headers.has('authorization') && res.status !== 401 && res.status !== 403;
    const empty = ['', '', '', '', ''];
    const blobs = [
      'client',
      '',
      '',
      countryOf(req),
      ...empty,
      'agent',
      seen.client,
      seen.operation,
    ];
    const doubles = [0, 1, every, held ? 1 : 0, 1];
    const point = report
      ? {
          indexes: ['client'],
          blobs: [...blobs, outcomeOf(res.status)],
          doubles: [...doubles, Math.max(Date.now() - started, 0)],
        }
      : { indexes: ['client'], blobs, doubles };
    const write = () => env.SITE_EVENTS?.writeDataPoint(point);
    const account = report ? requestAccount() : null;
    if (!account) {
      write();
      return;
    }
    return afterAnswer(async () => {
      if ((await isInternal(env, account)) === false) write();
    }).catch(() => {});
  } catch {
    // A lost data point is acceptable; a failed request is not.
  }
}
