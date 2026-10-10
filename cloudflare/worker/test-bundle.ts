import type { Env, Json, Scope } from './types';

/** Load a digest-addressed canonical Workspace JSON object for supervisor-only evaluation. */
export async function testBundle(env: Env, scope: Scope, expected: string) {
  if (scope.job.kind !== 'evaluate' || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Immutable test bundle is unavailable to this attempt');
  const approved = scope.job.payload?.policy?.build?.test_bundle;
  if (approved?.digest !== expected)
    throw new Error('Test bundle differs from frozen owner policy');
  const object = await env.OBJECTS.get(`sha256/${expected}`);
  if (!object || object.size > 100 * 1024 * 1024)
    throw new Error('Approved test bundle is missing or too large');
  const value = JSON.parse(await object.text()) as Json;
  const files = value.files ?? value;
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new Error('Malformed test bundle');
  const canonical: Json = Object.create(null);
  for (const path of Object.keys(files).sort()) {
    if (!safePath(path)) throw new Error('Test bundle contains an unsafe path');
    const entry = files[path];
    if (!entry || typeof entry.content !== 'string' || typeof entry.executable !== 'boolean')
      throw new Error('Malformed test bundle file entry');
    canonical[path] = {
      content: entry.content,
      executable: entry.executable,
      ...(entry.encoding ? { encoding: entry.encoding } : {}),
    };
  }
  if (Object.keys(canonical).length > 10_000) throw new Error('Test bundle has too many files');
  let total = 0;
  for (const entry of Object.values(canonical)) {
    const value = entry as Json;
    const bytes =
      value.encoding === 'base64'
        ? Math.floor((value.content.length * 3) / 4)
        : new TextEncoder().encode(value.content).length;
    if (bytes > 32_000_000) throw new Error('Test bundle file exceeds 32 MB');
    total += bytes;
  }
  if (total > 100 * 1024 * 1024) throw new Error('Test bundle exceeds 100 MiB');
  const encoded = JSON.stringify(canonical);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== expected) throw new Error('Approved test bundle digest mismatch');
  return { digest, files: canonical };
}

function safePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !/[\\\0:]/.test(path) &&
    path
      .split('/')
      .every(
        (part) => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
      )
  );
}
