import { sourceAuthority } from './source-authority';
import { type SourceContext, type SourceTicket, sourceError } from './source-contract';
import { verifyTicketObject } from './source-storage';
import { sourceStream } from './source-stream';
import type { Env, Json } from './types';

/** Reserve first. A failed or ambiguous upload retains its native reservation for fenced GC. */
export async function sourceUpload(
  env: Env,
  context: SourceContext,
  supervisor: SourceContext,
  args: Json,
  body: ReadableStream<Uint8Array>,
) {
  if (
    supervisor.binding.workspace_id !== context.binding.workspace_id ||
    supervisor.actor.claims.purpose !== 'supervisor'
  )
    throw sourceError('SOURCE_SCOPE', 'Source verification requires the same supervisor binding');
  const issued = await sourceAuthority<{
    version: 1;
    workspace_id: string;
    workspace_version: number;
    ticket: SourceTicket;
  }>(env, context.binding.workspace_id, {
    op: 'source_upload_ticket',
    ...args,
    _actor: context.actor,
  });
  const ticket = issued.ticket;
  const content = {
    kind: 'r2' as const,
    key: ticket.key,
    ticket_id: ticket.id,
    size: ticket.size,
    sha256: ticket.sha256,
  };
  if (
    ticket.key !== `source/v1/${context.binding.workspace_id}/uploads/${ticket.id}/${ticket.sha256}`
  )
    throw sourceError('SOURCE_SCOPE', 'Upload ticket key differs from its native authority');
  const existing = await env.OBJECTS.head(ticket.key);
  if (existing) {
    await body.cancel('Idempotent upload already stored');
    await verifyTicketObject(env, context.binding.workspace_id, content);
  } else {
    const measured = sourceStream(body, ticket.size);
    try {
      const stored = await env.OBJECTS.put(ticket.key, measured.body, {
        onlyIf: { etagDoesNotMatch: '*' },
        sha256: ticket.sha256,
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      if (!stored) {
        await measured.body.cancel('Concurrent idempotent upload').catch(() => {});
        await Promise.allSettled([measured.piped, measured.proof]);
      } else {
        await measured.piped;
        const actual = await measured.proof;
        if (actual.sha256 !== ticket.sha256)
          throw sourceError('SOURCE_CHECKSUM', 'Upload differs from its reserved checksum');
      }
    } catch (failure) {
      await measured.body.cancel(failure).catch(() => {});
      await Promise.allSettled([measured.piped, measured.proof]);
      throw failure;
    }
    await verifyTicketObject(env, context.binding.workspace_id, content);
  }
  const verified = await sourceAuthority<Json>(env, context.binding.workspace_id, {
    op: 'source_verify_upload',
    request_id: `verify:${ticket.id}`,
    ticket_id: ticket.id,
    sha256: ticket.sha256,
    size: ticket.size,
    _actor: supervisor.actor,
  });
  const { key: _key, ...publicTicket } = verified.ticket;
  return { ...verified, ticket: publicTicket };
}
