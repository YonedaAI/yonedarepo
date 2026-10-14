import { guidedProfileId, guidedProfileVersion } from '../../shared/guided-runs';
import { type GuidedEnv, guidedFailure, publishedGuidedProfile } from './guided-profile';
import { setupCode } from './project-remote';
import { sourceFingerprint } from './source-crypto';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export function isGuidedProject(value: Json | undefined): boolean {
  return (
    value?.profile_id === guidedProfileId &&
    value.version === guidedProfileVersion &&
    typeof value.policy_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.policy_digest) &&
    typeof value.test_bundle_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.test_bundle_digest) &&
    /^[a-f0-9]{40}$/.test(value.starter?.commit ?? '') &&
    /^[a-f0-9]{40}$/.test(value.starter?.tree ?? '')
  );
}

/** Existing request replays retain their original marker; other repositories cannot be adopted. */
export async function guidedProjectInput(
  env: GuidedEnv,
  owner: string,
  id: string,
  body: Json,
): Promise<Json> {
  if (
    body.guided_profile_id !== guidedProfileId ||
    body.source != null ||
    body.policy !== undefined
  )
    throw guidedFailure(
      'INVALID_INPUT',
      'Choose the fixed task-board profile without source or policy overrides.',
    );
  let existing: Json | null = null;
  try {
    existing = await workspace(env, owner, { op: 'project_get', id });
  } catch (failure) {
    if (setupCode(failure) !== 'NOT_FOUND') throw failure;
  }
  if (existing) {
    if (existing.status === 'deleted')
      throw guidedFailure('REPOSITORY_DELETED', 'This guided project was deleted.');
    if (
      !isGuidedProject(existing.guided_project) ||
      existing.name !== body.name ||
      existing.source != null ||
      (await sourceFingerprint(existing.policy)) !== existing.guided_project.policy_digest
    )
      throw guidedFailure(
        'IDEMPOTENCY_CONFLICT',
        'This request belongs to another project or profile.',
      );
    return { source: null, policy: existing.policy, _guided_project: existing.guided_project };
  }
  // Both local authority and remote target must be new. A same-request retry is
  // allowed only after its durable workspace reservation has been recorded.
  try {
    await ledger(env, id, { op: 'repository_status' });
    throw guidedFailure('IDEMPOTENCY_CONFLICT', 'Guided setup requires a fresh repository.');
  } catch (failure) {
    if (setupCode(failure) !== 'NOT_FOUND') throw failure;
  }
  try {
    using target = await env.ARTIFACTS.get(id);
    await target.info();
    throw guidedFailure(
      'IDEMPOTENCY_CONFLICT',
      'Guided setup cannot reuse an existing source repository.',
    );
  } catch (failure) {
    if (setupCode(failure) !== 'NOT_FOUND') throw failure;
  }
  const profile = await publishedGuidedProfile(env);
  return {
    source: null,
    policy: profile.policy,
    _guided_project: {
      profile_id: profile.profile_id,
      version: profile.version,
      starter: profile.starter,
      policy_digest: await sourceFingerprint(profile.policy),
      test_bundle_digest: profile.policy.build.test_bundle.digest,
    },
  };
}

export async function guidedProvisionEnvironment(env: Env, project: Json): Promise<Env> {
  const marker = project.guided_project;
  if (!marker) return env;
  if (
    !isGuidedProject(marker) ||
    project.source != null ||
    (await sourceFingerprint(project.policy)) !== marker.policy_digest
  )
    throw guidedFailure(
      'GUIDED_PROFILE_UNAVAILABLE',
      'The fixed guided project configuration changed.',
    );
  const [namespace, name, extra] = String(marker.starter.repository).split('/');
  if (namespace !== env.ARTIFACTS_NAMESPACE || extra || !/^[A-Za-z0-9_.-]{1,100}$/.test(name ?? ''))
    throw guidedFailure(
      'GUIDED_PROFILE_UNAVAILABLE',
      'The guided starter is outside this workspace service.',
    );
  using starter = await env.ARTIFACTS.get(name);
  const info = await starter.info();
  const head = (await starter.log({ ref: marker.starter.branch, limit: 1 }))[0]?.hash;
  const actual = await starter.readCommit(marker.starter.commit);
  if (
    info.name !== name ||
    info.defaultBranch !== marker.starter.branch ||
    head !== marker.starter.commit ||
    !actual ||
    actual.hash !== marker.starter.commit ||
    actual.treeHash !== marker.starter.tree ||
    !Array.isArray(actual.parents) ||
    actual.parents.length !== 0
  )
    throw guidedFailure('GUIDED_PROFILE_UNAVAILABLE', 'The immutable guided starter changed.');
  return { ...env, STARTER_REPO: name };
}

export async function assertGuidedFork(remote: ArtifactsRepo, project: Json) {
  const marker = project.guided_project;
  if (!marker) return;
  const info = await remote.info();
  const head = (await remote.log({ ref: marker.starter.branch, limit: 1 }))[0]?.hash;
  const actual = await remote.readCommit(marker.starter.commit);
  if (
    info.name !== project.id ||
    info.source !== `artifacts:${marker.starter.repository}` ||
    info.readOnly !== false ||
    info.defaultBranch !== marker.starter.branch ||
    head !== marker.starter.commit ||
    !actual ||
    actual.hash !== marker.starter.commit ||
    actual.treeHash !== marker.starter.tree ||
    !Array.isArray(actual.parents) ||
    actual.parents.length !== 0
  )
    throw guidedFailure('IDEMPOTENCY_CONFLICT', 'The target is not the fresh guided starter fork.');
}
