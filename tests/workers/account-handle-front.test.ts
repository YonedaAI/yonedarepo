// The front Worker has no database: a handle chosen there reaches D1 through the platform.
import { expect, it } from 'vitest';
import { setHandle } from '../../cloudflare/worker/account-handles';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { bindings } from './repo-fixture';

it('a handle chosen on the front Worker is projected by the platform', async () => {
  const noted: [string, string][] = [];
  const platform = {
    fetch: async () => new Response(null, { status: 404 }),
    handleChosen: async (account: string, handle: string) => void noted.push([account, handle]),
  };
  const email = 'front.handle@example.com';
  await workspace(bindings, email, {
    op: 'signup',
    username: email,
    password: 'long platform test password',
    salt: '01'.repeat(16),
    session_hash: await sha('f'.repeat(64)),
    recovery_hash: 'b'.repeat(64),
  });
  const front = { ...bindings, INDEX: undefined, PLATFORM: platform } as unknown as Env;
  await expect(setHandle(front, email, 'front_handle')).resolves.toEqual({
    handle: 'front_handle',
  });
  expect(noted).toEqual([[email, 'front_handle']]);
  // Settings changes it: the new name is held, the old one is free for anyone, and the
  // listings follow.
  await expect(setHandle(front, email, 'next_handle')).resolves.toEqual({ handle: 'next_handle' });
  expect(noted).toEqual([
    [email, 'front_handle'],
    [email, 'next_handle'],
  ]);
  await expect(workspace(bindings, email, { op: 'handle_get' })).resolves.toEqual({
    handle: 'next_handle',
  });
  await expect(workspace(bindings, 'front_handle', { op: 'handle_lookup' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(workspace(bindings, 'next_handle', { op: 'handle_lookup' })).resolves.toMatchObject({
    account: email,
  });
});
