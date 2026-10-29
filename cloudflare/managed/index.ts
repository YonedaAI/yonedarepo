// Managed agents Worker (`<prefix>-agents-managed`): YonedaRepo's predefined reviewers, run as
// an ordinary API client of the platform. Its public hostname takes only signed webhooks and
// /health; the browser API is served to the front Worker's service binding on the site's own
// origin. The platform itself never runs, schedules or knows about agents.
import { ApiRefusal, managedApi } from './api';
import type { ManagedEnv, QueueMessage } from './config';
import { REPO_ID } from './config';
import { consume, receiveHook } from './dispatch';
import { ledgerStub } from './ledger';
import { PlatformError } from './platform';

export { ContainerProxy } from '@cloudflare/containers';
export { HarnessContainer } from './harness';
export { CreditLedger } from './ledger';
export { RepoAgents } from './repo-agents';
export { ManagedReviewWorkflow } from './workflow';
export { WorkspaceAgents } from './workspace-agents';

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Fails closed: no configured admin token means nobody may grant credit. */
async function admin(req: Request, env: ManagedEnv) {
  const header = req.headers.get('authorization') ?? '';
  if (!env.MANAGED_ADMIN_TOKEN || !header.startsWith('Bearer ')) return false;
  const [supplied, expected] = await Promise.all([
    digest(header.slice(7)),
    digest(env.MANAGED_ADMIN_TOKEN),
  ]);
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

/** `POST /admin/accounts/<account>/credit {usd, note}`: adds credit and resumes paused runs. */
async function grantCredit(req: Request, env: ManagedEnv, account: string) {
  const body = (await req.json().catch(() => null)) as { usd?: unknown; note?: unknown } | null;
  const micro = Math.round(Number(body?.usd) * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro <= 0 || micro > 1_000_000_000)
    return refuse('INVALID_INPUT', 'usd must be a positive amount up to 1000', 400);
  const granted = await ledgerStub(env, account).grant(
    crypto.randomUUID(),
    micro,
    String(body?.note ?? 'Credit').slice(0, 200),
  );
  if (granted.resume.length)
    await env.RUNS.sendBatch(
      granted.resume.map((r) => ({
        body: { kind: 'resume', repo: r.repo, run: r.run } as QueueMessage,
      })),
    );
  return json({ balance: granted.balance, resumed: granted.resume.length });
}

export async function managedFetch(req: Request, env: ManagedEnv): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/health') return json({ service: 'yonedarepo-agents-managed', v: 1 });
  if (parts[0] === 'hooks' && parts.length === 2 && req.method === 'POST') {
    if (!REPO_ID.test(parts[1])) return refuse('NOT_FOUND', 'Unknown repository', 404);
    return receiveHook(req, env, parts[1]);
  }
  if (
    parts[0] === 'admin' &&
    parts[1] === 'accounts' &&
    parts[3] === 'credit' &&
    parts.length === 4
  ) {
    if (req.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', 'POST only', 405);
    if (!(await admin(req, env))) return refuse('UNAUTHORIZED', 'Admin token required', 401);
    return grantCredit(req, env, decodeURIComponent(parts[2]));
  }
  // The browser API only on the site's origin (through the front Worker), never on this
  // Worker's own hostname, so a session cookie is only ever checked for the site it belongs to.
  const own = new URL(env.PUBLIC_URL).host;
  if (parts[0] === 'api' && parts[1] === 'managed' && url.host !== own) {
    try {
      return json(await managedApi(req, env, parts.slice(2)));
    } catch (e: any) {
      if (e instanceof ApiRefusal || e instanceof PlatformError)
        return refuse(e.code, e.message, e.status);
      console.error(
        JSON.stringify({ event: 'managed.api', message: String(e?.message ?? e).slice(0, 200) }),
      );
      return refuse('INTERNAL', 'The managed agents service failed', 500);
    }
  }
  return refuse('NOT_FOUND', 'Not found', 404);
}

export default {
  fetch: managedFetch,
  async queue(batch, env) {
    await consume(batch, env);
  },
} satisfies ExportedHandler<ManagedEnv, QueueMessage>;
