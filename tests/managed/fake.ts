// Test fixtures: a fake platform public API (the endpoints the agents use, recording every
// request), a fake AI Gateway answering the review chain from a script, and an inline step
// runner. Repositories, commits, keys and replies are invented; nothing reaches the network.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { ManagedEnv, QueueMessage, RunParams } from '../../cloudflare/managed/config';
import type { Steps } from '../../cloudflare/managed/review';

export const GATEWAY = 'https://gateway.example.com/v1/acct/yonedarepo-test-agents';
export const ZAI_FIXTURE_KEY = 'fixture-zai-key-not-real';
/** The fake hook's signing secret, built at run time so no credential-shaped literal is committed. */
export const HOOK_SECRET = ['whsec', 'fixture'.repeat(3)].join('_');
export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);

export const newRepo = () =>
  `r${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export const PATCH = [
  '@@ -1,3 +1,5 @@',
  ' export function find(db, id) {',
  "-  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
  "+  const sql = 'SELECT * FROM users WHERE id = ' + id;",
  '+  return db.query(sql);',
  ' }',
  '+export const VERSION = 2;',
].join('\n');

export interface FakeChange {
  number: number;
  branch: string;
  head: string;
  status: string;
  title: string;
  body: string;
  patch: string;
}

/** The platform's public API as far as the agents use it, plus refusals for anything else. */
export class FakePlatform {
  requests: { method: string; path: string; auth: string | null; body: any }[] = [];
  comments: any[] = [];
  checks: any[] = [];
  tokens: string[] = [];
  hooks: any[] = [];
  changes: FakeChange[] = [];
  /** The repository's owner, the billed account (one per test: ledgers outlive a test). */
  readonly account = `acct-${crypto.randomUUID()}`;

  constructor(readonly repo: string) {}

  change(c: Partial<FakeChange> = {}) {
    const change: FakeChange = {
      number: 1,
      branch: 'feature',
      head: HEAD_A,
      status: 'open',
      title: 'Look users up by id',
      body: 'Small refactor.',
      patch: PATCH,
      ...c,
    };
    this.changes = this.changes.filter((x) => x.number !== change.number).concat(change);
    return change;
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
    const auth = req.headers.get('authorization') ?? req.headers.get('cookie');
    this.requests.push({ method: req.method, path: path + url.search, auth, body });
    const ok = (v: unknown) => Response.json(v);
    const refuse = (code: string, status: number) =>
      Response.json({ error: { code, message: code } }, { status });
    const base = `/repos/${this.repo}`;
    const owner = req.headers.get('cookie') === 'session=owner';
    const token = req.headers.get('authorization')?.startsWith('Bearer yrp_') === true;
    if (!owner && !token && req.headers.get('cookie') !== 'session=reader')
      return refuse('UNAUTHORIZED', 401);
    if (req.method === 'GET' && path === base)
      return ok({
        owner: this.account,
        viewer: { owner, principal: owner ? 'user:owner' : 'user:reader', role: owner ? 'admin' : 'read' },
      });
    if (req.method === 'GET' && path === `${base}/changes`)
      return ok({ changes: this.changes.filter((c) => c.status === 'open').map(({ patch, ...c }) => c) });
    const show = new RegExp(`^${base}/changes/(\\d+)$`).exec(path);
    if (req.method === 'GET' && show) {
      const c = this.changes.find((x) => x.number === Number(show[1]));
      if (!c) return refuse('NOT_FOUND', 404);
      return ok({
        ...c,
        base: 'main',
        comments: this.comments.filter((m) => m.number === c.number),
        diff: {
          base: { commit: 'c'.repeat(40) },
          head: { commit: c.head },
          changes: [
            { path: 'src/users.js', op: 'modify', patch: c.patch, additions: 3, deletions: 1 },
            { path: 'logo.png', op: 'add', binary: true },
          ],
        },
      });
    }
    if (req.method === 'GET' && path === `${base}/context/relevant`)
      return ok({ items: [{ kind: 'memory', title: 'SQL', text: 'Always use parameterized queries.' }] });
    const comment = new RegExp(`^${base}/changes/(\\d+)/comments$`).exec(path);
    if (req.method === 'POST' && comment) {
      if (!token) return refuse('FORBIDDEN', 403);
      // The platform's secret scanner refuses credentials in comments.
      if (/ghp_[A-Za-z0-9]{36}/.test(String(body?.body))) return refuse('SECRET_DETECTED', 400);
      const posted = { id: this.comments.length + 1, number: Number(comment[1]), ...body };
      this.comments.push(posted);
      return ok({ comment: posted, resolved: 0 });
    }
    const check = new RegExp(`^${base}/commits/([0-9a-f]{40})/checks$`).exec(path);
    if (req.method === 'POST' && check) {
      this.checks.push({ commit: check[1], ...body });
      return ok({ recorded: true });
    }
    if (req.method === 'POST' && path === `${base}/tokens`) {
      if (!owner) return refuse('FORBIDDEN', 403);
      if (this.tokens.includes(body.name)) return refuse('ALREADY_EXISTS', 409);
      this.tokens.push(body.name);
      return ok({ name: body.name, scopes: body.scopes, token: `yrp_fixture_${body.name}_0123456789abcdef` });
    }
    if (req.method === 'POST' && path === `${base}/hooks`) {
      if (!owner) return refuse('FORBIDDEN', 403);
      const hook = { id: this.hooks.length + 7, ...body, secret: HOOK_SECRET };
      this.hooks.push(hook);
      return ok(hook);
    }
    return refuse('NOT_FOUND', 404);
  };

  /** The endpoints a run touched, as `METHOD path` without query strings. */
  touched() {
    return [...new Set(this.requests.map((r) => `${r.method} ${r.path.split('?')[0].replace(this.repo, 'R')}`))];
  }
}

export type Script = { summarise?: unknown; review?: unknown; rank?: unknown };

/** The AI Gateway: answers the chain's three prompts from `script`, recording each call. */
export function fakeGateway(script: Script = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const reply = (value: unknown) =>
    Response.json({
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(GATEWAY)) throw new Error(`unexpected fetch ${req.url}`);
    const body = await req.json<any>();
    calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body });
    const prompt = String(body.messages?.[0]?.content ?? '');
    if (prompt.startsWith('Summarise'))
      return reply(script.summarise ?? { summary: 'Builds the user query by string concatenation.', focus: ['src/users.js'] });
    if (prompt.startsWith('Below are candidate'))
      return reply(script.rank ?? { keep: [0, 1] });
    return reply(
      script.review ?? {
        findings: [
          { path: 'src/users.js', line: 2, severity: 'high', title: 'SQL injection', why: 'id is concatenated into the query.' },
          { path: 'src/users.js', line: 5, severity: 'low', title: 'Unused export', why: 'VERSION is never read.' },
        ],
      },
    );
  });
  return calls;
}

export interface Harness {
  env: ManagedEnv;
  platform: FakePlatform;
  sent: QueueMessage[];
  created: RunParams[];
}

/** An env with the real Durable Objects and a fake platform, queue, workflows and keys. */
export function harness(repo = newRepo(), overrides: Partial<ManagedEnv> = {}): Harness {
  const platform = new FakePlatform(repo);
  const sent: QueueMessage[] = [];
  const created: RunParams[] = [];
  const ids = new Set<string>();
  const secret = (value: string) => ({ get: async () => value }) as unknown as SecretsStoreSecret;
  const base = env as unknown as ManagedEnv;
  const managed: ManagedEnv = {
    ...base,
    PLATFORM: { fetch: platform.fetch } as unknown as Fetcher,
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
    ZAI_KEY: secret(ZAI_FIXTURE_KEY),
    CLAUDE_KEY: secret('fixture-claude-key-not-real'),
    ...overrides,
  };
  return { env: managed, platform, sent, created };
}

/** Runs each step once, in order, like a Workflow that never fails. */
export const inline: Steps = { do: (_name, fn) => fn() };

export async function signature(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
