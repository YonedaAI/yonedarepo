// Superfan Worker: the tail consumer of an environment's Workers, an hourly cron pass over
// their telemetry, a five-minute quick pass for urgent signals on the wide watch, and an
// authenticated read endpoint for findings. Findings reach the owner by private email (notify.ts)
// and nowhere public. /heartbeat is public: the dead-man (deadman.ts) reads it, and it says only
// when passes last ran.
import { isWatchable, type SuperfanEnv, wideOn } from './config';
import { parseDeploy } from './ledger-deploys';
import { noticesOn } from './notify';
import { QUICK_CRON, runQuick } from './quick';
import { aggregate } from './tail';
import { ledgerStub, runWatch } from './watch';

export { SuperfanLedger } from './ledger';

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (code: string, status: number) => json({ error: { code } }, status);

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Fails closed: no configured secret means nobody is authorized. */
async function authorized(req: Request, env: SuperfanEnv) {
  const header = req.headers.get('authorization') ?? '';
  if (!env.SUPERFAN_READ_TOKEN || !header.startsWith('Bearer ')) return false;
  const [supplied, expected] = await Promise.all([
    digest(header.slice(7)),
    digest(env.SUPERFAN_READ_TOKEN),
  ]);
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

export async function superfanFetch(req: Request, env: SuperfanEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/heartbeat')
    return json({ ...(await ledgerStub(env).beats()), notices: noticesOn(env) });
  if (!['/findings', '/status', '/run', '/deploys'].includes(url.pathname))
    return refuse('NOT_FOUND', 404);
  if (!(await authorized(req, env))) return refuse('UNAUTHORIZED', 401);
  const ledger = ledgerStub(env);
  if (url.pathname === '/run') {
    if (req.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', 405);
    return json(await runWatch(env));
  }
  if (url.pathname === '/deploys' && req.method === 'POST') {
    const row = parseDeploy(await req.json().catch(() => null), env.WATCH_SCRIPT);
    if (!row) return refuse('INVALID_DEPLOY', 400);
    await ledger.recordDeploy(row);
    return json({ recorded: true });
  }
  if (req.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', 405);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  if (url.pathname === '/deploys') return json({ deploys: await ledger.deploys(limit) });
  if (url.pathname === '/status') {
    const now = Date.now();
    return json({
      watching: env.WATCH_SCRIPT,
      tail_events_last_hour: (await ledger.tailStats(now - 60 * 60_000, now)).events,
      analytics:
        env.TELEMETRY_SOURCE !== 'cloudflare'
          ? 'disabled'
          : env.CF_ANALYTICS_TOKEN
            ? 'cloudflare'
            : 'waiting_on_token',
      model: env.SUPERFAN_MODEL,
      notices: noticesOn(env) ? 'email' : 'off',
      wide: wideOn(env),
      last_deploy: (await ledger.deploys(1))[0] ?? null,
      ...(await ledger.status(now)),
    });
  }
  const status = url.searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved' && status !== 'all')
    return refuse('INVALID_STATUS', 400);
  return json({ findings: await ledger.findings(status, limit) });
}

/** Counts one batch of the watched Workers' tail events; other producers are ignored. */
export async function superfanTail(events: TraceItem[], env: SuperfanEnv) {
  if (!isWatchable(env.WATCH_SCRIPT)) return;
  const rows = aggregate(events, env.WATCH_SCRIPT, wideOn(env));
  if (rows.length) await ledgerStub(env).ingest(rows, Date.now());
}

export default {
  fetch: superfanFetch,
  async tail(events, env) {
    await superfanTail(events, env);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(controller.cron === QUICK_CRON ? runQuick(env) : runWatch(env));
  },
} satisfies ExportedHandler<SuperfanEnv>;
