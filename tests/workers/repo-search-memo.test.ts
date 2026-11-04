// Real authority/R2 reads; no inference, containers or retained user repositories.
import { expect, it, vi } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { caller } from '../../cloudflare/worker/repo-ops';
import { toBase64 } from '../../cloudflare/worker/repo-stores';
import { CodeMemo, codeKey } from '../../cloudflare/worker/repo-search-memo';
import * as searchIndex from '../../cloudflare/worker/repo-search-index';
import { api, author, countingOps, drainObjects, failingOp, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, SEARCH_CODE_MEMO: 'on' } as unknown as Env;
async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const made = await api('/repos', owner, { body: { name, author,
    policy: { approvals: 0, required_checks: [] },
    files: [file('src/a.ts', 'agent alpha\nAGENT beta\n'), file('secret/b.ts', 'agent secret\n')],
  } }, on);
  expect(made.status).toBe(200);
  return { owner, repo: `/repos/${made.body.id}`, commit: made.body.commit };
}
it('reuses completed code matches after fresh target admission without rereading stored segments', async () => {
  const { owner, repo } = await setup('search_memo');
  const first = await api(`${repo}/search?query=agent&groups=code`, owner, {}, on);
  expect(first.status).toBe(200);
  expect(first.body.results).toHaveLength(2);
  const gets = vi.spyOn(on.OBJECTS, 'get');
  const second = await api(`${repo}/search?query=agent&groups=code`, owner, {}, on);
  expect(second.status).toBe(200);
  expect(second.body).toEqual({ ...first.body, partitions_built: 0 });
  expect(gets.mock.calls.filter(([key]) => String(key).includes('/search/'))).toHaveLength(0);
  expect(gets.mock.calls).toHaveLength(0); // No stored segments or candidate file bytes.
  expect(second.headers.get('server-timing')).toContain('search.code.hit;dur=');
});

it('keeps the old path with the switch off and separates query options', async () => {
  const { owner, repo } = await setup('search_options');
  for (const extra of ['', '&path=src/', '&limit=1', '&ignore_case=true', '&word=true', '&query=AGENT']) {
    const path = `${repo}/search?query=agent&groups=code${extra}`;
    const cold = await api(path, owner, {}, on);
    const warm = await api(path, owner, {}, on);
    const off = await api(path, owner, {}, scoped);
    expect(warm.body).toEqual({ ...cold.body, partitions_built: 0 });
    expect(off.body).toEqual(warm.body);
    expect(warm.headers.get('server-timing')).toContain('search.code.hit;dur=');
    expect(off.headers.get('server-timing')).not.toContain('search.code.hit;dur=');
  }
});

it('resolves current refs and enforces fresh grants, revocation and private visibility after warming', async () => {
  const { owner, repo, commit } = await setup('search_access');
  const seen = countingOps(on);
  const path = `${repo}/search?query=agent&groups=code`;
  await api(path, owner, {}, seen.env); seen.take();
  const warm = await api(path, owner, {}, seen.env);
  const ops = seen.take();
  expect(ops.repo_snapshot).toBe(1);
  expect(ops.repo_status).toBe(1);
  expect(warm.body.commit).toBe(commit);
  const token = await api(`${repo}/tokens`, owner, { body: { name: 'reader', scopes: ['read'], paths: ['src/'] } }, on);
  const reader = { token: token.body.token };
  for (let n = 0; n < 2; n++) {
    const restricted = await api(path, reader, {}, on);
    expect(restricted.body.results.map((r: any) => r.path)).toEqual(['src/a.ts']);
    expect(restricted.headers.get('server-timing')).not.toContain('search.code.hit;dur=');
  }
  expect((await api(`${repo}/tokens/reader`, owner, { method: 'DELETE' }, on)).status).toBe(200);
  expect((await api(path, reader, {}, on)).status).toBe(401);
  const stranger = { cookie: await signup('search_stranger') };
  expect((await api(path, stranger, {}, on)).status).toBe(404);
  expect((await api(`${repo}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, on)).status).toBe(200);
  expect((await api(path, {}, {}, on)).status).toBe(200);
  expect((await api(`${repo}/visibility`, owner, { method: 'PUT', body: { visibility: 'private' } }, on)).status).toBe(200);
  expect((await api(path, {}, {}, on)).status).toBe(404);
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('src/a.ts', 'nothing\n')], message: 'remove match', author } }, on);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, on)).body.landed).toBe(true);
  const now = await api(path, owner, {}, on);
  expect(now.body.commit).toBe(made.body.commit);
  expect(now.body.results.map((r: any) => r.path)).toEqual(['secret/b.ts']);
  expect((await api(`${path}&commit=${commit}`, owner, {}, on)).body.results).toHaveLength(2);
});

it('invalidates populated matches on real quarantine and bypasses inherited fork results', async () => {
  const { owner, repo } = await setup('search_withheld');
  const path = `${repo}/search?query=agent&groups=code`;
  expect((await api(path, owner, {}, on)).body.results).toHaveLength(2);
  expect((await api(path, owner, {}, on)).headers.get('server-timing')).toContain('search.code.hit');
  const fork = await api(`${repo}/fork`, owner, { body: { name: 'fork' } }, on);
  expect(fork.status).toBe(200);
  const forkPath = `/repos/${fork.body.id}/search?query=agent&groups=code`;
  for (let n = 0; n < 2; n++) {
    const result = await api(forkPath, owner, {}, on);
    expect(result.body.results).toHaveLength(2);
    expect(result.headers.get('server-timing')).not.toContain('search.code.hit');
  }
  expect((await api(`${repo}/quarantine`, owner, { body: { path: 'secret/b.ts', reason: 'fixture' } }, on)).status).toBe(200);
  const hidden = await api(path, owner, {}, on);
  expect(hidden.body.results.map((r: any) => r.path)).toEqual(['src/a.ts']);
  expect(hidden.headers.get('server-timing')).not.toContain('search.code.hit');
  const inherited = await api(forkPath, owner, {}, on);
  expect(inherited.status).toBe(451);
});

it('cannot reuse a completed envelope across a real same-version history reset/import', async () => {
  const { owner, repo, commit } = await setup('search_reset');
  const seen = countingOps(on);
  const id = repo.slice('/repos/'.length);
  await drainObjects(on);
  const path = `${repo}/search?query=agent`;
  const before = await api(path, owner, {}, on);
  expect((await api(path, owner, {}, on)).headers.get('server-timing')).toContain('search.code.hit');
  const call = caller(on, id, { _system: 'import' });
  const original = await call({ op: 'repo_status' });
  const raw = await on.OBJECTS.get(`platform/v1/${id}/git/${commit}`);
  const bytes = new Uint8Array(await raw!.arrayBuffer());
  while (!(await call({ op: 'repo_import_reset' })).done) { /* bounded authority steps */ }
  expect((await api(path, owner, {}, on)).status).not.toBe(200);
  await call({ op: 'repo_record_pushed', commits: [{ commit, data_b64: toBase64(bytes), touches: [], objects: [{ id: commit, kind: 'commit' }] }] });
  await call({ op: 'repo_import', ref: 'main', commit });
  const current = await call({ op: 'repo_status' });
  expect(current.version).toBe(original.version);
  expect(current.object_store).toBe(original.object_store);
  expect(current.history_chain).not.toBe(original.history_chain);
  seen.take();
  const after = await api(path, owner, {}, seen.env);
  expect(after.body.results).toEqual(before.body.results);
  expect(after.headers.get('server-timing')).not.toContain('search.code.hit');
  expect(seen.take().repo_search_records).toBe(1);
  expect((await api(path, owner, {}, on)).headers.get('server-timing')).toContain('search.code.hit');
});

it('does not share pending segment I/O or retain a failed segment read', async () => {
  const { owner, repo } = await setup('search_pending');
  const path = `${repo}/search?query=agent&groups=code`;
  // Build the indexes without populating the new completed result cache.
  expect((await api(path, owner, {}, scoped)).status).toBe(200);
  let started = 0, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = on.OBJECTS.get.bind(on.OBJECTS);
  vi.spyOn(on.OBJECTS, 'get').mockImplementation(async (...args: Parameters<R2Bucket['get']>) => {
    if (String(args[0]).includes('/search/') && ++started === 1) {
      await held;
      throw new Error('simulated segment outage');
    }
    return original(...args);
  });
  const first = api(path, owner, {}, on);
  try {
    await vi.waitFor(() => expect(started).toBeGreaterThan(0));
    let second: Awaited<ReturnType<typeof api>> | undefined;
    const next = api(path, owner, {}, on).then((r) => { second = r; });
    await vi.waitFor(() => expect(second?.status).toBe(200));
    await next;
    expect(second!.headers.get('server-timing')).not.toContain('search.code.hit');
  } finally { release(); }
  expect((await first).status).not.toBe(200);
  expect((await api(path, owner, {}, on)).headers.get('server-timing')).toContain('search.code.hit');
});

it('keeps new session records fresh and never publishes a code fill from a failed group', async () => {
  const { owner, repo, commit } = await setup('search_records');
  const path = `${repo}/search?query=agent`;
  const failed = await api(path, owner, {}, failingOp(on, 'repo_search_records'));
  expect(failed.status).not.toBe(200);
  const first = await api(path, owner, {}, on);
  expect(first.headers.get('server-timing')).not.toContain('search.code.hit');
  expect(first.body.sessions.count).toBe(0);
  expect(first.body.memories).toEqual([]);
  expect((await api(`${repo}/commits/${commit}/sessions`, owner, { body: { cli: 'fixture', summary: 'agent session', session_id: 'fixture:1' } }, on)).status).toBe(200);
  expect((await api(`${repo}/memories`, owner, { body: { kind: 'decision', text: 'agent memory', commit } }, on)).status).toBe(200);
  const after = await api(path, owner, {}, on);
  expect(after.headers.get('server-timing')).toContain('search.code.hit');
  expect(after.body.sessions.count).toBe(1);
  expect(after.body.memories).toHaveLength(1);
});

it('separates store/history/quarantine/options and bounds copied complete values', () => {
  const status = { parent: null, grant: null, version: 3, quarantine_epoch: 0, history_chain: 'chain', object_store: 'store' };
  const where = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const key = codeKey('repo', status, where, 'agent', {})!;
  for (const changed of [{ object_store: 'other' }, { quarantine_epoch: 1 }, { history_chain: 'reset' }])
    expect(codeKey('repo', { ...status, ...changed }, where, 'agent', {})).not.toBe(key);
  expect(codeKey('repo', { ...status, version: 4 }, where, 'agent', {})).toBe(key);
  for (const changed of [{ grant: [] }, { parent: { repo: 'parent' } }, { history_chain: null }, { quarantine_epoch: NaN }])
    expect(codeKey('repo', { ...status, ...changed }, where, 'agent', {})).toBeNull();
  const memo = new CodeMemo({ entries: 2, bytes: 150, entry: 100 });
  memo.put('a', { value: 'one' }); memo.put('b', { value: 'two' });
  memo.get('a')!.value = 'mutated'; memo.put('c', { value: 'three' });
  expect(memo.get('a')).toEqual({ value: 'one' }); expect(memo.get('b')).toBeUndefined();
  memo.put('large', { value: '💫'.repeat(30) }); expect(memo.get('large')).toBeUndefined();
  memo.put('d', { value: 'd'.repeat(80) }); memo.put('e', { value: 'e'.repeat(80) });
  expect(memo.get('d')).toBeUndefined(); expect(memo.get('e')).toEqual({ value: 'e'.repeat(80) });
});

it('applies current public redaction outside a result warmed by a member', async () => {
  const owner = { cookie: await signup('search_redaction') };
  const made = await api('/repos', owner, { body: { name: 'redaction', author,
    policy: { approvals: 0, required_checks: [] }, files: [file('a.txt', 'user:fixture@example.com\n')],
  } }, on);
  const repo = `/repos/${made.body.id}`;
  const path = `${repo}/search?query=user&groups=code&limit=20`;
  expect((await api(`${repo}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, on)).status).toBe(200);
  expect((await api(path, owner, {}, on)).body.results[0].lines[0].text).toBe('user:fixture@example.com');
  const publicRead = await api(path, {}, {}, on);
  expect(publicRead.headers.get('server-timing')).toContain('search.code.hit');
  expect(publicRead.body.results[0].lines[0].text).toBe('user:(hidden)');
  const member = await api(path, owner, {}, on);
  expect(member.headers.get('server-timing')).toContain('search.code.hit');
  expect(member.body.results[0].lines[0].text).toBe('user:fixture@example.com');
});

it('does not retain a refused partition returned as a partial HTTP 200 scan', async () => {
  const { owner, repo } = await setup('search_partial');
  const partition = vi.spyOn(searchIndex, 'searchSegments').mockResolvedValue({
    indexes: [{ partition: { prefix: 'src/' }, chunks: 0, refused: 'simulated index refusal' }], built: 0,
  });
  for (let n = 0; n < 2; n++) {
    const answer = await api(`${repo}/search?query=agent&groups=code`, owner, {}, on);
    expect(answer.status).toBe(200);
    expect(answer.body.skipped_count).toBe(1);
    expect(answer.headers.get('server-timing')).not.toContain('search.code.hit');
  }
  expect(partition).toHaveBeenCalledTimes(2);
});
