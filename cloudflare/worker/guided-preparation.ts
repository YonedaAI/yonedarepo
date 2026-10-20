import {
  type GuidedSession,
  type GuidedStepId,
  guidedIntents,
  guidedRunId,
  isGuidedProfileVersion,
} from '../../shared/guided-runs';
import { guidedFixedPlan, guidedModelMix, guidedPlanVersion } from './guided-plan';
import { guidedFailure } from './guided-profile';
import { approveOwnerRun } from './owner-run-approval';
import { sha } from './storage';
import type { Env, Json, Principal } from './types';

/** Guide v1: the ordinary planner defines specialist scopes. Guide v2: a fixed, validated
 * team plan replaces the planner. Both approve the guide model mix (specialists on Codex,
 * planning/integration/coordination on GLM) and fail before start if either is not connected.
 * An `attempt` above 1 prepares a retry whose run ids the native ledger suffixes identically. */
export async function prepareGuidedRuns(
  env: Env,
  principal: Principal,
  repo: string,
  session: GuidedSession,
  step: GuidedStepId,
  commit: string,
  version: number,
  attempt = 1,
): Promise<Json[]> {
  if (step === 'review') return [];
  // Each session keeps the briefs of the version its project was created with.
  if (!isGuidedProfileVersion(session.version))
    throw guidedFailure('GUIDED_VERSION_MISMATCH', 'Unknown guided profile version.');
  const briefs = guidedIntents(session.version);
  const intents =
    step === 'build'
      ? [briefs.build]
      : step === 'extend'
        ? [briefs.extend]
        : [...briefs.concurrent];
  const prefix = (await sha(session.session_id)).slice(0, 24);
  const approvals: Json[] = [];
  const contextInstructions =
    step === 'build'
      ? 'Publish the stable-identity design choice through context_publish as a proposed_decision with file_paths [public/tasks.mjs], explaining why replacing IDs during edits would lose references.'
      : 'Use context_get to open the relevant prior design choice from your assigned context, then cite its record ID in a context_publish link and explain how it influenced your implementation.';
  const fixed = Number(session.version) === guidedPlanVersion;
  // A retry after the owner rejected the result carries that feedback to the agents.
  const rejection = session.steps
    .find((entry) => entry.id === step)
    ?.evidence.find((evidence) => evidence.kind === 'owner_rejection');
  const ownerFeedback =
    attempt > 1 && typeof rejection?.reason === 'string' && rejection.reason.trim()
      ? ` The owner rejected the previous result with this feedback: “${rejection.reason.trim().slice(0, 1000)}”. Address it while keeping every feature working.`
      : '';
  for (const [ordinal, intent] of intents.entries()) {
    const entry = fixed ? guidedFixedPlan(step, ordinal) : undefined;
    const coordination = entry
      ? 'The platform supplies this run’s fixed team plan and shared contract. Implement only your assigned scope and start immediately in parallel; coordinate discrepancies through peer_message. The integrator waits for every captured specialist contribution before integration and independent checks.'
      : null;
    const input: Json = {
      id: guidedRunId(prefix, step, ordinal, attempt),
      intent: coordination
        ? `${intent}${ownerFeedback} ${contextInstructions} ${coordination}`
        : `${intent}${ownerFeedback} ${contextInstructions} Plan two independent specialist scopes: task behavior in public/tasks.mjs and the interface in public/index.html, public/app.mjs and public/style.css. Establish the shared API contract upfront using the exact function signatures in this brief. Start both specialists in parallel. Do not wait for the core capture before starting interface work; implement against the known contract and coordinate discrepancies through peer_message while both work. Record and capture the shared contract. The integrator must wait for both captured contributions before integration and independent checks.`,
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
        // The guided demo favours quick turns: every role thinks at low effort.
        requested_agents: entry
          ? entry.roles.map((role) => ({ connection: null, role, reasoning_effort: 'low' }))
          : [
              { connection: null, role: 'backend', reasoning_effort: 'low' },
              { connection: null, role: 'frontend', reasoning_effort: 'low' },
            ],
        model_mix: guidedModelMix,
      },
      ...(entry ? { team: entry.plan } : {}),
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
    // A concurrent retry restarts from the checked extend revision the ledger restores.
    const checkpoint =
      step === 'concurrent' && attempt > 1
        ? (session.steps.find((entry) => entry.id === 'extend')?.revision ?? undefined)
        : undefined;
    approvals.push(await approveOwnerRun(env, principal, repo, input, checkpoint));
  }
  return approvals;
}
