import { env } from 'cloudflare:workers';
import { rejects } from 'node:assert/strict';
import { canonicalJson } from '../../cloudflare/worker/canonical-json';
import type { Env, Json } from '../../cloudflare/worker/types';

export const bindings = env as unknown as Env & { SOURCES: DurableObjectNamespace };
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes: Uint8Array | string) =>
  hex(
    await crypto.subtle.digest(
      'SHA-256',
      typeof bytes === 'string' ? encoder.encode(bytes) : bytes,
    ),
  );
export const fingerprint = (value: unknown) =>
  sha256(`yonedarepo:json:v1\0${canonicalJson(value)}`);
export const denied = (promise: Promise<unknown>) =>
  rejects(
    promise,
    (error: any) =>
      [403, 409].includes(error.status) &&
      typeof error.code === 'string' &&
      error.code !== 'SOURCE_FAILED',
  );

/** Internal fixture grants exercise native HMAC validation; they never enter public model APIs. */
export async function signed(claims: Json, purpose: 'actor' | 'gc' | 'capture') {
  const derived = await sha256(`yoneda:source-grant:v1:${bindings.VAULT_KEY}`);
  const bytes = Uint8Array.from(derived.match(/../g) ?? [], (value) => Number.parseInt(value, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const tag =
    purpose === 'actor'
      ? 'yoneda:source-grant:v1'
      : purpose === 'gc'
        ? 'yoneda:source-gc:v1'
        : 'yoneda:source-capture:v1';
  return {
    claims,
    signature: hex(
      await crypto.subtle.sign('HMAC', key, encoder.encode(`${tag}\0${await fingerprint(claims)}`)),
    ),
  };
}

export function gitFile(path: string, size: number, blob = 'c'.repeat(40)): Json {
  return {
    path,
    mode: '100644',
    size,
    content: {
      kind: 'git',
      repository: 'yoneda-test/source-base',
      commit: 'a'.repeat(40),
      path,
      blob,
    },
  };
}

export async function sourceFixture(
  name: string,
  options: {
    access?: 'read_only' | 'read_write';
    role?: string;
    files?: Json[];
    write_paths?: string[];
    protected_paths?: string[];
    base?: Json;
    baseline_overrides?: Json[];
    inputs?: Json[];
  } = {},
) {
  const access = options.access ?? 'read_write';
  const base = options.base ?? {
    repository: 'yoneda-test/source-base',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const files = options.files ?? [
    gitFile('src/read.bin', 4),
    gitFile('src/unread.bin', 8, 'd'.repeat(40)),
    gitFile('tests/protected.bin', 6, 'e'.repeat(40)),
  ];
  const view = { version: 1, base, files };
  const overrides = options.baseline_overrides ?? [];
  const viewDigest = await fingerprint({ view, baseline_overrides: overrides });
  const identity = {
    repo_id: `source-fixture-${name}`,
    job_id: `job:${name}`,
    epoch: 1,
    view_digest: viewDigest,
  };
  const workspaceId = `source-workspace:${await fingerprint(identity)}`;
  const binding = {
    version: 1,
    transport: 'api-source-v1',
    workspace_id: workspaceId,
    ...identity,
    baseline_overrides_digest: await fingerprint(overrides),
    run_id: `run:${name}`,
    execution_id: `execution:${name}`,
    role: options.role ?? 'builder',
    access,
    base,
    parents: [base.commit],
    policy_digest: 'f'.repeat(64),
    intent_digest: '1'.repeat(64),
    write_paths: access === 'read_only' ? [] : (options.write_paths ?? ['src/']),
    scratch_paths: [],
    protected_paths: options.protected_paths ?? ['tests/'],
    inputs: options.inputs ?? [base],
    repo_base_version: 0,
    working_branch_id: null,
    working_branch_version: null,
  };
  const bindingDigest = await fingerprint(binding);
  const actor = async (expiresAt = Date.now() + 60000, overrides: Json = {}) =>
    signed(
      {
        version: 1,
        workspace_id: workspaceId,
        binding_digest: bindingDigest,
        repo_id: binding.repo_id,
        run_id: binding.run_id,
        job_id: binding.job_id,
        epoch: binding.epoch,
        execution_id: binding.execution_id,
        view_digest: viewDigest,
        role: binding.role,
        access,
        purpose: 'supervisor',
        expires_at: expiresAt,
        ...overrides,
      },
      'actor',
    );
  const gc = async () =>
    signed(
      {
        version: 1,
        workspace_id: workspaceId,
        binding_digest: bindingDigest,
        repo_id: binding.repo_id,
        expires_at: Date.now() + 60000,
        purpose: 'gc',
      },
      'gc',
    );
  const stub = bindings.SOURCES.get(bindings.SOURCES.idFromName(workspaceId));
  async function rpc(command: Json) {
    const response = await stub.fetch('http://source/command', {
      method: 'POST',
      body: JSON.stringify({ _actor: await actor(), ...command }),
    });
    const value = await response.json<Json>();
    if (!response.ok)
      throw Object.assign(new Error(value.error?.message ?? 'Source operation failed'), {
        code: value.error?.code ?? 'SOURCE_FAILED',
        status: response.status,
      });
    return value;
  }
  const status = await rpc({
    op: 'source_init',
    request_id: `init:${name}`,
    binding,
    view,
    baseline_overrides: overrides,
  });
  return { binding, view, status, stub, actor, gc, rpc };
}

export async function verifiedTicket(
  fixture: Awaited<ReturnType<typeof sourceFixture>>,
  path: string,
  bytes: Uint8Array,
  workspaceVersion = 0,
  fileVersion = 0,
  actor?: Json,
) {
  const sha = await sha256(bytes);
  const request = {
    op: 'source_upload_ticket',
    request_id: `ticket:${path}:${sha}:${workspaceVersion}:${fileVersion}`,
    path,
    sha256: sha,
    size: bytes.length,
    mode: '100644',
    expected_workspace_version: workspaceVersion,
    expected_file_version: fileVersion,
    ...(actor ? { _actor: actor } : {}),
  };
  const issued = await fixture.rpc(request);
  await bindings.OBJECTS.put(issued.ticket.key, bytes);
  const readback = await bindings.OBJECTS.get(issued.ticket.key);
  if (!readback) throw new Error('Fixture upload missing in actual R2');
  const actual = new Uint8Array(await readback.arrayBuffer());
  await fixture.rpc({
    op: 'source_verify_upload',
    request_id: `verify:${issued.ticket.id}`,
    ticket_id: issued.ticket.id,
    sha256: await sha256(actual),
    size: actual.length,
    ...(actor ? { _actor: actor } : {}),
  });
  return issued.ticket;
}
