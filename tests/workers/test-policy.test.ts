import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import { canonicalBundle } from '../../cloudflare/worker/test-bundle';
import { approveTestPolicy } from '../../cloudflare/worker/test-policy';
import type { Env } from '../../cloudflare/worker/types';

afterEach(reset);
const bindings = env as unknown as Env;

it('binds immutable owner tests to a new policy and rejects a foreign owner or stale approval', async () => {
  const repo = 'immutable-owner-tests';
  const base = 'a'.repeat(40);
  const previous = { version: 'v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
    required_checks: ['owner'], build: { checks: [{ name: 'owner', argv: ['node', '-e', 'process.exit(0)'], timeout_seconds: 10 }] } };
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Immutable test approval', workspace: 'owner',
    commit: base, remote: { namespace: 'test', name: repo }, policy: previous });
  const body = { expected_commit: base, expected_version: 0, expected_policy: 'v1',
    policy: { ...previous, version: 'v2', build: { checks: [{ name: 'owner',
      argv: ['node', '/opt/yoneda/test-bundle/runner.cjs'], timeout_seconds: 10 }] } },
    protected_paths: ['tests'], files: {
      'runner.cjs': { content: 'process.exit(0)', executable: false },
      '2': { content: 'two', executable: false },
      '10': { content: 'ten', executable: false },
      '\uE000': { content: 'bmp', executable: false },
      '😀': { content: 'astral', executable: false },
    } };
  const request = () => new Request('https://yoneda/api/approve', { method: 'POST', body: JSON.stringify(body) });
  const canonical = canonicalBundle(body.files).encoded;
  const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await expect(approveTestPolicy(request(), bindings, { workspace: 'foreign', role: 'user' }, repo)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await bindings.OBJECTS.get(`sha256/${expected}`)).toBeNull();
  const approved = await (await approveTestPolicy(request(), bindings, { workspace: 'owner', role: 'user' }, repo)).json<{ digest: string }>();
  expect(approved.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(approved.digest).toBe(expected);
  const current = await ledger(bindings, repo, { op: 'repository_status' });
  expect(current.policy.build.test_bundle).toEqual({ digest: approved.digest, protected_paths: ['tests'] });
  body.expected_version = current.version;
  expect(await (await approveTestPolicy(request(), bindings, { workspace: 'owner', role: 'user' }, repo)).json()).toMatchObject({ already_approved: true });
  body.expected_version = current.version + 1;
  await expect(approveTestPolicy(request(), bindings, { workspace: 'owner', role: 'user' }, repo)).rejects.toMatchObject({ code: 'HEAD_MOVED' });
});
