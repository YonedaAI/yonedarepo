// The storage guard through the real authority, shards, combiner logic and D1: behind
// REPO_STORAGE_GUARD, a repository at its limit answers 507 REPO_FULL to new work, on REST, Git
// and batched landing (one refusal per landing), and everything already accepted keeps going.
// No test fills it: the variable takes a byte count here, and only here.
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { REPO_FULL_MESSAGE } from '../../cloudflare/worker/durable';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { projectChangesets } from '../../cloudflare/worker/repo-changesets';
import { compute } from '../../cloudflare/worker/repo-compute';
import { forgetHead } from '../../cloudflare/worker/repo-head';
import { deliverHook, fanoutHooks } from '../../cloudflare/worker/repo-hooks';
import { LandBatcher } from '../../cloudflare/worker/repo-land-batcher';
import { caller } from '../../cloudflare/worker/repo-ops';
import { shardRecord } from '../../cloudflare/worker/repo-shards';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const OPEN = { required_checks: [], approvals: 0 };
const batched = { ...scoped, LAND_MODE: 'batch' } as unknown as Env;
/** A limit every database is over. */
const atLimit = (target: Env = scoped) => ({ ...target, REPO_STORAGE_GUARD: '1' }) as unknown as Env;

async function repository(name: string, target: Env = scoped, policy: unknown = OPEN) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy, files: [file('a.txt', '0\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write', 'land', 'check'] }] },
  }, target);
  expect(created.status).toBe(200);
  return { owner, id: created.body.id as string, repo: `/repos/${created.body.id}`, root: created.body.commit as string, agent: { token: created.body.tokens[0].token as string } };
}
const commitOn = (repo: string, who: { cookie?: string }, path: string, target: Env) =>
  api(`${repo}/commits`, who, { body: { ref: 'main', changes: [file(path, `${path}\n`)], message: path, author } }, target);
const landOn = (repo: string, who: { cookie?: string }, commit: string, target: Env) =>
  api(`${repo}/land`, who, { body: { ref: 'main', commit } }, target);
const refusedFull = (answer: { status: number; body: any }) => {
  expect(answer.status).toBe(507);
  expect(answer.body.error.code).toBe('REPO_FULL');
  expect(answer.body.error.message).toBe(REPO_FULL_MESSAGE);
};

/** A receive-pack body creating `refname` with one new commit on `parent`. */
async function branchPush(refname: string, parent: string) {
  const encoder = new TextEncoder();
  const sha = async (kind: string, data: Uint8Array) => {
    const whole = new Uint8Array([...encoder.encode(`${kind} ${data.length}\0`), ...data]);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-1', whole))].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const blob = encoder.encode('pushed\n');
  const blobId = await sha('blob', blob);
  const tree = new Uint8Array([...encoder.encode('100644 p.txt\0'), ...(blobId.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))]);
  const treeId = await sha('tree', tree);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = encoder.encode(`tree ${treeId}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\npushed\n`);
  const commitId = await sha('commit', commit);
  const objects = [[commitId, 'commit', commit], [treeId, 'tree', tree], [blobId, 'blob', blob]] as const;
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old: null,
    new: commitId,
    objects: objects.map(([oid, kind, data]) => ({ id: oid, kind, data_b64: btoa(String.fromCharCode(...data)) })),
  });
  return Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0));
}

it('is off unless the variable turns it on: unset, off, and on below the limit change nothing', async () => {
  const { owner, repo } = await repository('guard-off');
  for (const value of [undefined, '', 'off', 'on']) {
    const target = { ...scoped, REPO_STORAGE_GUARD: value } as unknown as Env;
    const made = await commitOn(repo, owner, `${value}.txt`, target);
    expect(made.status).toBe(200);
    expect((await landOn(repo, owner, made.body.commit, target)).status).toBe(200);
  }
});

it('refuses commits and landings at the limit with 507 REPO_FULL; reads go on and nothing changed', async () => {
  const { owner, repo } = await repository('guard-rest');
  const made = await commitOn(repo, owner, 'b.txt', scoped);
  // No combiner: a landing goes straight to the authority (batch mode has its own test).
  const guarded = { ...atLimit(), LAND_COMBINERS: undefined } as unknown as Env;
  refusedFull(await commitOn(repo, owner, 'c.txt', guarded));
  refusedFull(await landOn(repo, owner, made.body.commit, guarded));
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, guarded)).body.content).toBe('0\n');
  expect((await api(`${repo}/log?ref=main`, owner, {}, guarded)).status).toBe(200);
  expect((await api(repo, owner, {}, guarded)).status).toBe(200);
  // The landing was refused, not lost: it goes through once the repository has room.
  expect((await landOn(repo, owner, made.body.commit, scoped)).body.landed).toBe(true);
  // A repeat of a landing that happened answers as it did.
  expect((await landOn(repo, owner, made.body.commit, guarded)).status).toBe(200);
});

it('compares the real database size: a repository that grows past the limit is refused, and shrinks back', async () => {
  const { owner, id, repo } = await repository('guard-real');
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  const size = async () => (await caller(scoped, id, { _system: 'derive' })({ op: 'repo_storage' })).db_bytes as number;
  // No holder: this isolate reads the published head itself, with the limit.
  const target = { ...scoped, LAND_COMBINERS: undefined, REPO_STORAGE_GUARD: String((await size()) + 4_000_000) } as unknown as Env;
  expect((await commitOn(repo, owner, 'b.txt', target)).status).toBe(200);
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec('CREATE TABLE ballast(v TEXT)');
    for (let i = 0; i < 16; i++) state.storage.sql.exec('INSERT INTO ballast VALUES(?)', 'x'.repeat(500_000));
  });
  forgetHead(id);
  refusedFull(await commitOn(repo, owner, 'c.txt', target));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec('DROP TABLE ballast');
  });
  // The head still says full: the authority decides, and there is room again.
  expect((await commitOn(repo, owner, 'd.txt', target)).status).toBe(200);
});

it('never takes the limit from a client: the adapter drops the field from a command', () => {
  const sign = (target: Env) => caller(target, 'r0', { _system: 'derive' }).sign({ op: 'repo_status', _storage_guard: 5 });
  expect(sign(scoped)).not.toHaveProperty('_storage_guard');
  expect(sign({ ...scoped, REPO_STORAGE_GUARD: 'on' } as unknown as Env)._storage_guard).toBe(9_400_000_000);
  expect(sign(atLimit())._storage_guard).toBe(1);
  const sized = caller({ ...scoped, REPO_SIZE_GUARD: 'on' } as unknown as Env, 'r0', { _system: 'derive' }).sign({ op: 'repo_status', _size_guard: 5 });
  expect(sized._size_guard).toBe(10_000_000_000);
  expect(caller(scoped, 'r0', { _system: 'derive' }).sign({ op: 'repo_status', _size_guard: 5 })).not.toHaveProperty('_size_guard');
});

it('refuses a Git push at the limit by ref, naming REPO_FULL', async () => {
  const { id, root, agent } = await repository('guard-push');
  const body = await branchPush('refs/heads/topic', root);
  const response = await platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${agent.token}`)}` }, body }),
    atLimit(),
  );
  const report = new TextDecoder().decode(await response.arrayBuffer());
  expect(report).toContain('ng refs/heads/topic');
  expect(report).toContain('REPO_FULL');
});

it('counts what a push sends, and at the size limit refuses pushes and commits with 507 before storing anything', async () => {
  const { owner, id, repo, root, agent } = await repository('guard-size');
  const push = async (refname: string, target: Env) =>
    platformFetch(new Request(`https://yoneda/git/${id}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${agent.token}`)}` }, body: await branchPush(refname, root) }), target);
  const size = async () => (await caller(scoped, id, { _system: 'derive' })({ op: 'repo_storage' })).git_bytes as number;
  expect(await size()).toBe(0);
  const first = await push('refs/heads/one', scoped);
  expect(new TextDecoder().decode(await first.arrayBuffer())).toContain('ok refs/heads/one');
  const counted = await size();
  expect(counted).toBeGreaterThan(100);
  const sized = { ...scoped, LAND_COMBINERS: undefined, REPO_SIZE_GUARD: String(counted) } as unknown as Env;
  const refused = await push('refs/heads/two', sized);
  expect(refused.status).toBe(507);
  expect(await refused.text()).toContain('REPO_SIZE_LIMIT');
  expect(await size()).toBe(counted);
  const commit = await commitOn(repo, owner, 'b.txt', sized);
  expect(commit.status).toBe(507);
  expect(commit.body.error.code).toBe('REPO_SIZE_LIMIT');
  expect(commit.body.error.message).toContain('10 GB');
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, sized)).body.content).toBe('0\n');
  const under = { ...scoped, REPO_SIZE_GUARD: String(counted + 1) } as unknown as Env;
  expect(new TextDecoder().decode(await (await push('refs/heads/three', under)).arrayBuffer())).toContain('ok refs/heads/three');
});

it('adds what API commits store to the size once it amounts to a megabyte, not on every commit', async () => {
  const { owner, id, repo } = await repository('guard-api-size');
  const size = async () => (await caller(scoped, id, { _system: 'derive' })({ op: 'repo_storage' })).git_bytes as number;
  const commit = (path: string, bytes: number) =>
    api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file(path, 'x'.repeat(bytes))], message: path, author } });
  expect((await commit('small.txt', 1_000)).status).toBe(200);
  expect(await size()).toBe(0);
  expect((await commit('large.txt', 1_100_000)).status).toBe(200);
  await waitOnExecutionContext(createExecutionContext());
  await vi.waitFor(async () => expect(await size()).toBeGreaterThanOrEqual(1_101_000));
});

it('takes a purged file off the size, so a repository at its limit can push again', async () => {
  const { owner, id, repo, root, agent } = await repository('guard-purge');
  const push = async (refname: string, target: Env) =>
    platformFetch(new Request(`https://yoneda/git/${id}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${agent.token}`)}` }, body: await branchPush(refname, root) }), target);
  const size = async () => (await caller(scoped, id, { _system: 'derive' })({ op: 'repo_storage' })).git_bytes as number;
  const content = 'x'.repeat(1_100_000);
  const committed = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('large.bin', content)], message: 'large', author } });
  expect((await landOn(repo, owner, committed.body.commit, scoped)).status).toBe(200);
  await vi.waitFor(async () => expect(await size()).toBeGreaterThanOrEqual(1_100_000));
  const counted = await size();
  const sized = { ...scoped, REPO_SIZE_GUARD: String(counted) } as unknown as Env;
  expect((await push('refs/heads/refused', sized)).status).toBe(507);
  const made = await api(`${repo}/quarantine`, owner, { body: { path: 'large.bin', reason: 'too large' } });
  expect(made.status).toBe(200);
  const purged = await api(`${repo}/quarantine/${made.body.record.id}/purge`, owner, { body: { confirm: made.body.record.target.id } });
  expect([purged.status, purged.body.purged]).toEqual([200, 1]);
  expect(await size()).toBe(counted - 1_100_000);
  expect(new TextDecoder().decode(await (await push('refs/heads/after', sized)).arrayBuffer())).toContain('ok refs/heads/after');
});

/** Combiners running in this test against `env`, drained by `settled`. */
function combinersOf(env: () => Env) {
  let running: Promise<unknown> = Promise.resolve();
  const batcher = new LandBatcher({ ...env() }, async (ms) => {
    if (ms === 0) running = running.then(() => batcher.step());
  });
  return {
    combiners: { idFromName: (name: string) => name, get: () => ({ submit: (repo: string, ref: string, item: any, ms: number) => batcher.submit({ repo, ref }, item, ms) }) },
    settled: async () => {
      await running;
      await running;
      await batcher.idle();
    },
  };
}

it('refuses a new branch at the limit, and deletes the branches that exist', async () => {
  const { owner, repo, root } = await repository('guard-branch');
  const refsOf = async () => Object.keys((await api(`${repo}/refs`, owner)).body.refs);
  await api(`${repo}/refs/batch`, owner, { body: { updates: [{ ref: 'old', commit: root, expected: null }] } });
  refusedFull(await api(`${repo}/refs/batch`, owner, { body: { updates: [{ ref: 'new', commit: root, expected: null }] } }, atLimit()));
  expect(await refsOf()).toEqual(['refs/heads/main', 'refs/heads/old']);
  const gone = await api(`${repo}/refs/batch`, owner, { body: { updates: [{ ref: 'old', commit: null, expected: root }] } }, atLimit());
  expect(gone.status).toBe(200);
  expect(await refsOf()).toEqual(['refs/heads/main']);
});

it('in batch mode refuses each new landing alone, in one pass, and answers a landed one', async () => {
  const { owner, repo } = await repository('guard-batch', batched);
  const made = [];
  for (const path of ['w/1.txt', 'w/2.txt', 'w/3.txt']) made.push((await commitOn(repo, owner, path, batched)).body.commit as string);
  expect((await landOn(repo, owner, made[0], batched)).status).toBe(200);
  const { combiners, settled } = combinersOf(() => atLimit(batched));
  const guarded = { ...atLimit(batched), LAND_COMBINERS: combiners } as unknown as Env;
  const [again, second, third] = await Promise.all(made.map((commit) => landOn(repo, owner, commit, guarded)));
  await settled();
  expect(again.status).toBe(200);
  refusedFull(second);
  refusedFull(third);
  // Refused, not stuck: the same landings go through once there is room.
  expect((await landOn(repo, owner, made[1], batched)).status).toBe(200);
});

it('keeps accepted work going at the limit: projection, adoption, hooks, checks, tokens, quarantine, delete', async () => {
  const { owner, id, repo, agent } = await repository('guard-keeps', batched);
  const hook = (await api(`${repo}/hooks`, owner, { body: { url: 'https://ci.example.com/hook', events: ['land'] } }, batched)).body;
  const commit = (await commitOn(repo, owner, 'b.txt', batched)).body.commit as string;
  // Landed the way the combiner lands, with nothing projecting it behind the test.
  const items = [{ credentials: caller(batched, id, { _token: agent.token }).sign({}), records: [await shardRecord(batched, id, commit)] }];
  const landed = await caller(batched, id, { _system: 'merge' })({ op: 'repo_land_submitted', ref: 'main', items });
  expect(landed.items[0].status).toBe('landed');
  const guarded = atLimit(batched);
  // Projection of the landed changeset, then branch reads that need it.
  expect(await projectChangesets(guarded, id)).toBe(1);
  expect((await api(`${repo}/refs`, owner, {}, guarded)).status).toBe(200);
  expect((await api(`${repo}/blob?path=b.txt`, owner, {}, guarded)).body.content).toBe('b.txt\n');
  // A read of a commit still in its shard adopts it; checks and reviews go on it.
  expect((await api(`${repo}/commits/${commit}`, owner, {}, guarded)).status).toBe(200);
  expect((await api(`${repo}/commits/${commit}/checks`, agent, { body: { name: 'unit', status: 'pass' } }, guarded)).status).toBe(200);
  // Hook fan-out and settling.
  await fanoutHooks(guarded, id);
  const job = queued.find((m) => m.kind === 'platform_hooks' && m.repo_id === id);
  expect(job).toBeDefined();
  const sent: Request[] = [];
  await deliverHook(guarded, id, hook.id, async (req: Request) => {
    sent.push(req);
    return new Response('ok');
  });
  expect(sent.length).toBeGreaterThan(0);
  // Protecting the repository, and leaving it.
  const made = await api(`${repo}/tokens`, owner, { body: { name: 'short', scopes: ['read'] } }, batched);
  expect((await api(`${repo}/tokens/short`, owner, { method: 'DELETE' }, guarded)).status).toBe(200);
  expect((await api(`${repo}/blob?path=a.txt`, { token: made.body.token }, {}, guarded)).status).toBe(401);
  expect((await api(`${repo}/quarantine`, owner, { body: { path: 'b.txt', reason: 'leak' } }, guarded)).status).toBe(200);
  const named = (await api(repo, owner, {}, guarded)).body.name;
  expect((await api(`${repo}?confirm=${named}`, owner, { method: 'DELETE' }, guarded)).status).toBe(200);
});

it('keeps compaction going at the limit', async () => {
  const { owner, repo, root, agent } = await repository('guard-compact');
  const child = (await api(`${repo}/commits`, agent, { body: { parent: root, changes: [file('b.txt', 'b\n')], message: 'b', author } })).body.commit;
  const at: (string | null)[] = Array(100).fill(null);
  let version = (await api(repo, owner)).body.version as number;
  while (version < 1_100) {
    const updates = at.map((was, i) => {
      at[i] = was === root ? child : root;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    version = (await api(`${repo}/refs/batch`, agent, { body: { updates } })).body.version;
  }
  const guarded = atLimit();
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } }, guarded);
  const compacted = await api(`${repo}/compact`, owner, { body: {} }, guarded);
  expect(compacted.status).toBe(200);
  expect(compacted.body.segments).toBe(1);
});

/** `target` with the authority's writes among `ops` thrown out of the call, as Durable Object
 * storage throws them at its size limit. */
function databaseFull(target: Env, ops: string[]) {
  const namespace = target.SOURCE_REPOS;
  const SOURCE_REPOS = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: async (url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body));
        if ([sent].flat().some((c) => ops.includes(c.op))) throw new Error('Exceeded the maximum database size.');
        return namespace.get(id).fetch(url, init);
      },
    }),
  };
  return { ...target, SOURCE_REPOS } as unknown as Env;
}

it('maps a database that really is full to 507 REPO_FULL on REST, whatever the operation', async () => {
  const { owner, repo, root } = await repository('full-rest');
  const full = databaseFull(scoped, ['repo_branch_batch', 'repo_tag_create']);
  refusedFull(await api(`${repo}/refs/batch`, owner, { body: { updates: [{ ref: 'x', commit: root, expected: null }] } }, full));
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, full)).status).toBe(200);
});

it('maps a full database to REPO_FULL on Git, in the push report and as an HTTP status', async () => {
  const { id, root, agent } = await repository('full-git');
  const body = await branchPush('refs/heads/topic', root);
  const push = (target: Env) =>
    platformFetch(new Request(`https://yoneda/git/${id}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${agent.token}`)}` }, body }), target);
  const reported = await push(databaseFull(scoped, ['repo_record_pushed']));
  expect(new TextDecoder().decode(await reported.arrayBuffer())).toContain('REPO_FULL');
  const refused = await push(databaseFull(scoped, ['repo_git_access']));
  expect(refused.status).toBe(507);
  expect(await refused.text()).toContain('REPO_FULL');
});

it('answers every lander of a batch the database would not take, instead of requeueing it', async () => {
  const { owner, repo } = await repository('full-batch', batched);
  const made = [];
  for (const path of ['w/1.txt', 'w/2.txt']) made.push((await commitOn(repo, owner, path, batched)).body.commit as string);
  const full = databaseFull(batched, ['repo_land_submitted']);
  const { combiners, settled } = combinersOf(() => full);
  const target = { ...full, LAND_COMBINERS: combiners } as unknown as Env;
  const answers = await Promise.all(made.map((commit) => landOn(repo, owner, commit, target)));
  await settled();
  answers.forEach(refusedFull);
  expect((await landOn(repo, owner, made[0], batched)).status).toBe(200);
});
