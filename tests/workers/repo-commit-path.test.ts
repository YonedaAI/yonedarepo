// The commit path's authority budget (C2): a commit on main is authorized from the head
// holder's access snapshot and recorded in its shard, so in steady state it makes no call
// to the repository authority, including right after an access change and after this
// isolate's own landing. Revocation stays bounded: the isolate that served it refuses at
// once, every other isolate within ACCESS_MS (1 s) of its answer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { credentials } from '../../cloudflare/worker/repo-api';
import { tokenSecret } from '../../cloudflare/worker/repo-create';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, fakeCombiners, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** Authority commands sent while serving the current request, by op. */
const request = new AsyncLocalStorage<string[]>();
/** While set, `repo_head` (the holder's reload) waits for it: the authority is "busy". */
let headGate: Promise<void> | null = null;
let openGate = () => {};
function holdHeads() {
  headGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}
const authority = scoped.SOURCE_REPOS;
const counting = {
  idFromName: (name: string) => authority.idFromName(name),
  get: (id: DurableObjectId) => {
    const stub = authority.get(id);
    return {
      fetch: async (url: string, init: RequestInit) => {
        const op = JSON.parse(String(init.body)).op as string;
        request.getStore()?.push(op);
        if (op === 'repo_head' && headGate) await headGate;
        return stub.fetch(url, init);
      },
    };
  },
};
beforeEach(() => {
  (scoped as { SOURCE_REPOS: unknown }).SOURCE_REPOS = counting;
});
afterEach(() => {
  openGate();
  headGate = null;
  (scoped as { SOURCE_REPOS: unknown }).SOURCE_REPOS = authority;
});

/** `api` with the authority commands it caused. */
async function traced(path: string, who: { cookie?: string; token?: string }, body?: unknown, target: Env = scoped) {
  const ops: string[] = [];
  const response = await request.run(ops, () => api(path, who, body ? { body } : {}, target));
  return { ...response, ops };
}
const commitOn = (repo: string, who: { token?: string; cookie?: string }, path: string, text = `${path}\n`) =>
  traced(`${repo}/commits`, who, { ref: 'main', changes: [file(path, text)], message: path, author });

async function repoWithToken(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# r\n')], author } });
  const repo = `/repos/${created.body.id}`;
  const mint = async (token: string) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name: token, scopes: ['read', 'write', 'land'] } })).body.token as string });
  return { owner, repo, id: created.body.id as string, mint };
}

it('makes no authority call to commit, even right after a token is minted', async () => {
  const { repo, mint } = await repoWithToken('pathmint');
  // A token minted just before the burst (the many-repo bench's shape): its first commits
  // are authorized from the holder's refreshed snapshot, not deferred to the authority.
  const writer = await mint('writer');
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => commitOn(repo, writer, `w/${i}.txt`)));
  expect(first.map((c) => c.status)).toEqual(Array(10).fill(200));
  expect(first.flatMap((c) => c.ops)).toEqual([]);
});

it('asks the holder, not the authority, when a token is newer than this isolate\'s copy', async () => {
  const { owner, repo, id, mint } = await repoWithToken('pathlate');
  expect((await commitOn(repo, await mint('early'), 'e.txt')).status).toBe(200);
  // Minted through another isolate: this isolate's copy (under 1 s old) lacks the token.
  const late = tokenSecret();
  await changedElsewhere(id, owner, { op: 'repo_token_create', name: 'late', scopes: ['read', 'write'], paths: null, _secret: late });
  const made = await commitOn(repo, { token: late }, 'l.txt');
  expect([made.status, made.ops]).toEqual([200, []]);
});

it('commits beside its own landing without waiting for the holder to reload', async () => {
  const { repo, mint } = await repoWithToken('pathfloor');
  const writer = await mint('writer');
  const a = await commitOn(repo, writer, 'a.txt');
  // The authority is busy (its head answers are held), so the holder cannot reload after
  // this landing: a commit on another path begins at once from the head already held.
  holdHeads();
  expect((await api(`${repo}/land`, writer, { body: { ref: 'main', commit: a.body.commit } })).body.landed).toBe(true);
  const b = await Promise.race([commitOn(repo, writer, 'b.txt'), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
  expect(b && [b.status, b.ops]).toEqual([200, []]);
  // A commit on the path this isolate just landed waits for the head to reach that landing,
  // so it builds on its own write instead of conflicting with it.
  let settled = false;
  const again = commitOn(repo, writer, 'a.txt', 'a2\n').finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  openGate();
  const rewritten = await again;
  expect(rewritten.status).toBe(200);
  const landed = await api(`${repo}/land`, writer, { body: { ref: 'main', commit: rewritten.body.commit } });
  expect(landed.body.landed).toBe(true);
});

/** An access change served by another isolate: the authority and the head holder learn
 * of it (as that isolate's refreshHead does), while this isolate keeps its cached head. */
async function changedElsewhere(id: string, owner: { cookie: string }, command: Record<string, unknown>) {
  const auth = await credentials(new Request('https://yoneda/api/v1/repos', { headers: { cookie: owner.cookie } }), scoped);
  if (!auth) throw new Error('owner session expected');
  await caller(scoped, id, auth)(command);
  await (fakeCombiners.get(`${id}#head`) as { refresh(repo: string, wait: boolean): Promise<void> }).refresh(id, true);
}
const later = () => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001);

it('refuses a revoked token at once, and within 1 s where another isolate revoked it', async () => {
  const { owner, repo, id, mint } = await repoWithToken('pathrevoke');
  const [writer, other, kept] = [await mint('writer'), await mint('other'), await mint('kept')];
  for (const who of [writer, other, kept]) expect((await commitOn(repo, who, 'x.txt')).status).toBe(200);
  // Revoked through this isolate: refused at once.
  expect((await api(`${repo}/tokens/writer`, owner, { method: 'DELETE' })).status).toBe(200);
  expect((await commitOn(repo, writer, 'x2.txt')).status).toBe(401);
  // Revoked through another isolate: this one may serve its copy for under 1 s, never longer.
  await changedElsewhere(id, owner, { op: 'repo_token_revoke', name: 'other' });
  later();
  expect((await commitOn(repo, other, 'x3.txt')).status).toBe(401);
  // A live token is unaffected and still authorized without the authority.
  const live = await commitOn(repo, kept, 'y.txt');
  expect([live.status, live.ops]).toEqual([200, []]);
});

it('refuses a removed member within 1 s where another isolate removed it', async () => {
  const { owner, repo, id } = await repoWithToken('pathmember');
  const bob = { cookie: await signup('pathbob') };
  expect((await api(`${repo}/members`, owner, { body: { account: 'pathbob', role: 'write' } })).status).toBe(200);
  expect((await commitOn(repo, bob, 'm.txt')).status).toBe(200);
  await changedElsewhere(id, owner, { op: 'repo_member_remove', account: 'pathbob' });
  later();
  expect((await commitOn(repo, bob, 'm2.txt')).status).toBe(403);
});
