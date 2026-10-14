import {
  type GuidedSession,
  guidedProfileId,
  guidedSteps,
  type StartGuidedStep,
} from '../../shared/guided-runs';
import { sourceApprovalSelected } from './api-source-approval';
import { prepareGuidedRuns } from './guided-preparation';
import { guidedFailure } from './guided-profile';
import { isGuidedProject } from './guided-project';
import { readJson, response } from './http';
import { sourceFingerprint } from './source-crypto';
import { ledger, sha } from './storage';
import type { Env, Json, Principal } from './types';

export const guidedSessionId = async (repo: string) =>
  `guide-session:${(await sha(`${repo}\0${guidedProfileId}`)).slice(0, 40)}`;

function startInput(body: Json, sessionId: string): StartGuidedStep {
  const allowed = [
    'request_id',
    'session_id',
    'profile_id',
    'step_id',
    'expected_commit',
    'expected_version',
    'retry',
  ];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    body.session_id !== sessionId ||
    body.profile_id !== guidedProfileId ||
    !guidedSteps.some((step) => step.id === body.step_id) ||
    typeof body.request_id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(body.request_id) ||
    typeof body.expected_commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(body.expected_commit) ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 0 ||
    ('retry' in body && body.retry !== true)
  )
    throw guidedFailure(
      'INVALID_INPUT',
      'Supply the guide request identity and exact checked branch lease.',
    );
  return body as StartGuidedStep;
}

async function reply(env: Env, repo: string, repository: Json, session: Json) {
  const ready =
    (await sourceApprovalSelected(env, repo, repository)) &&
    repository.capabilities?.source_api === 1 &&
    !!env.SOURCES &&
    isGuidedProject(repository.guided_project) &&
    (await sourceFingerprint(repository.policy)) === repository.guided_project.policy_digest;
  return response({
    ...session,
    source_transport: ready ? 'api-source-v1' : 'git-native-v1',
    source_allowlisted: ready,
  });
}

/** Rust owns session progress, atomic starts and receipt replay. GET never starts work. */
export async function guidedRoute(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
  action: string,
): Promise<Response | null> {
  if (!['guided_session', 'start_guided_step'].includes(action)) return null;
  if (principal.role !== 'user')
    throw guidedFailure('FORBIDDEN', 'Use your normal workspace account for the guide.');
  if (req.method !== (action === 'guided_session' ? 'GET' : 'POST'))
    throw guidedFailure('NOT_FOUND', 'Unknown guided operation.');
  // Starting guided work spends operator-funded agents; reading a session stays available.
  if (action === 'start_guided_step' && principal.reviewer !== true)
    throw guidedFailure('FORBIDDEN', 'The guided demo is available to reviewer accounts only.');
  const repository = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  if (repository.capabilities?.guided_runs !== 1)
    throw guidedFailure('LEDGER_UPDATING', 'Guided workflow is updating; retry shortly.');
  if (!isGuidedProject(repository.guided_project))
    throw guidedFailure(
      'GUIDED_PROFILE_UNAVAILABLE',
      'This repository is not a freshly provisioned guided project.',
    );
  const sessionId = await guidedSessionId(repo);
  const read = () =>
    ledger(env, repo, { op: 'guided_session', id: sessionId, _workspace: principal.workspace });
  if (action === 'guided_session') return reply(env, repo, repository, await read());
  const input = startInput(await readJson(req, 16 * 1024), sessionId);
  const command = { ...input, op: 'start_guided_step', _workspace: principal.workspace };
  // Receipt replay must reach Rust before current-head/provider/spend approval.
  // A fresh start's empty approvals fail transactionally; no branch/job survives.
  try {
    return await reply(
      env,
      repo,
      repository,
      await ledger(env, repo, { ...command, _guided_runs: [] }),
    );
  } catch (failure) {
    if (
      (failure as { code?: string }).code !== 'INVALID_INPUT' ||
      (failure as Error).message !== 'Guided step needs its exact trusted run count'
    )
      throw failure;
  }
  if ((await sourceFingerprint(repository.policy)) !== repository.guided_project.policy_digest)
    throw guidedFailure('POLICY_CHANGED', 'The guided policy differs from its immutable profile.');
  const session = (await read()) as GuidedSession;
  // Native refused an ineligible retry above; a retry prepares the next attempt's run ids.
  const current = session.steps.find((step) => step.id === input.step_id)?.attempt ?? 1;
  const runs = await prepareGuidedRuns(
    env,
    principal,
    repo,
    session,
    input.step_id,
    input.expected_commit,
    input.expected_version,
    input.retry ? current + 1 : 1,
  );
  return reply(env, repo, repository, await ledger(env, repo, { ...command, _guided_runs: runs }));
}
