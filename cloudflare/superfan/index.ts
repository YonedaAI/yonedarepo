// Superfan Worker: an hourly cron pass over the platform-only Worker's telemetry, and an
// authenticated read endpoint for its findings. It posts nowhere; readers come to it.
import type { SuperfanEnv } from './config';
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
  if (!['/findings', '/status', '/run'].includes(url.pathname)) return refuse('NOT_FOUND', 404);
  if (!(await authorized(req, env))) return refuse('UNAUTHORIZED', 401);
  const ledger = ledgerStub(env);
  if (url.pathname === '/run') {
    if (req.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', 405);
    return json(await runWatch(env));
  }
  if (req.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', 405);
  if (url.pathname === '/status')
    return json({
      watching: env.WATCH_SCRIPT,
      telemetry:
        env.TELEMETRY_SOURCE !== 'cloudflare'
          ? 'disabled'
          : env.CF_ANALYTICS_TOKEN
            ? 'cloudflare'
            : 'waiting_on_token',
      model: env.SUPERFAN_MODEL,
      ...(await ledger.status(Date.now())),
    });
  const status = url.searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved' && status !== 'all')
    return refuse('INVALID_STATUS', 400);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  return json({ findings: await ledger.findings(status, limit) });
}

export default {
  fetch: superfanFetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runWatch(env));
  },
} satisfies ExportedHandler<SuperfanEnv>;
