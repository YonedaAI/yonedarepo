// The harness container (cloudflare/containers/harness): one per run attempt and model, with no
// internet. Its only ways out are two outbound handlers running here in the Worker:
// - platform.internal: the platform's public API and Git, for this repository and only for
//   reads (the lazy clone and `git show`), with the agents' token added on the way out;
// - gateway.internal: AI Gateway, for this run's provider and model only, with the provider key
//   added on the way out. Each request first holds its worst case against the workspace's
//   credit (and the run's cost cap), then settles at the usage the response reports.
// The container therefore holds no credential at all: the CLIs get placeholders.
import { Container, type OutboundHandlerContext } from '@cloudflare/containers';
import {
  chargeMicrousd,
  type ModelProvider,
  modelRate,
  type TokenUsage,
  usageCostMicrousd,
} from '../../shared/managed-agents';
import harnessVersion from '../containers/harness/version.json';
import { requestTopUp } from './billing';
import { gatewaySlug, type ManagedEnv } from './config';
import { type CallMeta, ledgerStub, type Usage } from './ledger';
import { repoStub } from './repo-agents';
import { meterStream, usageOfBody } from './usage';

export const PLATFORM_HOST = 'platform.internal';
/** The harness image this Worker was built with (version.json: a digest of runner.mjs and
 * commands.mjs, checked by tests/runtime/managed-harness.test.mjs). */
export const HARNESS_BUILD: string = harnessVersion.build;

/** Why a runner's answer to `POST /run` is not this Worker's harness, or null when it is. */
export function buildMismatch(answer: unknown): string | null {
  const build = (answer as { build?: unknown } | null)?.build;
  return build === HARNESS_BUILD
    ? null
    : `The harness image (${typeof build === 'string' ? build : 'unknown'}) is not this Worker's (${HARNESS_BUILD}); retrying on a fresh container`;
}
export const GATEWAY_HOST = 'gateway.internal';

/** What the handlers know about the run a container serves. */
export interface HarnessParams {
  repo: string;
  account: string;
  run: string;
  attempt: number;
  agent: string;
  change: number;
  provider: ModelProvider;
  model: string;
  /** The run's model spend cap, micro-USD charged. */
  cap_microusd: number;
}

const deny = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

/** A refused egress attempt, logged (Workers Logs: `managed.egress_refused`) and answered 403. */
function refuse(req: Request, p: HarnessParams | undefined, code: string, message: string) {
  const url = new URL(req.url);
  console.warn(
    JSON.stringify({
      event: 'managed.egress_refused',
      run: p?.run ?? null,
      repo: p?.repo ?? null,
      code,
      method: req.method,
      host: url.host,
      path: url.pathname.slice(0, 200),
    }),
  );
  return deny(403, code, message);
}

/** The platform requests a reviewer may make: reads of its own repository. */
export function readAllowed(method: string, path: string, repo: string) {
  const api = `/api/v1/repos/${repo}`;
  const git = `/git/${repo}.git/`;
  if (method === 'GET' || method === 'HEAD')
    return path === api || path.startsWith(`${api}/`) || path.startsWith(git);
  if (method !== 'POST') return false;
  // Object downloads (the lazy clone) and Git's upload-pack are reads that use POST.
  return (
    path === `${api}/objects` ||
    path.startsWith(`${api}/objects/`) ||
    path === `${git}git-upload-pack`
  );
}

async function platformOutbound(
  req: Request,
  env: ManagedEnv,
  ctx: OutboundHandlerContext<HarnessParams>,
) {
  const p = ctx.params;
  const url = new URL(req.url);
  if (!p || !readAllowed(req.method, url.pathname, p.repo))
    return refuse(req, p, 'FORBIDDEN', 'The review container may only read its repository');
  const connection = await repoStub(env, p.repo).connection();
  if (!connection || connection.revoked)
    return deny(403, 'FORBIDDEN', 'The repository is not connected');
  const headers = new Headers(req.headers);
  for (const h of ['cookie', 'authorization', 'x-forwarded-for']) headers.delete(h);
  headers.set('authorization', `Bearer ${connection.token}`);
  return env.PLATFORM.fetch(
    new Request(`https://platform.internal${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? req.body : undefined,
      redirect: 'manual',
    }),
  );
}

const keyBinding = (env: ManagedEnv, provider: ModelProvider) =>
  ({ claude: env.CLAUDE_KEY, codex: env.CODEX_KEY, zai: env.ZAI_KEY, mimo: env.MIMO_KEY })[
    provider
  ];
const AUTH: Record<ModelProvider, [string, string]> = {
  claude: ['x-api-key', ''],
  codex: ['authorization', 'Bearer '],
  zai: ['authorization', 'Bearer '],
  mimo: ['api-key', ''],
};
const DEFAULT_MAX_OUTPUT = 32_000;

const asUsage = (rate: NonNullable<ReturnType<typeof modelRate>>, t: TokenUsage): Usage => {
  const cost = usageCostMicrousd(rate, t);
  return {
    inputTokens: t.input + t.cache_write + t.cache_read,
    outputTokens: t.output,
    costMicrousd: cost,
    chargeMicrousd: chargeMicrousd(cost),
  };
};

async function gatewayOutbound(
  req: Request,
  env: ManagedEnv,
  ctx: OutboundHandlerContext<HarnessParams>,
) {
  const p = ctx.params;
  if (!p) return deny(403, 'FORBIDDEN', 'No run is bound to this container');
  const url = new URL(req.url);
  const gateway = new URL(env.AI_GATEWAY_URL);
  const prefix = `${gateway.pathname.replace(/\/$/, '')}/${gatewaySlug(env, p.provider)}/`;
  if (req.method !== 'POST' || !url.pathname.startsWith(prefix))
    return refuse(req, p, 'FORBIDDEN', `This run may only call ${p.provider} through the gateway`);
  const text = await req.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    return deny(400, 'INVALID_INPUT', 'Model requests are JSON');
  }
  if (body.model !== p.model)
    return refuse(req, p, 'MODEL_NOT_ALLOWED', `This run uses ${p.model} only`);
  const repo = repoStub(env, p.repo);
  const stop = await repo.stopReason(p.run, p.attempt);
  if (stop) return deny(409, 'RUN_STOPPED', `The run is ${stop}`);
  const rate = modelRate(p.provider, p.model);
  if (!rate) return deny(403, 'MODEL_NOT_ALLOWED', `${p.model} has no rate`);
  const maxOutput = Number(body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_OUTPUT);
  const worst = chargeMicrousd(
    usageCostMicrousd(rate, {
      input: new TextEncoder().encode(text).length,
      cache_write: 0,
      cache_read: 0,
      output: Number.isSafeInteger(maxOutput) && maxOutput > 0 ? maxOutput : DEFAULT_MAX_OUTPUT,
    }),
  );
  const spent = (await repo.run(p.run))?.cost_usd ?? 0;
  if (spent * 1_000_000 + worst > p.cap_microusd)
    return deny(402, 'RUN_COST_CAP', "This run reached its agent's cost cap");
  const ledger = ledgerStub(env, p.account);
  const meta: CallMeta = { repo: p.repo, run: p.run, agent: p.agent, model: p.model };
  const key = `${p.run}:${p.attempt}:${crypto.randomUUID()}`;
  if (!(await ledger.hold(key, worst, meta)).held) {
    await repo.pause(p.run, p.attempt);
    await ledger.pause(p.repo, p.run);
    return deny(402, 'NO_CREDIT', 'The workspace has no agent credit left');
  }
  const key_ = await keyBinding(env, p.provider)
    ?.get()
    .catch(() => '');
  if (!key_) {
    await ledger.settle(key, null, false, meta);
    return deny(503, 'NOT_CONFIGURED', `${p.provider} key is not bound`);
  }
  const headers = new Headers(req.headers);
  for (const h of ['authorization', 'x-api-key', 'api-key', 'cookie', 'host']) headers.delete(h);
  const [name, prefixValue] = AUTH[p.provider];
  headers.set(name, prefixValue + key_);
  headers.set(
    'cf-aig-metadata',
    JSON.stringify({
      account: p.account,
      repo: p.repo,
      change: p.change,
      agent: p.agent,
      run: p.run,
    }),
  );
  if (env.AI_GATEWAY_TOKEN) headers.set('cf-aig-authorization', `Bearer ${env.AI_GATEWAY_TOKEN}`);
  const settle = async (usage: TokenUsage | null, sent: boolean) => {
    const priced = usage ? asUsage(rate, usage) : null;
    await requestTopUp(env, p.account, await ledger.settle(key, priced, sent, meta));
    if (priced)
      await repo.recordCall(p.run, priced.inputTokens, priced.outputTokens, priced.chargeMicrousd);
  };
  const res = await fetch(`${gateway.origin}${url.pathname}${url.search}`, {
    method: 'POST',
    headers,
    body: text,
    redirect: 'manual',
  }).catch(() => null);
  if (!res) {
    await settle(null, true);
    return deny(502, 'GATEWAY_UNREACHABLE', 'The model gateway did not answer');
  }
  // Providers bill no failed request; its hold is released.
  if (!res.ok) {
    await settle(null, false);
    return new Response(res.body, res);
  }
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body)
    return new Response(res.body.pipeThrough(meterStream((u) => settle(u, true))), res);
  const answer = await res.text();
  let usage: TokenUsage | null = null;
  try {
    usage = usageOfBody(JSON.parse(answer));
  } catch {
    // No JSON: the hold is charged whole below.
  }
  await settle(usage, true);
  return new Response(answer, res);
}

export class HarnessContainer extends Container<ManagedEnv> {
  defaultPort = 8080;
  enableInternet = false;
  /** Past the longest timeout (30 minutes): the Workflow destroys it before then. */
  sleepAfter = '40m';

  /** Binds the run to the handlers, starts the image and hands the runner its review. */
  async begin(params: HarnessParams, spec: Record<string, unknown>) {
    await this.setOutboundByHosts({
      [PLATFORM_HOST]: { method: 'platform', params },
      [GATEWAY_HOST]: { method: 'gateway', params },
    });
    await this.setOutboundHandler('elsewhere', params);
    await this.startAndWaitForPorts(8080);
    const res = await this.containerFetch('http://runner/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (res.status !== 202) throw new Error(`The harness refused the run: HTTP ${res.status}`);
    const mismatch = buildMismatch(await res.json().catch(() => null));
    if (mismatch) {
      // An older (or newer) image than this Worker's, e.g. mid container rollout: its prompt
      // and result contract may differ, so it never reviews. The start is retried, fresh.
      await this.destroy();
      throw new Error(mismatch);
    }
  }

  async status(): Promise<Record<string, any>> {
    if (!this.ctx.container?.running) return { phase: 'gone' };
    const res = await this.containerFetch('http://runner/status');
    return (await res.json()) as Record<string, any>;
  }

  /** Container.stop() never ends the runner (PID 1 ignores SIGTERM), so it is destroyed. */
  async end() {
    if (this.ctx.container?.running) await this.destroy();
  }

  override async onActivityExpired() {
    await this.end();
  }
}

// Assigned, not a `static` class field: a class field hides @cloudflare/containers' setter, so
// its per-class registry (which ContainerProxy reads) would stay empty (platform-ssh-gateway.ts).
/** Every other plain-HTTP host: refused and logged (HTTPS elsewhere is blocked by
 * `enableInternet = false` before any handler, so it leaves no log). */
const elsewhereOutbound = (
  req: Request,
  _env: ManagedEnv,
  ctx: OutboundHandlerContext<HarnessParams>,
) => refuse(req, ctx.params, 'EGRESS_DENIED', 'The review container has no internet access');

export const outbound = {
  platform: platformOutbound,
  gateway: gatewayOutbound,
  elsewhere: elsewhereOutbound,
};
HarnessContainer.outboundHandlers = outbound;
HarnessContainer.outbound = elsewhereOutbound;

/** The calls a run makes on its container (typed plainly: RPC types of a Container nest deep). */
export interface HarnessBox {
  begin(params: HarnessParams, spec: Record<string, unknown>): Promise<void>;
  status(): Promise<Record<string, any>>;
  end(): Promise<void>;
}

export const harnessStub = (env: ManagedEnv, name: string) =>
  env.HARNESS.get(env.HARNESS.idFromName(name)) as unknown as HarnessBox;
