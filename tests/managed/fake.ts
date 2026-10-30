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
}

/** The platform's public API as far as the agents use it, plus refusals for anything else. */
export class FakePlatform {
  requests: { method: string; path: string; auth: string | null; body: any }[] = [];
  comments: any[] = [];
  checks: any[] = [];
  tokens: string[] = [];
  hooks: any[] = [];
  changes: FakeChange[] = [];
  revoked: string[] = [];
  /** A credential shape only the platform's scanner knows (the managed pre-filter misses it). */
  scannerRefuses: RegExp | null = null;
  /** The owner's break-glass automation pause (repo status `automation.paused`). */
  paused = false;
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
    const base = `/repos/${this.repo}`;
    if (req.method === 'GET' && path === base)
      return ok({ owner: this.account, automation: { paused: this.paused ? { by: 'user:owner' } : null } });
    const del = /^\/repos\/(r[0-9a-f]{20})\/(tokens|hooks)\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && del) {
      if (!owner) return refuse('FORBIDDEN', 403);
      this.revoked.push(`${del[2]}:${decodeURIComponent(del[3])}`);
      return ok({ deleted: true });
    }
    if (req.method === 'GET' && path === `${base}/changes`)
      return ok({ changes: this.changes.filter((c) => c.status === 'open').map(({ files, ...c }) => c) });
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
      const posted = { id: this.comments.length + 1, number: Number(comment[1]), ...body };
      this.comments.push(posted);
      return ok({ comment: posted, resolved: 0 });
    }
    const check = new RegExp(`^${base}/commits/([0-9a-f]{40})/checks$`).exec(path);
    if (req.method === 'POST' && check) {
      this.checks.push({ commit: check[1], ...body });
      return ok({ recorded: true });
    }
    if (req.method === 'POST' && /^\/repos\/r[0-9a-f]{20}\/tokens$/.test(path)) {
      if (!owner) return refuse('FORBIDDEN', 403);
      const key = `${path}:${body.name}`;
      if (this.tokens.includes(key)) return refuse('ALREADY_EXISTS', 409);
      this.tokens.push(key);
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
export function fakeGateway(usage = { input_tokens: 1000, output_tokens: 200 }) {
  const calls: GatewayCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
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
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...transcripts.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })),
      }),
      get: async (key: string) => (transcripts.has(key) ? { text: async () => transcripts.get(key) } : null),
    } as unknown as R2Bucket,
    CLAUDE_KEY: secret(KEYS.claude),
    CODEX_KEY: secret(KEYS.codex),
    ZAI_KEY: secret(KEYS.zai),
    MIMO_KEY: secret(KEYS.mimo),
    ...overrides,
  };
  return { env: managed, platform, harness: fakeHarness, sent, created };
}

/** Runs each step once, in order, like a Workflow that never fails; sleeps are instant. */
export const inline: Steps = { do: (_name, fn) => fn(), sleep: async () => {} };

export async function signature(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
