// The listings' copy of an account's handle: D1 is the platform's, so the front Worker asks here.
import type { Env } from './types';

export async function projectHandle(env: Env, account: string, handle: string) {
  await env.INDEX.prepare(
    'INSERT INTO platform_handles(workspace,handle) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET handle=excluded.handle',
  )
    .bind(account, handle)
    .run();
}
