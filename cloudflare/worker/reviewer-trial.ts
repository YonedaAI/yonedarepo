import { checkLedger } from './runtime';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** Fixed reviewer approval: no caller-supplied prompts, models, scopes or spend. */
export function trialRequest(id: string) {
  return {
    id,
    workspace_transport: 'git-native-v1',
    mode: 'collaborate',
    intent:
      'Build an accessible San Jose cycling trail guide together, with trail data and a bilingual English/Spanish interface.',
    criteria: [
      'No account, location or personal data collection',
      'Keyboard accessible trail filtering',
      'Trail data from public/js/trails.js renders in public/index.html',
      'English and Spanish labels',
    ],
    agents: [
      {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        connection: 'reviewer-codex',
        strategy: 'Trail data and filtering module',
      },
      {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        connection: 'reviewer-claude-sonnet-5-5',
        strategy: 'Bilingual accessible interface',
      },
    ],
    model_budgets: [
      {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        max_requests: 48,
        max_output_tokens: 4096,
        max_execution_ms: 600000,
        spend_limit_microusd: 200000,
        pricing: {
          input_microusd_per_million: 250000,
          output_microusd_per_million: 1200000,
          source: 'owner-approved conservative rates',
        },
      },
      {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        max_requests: 24,
        max_output_tokens: 4096,
        max_execution_ms: 600000,
        spend_limit_microusd: 4800000,
        pricing: {
          input_microusd_per_million: 4000000,
          output_microusd_per_million: 10000000,
          source: 'owner-approved conservative rates',
        },
      },
    ],
    team: {
      version: 1,
      contract:
        'public/js/trails.js exposes window.Trails with trails and filter({query}). Every trail has id, name, lengthMiles, difficulty. public/index.html loads this script and consumes the contract. No dependencies, tracking, forms collecting identity, or build-script changes.',
      integrator_agent: 0,
      integration_paths: ['public/index.html'],
      tasks: [
        {
          id: 'trail-data',
          title: 'Trail data and filtering module',
          agent: 0,
          depends_on: [],
          write_paths: ['public/js/trails.js'],
          instructions:
            'Create dependency-free UMD browser module window.Trails with a small clearly labelled illustrative San Jose trail dataset and filter({query}) function. All implementation in public/js/trails.js. Run node public/js/trails.js; publish findings and handoff describing the interface. Do not modify other files.',
        },
        {
          id: 'bilingual-ui',
          title: 'Bilingual accessible interface',
          agent: 1,
          depends_on: [],
          write_paths: ['public/index.html'],
          instructions:
            'Build polished accessible bilingual English/Spanish trail-guide interface in public/index.html only, using inline CSS and JS. Load public/js/trails.js and consume window.Trails.trails and window.Trails.filter({query}); fields id,name,lengthMiles,difficulty. Keyboard-accessible search and language switch. Dataset is illustrative, not verified travel advice. Publish findings and handoff. Do not modify other files.',
        },
      ],
    },
  };
}
/** Release a finished trial without refunding spend or deleting its evidence. */
export async function reviewerTrialStatus(env: Env, owner: string) {
  let policy = await workspace(env, owner, { op: 'reviewer_status' });
  const repo = policy.repo_id;
  if (policy.active_trial) {
    const detail = await runDetailIfPresent(env, repo, owner, policy.active_trial);
    const run = detail?.runs?.find((r: Json) => r.id === policy.active_trial);
    const active =
      detail?.executions?.some(
        (e: Json) =>
          e.run_id === policy.active_trial &&
          ['queued', 'running', 'capturing', 'evaluating'].includes(e.status),
      ) ?? false;
    const terminal = ['ready', 'failed', 'cancelled', 'accepted'].includes(run?.status);
    if (run && policy._active_trial_status === 'repair_pending' && (!terminal || active)) {
      await workspace(env, owner, {
        op: 'reviewer_trial_repair_finish',
        id: policy.active_trial,
        request_id: policy._active_repair_request_id,
        fingerprint: policy._active_repair_fingerprint,
      }).catch(() => undefined);
    } else if (run && terminal && !active) {
      await workspace(env, owner, {
        op: 'reviewer_trial_complete',
        id: policy.active_trial,
        expected_epoch: policy.trial_epoch ?? 0,
      });
      policy = await workspace(env, owner, { op: 'reviewer_status' });
    }
  }
  delete policy._active_trial_status;
  delete policy._active_repair_request_id;
  delete policy._active_repair_fingerprint;
  return policy;
}

export async function reviewerRepairFingerprint(input: Json) {
  const keys = [
    'request_id',
    'expected_commit',
    'expected_version',
    'run_id',
    'expected_plan_revision',
    'task_ids',
    'expected_task_revisions',
    'owner_brief',
  ];
  const normalized = Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  );
  return sha(JSON.stringify(normalized));
}

export async function finishReviewerRepair(
  env: Env,
  owner: string,
  id: string,
  requestId: string,
  fingerprint: string,
) {
  return workspace(env, owner, {
    op: 'reviewer_trial_repair_finish',
    id,
    request_id: requestId,
    fingerprint,
  });
}

export async function abortReviewerRepair(
  env: Env,
  owner: string,
  id: string,
  requestId: string,
  fingerprint: string,
) {
  return workspace(env, owner, {
    op: 'reviewer_trial_repair_abort',
    id,
    request_id: requestId,
    fingerprint,
  });
}

export async function submitReviewerRepair(
  env: Env,
  owner: string,
  repo: string,
  command: Json,
): Promise<Json> {
  const runId = command.run_id;
  const requestId = command.request_id;
  const fingerprint = await reviewerRepairFingerprint(command);
  try {
    const result = await ledger(env, repo, command);
    await finishReviewerRepair(env, owner, runId, requestId, fingerprint);
    return result;
  } catch (failure) {
    if ((failure as Error & { code?: string }).code)
      await abortReviewerRepair(env, owner, runId, requestId, fingerprint).catch(() => undefined);
    throw failure;
  }
}

export async function startTrial(env: Env, owner: string, requestId: string) {
  const policy = await reviewerTrialStatus(env, owner);
  const trial = await workspace(env, owner, { op: 'reviewer_trial', id: `reviewer-${requestId}` });
  return ensureTrialStarted(env, owner, policy.repo_id, trial.id);
}

/** Resume the durable reservation, even if start_run has not committed yet. */
export async function resumeTrial(env: Env, owner: string) {
  const policy = await workspace(env, owner, { op: 'reviewer_status' });
  if (!policy.active_trial)
    throw Object.assign(new Error('There is no reviewer trial to resume'), {
      code: 'NO_ACTIVE_TRIAL',
    });
  // Recheck access through the authoritative command and preserve the exact ID.
  // Never release a missing run: another same-ID start may still commit.
  const trial = await workspace(env, owner, { op: 'reviewer_trial', id: policy.active_trial });
  return ensureTrialStarted(env, owner, policy.repo_id, trial.id);
}

async function ensureTrialStarted(env: Env, owner: string, repo: string, id: string) {
  const repository = await ledger(env, repo, { op: 'repository_status', _workspace: owner });
  const existing = await runDetailIfPresent(env, repo, owner, id);
  if (!existing) {
    const approval = trialRequest(id);
    checkLedger({ capabilities: repository.capabilities }, approval);
    try {
      await ledger(env, repo, { ...approval, op: 'start_run', _workspace: owner });
    } catch (failure) {
      // A lost acknowledgement may have committed. Verify before reporting failure.
      if (!(await runDetailIfPresent(env, repo, owner, id))) throw failure;
    }
  }
  return {
    repo_id: repo,
    run_id: id,
    url: `/?repo=${encodeURIComponent(repo)}&run=${encodeURIComponent(id)}`,
  };
}

async function runDetailIfPresent(
  env: Env,
  repo: string,
  owner: string,
  id: string,
): Promise<Json | null> {
  try {
    return await ledger(env, repo, { op: 'run_detail', run_id: id, _workspace: owner });
  } catch (failure) {
    const error = failure as Error & { code?: string };
    if (error.code === 'NOT_FOUND' && error.message === `Unknown runs ${id}`) return null;
    throw failure;
  }
}
