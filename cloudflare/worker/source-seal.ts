import { sourceAuthority } from './source-authority';
import { type SourceContext, sourceError } from './source-contract';
import { verifyTicketObject } from './source-storage';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

/** Reread native seal and every changed R2 reference before requesting repository registration. */
export async function registerSourceSeal(
  env: Env,
  scope: Scope,
  context: SourceContext,
  receipt: Json,
) {
  const status = await sourceAuthority<Json>(env, context.binding.workspace_id, {
    op: 'source_status',
    _actor: context.actor,
  });
  const seal = status.seal_receipt;
  if (
    !seal ||
    seal.seal_id !== receipt.seal_id ||
    seal.checkpoint_id !== receipt.checkpoint_id ||
    seal.workspace_id !== context.binding.workspace_id ||
    seal.changeset_digest !== receipt.changeset_digest
  )
    throw sourceError('SOURCE_SCOPE', 'Source seal readback differs');
  let after: string | undefined;
  let count = 0;
  for (let index = 0; index < 51; index++) {
    const page = await sourceAuthority<Json>(env, context.binding.workspace_id, {
      op: 'source_manifest',
      checkpoint_id: seal.checkpoint_id,
      section: 'changes',
      ...(after ? { after } : {}),
      limit: 200,
      _actor: context.actor,
    });
    if (
      page.changeset_digest !== seal.changeset_digest ||
      !Array.isArray(page.items) ||
      page.items.length > 200
    )
      throw sourceError('SOURCE_SCOPE', 'Source sealed manifest differs');
    for (const change of page.items) {
      if (change.after?.content?.kind === 'r2')
        await verifyTicketObject(env, context.binding.workspace_id, change.after.content);
    }
    count += page.items.length;
    if (!page.has_more) break;
    if (!page.next_cursor || page.next_cursor === after)
      throw sourceError('SOURCE_SCOPE', 'Source sealed manifest cursor did not advance');
    after = page.next_cursor;
  }
  if (count !== seal.change_count)
    throw sourceError('SOURCE_SCOPE', 'Source sealed manifest count differs');
  // Native RepoDO repeats lease, policy, base/branch, plan and signed-attestation checks here.
  return ledger(env, scope.repo_id, {
    op: 'source_register_changeset',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
    request_id: `register:${seal.seal_id}`,
    view_digest: context.binding.view_digest,
    _source_seal: seal,
  });
}
