import { sourceAuthority } from './source-authority';
import { type SourceGcDue, sourceError } from './source-contract';
import type { Env } from './types';

/** Private service RPC only. Native GC claim fences registration before any R2 deletion. */
export async function sourceCleanup(env: Env, due: SourceGcDue) {
  if (
    due.version !== 1 ||
    !Array.isArray(due.tickets) ||
    due.tickets.length > 50 ||
    due.gc_grant?.claims.workspace_id !== due.workspace_id ||
    due.gc_grant.claims.binding_digest !== due.binding_digest ||
    due.gc_grant.claims.repo_id !== due.repo_id
  )
    throw sourceError('SOURCE_SCOPE', 'Source cleanup authority differs');
  let deleted = 0;
  for (const ticket of due.tickets) {
    const claim = await sourceAuthority<{
      ticket_id: string;
      key: string;
      state: string;
      gc_token: string;
    }>(env, due.workspace_id, {
      op: 'source_gc_claim',
      request_id: `gc-claim:${ticket.id}`,
      ticket_id: ticket.id,
      _gc_grant: due.gc_grant,
    });
    // Payload keys are advisory. Only the authenticated transactional claim supplies a delete key.
    if (
      claim.ticket_id !== ticket.id ||
      claim.state !== 'gc_pending' ||
      !claim.key.startsWith(`source/v1/${due.workspace_id}/uploads/${ticket.id}/`) ||
      !/^[a-f0-9]{64}$/.test(claim.key.split('/').at(-1) ?? '')
    )
      throw sourceError('SOURCE_SCOPE', 'Source cleanup claim is invalid');
    await env.OBJECTS.delete(claim.key);
    if (await env.OBJECTS.head(claim.key))
      throw sourceError('SOURCE_GC', 'Source cleanup deletion is not confirmed');
    await sourceAuthority(env, due.workspace_id, {
      op: 'source_gc_complete',
      request_id: `gc-complete:${ticket.id}`,
      ticket_id: ticket.id,
      gc_token: claim.gc_token,
      observed_missing: true,
      _gc_grant: due.gc_grant,
    });
    deleted++;
  }
  return { deleted };
}
