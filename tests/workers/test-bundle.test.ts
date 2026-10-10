import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { testBundle } from '../../cloudflare/worker/test-bundle';
import type { Env, Scope } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const digest = async (content: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

it('loads immutable policy bundles beyond legacy workspace limits with binary and executable metadata', async () => {
  const files: Record<string, { content: string; executable: boolean; encoding?: string }> = Object.create(null);
  for (let index = 0; index < 501; index++)
    files[`tests/${String(index).padStart(4, '0')}.txt`] = { content: `${String(index).padStart(5, '0')}:` + 'x'.repeat(18_000), executable: false };
  files['tests/runner.sh'] = { content: '#!/bin/sh\nexit 0\n', executable: true };
  files['tests/blob.bin'] = { content: 'iVBORwD/gA==', encoding: 'base64', executable: false };
  const canonical: Record<string, unknown> = Object.create(null);
  for (const path of Object.keys(files).sort()) {
    const entry = files[path];
    canonical[path] = { content: entry.content, executable: entry.executable, ...(entry.encoding ? { encoding: entry.encoding } : {}) };
  }
  const serialized = JSON.stringify(canonical);
  expect(new TextEncoder().encode(serialized).length).toBeGreaterThan(8 * 1024 * 1024);
  const bundleDigest = await digest(serialized);
  await bindings.OBJECTS.put(`sha256/${bundleDigest}`, serialized);
  const scope = { job: { kind: 'evaluate', payload: { policy: { build: { test_bundle: { digest: bundleDigest } } } } } } as unknown as Scope;
  const result = await testBundle(bindings, scope, bundleDigest);
  expect(Object.keys(result.files)).toHaveLength(503);
  expect(result.files['tests/runner.sh']).toMatchObject({ executable: true });
  expect(result.files['tests/blob.bin']).toMatchObject({ encoding: 'base64', content: 'iVBORwD/gA==' });
});
