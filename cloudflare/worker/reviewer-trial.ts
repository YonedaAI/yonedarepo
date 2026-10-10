import { checkLedger } from './runtime';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** Fixed reviewer approval: no caller-supplied prompts, models, scopes or spend. */
export function trialRequest(id: string) {
  return {
    id,
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
        model: 'claude-sonnet-4-6',
        connection: 'reviewer-claude',
        strategy: 'Bilingual accessible interface',
      },
    ],
    model_budgets: [
      {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        max_requests: 24,
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
        model: 'claude-sonnet-4-6',
        max_requests: 24,
        max_output_tokens: 4096,
        max_execution_ms: 600000,
        spend_limit_microusd: 4800000,
        pricing: {
          input_microusd_per_million: 6000000,
          output_microusd_per_million: 30000000,
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
    const snapshot = await ledger(env, repo, { op: 'snapshot', _workspace: owner });
    const run = snapshot.runs.find((r: Json) => r.id === policy.active_trial);
    const active = snapshot.executions.some(
      (e: Json) =>
        e.run_id === policy.active_trial &&
        ['queued', 'running', 'capturing', 'evaluating'].includes(e.status),
    );
    if (run && !active && !['planning', 'integrating'].includes(run.status)) {
      await workspace(env, owner, { op: 'reviewer_trial_complete', id: policy.active_trial });
      policy = await workspace(env, owner, { op: 'reviewer_status' });
    }
  }
  return policy;
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
  const snapshot = await ledger(env, repo, { op: 'snapshot', _workspace: owner });
  const existing = snapshot.runs.find((r: Json) => r.id === id);
  if (!existing) {
    const approval = trialRequest(id);
    checkLedger(snapshot, approval);
    try {
      await ledger(env, repo, { ...approval, op: 'start_run', _workspace: owner });
    } catch (failure) {
      // A lost acknowledgement may have committed. Verify before reporting failure.
      const updated = await ledger(env, repo, { op: 'snapshot', _workspace: owner });
      if (!updated.runs.some((r: Json) => r.id === id)) throw failure;
    }
  }
  return {
    repo_id: repo,
    run_id: id,
    url: `/?repo=${encodeURIComponent(repo)}&run=${encodeURIComponent(id)}`,
  };
}
