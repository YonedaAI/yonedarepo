// The laptop side of the bench (tools/platform-fanout-bench.mjs): one owner session on the
// platform for setup and verification, and calls to the bench client Worker, which sends
// the measured load. Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the
// bench client.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_VERSION, RELAY_MAX } from './relay.js';
import { OWN_TRAFFIC } from '../own-traffic.mjs';

export const AUTHOR = { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' };
export const b64 = (text) => Buffer.from(text).toString('base64');
const root = fileURLToPath(new URL('../../', import.meta.url));
export const EVIDENCE_DIR = resolve(root, '.local/platform-live');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** `client2` is a second bench client Worker: invocations alternate between the two. */
export async function connect(url, client, { client2 } = {}) {
  const clients = [client, client2].filter(Boolean);
  // How many of them the next invocations use: a run compares 1 against 2 on one session.
  let active = clients.length;
  let turn = 0;
  const signIn = async () => {
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...OWN_TRAFFIC },
      body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
    });
    assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
    return (login.headers.get('set-cookie') ?? '').split(';')[0];
  };
  let cookie = await signIn();
  // A read is retried when the connection itself fails (a reset or connect timeout on the
  // machine running the bench), never on an HTTP answer; writes are never retried. A session
  // that ended is the one exception: nothing ran, and a multi-hour run outlives one.
  const call = async (method, path, body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`${url}/api/v1${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...OWN_TRAFFIC, cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 401 && attempt === 1) {
          cookie = await signIn();
          continue;
        }
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
      response = await fetch(clients[turn++ % active], {
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

  /** Sends many `{repo, writers}` batches through the bench client's relay, so this machine
   * holds one connection per RELAY_MAX batches: they answer as `{repo, ...result}` rows. */
  async function relayed(batches) {
    const roots = [];
    for (let i = 0; i < batches.length; i += RELAY_MAX) roots.push(batches.slice(i, i + RELAY_MAX));
    const replies = await Promise.all(
      roots.map(async (root) => {
        const reply = await invoke({ relay: root });
        if (reply.failed) {
          const failed = { status: 0, error: 'BENCH_CLIENT', message: reply.failed, started_at: Date.now() };
          return root.flatMap((b) => b.writers.map(() => ({ repo: b.repo, commit: failed, land: null })));
        }
        return reply.batches.flatMap((b) => b.results.map((r) => ({ repo: b.repo, ...r })));
      }),
    );
    return replies.flat();
  }

  /** Stops before any setup if a bench client is older than this bench or cannot reach itself. */
  async function preflight() {
    for (const url of clients) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-key': process.env.BENCH_KEY ?? '' },
        body: JSON.stringify({ ping: { self: true } }),
      }).catch((e) => ({ status: `unreachable (${e.message})` }));
      const body = response.status === 200 ? await response.json().catch(() => ({})) : {};
      if (body.bench !== BENCH_VERSION || !body.relay)
        throw new Error(`Bench client ${url} is not ready (status ${response.status}, version ${body.bench ?? 'none'}, relay ${body.relay ?? 'none'}): deploy tools/fanout-bench first`);
    }
  }

  /** A setup request, retried as a refused or dropped one can be; the measured load never is. */
  async function setup(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const answer = await call(method, path, body).catch((e) => ({ status: 0, body: { error: { code: 'CLIENT_FETCH', message: String(e) } } }));
      if (answer.status === 200) return answer.body;
      if (attempt >= 4) throw new Error(`${method} ${path}: ${answer.status} ${answer.body.error?.code} ${answer.body.error?.message}`);
      await pause(500 * (attempt + 1));
    }
  }

  const created = [];
  /** A repository a saved pool keeps: no run deletes it. */
  async function createKept(name) {
    const files = [{ path: 'README.md', content_b64: b64(`${name}\n`) }];
    const { id } = await setup('POST', '/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author: AUTHOR });
    return { id, name };
  }

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

  /** `count` repository tokens (read, write, land) named `<label><n>`, minted 50 at a time. */
  async function mintTokens(repo, count, label = 'w') {
    const tokens = [];
    for (let i = 0; i < count; i += 50)
      tokens.push(...(await Promise.all(Array.from({ length: Math.min(50, count - i) }, async (_, k) => (await setup('POST', `/repos/${repo}/tokens`, { name: `${label}${i + k}`, scopes: ['read', 'write', 'land'] })).token))));
    return tokens;
  }

  /** Revokes what `mintTokens(repo, count, label)` made; how many could not be revoked. */
  async function revokeTokens(repo, count, label) {
    let left = 0;
    for (let i = 0; i < count; i += 50) {
      const answers = await Promise.all(Array.from({ length: Math.min(50, count - i) }, (_, k) => call('DELETE', `/repos/${repo}/tokens/${label}${i + k}`).catch(() => ({ status: 0 }))));
      left += answers.filter((a) => a.status !== 200).length;
    }
    return left;
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

  return {
    url,
    get clients() {
      return active;
    },
    useClients(count) {
      assert.ok(count >= 1 && count <= clients.length, `${clients.length} bench clients configured, ${count} asked for`);
      active = count;
    },
    get cookie() {
      return cookie;
    },
    call,
    post,
    setup,
    invoke,
    fanout,
    relayed,
    preflight,
    createRepo,
    createKept,
    cleanup,
    mintTokens,
    revokeTokens,
    txlog,
  };
}

/** A run's stamp in a file name: sorts by time, safe on any filesystem. */
export const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');
/** A credential in evidence is a bug: evidence is kept, and quoted in docs. */
const SECRET = /\b(yrp|ypat)_[A-Za-z0-9_-]{16,}/;

/** The recorded form of one run; throws rather than record a credential. */
export function evidenceRecord(target, result, { recorded_at, revision, client = 'bench client Worker, aws:us-east-1' }) {
  const record = { schema: 2, target, client, recorded_at, revision, result };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (SECRET.test(text)) throw new Error('Evidence holds a token; not writing it');
  return { record, text };
}

/** Writes `.local/platform-live/<name>-<stamp>.json`, one file per run (never over another),
 * with the revision, and prints it. */
export async function evidence(name, target, result, { client, quiet = false } = {}) {
  const now = new Date();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const { record, text } = evidenceRecord(target, result, { recorded_at: now.toISOString(), revision, client });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(resolve(EVIDENCE_DIR, `${name}-${stampOf(now)}.json`), text, { flag: 'wx' });
  if (!quiet) console.log(text.trimEnd());
  return record;
}
