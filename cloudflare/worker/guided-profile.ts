import { type GuidedProfileVersion, guidedProfileId } from '../../shared/guided-runs';
import { safeId } from './http';
import { testBundle } from './test-bundle';
import type { Env, Json, Scope } from './types';

export type GuidedEnv = Env & {
  GUIDED_TASK_BOARD_STARTER_REPO?: string;
  GUIDED_TASK_BOARD_BUNDLE_DIGEST?: string;
  GUIDED_TASK_BOARD_V2_STARTER_REPO?: string;
  GUIDED_TASK_BOARD_V2_BUNDLE_DIGEST?: string;
};
export const guidedFailure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

/** The browser chooses a profile, never its checks, starter or oracle digest. */
export function guidedPolicy(digest: string): Json {
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw guidedFailure('GUIDED_PROFILE_UNAVAILABLE', 'The guided checks are not published yet.');
  return {
    version: guidedProfileId,
    suite: 'commands-v1',
    environment: 'linux-node24-rust1.94-v1',
    required_checks: ['guided-task-board'],
    build: {
      setup: [],
      checks: [
        {
          name: 'guided-task-board',
          argv: ['node', '/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs'],
          timeout_seconds: 30,
        },
      ],
      static_dir: 'public',
      test_bundle: {
        digest,
        protected_paths: ['README.md', '.yoneda-guided', 'fixtures/guided-task-board/oracle'],
      },
    },
  };
}

/** New projects use version 2 once both of its settings exist, otherwise version 1.
 * A half-configured version 2 fails closed instead of silently mixing versions. */
export function selectedGuidedProfile(env: GuidedEnv): {
  version: GuidedProfileVersion;
  starter?: string;
  digest?: string;
} {
  const v2 = [env.GUIDED_TASK_BOARD_V2_STARTER_REPO, env.GUIDED_TASK_BOARD_V2_BUNDLE_DIGEST];
  if (v2.every((value) => !value))
    return {
      version: 1,
      starter: env.GUIDED_TASK_BOARD_STARTER_REPO,
      digest: env.GUIDED_TASK_BOARD_BUNDLE_DIGEST,
    };
  if (v2.some((value) => !value))
    throw guidedFailure(
      'GUIDED_PROFILE_UNAVAILABLE',
      'The version 2 guided starter is only partly configured.',
    );
  return { version: 2, starter: v2[0], digest: v2[1] };
}

export async function publishedGuidedProfile(env: GuidedEnv) {
  const selected = selectedGuidedProfile(env);
  const name = selected.starter;
  if (!name || !safeId(name))
    throw guidedFailure('GUIDED_PROFILE_UNAVAILABLE', 'The guided starter is not published yet.');
  const policy = guidedPolicy(selected.digest ?? '');
  const scope: Scope = {
    repo_id: 'guided-profile',
    supervisor: '',
    model_calls: 0,
    created_at: Date.now(),
    job: { kind: 'evaluate', payload: { policy } },
  };
  try {
    const bundle = await testBundle(env, scope, policy.build.test_bundle.digest);
    for (const file of ['run.mjs', 'check.mjs', 'observe.mjs'])
      if (!bundle.files[`fixtures/guided-task-board/oracle/${file}`])
        throw new Error('Missing guided oracle');
    using starter = await env.ARTIFACTS.get(name);
    const info = await starter.info();
    const branch = info.defaultBranch;
    if (
      info.name !== name ||
      !branch ||
      branch.length > 255 ||
      [...branch].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
      /[~^:?*[\\]/.test(branch) ||
      branch.includes('..') ||
      branch.includes('@{') ||
      branch
        .split('/')
        .some(
          (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'),
        )
    )
      throw new Error('Invalid guided starter branch');
    const commit = (await starter.log({ ref: branch, limit: 1 }))[0]?.hash;
    const actual = commit ? await starter.readCommit(commit) : null;
    if (
      !actual ||
      actual.hash !== commit ||
      !/^[a-f0-9]{40}$/.test(commit ?? '') ||
      !/^[a-f0-9]{40}$/.test(actual.treeHash) ||
      !Array.isArray(actual.parents) ||
      actual.parents.length !== 0
    )
      throw new Error('Guided starter must have one initial commit');
    return {
      profile_id: guidedProfileId,
      version: selected.version,
      policy,
      starter: {
        repository: `${env.ARTIFACTS_NAMESPACE}/${name}`,
        branch,
        commit,
        tree: actual.treeHash,
      },
    };
  } catch {
    throw guidedFailure(
      'GUIDED_PROFILE_UNAVAILABLE',
      'The published guided starter or checks are unavailable.',
    );
  }
}
