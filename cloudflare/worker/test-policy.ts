import { readJson, response } from './http';
import { ledger, object } from './storage';
import { canonicalBundle, testBundle } from './test-bundle';
import type { Env, Json, Principal, Scope } from './types';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Owner-only upload and policy approval; the evaluator receives an immutable digest. */
export async function approveTestPolicy(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
) {
  const body = await readJson(req, 8 * 1024 * 1024);
  const current = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files))
    throw Object.assign(new Error('Supply the immutable test files'), { code: 'INVALID_INPUT' });
  const { encoded } = canonicalBundle(body.files);
  const { digest } = await object(env, encoded);
  const policy = structuredClone(body.policy);
  if (!policy?.build)
    throw Object.assign(new Error('Supply a build policy'), { code: 'INVALID_INPUT' });
  policy.build.setup ??= [];
  policy.build.test_bundle = { digest, protected_paths: body.protected_paths ?? [] };
  const validationScope: Scope = {
    repo_id: repo,
    supervisor: '',
    model_calls: 0,
    created_at: Date.now(),
    job: { kind: 'evaluate', payload: { policy } },
  };
  await testBundle(env, validationScope, digest);
  const input = body;
  if (
    current.head_commit === input.expected_commit &&
    current.version === input.expected_version &&
    current.pending == null &&
    canonical(current.policy) === canonical(policy)
  )
    return response({ digest, repository: current, already_approved: true });
  const repository = await ledger(env, repo, {
    op: 'update_policy',
    _workspace: principal.workspace,
    expected_commit: input.expected_commit,
    expected_version: input.expected_version,
    expected_policy: input.expected_policy,
    policy,
  });
  return response({ digest, repository });
}
