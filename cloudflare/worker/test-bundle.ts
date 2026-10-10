import type { Env, Json, Scope } from './types';

export type BundleFile = { content: string; executable: boolean; encoding?: string };

/** Canonical Rust Workspace JSON, independent of JS UTF-16 and integer-key ordering. */
export function canonicalBundle(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Malformed test bundle');
  const source = input as Record<string, unknown>;
  const encoder = new TextEncoder();
  const paths = Object.keys(source);
  if (paths.length === 0 || paths.length > 10_000)
    throw new Error('Invalid test bundle file count');
  paths.sort((left, right) => compareBytes(encoder.encode(left), encoder.encode(right)));
  const files: Record<string, BundleFile> = Object.create(null);
  const pairs: string[] = [];
  let total = 0;
  for (const path of paths) {
    if (!safePath(path)) throw new Error('Test bundle contains an unsafe path');
    const entry = source[path];
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof (entry as BundleFile).content !== 'string' ||
      typeof (entry as BundleFile).executable !== 'boolean'
    )
      throw new Error('Malformed test bundle file entry');
    const file = entry as BundleFile;
    if (file.encoding !== undefined && file.encoding !== 'base64')
      throw new Error('Unsupported test bundle encoding');
    const contentBytes =
      file.encoding === 'base64'
        ? decodeBase64(file.content).length
        : encoder.encode(file.content).length;
    if (contentBytes > 32_000_000) throw new Error('Test bundle file exceeds 32 MB');
    total += contentBytes;
    if (total > 100 * 1024 * 1024) throw new Error('Test bundle exceeds 100 MiB');
    const canonical = {
      content: file.content,
      executable: file.executable,
      ...(file.encoding ? { encoding: file.encoding } : {}),
    };
    files[path] = canonical;
    pairs.push(`${JSON.stringify(path)}:${JSON.stringify(canonical)}`);
  }
  return { files, encoded: `{${pairs.join(',')}}` };
}

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
  const canonical = canonicalBundle(files);
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.encoded)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== expected) throw new Error('Approved test bundle digest mismatch');
  return { digest, files: canonical.files as unknown as Json };
}

function compareBytes(left: Uint8Array, right: Uint8Array) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}

function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Invalid base64 test bundle content');
  return atob(value);
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
