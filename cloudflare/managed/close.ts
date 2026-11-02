// A deleted account's side here, called only by the platform Worker with the admin bearer: its
// agents forgotten, its card off Stripe, and what is left of its credit written off. A run in
// flight ends with its repository, which is deleted first. The ledger's entries stay for
// accounting. Repeating this changes nothing.
import type { ManagedEnv } from './config';
import { ledgerStub } from './ledger';
import { detach, stripeEnabled } from './stripe';
import { workspaceStub } from './workspace-agents';

export async function closeWorkspace(env: ManagedEnv, workspace: string) {
  await workspaceStub(env, workspace).close();
  const closed = await ledgerStub(env, workspace).closeAccount();
  if (closed.payment_method && stripeEnabled(env)) await detach(env, closed.payment_method);
  return { forfeited_usd: closed.forfeited / 1_000_000 };
}
