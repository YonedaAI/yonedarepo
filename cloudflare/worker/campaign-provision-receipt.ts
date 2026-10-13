import { username } from './accounts';
import { safeId } from './http';
import { setupError } from './project-remote';
import type { Env, Json } from './types';

/** Stable JSON equality for immutable operator input, independent of object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function campaignInput(owner: string, input: Json) {
  if (
    username(owner) !== owner ||
    (input.username !== undefined && username(input.username) !== owner)
  )
    throw setupError('INVALID_INPUT', 'Normalized campaign owner required');
  if (
    Object.keys(input).some(
      (key) =>
        !['username', 'repo_id', 'template', 'policy', 'context_study', 'context_seed'].includes(
          key,
        ),
    )
  )
    throw setupError('INVALID_INPUT', 'Unknown campaign provisioning field');
  if (
    typeof input.repo_id !== 'string' ||
    !safeId(input.repo_id) ||
    typeof input.template !== 'string' ||
    !safeId(input.template) ||
    input.repo_id === input.template
  )
    throw setupError('INVALID_INPUT', 'Distinct safe repository and template names required');
  if (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy))
    throw setupError('INVALID_INPUT', 'Frozen policy required');
  const request = JSON.parse(
    canonical({
      owner,
      repo_id: input.repo_id,
      template: input.template,
      policy: input.policy,
      ...(input.context_study !== undefined ? { context_study: input.context_study } : {}),
      ...(input.context_seed !== undefined ? { context_seed: input.context_seed } : {}),
    }),
  );
  if (new TextEncoder().encode(canonical(request)).length > 128 * 1024)
    throw setupError('INVALID_INPUT', 'Campaign provisioning input exceeds limit');
  return request as Json;
}
/** Match serde defaults without implementing policy validation outside the Rust authority. */
export function normalizedPolicy(policy: Json) {
  const value = { ...policy };
  if (!value.build) delete value.build;
  else {
    value.build = { ...value.build, setup: value.build.setup ?? [] };
    for (const key of ['app', 'static_dir', 'test_bundle'])
      if (value.build[key] === null) delete value.build[key];
    if (value.build.test_bundle)
      value.build.test_bundle = {
        ...value.build.test_bundle,
        protected_paths: value.build.test_bundle.protected_paths ?? [],
      };
  }
  return value;
}
export function receiptKey(repo: string) {
  return `campaign-provision/${repo}.json`;
}
export async function readReceipt(env: Env, request: Json): Promise<Json | null> {
  const stored = await env.OBJECTS.get(receiptKey(request.repo_id));
  if (!stored) return null;
  if (stored.size > 132 * 1024)
    throw setupError('IDEMPOTENCY_CONFLICT', 'Invalid provisioning receipt');
  const value = await stored.json<Json>();
  if (
    value.version !== 1 ||
    canonical(value.request) !== canonical(request) ||
    value.source?.namespace !== env.ARTIFACTS_NAMESPACE ||
    value.source?.name !== request.template ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.source?.commit ?? '')
  )
    throw setupError(
      'IDEMPOTENCY_CONFLICT',
      'Repository provisioning input differs from its frozen receipt',
    );
  return value;
}
export async function freezeReceipt(env: Env, request: Json, source: Json) {
  await env.OBJECTS.put(receiptKey(request.repo_id), canonical({ version: 1, request, source }), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  const receipt = await readReceipt(env, request);
  if (!receipt) throw setupError('SETUP_FAILED', 'Provisioning receipt unavailable');
  return receipt;
}
