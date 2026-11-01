// A Git read waits out a brief overload before its first byte (stock Git retries nothing), and
// when it cannot, says so where Git prints it: `info/refs` as a plain-text 503, a POST as an ERR
// line. Failures that say something about the request are never retried, a pack that started
// is never started again, and a push is not repeated.
import { beforeEach, expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { READ_RETRY, retrier } from '../../cloudflare/worker/repo-git-retry';
import * as stream from '../../cloudflare/worker/repo-pack-stream';
import type { Env } from '../../cloudflare/worker/types';
import { asGit } from './git-answer';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { count, fetchV2, on, pkt, pushedRepo } from './repo-pack-fixture';

usePlatformFixture();

const overloaded = () => Object.assign(new Error('Durable Object is overloaded. Requests queued for too long.'), { overloaded: true });
const quick = { ...READ_RETRY };
beforeEach(() => {
  Object.assign(READ_RETRY, { waits: [1, 1, 1], window: 20_000 });
  return () => void Object.assign(READ_RETRY, quick);
});

/** `target`, with the authority's commands counted by op and `fails` deciding each one. */
function flaky(target: Env, fails: (op: string, seen: number) => (() => Error) | null) {
  const namespace = target.SOURCE_REPOS;
  const seen = new Map<string, number>();
  const env = {
    ...target,
    SOURCE_REPOS: {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return {
          fetch: async (url: string, init: RequestInit) => {
            const { op } = JSON.parse(String(init.body));
            seen.set(op, (seen.get(op) ?? 0) + 1);
            const failure = fails(op, seen.get(op) as number);
            if (failure) throw failure();
            return stub.fetch(url, init);
          },
        };
      },
    },
  } as unknown as Env;
  return { env, seen };
}

const refs = (repo: string, token: string, target: Env, service = 'git-upload-pack') =>
  platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/refs?service=${service}`, { headers: { authorization: `Basic ${btoa(`git:${token}`)}` } }),
    target,
  );

async function repository(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name: name.replaceAll('_', '-'), policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'bot', scopes: ['read', 'write', 'land'] } });
  return { repo, token: minted.body.token as string };
}

it('retries a read through a brief overload, within its budget', async () => {
  let attempts = 0;
  const sleeps = vi.spyOn(globalThis, 'setTimeout');
  Object.assign(READ_RETRY, quick);
  await expect(
    retrier('r', 'git-upload-pack')(async () => {
      if (++attempts <= quick.waits.length) throw overloaded();
      return 'served';
    }),
  ).resolves.toBe('served');
  expect(attempts).toBe(4);
  const waits = sleeps.mock.calls.map(([, ms]) => Number(ms));
  expect(waits.length).toBe(3);
  waits.forEach((ms, i) => {
    expect(ms).toBeLessThanOrEqual(quick.waits[i]);
    expect(ms).toBeGreaterThanOrEqual(quick.waits[i] * 0.75);
  });
}, 10_000);

it('stops at four attempts, and starts none past the window', async () => {
  let attempts = 0;
  const failing = async () => {
    attempts++;
    throw overloaded();
  };
  await expect(retrier('r', 'git-upload-pack')(failing)).rejects.toThrow(/overloaded/);
  expect(attempts).toBe(4);
  attempts = 0;
  Object.assign(READ_RETRY, { window: 0 });
  await expect(retrier('r', 'git-upload-pack')(failing)).rejects.toThrow(/overloaded/);
  expect(attempts).toBe(1);
});

it("shares one budget between a request's steps", async () => {
  const retried = retrier('r', 'git-upload-pack');
  let attempts = 0;
  const twice = async () => {
    if (++attempts <= 2) throw overloaded();
  };
  await retried(twice);
  attempts = 0;
  await expect(
    retried(async () => {
      attempts++;
      throw overloaded();
    }),
  ).rejects.toThrow(/overloaded/);
  expect(attempts).toBe(2);
});

it('never retries what says something about the request', async () => {
  let attempts = 0;
  const refused = Object.assign(new Error('overloaded'), { code: 'NOT_FOUND' });
  await expect(
    retrier('r', 'git-upload-pack')(async () => {
      attempts++;
      throw refused;
    }),
  ).rejects.toBe(refused);
  expect(attempts).toBe(1);
});

it('serves info/refs through an overload, and says why as a plain-text 503 when it cannot', async () => {
  const { repo, token } = await repository('retry_refs');
  const brief = flaky(scoped, (op, seen) => (op === 'repo_git_access' && seen <= 2 ? overloaded : null));
  expect((await refs(repo, token, brief.env)).status).toBe(200);
  expect(brief.seen.get('repo_git_access')).toBe(3);

  const long = flaky(scoped, (op) => (op === 'repo_git_access' ? overloaded : null));
  const answer = await refs(repo, token, long.env);
  expect([answer.status, answer.headers.get('retry-after')]).toEqual([503, '1']);
  expect(await answer.text()).toBe('OVERLOADED: The repository is busy right now; try again in a few seconds\n');
  expect(long.seen.get('repo_git_access')).toBe(4);

  // A push's advertisement is a read too.
  const receive = flaky(scoped, (op, seen) => (op === 'repo_refs' && seen === 1 ? overloaded : null));
  expect((await refs(repo, token, receive.env, 'git-receive-pack')).status).toBe(200);
  expect(receive.seen.get('repo_refs')).toBe(2);
});

it('clones through an overload of the walk, and answers an ERR line Git prints when it cannot', async () => {
  const { repo, token, tip } = await pushedRepo('retry_walk', on, 2);
  const brief = flaky(on, (op, seen) => (op === 'repo_git_walk' && seen <= 2 ? overloaded : null));
  expect(count(await fetchV2(brief.env, repo, token, [`want ${tip}`, 'done']))).toBe(11);
  expect(brief.seen.get('repo_git_walk')).toBe(3);

  const long = flaky(on, (op) => (op === 'repo_git_walk' ? overloaded : null));
  const request = (version: string, body: string) =>
    platformFetch(
      new Request(`https://yoneda/git/${repo}.git/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...(version ? { 'git-protocol': version } : {}) },
        body,
      }),
      long.env,
    );
  const line = `want ${tip} multi_ack_detailed side-band-64k\n`;
  for (const [version, body] of [
    ['version=2', `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt(`want ${tip}\n`)}${pkt('done\n')}0000`],
    ['', `${pkt(line)}0000${pkt('done\n')}`],
  ]) {
    const answer = await request(version, body);
    expect([answer.status, answer.headers.get('retry-after')]).toEqual([200, '1']);
    const read = asGit(new Uint8Array(await answer.arrayBuffer()), version !== '');
    expect(read.error).toBe('OVERLOADED: The repository is busy right now; try again in a few seconds');
  }
  expect(long.seen.get('repo_git_walk')).toBe(8);
});

it("retries a personal token's lookup, and says why on a POST when it cannot", async () => {
  const cookie = await signup('retry_pat');
  const created = await api('/repos', { cookie }, { body: { name: 'pat', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const pat = (await api('/tokens', { cookie }, { body: { name: 'laptop', scopes: ['repo:read'], repos: [repo] } })).body.token as string;
  const busyIndex = (failures: number) => {
    const { INDEX } = scoped;
    let looked = 0;
    const env = {
      ...scoped,
      INDEX: new Proxy(INDEX, {
        get: (target, key) =>
          key === 'prepare'
            ? (sql: string) => {
                if (/platform_tokens/.test(sql) && looked++ < failures) throw new Error('D1 DB is overloaded. Requests queued for too long.');
                return target.prepare(sql);
              }
            : Reflect.get(target, key),
      }),
    } as unknown as Env;
    return { env, lookups: () => looked };
  };
  const brief = busyIndex(2);
  expect((await refs(repo, pat, brief.env)).status).toBe(200);
  expect(brief.lookups()).toBeGreaterThanOrEqual(3);

  const body = `${pkt('command=ls-refs\n')}${pkt('object-format=sha1\n')}0000`;
  const answer = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-upload-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${pat}`)}`, 'git-protocol': 'version=2' }, body }),
    busyIndex(100).env,
  );
  expect([answer.status, answer.headers.get('retry-after')]).toEqual([200, '1']);
  expect(asGit(new Uint8Array(await answer.arrayBuffer()), true).error).toMatch(/^OVERLOADED: The repository is busy/);
});

it('retries a failed read of the commits, which comes before the first byte', async () => {
  const { repo, token, tip } = await pushedRepo('retry_commits', on, 2);
  isolateLocations.clear();
  // The commits are asked first: their reads start before the walk's.
  const failed = flaky({ ...on, PACK_CACHE: 'off' } as unknown as Env, (op, seen) => (op === 'repo_bundle_locate' && seen === 1 ? overloaded : null));
  expect(count(await fetchV2(failed.env, repo, token, [`want ${tip}`, 'done']))).toBe(11);
  expect(failed.seen.get('repo_git_walk')).toBe(2);
});

it('does not start a pack again once its bytes went out', async () => {
  const { repo, token, tip } = await pushedRepo('retry_stream', on, 2);
  const { env, seen } = flaky({ ...on, PACK_CACHE: 'off' } as unknown as Env, () => null);
  // Fails as the pack's first piece is sent: after the answer started.
  const side = vi.spyOn(stream, 'sideBand').mockImplementationOnce(() => {
    throw overloaded();
  });
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt(`want ${tip}\n`)}${pkt('done\n')}0000`;
  const answer = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' },
      body,
    }),
    env,
  );
  const read = asGit(new Uint8Array(await answer.arrayBuffer()), true);
  side.mockRestore();
  expect(answer.status).toBe(200);
  expect(read.pack).toBe(0);
  expect(read.error).toMatch(/overloaded/);
  expect(seen.get('repo_git_walk')).toBe(1);
});

it('retries an LFS download batch, and never an upload, which reserves', async () => {
  const { repo, token } = await repository('retry_lfs');
  const lfs = { LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com', LFS_S3_BUCKET: 'b', LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id', LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret' };
  const batch = (operation: string, target: Env) =>
    platformFetch(
      new Request(`https://yoneda/git/${repo}.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'content-type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation, objects: [{ oid: 'a'.repeat(64), size: 3 }] }),
      }),
      target,
    );
  const once = (op: string, seen: number) => (op === 'repo_lfs_batch' && seen === 1 ? overloaded : null);
  const download = flaky({ ...scoped, ...lfs } as unknown as Env, once);
  expect((await batch('download', download.env)).status).toBe(200);
  expect(download.seen.get('repo_lfs_batch')).toBe(2);
  const upload = flaky({ ...scoped, ...lfs } as unknown as Env, once);
  const refused = await batch('upload', upload.env);
  expect([refused.status, refused.headers.get('retry-after')]).toEqual([503, '1']);
  expect(upload.seen.get('repo_lfs_batch')).toBe(1);
});
