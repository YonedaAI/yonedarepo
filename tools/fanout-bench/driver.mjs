// The laptop side of the bench (tools/platform-fanout-bench.mjs): one owner session on the
// platform for setup and verification, and calls to the bench client Worker, which sends
// the measured load. Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the
// bench client.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTHOR = { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' };
export const b64 = (text) => Buffer.from(text).toString('base64');
const root = fileURLToPath(new URL('../../', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(url, client) {
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
  });
  assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  // A read is retried when the connection itself fails (a reset or connect timeout on the
  // machine running the bench), never on an HTTP answer; writes are never retried.
  const call = async (method, path, body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`${url}/api/v1${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      } catch (e) {
        if (method !== 'GET' || attempt >= 5) throw e;
        await pause(500 * attempt);
      }
    }
  };
  const post = async (path, body) => {
    const { status, body: value } = await call('POST', path, body);
    assert.equal(status, 200, `${path}: ${value.error?.code} ${value.error?.message}`);
    return value;
  };

  /** Sends one request to the bench client; `{failed}` says how it did not answer 200 (its
   * status and body, e.g. a Cloudflare error page, or why the fetch itself failed). */
  async function invoke(body) {
    const started = Date.now();
    const after = () => `after ${Date.now() - started} ms`;
    let response;
    try {
      response = await fetch(client, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-key': process.env.BENCH_KEY ?? '' },
        body: JSON.stringify({ target: url, ...body }),
      });
    } catch (e) {
      return { failed: `bench client fetch failed ${after()}: ${e?.cause?.code ?? e?.name ?? ''} ${String(e?.cause?.message ?? e?.message ?? e)}`.slice(0, 300) };
    }
    if (response.status !== 200) {
      const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      return { failed: `bench client answered ${response.status} ${after()}: ${text}` };
    }
    return response.json();
  }

  /** Sends `writers` (or readers) to the bench client in batches of five, all at once. */
  async function fanout(repo, writers) {
    const batches = [];
    for (let i = 0; i < writers.length; i += 5) batches.push(writers.slice(i, i + 5));
    const replies = await Promise.all(
      batches.map(async (batch) => {
        const reply = await invoke({ repo, writers: batch });
        // A bench client invocation that failed outright counts its writers as failed.
        if (reply.failed) {
          const failed = { status: 0, error: 'BENCH_CLIENT', message: reply.failed, started_at: Date.now() };
          return batch.map((w) => (w.read || w.get ? { read: { ...failed, ok: false } } : { commit: failed, land: null }));
        }
        return reply.results;
      }),
    );
    return replies.flat();
  }

  const created = [];
  async function createRepo(prefix, files) {
    const name = `${prefix}-${Date.now()}`;
    const { id } = await post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author: AUTHOR });
    created.push({ id, name });
    return id;
  }

  /** Deletes every repository `createRepo` made (with their tokens); the names left behind. */
  async function cleanup() {
    const left = [];
    for (const { id, name } of created.splice(0)) {
      const { status, body } = await call('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`).catch((e) => ({ status: e.message, body: {} }));
      if (status !== 200) left.push(`${name} (${[status, body.error?.code].filter(Boolean).join(' ')})`);
    }
    return left;
  }

  /** `count` repository tokens (read, write, land), minted 50 at a time. */
  async function mintTokens(repo, count) {
    const tokens = [];
    for (let i = 0; i < count; i += 50)
      tokens.push(...(await Promise.all(Array.from({ length: Math.min(50, count - i) }, async (_, k) => (await post(`/repos/${repo}/tokens`, { name: `w${i + k}`, scopes: ['read', 'write', 'land'] })).token))));
    return tokens;
  }

  /** Log entries with `after < version <= until`; a busy authority's refusal is retried. */
  async function txlog(repo, after, until) {
    const entries = [];
    let refused = 0;
    for (let from = after; from < until; ) {
      const { status, body } = await call('GET', `/repos/${repo}/txlog?after=${from}&limit=500`);
      if (status !== 200) {
        assert.ok(++refused < 30, `txlog keeps refusing: ${status} ${body.error?.code}`);
        await pause(1000);
        continue;
      }
      entries.push(...body.entries.filter((e) => e.version <= until));
      if (!body.entries.length) break;
      from = body.entries.at(-1).version;
    }
    return { entries, refused };
  }

  return { url, cookie, call, post, invoke, fanout, createRepo, cleanup, mintTokens, txlog };
}

/** Writes `.local/platform-live/<name>.json` with the revision and prints it. */
export async function evidence(name, target, result) {
  const recorded = {
    schema: 1,
    target,
    client: 'bench client Worker, aws:us-east-1',
    recorded_at: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    result,
  };
  await mkdir(resolve(root, '.local/platform-live'), { recursive: true });
  await writeFile(resolve(root, `.local/platform-live/${name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(JSON.stringify(recorded, null, 2));
  return recorded;
}
