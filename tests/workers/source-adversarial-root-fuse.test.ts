import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceBroker } from '../../cloudflare/worker/source-broker';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import type { Json } from '../../cloudflare/worker/types';
import { boundSourceFixture } from '../../tools/source-benchmark/workerd-bound-source-fixture';

afterEach(reset);
function request(op: string, args: Json, headers: Record<string, string> = {}) {
  return new Request(`http://source.yoneda.internal/v1/repo/${op}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  });
}

it('a model cannot forge root-FUSE markers to suppress required invalidation or acquire seal authority', async () => {
  const f = await boundSourceFixture('source-fuse-auth');
  const command = {
    request_id: 'chmod-once',
    path: 'app.js',
    mode: '100755',
    expected_workspace_version: 0,
    expected_file_version: 0,
  };
  for (const headers of [
    { 'x-yoneda-source-fuse': '1' },
    { 'x-yoneda-source-fuse': '1', authorization: 'Bearer forged' },
    { 'x-yoneda-source-fuse': '0', authorization: `Bearer ${f.scope.supervisor}` },
  ]) {
    const result = await sourceBroker(request('source_chmod', command, headers), f.env, {
      containerId: 'fixture',
    } as never);
    expect(result.status).toBe(403);
  }
  const before = await sourceAuthority(f.env, f.context.binding.workspace_id, {
    op: 'source_status',
    _actor: f.context.actor,
  });
  expect(before.workspace_version).toBe(0);
  const normal = await sourceBroker(request('source_chmod', command), f.env, {
    containerId: 'fixture',
  } as never);
  expect(normal.status).toBe(200);
  expect(f.invalidations).toEqual([
    { alias: 'repo', paths: ['app.js'], job_id: f.scope.job.id, epoch: f.scope.job.epoch },
  ]);
  const seal = await sourceBroker(
    request('source_seal', {}, { 'x-yoneda-source-fuse': '1' }),
    f.env,
    { containerId: 'fixture' } as never,
  );
  expect(seal.status).toBe(403);
});

it('only an authenticated root FUSE mutation skips callback while closed public replies retain no capability or content pointers', async () => {
  const f = await boundSourceFixture('source-fuse-root');
  const headers = { authorization: `Bearer ${f.scope.supervisor}`, 'x-yoneda-source-fuse': '1' };
  const result = await sourceBroker(
    request(
      'source_chmod',
      {
        request_id: 'root-write',
        path: 'app.js',
        mode: '100755',
        expected_workspace_version: 0,
        expected_file_version: 0,
      },
      headers,
    ),
    f.env,
    { containerId: 'fixture' } as never,
  );
  expect(result.status).toBe(200);
  expect(f.invalidations).toEqual([]);
  const cp = await sourceBroker(
    request('source_checkpoint', { request_id: 'cp', expected_workspace_version: 1 }),
    f.env,
    { containerId: 'fixture' } as never,
  );
  expect(cp.status).toBe(200);
  const checkpoint = await cp.json<Json>();
  const sealed = await sourceBroker(
    request(
      'source_seal',
      {
        request_id: 'seal',
        expected_workspace_version: 1,
        checkpoint_id: checkpoint.checkpoint_id,
        expected_checkpoint_digest: checkpoint.changeset_digest,
      },
      headers,
    ),
    f.env,
    { containerId: 'fixture' } as never,
  );
  expect(sealed.status).toBe(200);
  for (const op of ['source_status', 'source_list', 'source_stat']) {
    const response = await sourceBroker(
      request(op, op === 'source_stat' ? { path: 'app.js' } : {}, headers),
      f.env,
      { containerId: 'fixture' } as never,
    );
    expect(response.status).toBe(200);
    const value = JSON.stringify(await response.json());
    for (const privateKey of [
      'attestation',
      'actor_grant',
      'gc_grant',
      'seal_receipt',
      '_source_signing_key',
      'content',
    ])
      expect(value).not.toContain(`"${privateKey}"`);
    expect(value).not.toContain(f.scope.supervisor);
  }
  const publicSeal = await sealed.json<Json>();
  expect(publicSeal.attestation).toBeUndefined();
  expect((await f.call({ op: 'source_registered', job_id: f.scope.job.id })).changeset_digest).toBe(
    publicSeal.changeset_digest,
  );
});
