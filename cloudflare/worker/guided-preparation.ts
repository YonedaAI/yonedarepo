import {
  type GuidedSession,
  type GuidedStepId,
  guidedBuildIntent,
  guidedConcurrentIntents,
  guidedExtendIntent,
} from '../../shared/guided-runs';
import { guidedFailure } from './guided-profile';
import { approveOwnerRun } from './owner-run-approval';
import { sha } from './storage';
import type { Env, Json, Principal } from './types';

/** The ordinary planner defines independent specialist scopes and coordination;
 * saved connections, funding and compatibility use the normal owner approval. */
export async function prepareGuidedRuns(
  env: Env,
  principal: Principal,
  repo: string,
  session: GuidedSession,
  step: GuidedStepId,
  commit: string,
  version: number,
): Promise<Json[]> {
  if (step === 'review') return [];
  const intents =
    step === 'build'
      ? [guidedBuildIntent]
      : step === 'extend'
        ? [guidedExtendIntent]
        : [...guidedConcurrentIntents];
  const prefix = (await sha(session.session_id)).slice(0, 24);
  const approvals: Json[] = [];
  const contextInstructions =
    step === 'build'
      ? 'Publish the stable-identity design choice through context_publish as a proposed_decision with file_paths [public/tasks.mjs], explaining why replacing IDs during edits would lose references.'
      : 'Use context_get to open the relevant prior design choice from your assigned context, then cite its record ID in a context_publish link and explain how it influenced your implementation.';
  for (const [ordinal, intent] of intents.entries()) {
    const input: Json = {
      id: `guide-${prefix}-${step}-${ordinal}`,
      intent: `${intent} ${contextInstructions} Plan two independent specialist scopes: task behavior in public/tasks.mjs and the interface in public/index.html, public/app.mjs and public/style.css. Establish the shared API contract upfront using the exact function signatures in this brief. Start both specialists in parallel. Do not wait for the core capture before starting interface work; implement against the known contract and coordinate discrepancies through peer_message while both work. Record and capture the shared contract. The integrator must wait for both captured contributions before integration and independent checks.`,
      mode: 'collaborate',
      criteria: [
        'Preserve all earlier behavior',
        'Pass the immutable phase-specific independent checks',
        'Record decisions and coordinate the checked integration',
      ],
      context: session.steps.flatMap((entry) =>
        entry.evidence
          .filter((evidence) => evidence.verified && evidence.record_id)
          .map((evidence) => evidence.record_id),
      ),
      adaptive_team: {
        version: 1,
        requested_agents: [
          { connection: null, role: 'backend' },
          { connection: null, role: 'frontend' },
        ],
      },
    };
    if (step !== 'build') {
      if (
        !session.working_branch_id ||
        session.working_revision?.commit !== commit ||
        session.working_version !== version
      )
        throw guidedFailure('HEAD_MOVED', 'The checked guided branch changed; refresh the guide.');
      input.working_branch_id = session.working_branch_id;
      input.expected_working_commit = commit;
      input.expected_working_version = version;
    }
    approvals.push(await approveOwnerRun(env, principal, repo, input));
  }
  return approvals;
}
