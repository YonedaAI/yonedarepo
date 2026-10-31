// Platform use by client kind (platform Worker, for the admin Traffic page): agents mostly use
// Git, the CLI and MCP, not web pages. Every request passes through here once, after its answer:
// one sampled Analytics Engine point, written without waiting, in the same dataset as the site's
// events. A point holds the client kind, country, operation class and whether a token held, never
// a repository, account, token, address or user agent. Budget: docs/load-testing.md. Off unless
// TRAFFIC_EVENTS is `on`. A browser session is not a client here: it counts on the site.
import { GIT_PATH } from './readable-paths';
import { countryOf, isOwnTraffic } from './site-events';
import type { Env } from './types';

export type ClientKind = 'cli' | 'git' | 'mcp' | 'token';
export type Operation = 'clone' | 'push' | 'land' | 'mcp' | 'read' | 'write';
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

/** Counts a finished request. It holds no work open and can't fail one. */
export function recordClient(req: Request, res: Response, env: Env, random = Math.random) {
  if (env.TRAFFIC_EVENTS !== 'on' || !env.SITE_EVENTS) return;
  try {
    if (isOwnTraffic(req)) return;
    const seen = clientRequest(req, new URL(req.url));
    if (!seen) return;
    const every = EVERY[seen.operation];
    if (random() * every >= 1) return;
    const held = req.headers.has('authorization') && res.status !== 401 && res.status !== 403;
    const empty = ['', '', '', '', ''];
    env.SITE_EVENTS.writeDataPoint({
      indexes: ['client'],
      blobs: ['client', '', '', countryOf(req), ...empty, 'agent', seen.client, seen.operation],
      doubles: [0, 1, every, held ? 1 : 0],
    });
  } catch {
    // A lost data point is acceptable; a failed request is not.
  }
}
