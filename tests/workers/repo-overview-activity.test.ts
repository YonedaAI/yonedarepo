import { expect, it } from 'vitest';
import { ActivityMemo, overviewActivity } from '../../cloudflare/worker/repo-overview-activity';
import type { Json, RepoContext } from '../../cloudflare/worker/repo-ops';

const fresh = { version: 3, history_chain: 'chain-3', quarantine_epoch: 0, object_store: 'r2:test', grant: null, parent: null };
const activity = (version = 3, authored_at: number | null = 100) => ({
  version,
  commits: [{ commit: 'a'.repeat(40), principal: 'user:owner', author_name: 'Owner', authored_at, landed: { landed_at: 200 }, message: 'not retained' }],
});
const context = (call: (command: Json) => Promise<Json>, repo = 'test') => ({ repo, call }) as RepoContext;
const query = new URLSearchParams();
const read = (ctx: RepoContext, memo: ActivityMemo, status = fresh, q = query, ref = 'main', commit = 'a'.repeat(40)) =>
  overviewActivity(ctx, status, ref, commit, q, memo);

it('does not keep incomplete legacy author metadata after same-version backfill', async () => {
  let calls = 0;
  const ctx = context(async () => activity(3, ++calls === 1 ? null : 100));
  const memo = new ActivityMemo();
  expect((await read(ctx, memo)).commits[0].authored_at).toBeNull();
  expect((await read(ctx, memo)).commits[0].authored_at).toBe(100);
  await read(ctx, memo);
  expect(calls).toBe(2);
});

it('a racing log stays uncached until admission observes its version and history', async () => {
  let calls = 0;
  const ctx = context(async () => { calls++; return activity(4); });
  const memo = new ActivityMemo();
  await read(ctx, memo);
  await read(ctx, memo);
  expect(calls).toBe(2);
  await read(ctx, memo, { ...fresh, version: 4, history_chain: 'chain-4' });
  expect(calls).toBe(3);
  await read(ctx, memo, { ...fresh, version: 4, history_chain: 'chain-4' });
  expect(calls).toBe(3);
});

it('reimported history cannot reuse an answer at the same store/version/commit', async () => {
  let calls = 0;
  const ctx = context(async () => activity(3, ++calls === 1 ? 100 : 300));
  const memo = new ActivityMemo();
  await read(ctx, memo);
  expect((await read(ctx, memo, { ...fresh, history_chain: 'reimport-chain' })).commits[0].authored_at).toBe(300);
  expect(calls).toBe(2);
});

it('separates exact versions, ref/commit selection, withholding epochs and stores', async () => {
  let calls = 0;
  const ctx = context(async (c) => { calls++; return { ...activity(c.at ?? 3), commits: [{ ...activity().commits[0], commit: c.from }] }; });
  const memo = new ActivityMemo();
  await read(ctx, memo);
  await read(ctx, memo);
  await read(ctx, memo, fresh, new URLSearchParams('at=2'));
  await read(ctx, memo, { ...fresh, quarantine_epoch: 1 });
  await read(ctx, memo, { ...fresh, object_store: 'r2:changed' });
  await read(ctx, memo, fresh, query, 'feature');
  await read(ctx, memo, fresh, query, 'main', 'b'.repeat(40));
  await read(context(ctx.call, 'other'), memo);
  expect(calls).toBe(7);
});

it('forks, restricted grants, invalid versions and future at never consume a cached answer', async () => {
  let calls = 0;
  const ctx = context(async () => { calls++; return activity(); });
  const memo = new ActivityMemo();
  await read(ctx, memo);
  for (const status of [{ ...fresh, parent: { repo: 'parent' } }, { ...fresh, grant: ['src/'] }, { ...fresh, quarantine_epoch: undefined }, { ...fresh, version: NaN }, { ...fresh, history_chain: null }]) {
    await read(ctx, memo, status as typeof fresh);
    await read(ctx, memo, status as typeof fresh);
  }
  await read(ctx, memo, fresh, new URLSearchParams('at=4'));
  expect(calls).toBe(12);
});

it('never caches failures or shares pending activity between independent callers', async () => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ctx = context(async () => { if (++calls === 1) { await held; throw new Error('cancelled read'); } return activity(); });
  const memo = new ActivityMemo();
  const first = read(ctx, memo).catch((e) => e.message);
  const second = await read(ctx, memo);
  expect(second.commits[0].commit).toBe('a'.repeat(40));
  release();
  expect(await first).toBe('cancelled read');
  await read(ctx, memo);
  expect(calls).toBe(2);
});

it('bounds retained entries/bytes, rejects oversized entries and copies returned values', () => {
  const memo = new ActivityMemo({ entries: 2, bytes: 150, entry: 100 });
  memo.put('a', { value: 'one' });
  memo.put('b', { value: 'two' });
  memo.get('a')!.value = 'mutated';
  memo.put('c', { value: 'three' });
  expect(memo.get('b')).toBeUndefined();
  expect(memo.get('a')).toEqual({ value: 'one' });
  memo.put('large', { value: '💫'.repeat(30) });
  expect(memo.get('large')).toBeUndefined();
  memo.put('d', { value: 'd'.repeat(80) });
  memo.put('e', { value: 'e'.repeat(80) });
  expect(memo.get('d')).toBeUndefined();
  expect(memo.get('e')).toEqual({ value: 'e'.repeat(80) });
});
