import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  bindings,
  denied,
  sha256,
  sourceFixture,
  verifiedTicket,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
const bytes = new TextEncoder().encode('orphan-or-committed-source');
// A grant that expires soon, so the test can wait for its ticket to lapse. It must outlive
// signing plus the ticket request: 500 ms did not on a loaded CI runner (FENCED 409).
const SHORT_GRANT_MS = 3_000;
const waitUntil = (time: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, time - Date.now() + 5)));

it('checks actual hash and size before a ticket can become writable and keeps digest keys private to each ticket', async () => {
  const f = await sourceFixture('verify');
  const sha = await sha256(bytes);
  const issued = await f.rpc({
    op: 'source_upload_ticket',
    request_id: 'ticket',
    path: 'src/read.bin',
    sha256: sha,
    size: bytes.length,
    mode: '100644',
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  await bindings.OBJECTS.put(issued.ticket.key, bytes);
  await denied(
    f.rpc({
      op: 'source_write',
      request_id: 'unverified',
      path: 'src/read.bin',
      ticket_id: issued.ticket.id,
      expected_workspace_version: 0,
      expected_file_version: 0,
    }),
  );
  await denied(
    f.rpc({
      op: 'source_verify_upload',
      request_id: 'wrong-hash',
      ticket_id: issued.ticket.id,
      sha256: '0'.repeat(64),
      size: bytes.length,
    }),
  );
  await denied(
    f.rpc({
      op: 'source_verify_upload',
      request_id: 'wrong-size',
      ticket_id: issued.ticket.id,
      sha256: sha,
      size: bytes.length + 1,
    }),
  );
  const other = await sourceFixture('verify-other');
  const otherTicket = await verifiedTicket(other, 'src/read.bin', bytes);
  expect(otherTicket.key).not.toBe(issued.ticket.key);
  await denied(
    f.rpc({
      op: 'source_write',
      request_id: 'foreign-ticket',
      path: 'src/read.bin',
      ticket_id: otherTicket.id,
      expected_workspace_version: 0,
      expected_file_version: 0,
    }),
  );
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});

it('an expired verified upload racing GC cannot register, and lost GC acknowledgments replay safely', async () => {
  const f = await sourceFixture('gc-race');
  const actor = await f.actor(Date.now() + SHORT_GRANT_MS);
  const ticket = await verifiedTicket(f, 'src/read.bin', bytes, 0, 0, actor);
  await waitUntil(ticket.expires_at);
  const grant = await f.gc();
  const claim = {
    op: 'source_gc_claim',
    request_id: 'gc-claim',
    ticket_id: ticket.id,
    _gc_grant: grant,
  };
  const [gc, write] = await Promise.allSettled([
    f.rpc(claim),
    f.rpc({
      op: 'source_write',
      request_id: 'late-registration',
      path: 'src/read.bin',
      ticket_id: ticket.id,
      expected_workspace_version: 0,
      expected_file_version: 0,
    }),
  ]);
  expect(gc.status).toBe('fulfilled');
  expect(write.status).toBe('rejected');
  if (gc.status !== 'fulfilled') throw gc.reason;
  expect(await f.rpc(claim)).toEqual(gc.value);
  await bindings.OBJECTS.delete(ticket.key);
  expect(await bindings.OBJECTS.head(ticket.key)).toBeNull();
  const complete = {
    op: 'source_gc_complete',
    request_id: 'gc-complete',
    ticket_id: ticket.id,
    gc_token: gc.value.gc_token,
    observed_missing: true,
    _gc_grant: grant,
  };
  await denied(f.rpc({ ...complete, request_id: 'wrong-gc-token', gc_token: 'wrong' }));
  const receipt = await f.rpc(complete);
  expect(receipt.state).toBe('deleted');
  expect(await f.rpc(complete)).toEqual(receipt);
  expect((await f.rpc({ op: 'source_stat', path: 'src/read.bin' })).content).toEqual(
    f.view.files[0].content,
  );
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});

it('committed checkpoint content is never reclaimable and actor authority cannot impersonate GC', async () => {
  const f = await sourceFixture('gc-committed');
  const ticket = await verifiedTicket(
    f,
    'src/read.bin',
    bytes,
    0,
    0,
    await f.actor(Date.now() + SHORT_GRANT_MS),
  );
  await f.rpc({
    op: 'source_write',
    request_id: 'committed',
    path: 'src/read.bin',
    ticket_id: ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  await f.rpc({
    op: 'source_checkpoint',
    request_id: 'durable-checkpoint',
    expected_workspace_version: 1,
  });
  await waitUntil(ticket.expires_at);
  await denied(
    f.rpc({
      op: 'source_gc_claim',
      request_id: 'actor-is-not-gc',
      ticket_id: ticket.id,
      _gc_grant: await f.actor(),
    }),
  );
  await denied(
    f.rpc({
      op: 'source_gc_claim',
      request_id: 'referenced-gc',
      ticket_id: ticket.id,
      _gc_grant: await f.gc(),
    }),
  );
  expect(await bindings.OBJECTS.head(ticket.key)).not.toBeNull();
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(1);
});
