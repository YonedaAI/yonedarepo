// The dead-man: a Worker apart from Superfan that says so when Superfan stops. Every five minutes
// it reads Superfan's public /heartbeat over the network, as anyone could, and mails the owner
// when the answer stays bad for CONFIRM_CHECKS checks in a row, then at most once per REPEAT_MS
// until it recovers. It imports nothing from Superfan, shares no state or cron with it, and has
// its own copy of the mail call: a bad Superfan deploy, a lost ledger or a broken cron cannot
// silence it. Superfan reads this Worker's /health in turn, so one of them stopping is told by the
// other. Why a cron and not Cloudflare Health Checks: docs/incidents.md.
import { DurableObject } from 'cloudflare:workers';

/** Up to two quick passes may be missed. */
export const QUICK_MAX_MS = 15 * 60_000;
/** Up to one hourly pass may be missed, and it may take its full lease. */
export const FULL_MAX_MS = 130 * 60_000;
/** Checks in a row: a new cron can take 15 minutes to start firing (docs/runbook.md). */
export const CONFIRM_CHECKS = 3;
export const REPEAT_MS = 6 * 60 * 60_000;
const RESEND_EMAILS = 'https://api.resend.com/emails';

export interface DeadmanEnv {
  STATE: DurableObjectNamespace<DeadmanState>;
  /** The Superfan Worker's base URL. */
  SUPERFAN_URL: string;
  ADMIN_NOTIFY_EMAIL: string;
  EMAIL_FROM: string;
  RESEND_API_KEY: SecretsStoreSecret;
}
interface State {
  failures: number;
  lastSent: number;
  lastCheck: number | null;
}

export class DeadmanState extends DurableObject {
  #read = async () =>
    (await this.ctx.storage.get<State>('state')) ?? { failures: 0, lastSent: 0, lastCheck: null };

  /** Records one check; true when this one should mail. Recovery clears the repeat limit too: a
   * second stop is news. */
  async record(failing: boolean, now: number) {
    const state = await this.#read();
    const failures = failing ? state.failures + 1 : 0;
    const lastSent = failing ? state.lastSent : 0;
    await this.ctx.storage.put<State>('state', { failures, lastSent, lastCheck: now });
    return failures >= CONFIRM_CHECKS && now - lastSent >= REPEAT_MS;
  }

  async sent(now: number) {
    await this.ctx.storage.put<State>('state', { ...(await this.#read()), lastSent: now });
  }

  async lastCheck() {
    return (await this.#read()).lastCheck;
  }
}

const stateStub = (env: DeadmanEnv) => env.STATE.get(env.STATE.idFromName('superfan'));
const time = (value: unknown) => value === null || typeof value === 'number';

/** What is wrong with Superfan, or null. */
async function problem(env: DeadmanEnv, now: number) {
  const res = await fetch(new URL('/heartbeat', env.SUPERFAN_URL), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return `Superfan did not answer: HTTP ${res?.status ?? 'none'}.`;
  const beat = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!beat || !time(beat.full_at) || !time(beat.quick_at))
    return 'Superfan answered with an unreadable heartbeat.';
  const { full_at: full, quick_at: quick } = beat as {
    full_at: number | null;
    quick_at: number | null;
  };
  if (full === null && quick === null) return 'Superfan has never finished a pass.';
  if (quick !== null && now - quick > QUICK_MAX_MS)
    return `Superfan's five-minute pass last finished ${new Date(quick).toISOString()}.`;
  if (full !== null && now - full > FULL_MAX_MS)
    return `Superfan's hourly pass last finished ${new Date(full).toISOString()}.`;
  if (beat.notices !== true)
    return 'Superfan is running but cannot mail: its recipient, sender or key is unset.';
  return null;
}

const failed = (detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ event: 'deadman.mail_failed', ...detail }));

/** Mails the owner; true once Resend took it. Never logs the key. */
async function mail(env: DeadmanEnv, what: string, now: number) {
  const key = (await env.RESEND_API_KEY.get().catch(() => ''))?.trim();
  if (!key) {
    failed({ reason: 'RESEND_API_KEY is empty or unreadable' });
    return false;
  }
  const answer = await fetch(RESEND_EMAILS, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      // A retry inside one repeat window is one email, should an answer have been lost.
      'idempotency-key': `deadman/${new URL(env.SUPERFAN_URL).hostname}/${Math.floor(now / REPEAT_MS)}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.ADMIN_NOTIFY_EMAIL],
      subject: `[URGENT] Superfan has stopped: ${new URL(env.SUPERFAN_URL).hostname}`,
      text: `${what}\n\nNothing is watching this environment until it is back, and no alert will be sent. docs/incidents.md has the first check.\n`,
    }),
  }).catch(() => null);
  if (!answer?.ok) failed({ status: answer?.status ?? null });
  return Boolean(answer?.ok);
}

/** One check. A mail that fails is tried again on the next. */
export async function runDeadman(env: DeadmanEnv, now: number) {
  const state = stateStub(env);
  const what = await problem(env, now);
  if ((await state.record(what !== null, now)) && what && (await mail(env, what, now)))
    await state.sent(now);
}

export async function deadmanFetch(req: Request, env: DeadmanEnv) {
  if (new URL(req.url).pathname !== '/health')
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  const last_check_at = await stateStub(env).lastCheck();
  return Response.json(
    { service: 'yonedarepo-deadman', last_check_at },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export default {
  fetch: deadmanFetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDeadman(env, Date.now()));
  },
} satisfies ExportedHandler<DeadmanEnv>;
