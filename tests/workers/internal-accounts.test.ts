// The internal list behind every figure: a request's account comes from credentials already
// checked, the list costs one read per isolate every five minutes and none on a request's way
// in, and a list that can't be read leaves nothing of ours in a figure. Simulated bindings.
import { beforeEach, expect, it, vi } from 'vitest';
import {
  forgetInternalAccounts,
  internalAccounts,
  isInternal,
  noteAccount,
  requestAccount,
  withRequestAccount,
} from '../../cloudflare/worker/internal-accounts';
import type { Credentials } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 31, 12);
function d1(accounts: string[] | Error) {
  const all = vi.fn(async () => {
    if (accounts instanceof Error) throw accounts;
    return { results: accounts.map((account) => ({ account })) };
  });
  const env = { INDEX: { prepare: () => ({ bind: () => ({ all }) }) } } as unknown as Env;
  return { env, all };
}

beforeEach(() => {
  forgetInternalAccounts();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

it('reads the list once per isolate in five minutes, however many ask', async () => {
  const { env, all } = d1(['team']);
  const asked = await Promise.all([
    isInternal(env, 'team', NOW),
    isInternal(env, 'stranger', NOW),
    isInternal(env, 'team', NOW + 4 * MINUTE),
  ]);
  expect(asked).toEqual([true, false, true]);
  expect(all).toHaveBeenCalledTimes(1);
  await isInternal(env, 'team', NOW + 5 * MINUTE);
  expect(all).toHaveBeenCalledTimes(2);
});

it('counts the operators’ own scripts as ours without reading anything', async () => {
  const { env, all } = d1([]);
  expect(await isInternal(env, '_admin', NOW)).toBe(true);
  expect(all).not.toHaveBeenCalled();
});

it('keeps the last list when a read fails, and answers null when it never had one', async () => {
  const { env } = d1(['team']);
  await isInternal(env, 'team', NOW);
  const failing = d1(new Error('D1 down'));
  expect(await isInternal(failing.env, 'team', NOW + 6 * MINUTE)).toBe(true);
  forgetInternalAccounts();
  expect(await isInternal(failing.env, 'team', NOW + 7 * MINUTE)).toBe(null);
  expect(await internalAccounts(failing.env, NOW + 7 * MINUTE)).toBe(null);
});

it('asks the platform where there is no D1, as on the front Worker', async () => {
  const list = vi.fn(async () => ['team']);
  const env = { PLATFORM: { internalAccounts: list } } as unknown as Env;
  expect(await isInternal(env, 'team', NOW)).toBe(true);
  expect(await isInternal(env, 'stranger', NOW)).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
});

it('notes the account credentials name, and nothing for those that name none', () => {
  const pat = { _pat: { workspace: 'alice' } } as unknown as Credentials;
  const session = { _session: { workspace: 'bob', principal: 'user:bob' } } as Credentials;
  const repoToken = { _token: 'yrp_x' } as unknown as Credentials;
  const seen = (auth: Credentials | null) =>
    withRequestAccount(() => {
      noteAccount(auth);
      return requestAccount();
    });
  expect([seen(pat), seen(session), seen(repoToken), seen(null)]).toEqual([
    'alice',
    'bob',
    null,
    null,
  ]);
  expect(requestAccount()).toBe(null);
});
