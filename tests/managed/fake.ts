// Test fixtures: a fake platform public API (recording every request), a harness container
// double that "runs" a scripted CLI (its model calls go through the real outbound handler to a
// fake AI Gateway), and an inline step runner. Repositories, commits, keys and replies are
// invented; nothing reaches the network and no model is called.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { ManagedEnv, QueueMessage, RunParams } from '../../cloudflare/managed/config';
import { type HarnessParams, outbound } from '../../cloudflare/managed/harness';
import type { Steps } from '../../cloudflare/managed/run';
import { FIXTURES } from './fixtures';

export const GATEWAY = 'https://gateway.example.com/v1/acct/yonedarepo-test-agents';
/** Credential-shaped fixtures are built at run time, so none is a literal in the repository. */
export const HOOK_SECRET = ['whsec', 'fixture'.repeat(3)].join('_');
export const KEYS = {
  claude: ['fixture', 'claude', 'key'].join('-'),
  codex: ['fixture', 'codex', 'key'].join('-'),
  zai: ['fixture', 'zai', 'key'].join('-'),
  mimo: ['fixture', 'mimo', 'key'].join('-'),
};
export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);

export const newRepo = () =>
  `r${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export interface FakeChange {
  number: number;
  branch: string;
  head: string;
  status: string;
  title: string;
  files: { path: string; patch: string }[];
  /** A push's own row (`auto`); absent as on a platform before migration 0044. */
  origin?: 'explicit' | 'auto';
  created_at?: number;
  body?: string;
  /** The newest flight plan, as `change show` answers it; left out by an older platform. */
  flight_plan?: { goal: string; scope: string | null } | null;
}

/** The platform's public API as far as the agents use it, plus refusals for anything else. */
export class FakePlatform {
  requests: { method: string; path: string; auth: string | null; body: any }[] = [];
  comments: any[] = [];
  checks: any[] = [];
  tokens: string[] = [];
  /** What each minted token holds, by name. */
  scopes = new Map<string, string[]>();
  /** The policy's required checks: a token posts one only with its `check:<name>` scope. */
  required: string[] = [];
  hooks: any[] = [];
  changes: FakeChange[] = [];
  revoked: string[] = [];
  /** When a deletion, since undone, revoked the listed tokens. */
  revokedAt: number | null = null;
  /** A credential shape only the platform's scanner knows (the managed pre-filter misses it). */
  scannerRefuses: RegExp | null = null;
  /** Comments the change has room for before the platform's cap refuses (null: plenty). */
  commentRoom: number | null = null;
  /** The owner's break-glass automation pause (repo status `automation.paused`). */
  paused = false;
  /** A platform older than the list's `branch` and `origin` filters answers every open change. */
  ignoresListFilters = false;
  /** Run agents on automatic Landings (repo status `landings.agents`); undefined: no such field. */
  autoAgents: boolean | undefined;
  /** A deleted repository: every call on it answers GONE, as the platform's tombstone does. */
  deleted = false;
  /** The workspace (the billed account): one per test, since ledgers outlive a test. */
  readonly account: string;
  readonly repos: string[];

  constructor(
    readonly repo: string,
    // A username the platform could give (a-z, 0-9, _): the managed API refuses anything else.
    account = `ws_${crypto.randomUUID().slice(0, 8)}`,
  ) {
    this.repos = [repo];
    this.account = account;
  }

  change(c: Partial<FakeChange> = {}) {
    const change: FakeChange = {
      number: 1,
      branch: 'feature',
      head: HEAD_A,
      status: 'open',
      title: 'Look users up by id',
      files: FIXTURES['security-review'].trigger.files,
      ...c,
    };
    this.changes = this.changes.filter((x) => x.number !== change.number).concat(change);
    return change;
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
    const cookie = req.headers.get('cookie');
    const auth = req.headers.get('authorization') ?? cookie;
    this.requests.push({ method: req.method, path: path + url.search, auth, body });
    const ok = (v: unknown) => Response.json(v);
    const refuse = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status });
    const owner = cookie === 'session=owner';
    const token = req.headers.get('authorization')?.startsWith('Bearer yrp_') === true;
    if (!owner && !token && cookie !== 'session=reader') return refuse('UNAUTHORIZED', 401);
    if (req.method === 'GET' && path === '/repos')
      return ok({
        repos: this.repos.map((id) => ({ id, name: `name-${id.slice(1, 5)}`, owner: this.account, role: owner ? 'owner' : 'read' })),
      });
    if (req.method === 'GET' && path === '/orgs') return ok({ orgs: [] });
    if (req.method === 'GET' && path === '/api/auth/session')
      return ok({ authenticated: true, username: owner ? this.account : 'someone-else' });
    const base = `/repos/${this.repo}`;
    if (this.deleted && (path === base || path.startsWith(`${base}/`))) return refuse('GONE', 404);
    if (req.method === 'GET' && path === base)
      return ok({
        owner: this.account,
        viewer: { owner, principal: owner ? 'user:owner' : 'user:reader' },
        automation: { paused: this.paused ? { by: 'user:owner' } : null },
        policy: { required_checks: this.required },
        ...(this.autoAgents === undefined ? {} : { landings: { create: true, agents: this.autoAgents } }),
      });
    const del = /^\/repos\/(r[0-9a-f]{20})\/(tokens|hooks)\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && del) {
      if (!owner) return refuse('FORBIDDEN', 403);
      this.revoked.push(`${del[2]}:${decodeURIComponent(del[3])}`);
      return ok({ deleted: true });
    }
    if (req.method === 'GET' && path === `${base}/changes`) {
      const wanted = (c: FakeChange) =>
        c.status === 'open' &&
        (this.ignoresListFilters ||
          ((!url.searchParams.has('branch') || c.branch === url.searchParams.get('branch')) &&
            (!url.searchParams.has('origin') || (c.origin ?? 'explicit') === url.searchParams.get('origin'))));
      return ok({ changes: this.changes.filter(wanted).map(({ files, ...c }) => c) });
    }
    const show = new RegExp(`^${base}/changes/(\\d+)$`).exec(path);
    if (req.method === 'GET' && show) {
      const c = this.changes.find((x) => x.number === Number(show[1]));
      if (!c) return refuse('NOT_FOUND', 404);
      return ok({
        ...c,
        base: 'main',
        comments: this.comments.filter((m) => m.number === c.number),
        diff: {
          base: { commit: BASE },
          head: { commit: c.head },
          changes: [...c.files.map((f) => ({ ...f, op: 'modify' })), { path: 'logo.png', op: 'add', binary: true }],
        },
      });
    }
    const comment = new RegExp(`^${base}/changes/(\\d+)/comments$`).exec(path);
    if (req.method === 'POST' && comment) {
      if (!token) return refuse('FORBIDDEN', 403);
      // The platform's secret scanner refuses credentials in comments.
      if (/ghp_[A-Za-z0-9]{36}/.test(String(body?.body)) || this.scannerRefuses?.test(String(body?.body)))
        return refuse('SECRET_DETECTED', 400);
      if (this.commentRoom !== null && this.comments.length >= this.commentRoom) return refuse('TOO_LARGE', 413);
      const posted = { id: this.comments.length + 1, number: Number(comment[1]), ...body };
      this.comments.push(posted);
      return ok({ comment: posted, resolved: 0 });
    }
    const check = new RegExp(`^${base}/commits/([0-9a-f]{40})/checks$`).exec(path);
    if (req.method === 'POST' && check) {
      const held = this.scopes.get(String(req.headers.get('authorization')).replace('Bearer yrp_fixture_', ''));
      if (this.required.includes(body.name) && !held?.includes(`check:${body.name}`))
        return refuse('FORBIDDEN', 403);
      this.checks.push({ commit: check[1], ...body });
      return ok({ recorded: true });
    }
    if (req.method === 'GET' && /^\/repos\/r[0-9a-f]{20}\/tokens$/.test(path)) {
      if (!owner) return refuse('FORBIDDEN', 403);
      // As the platform lists them: scopes are the stored JSON text.
      return ok({
        tokens: [...this.scopes].map(([name, scopes]) => ({
          name,
          scopes: JSON.stringify(scopes),
          revoked_at: this.revokedAt,
        })),
      });
    }
    if (req.method === 'POST' && /^\/repos\/r[0-9a-f]{20}\/tokens$/.test(path)) {
      if (!owner) return refuse('FORBIDDEN', 403);
      const key = `${path}:${body.name}`;
      if (this.tokens.includes(key)) return refuse('ALREADY_EXISTS', 409);
      this.tokens.push(key);
      this.scopes.set(body.name, body.scopes);
      return ok({ name: body.name, scopes: body.scopes, token: ['yrp', 'fixture', body.name].join('_') });
    }
    if (req.method === 'POST' && /^\/repos\/r[0-9a-f]{20}\/hooks$/.test(path)) {
      if (!owner) return refuse('FORBIDDEN', 403);
      const hook = { id: this.hooks.length + 7, path, ...body, secret: HOOK_SECRET };
      this.hooks.push(hook);
      return ok(hook);
    }
    if (req.method === 'GET' && path.startsWith(`${base}/`)) return ok({ read: path });
    if (req.method === 'POST' && path === `${base}/objects`) return ok({ objects: [] });
    return refuse('NOT_FOUND', 404);
  };
}

/** A model call the scripted CLI makes through the container's gateway handler. */
export interface ScriptedCall {
  /** Overrides the run's model (a CLI trying another one). */
  model?: string;
  path?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  stream?: boolean;
}
export interface Script {
  result?: Record<string, unknown> | null;
  error?: string;
  /** Polls before the run reports (default 1). */
  polls?: number;
  calls?: ScriptedCall[];
  transcript?: string;
}

/** The harness container double: records what it was given, answers polls from a script, and
 * makes the script's model calls through the real gateway handler. */
export class FakeHarness {
  started: { name: string; params: HarnessParams; spec: Record<string, any> }[] = [];
  ended = new Set<string>();
  responses: Response[] = [];
  scripts: Script[] = [];

  constructor(private readonly managed: () => ManagedEnv) {}

  namespace() {
    const boxes = new Map<string, unknown>();
    return {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!boxes.has(name)) boxes.set(name, this.box(name));
        return boxes.get(name);
      },
    } as unknown as ManagedEnv['HARNESS'];
  }

  box(name: string) {
    let polls = 0;
    let index = -1;
    return {
      begin: async (params: HarnessParams, spec: Record<string, any>) => {
        index = this.started.length;
        this.started.push({ name, params, spec });
      },
      status: async () => {
        const script = this.scripts[index] ?? this.scripts.at(-1) ?? {};
        polls++;
        if (polls === 1)
          for (const call of script.calls ?? []) this.responses.push(await this.call(this.started[index].params, call));
        if (polls < (script.polls ?? 1)) return { phase: 'running' };
        if (script.error) return { phase: 'failed', error: script.error, transcript: script.transcript ?? '' };
        return { phase: 'done', result: script.result ?? { summary: 'ok', findings: [] }, transcript: script.transcript ?? '' };
      },
      end: async () => void this.ended.add(name),
    };
  }

  async call(params: HarnessParams, call: ScriptedCall) {
    const gatewayPath = new URL(GATEWAY).pathname;
    const slug = { claude: 'anthropic', codex: 'openai', zai: 'custom-zai', mimo: 'custom-mimo' }[params.provider];
    // Codex speaks the Responses API; the others Anthropic Messages.
    const path = call.path ?? (params.provider === 'codex' ? `${gatewayPath}/${slug}/responses` : `${gatewayPath}/${slug}/v1/messages`);
    const req = new Request(`http://gateway.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'yoneda-managed-placeholder' },
      body: JSON.stringify({ model: call.model ?? params.model, max_tokens: 4000, stream: call.stream === true, messages: [] }),
    });
    const res = await outbound.gateway(req, this.managed(), { containerId: 'c', className: 'HarnessContainer', params });
    await res.text();
    return res;
  }
}

export type GatewayCall = { url: string; headers: Record<string, string>; body: any };

/** The real AI Gateway's place: answers each forwarded request with usage, JSON or SSE. */
/** Stripe in test mode, faked: no network. Records every call; `decline` makes the next
 * off-session payment fail as a card decline. */
export const STRIPE_BASE = 'https://stripe.test';
export const STRIPE_KEY = ['sk', 'test', 'fixture'].join('_');
export const STRIPE_WEBHOOK_SECRET = ['whsec', 'stripe', 'fixture'].join('_');
export const STRIPE_REFUND_KEY = ['rk', 'test', 'fixture'].join('_');
export type FakeCharge = {
  id: string;
  object: 'charge';
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  disputed: boolean;
  status: string;
  created: number;
  customer: string;
  payment_intent: string;
  metadata: Record<string, string>;
};
export type FakeRefund = {
  id: string;
  amount: number;
  status: string;
  charge: string;
  payment_intent: string;
  created: number;
  metadata: Record<string, string>;
};
export class FakeStripe {
  calls: { method: string; path: string; search: string; form: Record<string, string>; idempotency: string | null; auth: string | null }[] = [];
  intents = new Map<string, { id: string; status: string; amount: number }>();
  decline = false;
  detached: string[] = [];
  card = { brand: 'visa', last4: '4242' };
  charges = new Map<string, FakeCharge>();
  refunds: FakeRefund[] = [];
  /** Saved per idempotency key, as Stripe saves them, the 500s included, until pruned. */
  saved = new Map<string, Response>();
  /** The next refund request does its work, but its answer is lost (a 500 reaches the Worker). */
  loseRefundAnswer = false;
  /** The next refund request fails with this before any work. */
  refundError: { status: number; type: string; message: string } | null = null;
  /** The status a new refund starts in. */
  refundStatus = 'succeeded';
  /** Every read of a charge fails. */
  chargesDown = false;

  /** A refund as the dashboard makes one: no call from the Worker, no metadata of ours. */
  dashboardRefund(charge: FakeCharge, amount: number) {
    return this.refund(charge, amount, {});
  }

  private refund(charge: FakeCharge, amount: number, metadata: Record<string, string>) {
    charge.amount_refunded += amount;
    const refund = {
      id: `re_${this.refunds.length + 1}`,
      amount,
      status: this.refundStatus,
      charge: charge.id,
      payment_intent: charge.payment_intent,
      created: Math.floor(Date.now() / 1000),
      metadata,
    };
    this.refunds.push(refund);
    return refund;
  }

  private refundRoute(form: Record<string, string>, idempotency: string | null) {
    const known = idempotency ? this.saved.get(idempotency) : undefined;
    if (known) return known.clone();
    const answer = this.refundAnswer(form);
    if (idempotency) this.saved.set(idempotency, answer.clone());
    return answer;
  }

  private refundAnswer(form: Record<string, string>) {
    const error = (status: number, type: string, message: string) => Response.json({ error: { type, message } }, { status });
    if (this.refundError) {
      const { status, type, message } = this.refundError;
      this.refundError = null;
      return error(status, type, message);
    }
    const charge = [...this.charges.values()].find((c) => c.payment_intent === form.payment_intent);
    if (!charge) return error(404, 'invalid_request_error', 'No such payment intent');
    const amount = Number(form.amount);
    if (charge.amount_refunded + amount > charge.amount)
      return error(400, 'invalid_request_error', 'Refund amount is greater than the unrefunded amount');
    const metadata = Object.fromEntries(
      Object.entries(form)
        .filter(([k]) => k.startsWith('metadata['))
        .map(([k, v]) => [k.slice('metadata['.length, -1), v]),
    );
    const refund = this.refund(charge, amount, metadata);
    if (this.loseRefundAnswer) {
      this.loseRefundAnswer = false;
      return error(500, 'api_error', 'An error occurred');
    }
    return Response.json(refund);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const form = Object.fromEntries(new URLSearchParams(req.method === 'POST' ? await req.text() : ''));
    const idempotency = req.headers.get('idempotency-key');
    this.calls.push({ method: req.method, path: url.pathname, search: url.search, form, idempotency, auth: req.headers.get('authorization') });
    const ok = (v: unknown) => Response.json(v);
    if (url.pathname === '/v1/refunds' && req.method === 'POST') return this.refundRoute(form, idempotency);
    if (url.pathname === '/v1/refunds') {
      const intent = url.searchParams.get('payment_intent');
      const since = Number(url.searchParams.get('created[gte]') ?? 0);
      const data = this.refunds
        .filter((r) => (intent ? r.payment_intent === intent : r.created >= since))
        .map((r) => (url.searchParams.has('expand[]') ? { ...r, charge: this.charges.get(r.charge) } : r));
      return ok({ data, has_more: false });
    }
    if (url.pathname === '/v1/charges') {
      const customer = url.searchParams.get('customer');
      const since = Number(url.searchParams.get('created[gte]') ?? 0);
      const data = [...this.charges.values()].filter((c) => (customer ? c.customer === customer : c.created >= since));
      return ok({ data, has_more: false });
    }
    const charge = /^\/v1\/charges\/([^/]+)$/.exec(url.pathname);
    if (charge) {
      if (this.chargesDown) return Response.json({ error: { type: 'api_error', message: 'down' } }, { status: 500 });
      const found = this.charges.get(charge[1]);
      if (found) return ok(found);
      return Response.json({ error: { type: 'invalid_request_error', message: 'No such charge' } }, { status: 404 });
    }
    if (url.pathname === '/v1/customers' && req.method === 'POST') return ok({ id: `cus_${this.calls.length}` });
    if (url.pathname === '/v1/checkout/sessions' && req.method === 'POST')
      return ok({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
    const pm = /^\/v1\/payment_methods\/([^/]+)$/.exec(url.pathname);
    if (pm && req.method === 'GET') return ok({ id: pm[1], card: this.card });
    const detach = /^\/v1\/payment_methods\/([^/]+)\/detach$/.exec(url.pathname);
    if (detach) {
      this.detached.push(detach[1]);
      return ok({ id: detach[1] });
    }
    if (url.pathname === '/v1/payment_intents' && req.method === 'POST') {
      // Stripe's idempotency: the same key answers the same intent.
      const known = idempotency ? this.intents.get(idempotency) : undefined;
      if (known) return ok(known);
      if (this.decline)
        return Response.json(
          { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.', payment_intent: { id: 'pi_declined', status: 'requires_payment_method' } } },
          { status: 402 },
        );
      const intent = { id: `pi_${this.intents.size + 1}`, status: 'succeeded', amount: Number(form.amount) };
      if (idempotency) this.intents.set(idempotency, intent);
      // Stripe copies a payment intent's metadata onto the charge it creates.
      const chargeId = `ch_${this.charges.size + 1}`;
      this.charges.set(chargeId, {
        id: chargeId,
        object: 'charge',
        amount: intent.amount,
        amount_captured: intent.amount,
        amount_refunded: 0,
        disputed: false,
        status: 'succeeded',
        created: Math.floor(Date.now() / 1000),
        customer: form.customer,
        payment_intent: intent.id,
        metadata: { workspace: form['metadata[workspace]'], top_up: form['metadata[top_up]'] },
      });
      return ok(intent);
    }
    return Response.json({ error: { type: 'invalid_request_error', message: `no route ${url.pathname}` } }, { status: 404 });
  }

  /** A signed webhook request, as Stripe sends it. */
  async webhook(event: Record<string, unknown>, opts: { secret?: string; at?: number } = {}) {
    const body = JSON.stringify(event);
    const t = Math.floor((opts.at ?? Date.now()) / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(opts.secret ?? STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
    const v1 = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    return new Request('https://managed.example.com/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' },
      body,
    });
  }
}

export function fakeGateway(usage = { input_tokens: 1000, output_tokens: 200 }, stripe?: FakeStripe) {
  const calls: GatewayCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (stripe && req.url.startsWith(STRIPE_BASE)) return stripe.handle(req);
    if (!req.url.startsWith(GATEWAY)) throw new Error(`unexpected fetch ${req.url}`);
    const body = await req.json<any>();
    calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body });
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
        { type: 'content_block_delta', delta: { text: 'hi' } },
        { type: 'message_delta', usage: { output_tokens: usage.output_tokens } },
      ];
      const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ content: [{ type: 'text', text: '{}' }], usage });
  });
  return calls;
}

export interface Harness {
  transcripts: Map<string, string>;
  r2: { listCalls: { prefix: string; limit: number }[]; deleteCalls: number[] };
  env: ManagedEnv;
  platform: FakePlatform;
  harness: FakeHarness;
  sent: QueueMessage[];
  created: RunParams[];
}

/** An env with the real Durable Objects and fakes for the platform, queue, workflows, harness
 * containers, transcripts store and keys. */
export function harness(
  repo = newRepo(),
  overrides: Partial<ManagedEnv> = {},
  account?: string,
): Harness {
  const platform = new FakePlatform(repo, account);
  const sent: QueueMessage[] = [];
  const created: RunParams[] = [];
  const ids = new Set<string>();
  const transcripts = new Map<string, string>();
  const listCalls: { prefix: string; limit: number }[] = [];
  const deleteCalls: number[] = [];
  const secret = (value: string) => ({ get: async () => value }) as unknown as SecretsStoreSecret;
  let managed: ManagedEnv;
  const fakeHarness = new FakeHarness(() => managed);
  managed = {
    ...(env as unknown as ManagedEnv),
    PLATFORM: { fetch: platform.fetch } as unknown as Fetcher,
    HARNESS: fakeHarness.namespace(),
    RUNS: {
      send: async (m: QueueMessage) => void sent.push(m),
      sendBatch: async (ms: { body: QueueMessage }[]) => void sent.push(...ms.map((m) => m.body)),
    } as unknown as Queue<QueueMessage>,
    REVIEWS: {
      create: async ({ id, params }: { id: string; params: RunParams }) => {
        if (ids.has(id)) throw new Error(`instance ${id} already exists`);
        ids.add(id);
        created.push(params);
        return { id };
      },
    } as unknown as Workflow<RunParams>,
    TRANSCRIPTS: {
      put: async (key: string, text: string) => void transcripts.set(key, text),
      // R2's list: keys in order, at most `limit` (default 1000) a page, `truncated` past it.
      list: async ({ prefix, limit = 1000 }: { prefix: string; limit?: number }) => {
        const keys = [...transcripts.keys()].filter((k) => k.startsWith(prefix)).sort();
        listCalls.push({ prefix, limit });
        return {
          objects: keys.slice(0, limit).map((key) => ({ key, uploaded: new Date() })),
          truncated: keys.length > limit,
        };
      },
      delete: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.length > 1000) throw new Error('R2 deletes at most 1000 keys a call');
        deleteCalls.push(list.length);
        for (const k of list) transcripts.delete(k);
      },
      get: async (key: string) => (transcripts.has(key) ? { text: async () => transcripts.get(key) } : null),
    } as unknown as R2Bucket,
    CLAUDE_KEY: secret(KEYS.claude),
    CODEX_KEY: secret(KEYS.codex),
    ZAI_KEY: secret(KEYS.zai),
    MIMO_KEY: secret(KEYS.mimo),
    ...overrides,
  };
  return { env: managed, platform, harness: fakeHarness, sent, created, transcripts, r2: { listCalls, deleteCalls } };
}

/** Runs each step once, in order, like a Workflow that never fails; sleeps are instant. */
export const inline: Steps = { do: (_name, fn) => fn(), sleep: async () => {} };

export async function signature(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
