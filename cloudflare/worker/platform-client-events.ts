// Platform use by client kind (platform Worker, for the admin Traffic page): agents mostly use
// Git, the CLI and MCP, not web pages. Every request passes through here once, after its answer:
// one sampled Analytics Engine point, written without waiting, in the same dataset as the site's
// events. A point holds the client kind, country, operation class and whether a token held, never
// a repository, account, token, address or user agent. With TRAFFIC_REPORT on it also holds the
// outcome and how long the answer took, and an account that's ours leaves no point. With
// REPO_ANALYTICS on, a clone, push or landing also holds the repository, bytes and how a landing
// went (repo-usage.ts), still in the one point, indexed by repository so one busy repository
// can't thin another's figures. Budget: docs/load-testing.md. Off unless TRAFFIC_EVENTS is `on`.
// A browser session is not a client here: it counts on the site, and only its landings count here,
// under their own event, so the Traffic page's client figures stay the same.
import { afterAnswer, deferred } from './background';
import { isInternal, requestAccount } from './internal-accounts';
import { log } from './log';
import { GIT_PATH } from './readable-paths';
import { packDetail, repoAnalytics, requestActor, requestUsage, type Usage } from './repo-usage';
import { countryOf, isOwnTraffic } from './site-events';
import type { Env } from './types';

export type ClientKind = 'cli' | 'git' | 'mcp' | 'token';
export type Operation = 'clone' | 'push' | 'land' | 'mcp' | 'read' | 'write';
export type Outcome = 'success' | 'failed' | 'unauthorized' | 'rate_limited';
type ClientRequest = { client: ClientKind; operation: Operation };
type Seen = { client: ClientKind | 'browser'; operation: Operation };

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

/** A landing from a browser session, which is no client but is a repository's activity. */
const BROWSER_LANDING: Seen = { client: 'browser', operation: 'land' };
const ACTIVITY = new Set(['land', 'mcp', 'write']);

/** What goes on a point with REPO_ANALYTICS on, read when it's written: a pack's point waits for
 * its last byte. A request refused as its caller's, or for a repository it can't see, names no
 * repository: figures can't be put on one by asking for it. */
function usageFields(usage: Usage, seen: Seen, res: Response) {
  packDetail(usage);
  const refused = outcomeOf(res.status) === 'unauthorized' || res.status === 404;
  const repo = refused ? '' : (usage.repo ?? '');
  const failed = usage.detail === 'refused' && res.status >= 500;
  const person = requestActor();
  return {
    repo,
    operation: usage.landing && ACTIVITY.has(seen.operation) ? 'land' : seen.operation,
    blobs: [
      repo,
      // A CLI or MCP client signed in with a session is still a client, not a person's click.
      person === 'person' && seen.client !== 'browser' ? 'personal_token' : person,
      repo ? (usage.reason ?? '') : '',
      repo ? (failed ? 'failed' : (usage.detail ?? '')) : '',
    ],
    doubles: [usage.bytes ?? 0, usage.queueMs ?? 0, usage.retries ?? 0],
  };
}

/** Counts a finished request. It holds no work open and can't fail one; a D1 read for the internal
 * list, when one is due, happens after the answer. A pack that is still going out is counted when
 * it has gone, inside `waitUntil`. */
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
    const usage = requestUsage(env);
    const seen = clientRequest(req, new URL(req.url)) ?? (usage?.landing ? BROWSER_LANDING : null);
    if (!seen) return;
    const every = EVERY[seen.operation];
    if (random() * every >= 1) return;
    const report = env.TRAFFIC_REPORT === 'on';
    const held = req.headers.has('authorization') && res.status !== 401 && res.status !== 403;
    const empty = ['', '', '', '', ''];
    const doubles = [0, 1, every, held ? 1 : 0, 1];
    const browser = seen.client === 'browser';
    const write = () => {
      const added = usage ? usageFields(usage, seen, res) : null;
      if (browser && !added?.repo) return;
      const blobs = [
        browser ? 'repo' : 'client',
        '',
        '',
        countryOf(req),
        ...empty,
        browser ? '' : 'agent',
        seen.client,
        added?.operation ?? seen.operation,
      ];
      const indexes = [added?.repo || 'client'];
      const point = report
        ? {
            indexes,
            blobs: [...blobs, outcomeOf(res.status), ...(added?.blobs ?? [])],
            doubles: [...doubles, Math.max(Date.now() - started, 0), ...(added?.doubles ?? [])],
          }
        : { indexes, blobs, doubles };
      env.SITE_EVENTS?.writeDataPoint(point);
    };
    const account = report ? requestAccount() : null;
    const pack = usage?.pack?.ended;
    if (!account && !pack) {
      write();
      return;
    }
    const finish = async () => {
      await pack;
      if (!account || (await isInternal(env, account)) === false) write();
    };
    if (pack) {
      // A stream can't be awaited here: nothing reads it until this answer is returned.
      if (!deferred(finish)) void finish().catch(() => {});
      return;
    }
    return afterAnswer(finish).catch(() => {});
  } catch {
    // A lost data point is acceptable; a failed request is not.
  }
}

/** One point for what a job did to a repository, which no request carries: a check run finished,
 * or the clearance job landed. A repository of ours leaves none. Never fails the job. */
export async function recordJob(
  env: Env,
  repo: string,
  point: { operation: 'land' | 'write'; detail: string; reason?: string; ms?: number },
) {
  if (!repoAnalytics(env)) return;
  try {
    const row = await env.INDEX.prepare('SELECT workspace FROM platform_repos WHERE id=?')
      .bind(repo)
      .first<{ workspace: string }>();
    if (!row || (await isInternal(env, row.workspace)) !== false) return;
    const empty = ['', '', '', '', '', '', '', '', ''];
    env.SITE_EVENTS?.writeDataPoint({
      indexes: [repo],
      blobs: [
        'repo',
        ...empty,
        'platform',
        point.operation,
        'success',
        repo,
        'platform',
        point.reason ?? '',
        point.detail,
      ],
      doubles: [0, 1, 1, 1, 1, point.ms ?? 0, 0, 0, 0],
    });
  } catch (e) {
    log.warn('repo_analytics.job_point_lost', { repo, error: e });
  }
}
