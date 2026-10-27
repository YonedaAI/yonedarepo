// An overloaded or briefly unreachable Durable Object is the platform's condition, not the
// caller's mistake: REST and Git answer 503 OVERLOADED with Retry-After (so clients retry),
// MCP names OVERLOADED in the tool error, and an unexpected failure is 500 INTERNAL, never
// INVALID_INPUT. A push refused before any ref moved is a 503 Git reports, not a per-ref "ng".
import { expect, it } from 'vitest';
import { failureCode, transient } from '../../cloudflare/worker/durable';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

// As workerd throws them (see the Durable Objects error-handling docs).
const overloaded = () =>
  Object.assign(new Error('Durable Object is overloaded. Requests queued for too long.'), { overloaded: true });
const internal = () => new Error('internal error; reference = 0123456789abcdef');

/** `scoped`, with the authority failing every command whose op `fails` picks. */
function failing(fails: (op: string) => (() => Error) | null): Env {
  const namespace = scoped.SOURCE_REPOS;
  return {
    ...scoped,
    SOURCE_REPOS: {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return {
          fetch: async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body));
            const ops: string[] = Array.isArray(body) ? body.map((c) => c.op) : [body.op];
            const failure = ops.map(fails).find(Boolean);
            if (failure) throw failure();
            return stub.fetch(url, init);
          },
        };
      },
    },
  } as unknown as Env;
}

async function setup(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'bot', scopes: ['read', 'write', 'land'] } });
  return { repo, token: minted.body.token as string };
}

const call = (env: Env, path: string, token: string, init: RequestInit = {}) =>
  platformFetch(new Request(`https://yoneda${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }), env);

it('classifies Durable Object failures by what they say about the request', () => {
  expect(failureCode(overloaded())).toBe('OVERLOADED');
  expect(failureCode(new Error('Too many requests queued for this Durable Object'))).toBe('OVERLOADED');
  expect(failureCode(Object.assign(new Error('Network connection lost.'), { retryable: true }))).toBe('OVERLOADED');
  expect(failureCode(internal())).toBe('INTERNAL');
  // A platform answer keeps its code, whatever its message says.
  expect(failureCode(Object.assign(new Error('overloaded'), { code: 'CONFLICT' }))).toBe('CONFLICT');
  expect(transient(Object.assign(new Error('x'), { code: 'NOT_FOUND', retryable: true }))).toBe(false);
});

it('answers 503 OVERLOADED with Retry-After over REST, and 500 INTERNAL for the unexpected', async () => {
  const { repo, token } = await setup('overload_rest');
  const busy = await call(failing(() => overloaded), `/api/v1/repos/${repo}/refs`, token);
  expect(busy.status).toBe(503);
  expect(busy.headers.get('retry-after')).toBe('1');
  expect((await busy.json<any>()).error.code).toBe('OVERLOADED');

  const broken = await call(failing(() => internal), `/api/v1/repos/${repo}/refs`, token);
  expect(broken.status).toBe(500);
  expect(broken.headers.get('retry-after')).toBeNull();
  expect((await broken.json<any>()).error).toMatchObject({ code: 'INTERNAL', message: internal().message });

  // Genuine input errors stay 4xx.
  const bad = await call(scoped, `/api/v1/repos/${repo}/commits`, token, { method: 'POST', body: '{' });
  expect([bad.status, (await bad.json<any>()).error.code]).toEqual([400, 'INVALID_INPUT']);
});

it('names OVERLOADED in an MCP tool error', async () => {
  const { repo, token } = await setup('overload_mcp');
  const response = await call(failing(() => overloaded), `/api/v1/repos/${repo}/mcp`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_status', arguments: {} } }),
  });
  const { result } = await response.json<any>();
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/^OVERLOADED: .*retry after 1 s/);
});

it('answers Git 503 with Retry-After, and refuses a push whose objects could not be stored', async () => {
  const { repo, token } = await setup('overload_git');
  const basic = `Basic ${btoa(`git:${token}`)}`;
  const refs = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic } }),
    failing(() => overloaded),
  );
  expect([refs.status, refs.headers.get('retry-after')]).toEqual([503, '1']);
  expect(await refs.text()).toMatch(/^OVERLOADED: /);

  // Access and the pack check pass; recording the pushed commits meets an overloaded authority.
  const main = (await api(`/repos/${repo}/refs`, { token })).body.refs['refs/heads/main'] as string;
  const enc = new TextEncoder();
  const hash = async (kind: string, data: Uint8Array) => {
    const whole = new Uint8Array([...enc.encode(`${kind} ${data.length}\0`), ...data]);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-1', whole))].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const blob = enc.encode('pushed\n');
  const blobId = await hash('blob', blob);
  const tree = new Uint8Array([...enc.encode('100644 b.md\0'), ...(blobId.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))]);
  const treeId = await hash('tree', tree);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = enc.encode(`tree ${treeId}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\npushed\n`);
  const commitId = await hash('commit', commit);
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/topic',
    old: null,
    new: commitId,
    objects: [
      { id: commitId, kind: 'commit', data_b64: b64(commit) },
      { id: treeId, kind: 'tree', data_b64: b64(tree) },
      { id: blobId, kind: 'blob', data_b64: b64(blob) },
    ],
  });
  const push = (env: Env) =>
    platformFetch(
      new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basic },
        body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
      }),
      env,
    );
  const topic = async () => (await api(`/repos/${repo}/refs`, { token })).body.refs['refs/heads/topic'];
  for (const op of ['repo_record_pushed', 'repo_branch_batch']) {
    const pushed = await push(failing((o) => (o === op ? overloaded : null)));
    expect([op, pushed.status, pushed.headers.get('retry-after')]).toEqual([op, 503, '1']);
    expect(await topic()).toBeUndefined();
  }
  // The retry goes through.
  const retried = await push(scoped);
  expect([retried.status, new TextDecoder().decode(await retried.arrayBuffer())]).toEqual([200, expect.stringContaining('ok refs/heads/topic')]);
  expect(await topic()).toBe(commitId);
});
