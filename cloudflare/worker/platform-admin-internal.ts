// `POST /api/v1/admin/accounts/<a>/internal`: whether an account is ours, set with
// `cargo xtask admin internal`. It changes only what's counted (internal-accounts.ts).
import { forgetInternalAccounts } from './internal-accounts';
import { audit } from './platform-admin-queries';
import { ApiError } from './repo-ops';
import type { Env } from './types';

/** Flags `account`, left out of every figure from now on. Points already written can't be taken
 * back, and other isolates hear within ten minutes. */
export async function setInternal(env: Env, actor: string, account: string, internal: boolean) {
  const { meta } = await env.INDEX.prepare(
    'UPDATE platform_accounts SET internal=? WHERE account=?',
  )
    .bind(internal ? 1 : 0, account)
    .run();
  if (!meta.changes) throw new ApiError('NOT_FOUND', 'Unknown account');
  await audit(env, actor, internal ? 'account.internal' : 'account.not_internal', account);
  forgetInternalAccounts();
  return { account, internal };
}
