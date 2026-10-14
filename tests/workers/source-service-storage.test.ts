import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceCleanup } from '../../cloudflare/worker/source-cleanup';
import type { SourceContext, SourceGcDue } from '../../cloudflare/worker/source-contract';
import { sourceArguments, publicSourceValue } from '../../cloudflare/worker/source-operations';
import { sourceReadResponse } from '../../cloudflare/worker/source-storage';
import { sourceUpload } from '../../cloudflare/worker/source-upload';
import type { Env } from '../../cloudflare/worker/types';
import { bindings, sha256, sourceFixture, verifiedTicket } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
const bytes = new Uint8Array([0, 255, 128, 192, 10]);
const waiting = (at: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, at - Date.now() + 10)));
async function contexts(name: string) {
  const f = await sourceFixture(name);
  const normal = { binding: f.binding, view: f.view, baseline_overrides: [], mount: 'repo',
    actor: await f.actor(Date.now() + 60000, { purpose: 'source' }) } as unknown as SourceContext;
  const supervisor = { ...normal, actor: await f.actor() } as unknown as SourceContext;
  return { f, normal, supervisor };
}

it('reserves and verifies a streamed binary ticket before CAS registration, with raw bounded reads and no pointer leaks', async () => {
  const { f, normal, supervisor } = await contexts('adapter-upload');
  const args = { request_id: 'raw-ticket', path: 'src/raw.bin', sha256: await sha256(bytes), size: bytes.length,
    mode: '100644', expected_workspace_version: 0, expected_file_version: 0 };
  const receipt = await sourceUpload(bindings, normal, supervisor, args, new Blob([bytes]).stream());
  expect(receipt.ticket.state).toBe('verified');
  expect(receipt.ticket.key).toBeUndefined();
  expect((await f.rpc({ op: 'source_stat', path: 'src/raw.bin' })).exists).toBe(false);
  await f.rpc({ op: 'source_create', request_id: 'raw-create', path: 'src/raw.bin', ticket_id: receipt.ticket.id,
    expected_workspace_version: 0, expected_file_version: 0 });
  const read = await f.rpc({ op: 'source_read', path: 'src/raw.bin', expected_file_version: 1, offset: 1, limit: 3 });
  const response = await sourceReadResponse(bindings, normal.binding, read);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(1, 4));
  const metadata = JSON.parse(decodeURIComponent(response.headers.get('x-yoneda-source') ?? ''));
  expect(metadata.file.file_version).toBe(1);
  expect(metadata.file.size).toBe(bytes.length);
  expect(metadata.file.content).toBeUndefined();
  expect(metadata.content).toBeUndefined();
  expect(metadata.file.blob_id).toBe(args.sha256);
  expect(response.headers.get('content-length')).toBe('3');
});

it('wrong checksum cannot become a verified/writable pointer and does not refund issued upload capacity', async () => {
  const { f, normal, supervisor } = await contexts('adapter-bad-checksum');
  const args = { request_id: 'wrong-body', path: 'src/raw.bin', sha256: await sha256(bytes), size: bytes.length,
    mode: '100644', expected_workspace_version: 0, expected_file_version: 0 };
  await expect(sourceUpload(bindings, normal, supervisor, args,
    new Blob([new Uint8Array(bytes.length)]).stream())).rejects.toBeDefined();
  const replay = await f.rpc({ op: 'source_upload_ticket', ...args });
  expect(replay.ticket.state).toBe('issued');
  await expect(f.rpc({ op: 'source_create', request_id: 'cannot-use-bad', path: args.path,
    ticket_id: replay.ticket.id, expected_workspace_version: 0, expected_file_version: 0 })).rejects.toBeDefined();
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});

it('cleanup ignores payload key, fences registration natively, and recovers a lost completion acknowledgement', async () => {
  const f = await sourceFixture('adapter-cleanup');
  const ticket = await verifiedTicket(f, 'src/raw.bin', bytes, 0, 0, await f.actor(Date.now() + 300));
  await waiting(ticket.expires_at);
  const due = await f.rpc({ op: 'source_gc_due' }) as SourceGcDue;
  expect(due.tickets.some(value => value.id === ticket.id)).toBe(true);
  const unrelated = 'source/private-do-not-delete';
  await bindings.OBJECTS.put(unrelated, bytes);
  due.tickets = due.tickets.map(value => ({ ...value, key: unrelated }));
  let lost = false;
  const sourceNamespace = bindings.SOURCES;
  const local = { ...bindings, SOURCES: {
    idFromName: (id: string) => sourceNamespace.idFromName(id),
    get: (id: DurableObjectId) => ({ async fetch(input: RequestInfo, init: RequestInit) {
      const value = JSON.parse(String(init.body));
      const response = await sourceNamespace.get(id).fetch(input, init);
      if (value.op === 'source_gc_complete' && response.ok && !lost) { lost = true; throw new Error('Simulated lost GC acknowledgement'); }
      return response;
    } }),
  } } as unknown as Env;
  await expect(sourceCleanup(local, due)).rejects.toThrow('Simulated lost GC acknowledgement');
  expect(await sourceCleanup(local, due)).toEqual({ deleted: 1 });
  expect(await bindings.OBJECTS.head(ticket.key)).toBeNull();
  expect(await bindings.OBJECTS.head(unrelated)).not.toBeNull();
  await expect(f.rpc({ op: 'source_create', request_id: 'post-gc', path: 'src/raw.bin', ticket_id: ticket.id,
    expected_workspace_version: 0, expected_file_version: 0 })).rejects.toBeDefined();
});

it('committed ticket and forged cleanup grant cause no R2 deletion', async () => {
  const f = await sourceFixture('adapter-protected-cleanup');
  const ticket = await verifiedTicket(f, 'src/raw.bin', bytes);
  await f.rpc({ op: 'source_create', request_id: 'committed', path: 'src/raw.bin', ticket_id: ticket.id,
    expected_workspace_version: 0, expected_file_version: 0 });
  const grant = await f.gc();
  const due = { version: 1, workspace_id: f.binding.workspace_id, repo_id: f.binding.repo_id,
    binding_digest: grant.claims.binding_digest, tickets: [{ ...ticket, gc_token: null }],
    gc_grant: grant, next_due_at: null } as SourceGcDue;
  await expect(sourceCleanup(bindings, due)).rejects.toBeDefined();
  await expect(sourceCleanup(bindings, { ...due, gc_grant: { ...grant, signature: '0'.repeat(64) } })).rejects.toBeDefined();
  expect(await bindings.OBJECTS.head(ticket.key)).not.toBeNull();
});

it('model operation boundary denies init/verify/seal/GC and all supplied identity fields before native/R2 access', () => {
  for (const op of ['source_init', 'source_verify_upload', 'source_seal', 'source_gc_claim', 'source_gc_due', 'source_manifest'])
    expect(() => sourceArguments(op, {}, false)).toThrow();
  for (const field of ['_actor', '_capture_grant', '_source_signing_key', 'workspace_id', 'repo_id', 'epoch', 'content'])
    expect(() => sourceArguments('source_stat', { path: 'src/read.bin', [field]: 'forged' }, false)).toThrow();
  expect(publicSourceValue({ attestation: {}, seal_receipt: {}, actor_grant: {}, certificate: { signature: 'private' },
    signature: 'private', ticket: { id: 'x', key: 'secret' }, file: { content: {} } }))
    .toEqual({ ticket: { id: 'x' }, file: {} });
});

it('concurrent same-ticket upload converges without consuming another ticket or changing source version', async () => {
  const { f, normal, supervisor } = await contexts('adapter-upload-race');
  const args = { request_id: 'same-raw-ticket', path: 'src/raw.bin', sha256: await sha256(bytes), size: bytes.length,
    mode: '100644', expected_workspace_version: 0, expected_file_version: 0 };
  const [one, two] = await Promise.all([sourceUpload(bindings, normal, supervisor, args, new Blob([bytes]).stream()),
    sourceUpload(bindings, normal, supervisor, args, new Blob([bytes]).stream())]);
  expect(one.ticket.id).toBe(two.ticket.id);
  expect(one.ticket.state).toBe('verified');
  expect(two.ticket.state).toBe('verified');
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});

it('public source receipts preserve legitimate file paths named key and beginning with underscore', () => {
  const receipt = { version: 1, file_versions: { key: 1, _notes: 1 }, attestation: { signature: 'private' } };
  expect(publicSourceValue(receipt)).toEqual({ version: 1, file_versions: { key: 1, _notes: 1 } });
});
