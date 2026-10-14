import {
  type GuidedSession,
  guidedProfileId,
  guidedSteps,
  isGuidedProfileVersion,
  type StartGuidedStep,
} from '../../../../shared/guided-runs';
import { ApiError, api } from '../../lib/api';
import type { GuidedStartJournal } from './guidedStartJournal';
export type GuidedTransport = (path: string, body?: unknown) => Promise<unknown>;
const statuses = new Set(['ready', 'running', 'complete', 'needs_attention', 'locked']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown) =>
  value === undefined || value === null || typeof value === 'string';
export function readGuidedSession(value: unknown, expectedId?: string): GuidedSession {
  if (
    !record(value) ||
    value.profile_id !== guidedProfileId ||
    !isGuidedProfileVersion(value.version) ||
    typeof value.session_id !== 'string' ||
    !value.session_id ||
    (expectedId && value.session_id !== expectedId) ||
    !Array.isArray(value.steps) ||
    value.steps.length !== guidedSteps.length ||
    !optionalString(value.working_branch_id)
  )
    throw new Error('The guide response could not be verified. Refresh this project.');
  const ids = new Set(guidedSteps.map((step) => step.id));
  if (
    value.working_revision != null &&
    (!record(value.working_revision) ||
      typeof value.working_revision.repository !== 'string' ||
      typeof value.working_revision.commit !== 'string' ||
      !value.working_revision.commit)
  )
    throw new Error('The guide working revision could not be verified.');
  if (
    value.working_version !== undefined &&
    (!Number.isSafeInteger(value.working_version) || Number(value.working_version) < 0)
  )
    throw new Error('The guide working version could not be verified.');
  const observed = new Set<string>();
  for (const step of value.steps) {
    if (
      !record(step) ||
      !ids.has(step.id as (typeof guidedSteps)[number]['id']) ||
      typeof step.id !== 'string' ||
      observed.has(step.id) ||
      !statuses.has(String(step.status)) ||
      !Array.isArray(step.run_ids) ||
      !step.run_ids.every((id) => typeof id === 'string' && !!id) ||
      !Array.isArray(step.evidence) ||
      !optionalString(step.candidate_id) ||
      !optionalString(step.next_action) ||
      (step.attempt !== undefined &&
        (!Number.isSafeInteger(step.attempt) || Number(step.attempt) < 1)) ||
      (step.previous_run_ids !== undefined &&
        (!Array.isArray(step.previous_run_ids) ||
          !step.previous_run_ids.every((id) => typeof id === 'string' && !!id)))
    )
      throw new Error('The guide stage response could not be verified. Refresh this project.');
    if (
      step.revision != null &&
      (!record(step.revision) ||
        typeof step.revision.repository !== 'string' ||
        typeof step.revision.commit !== 'string')
    )
      throw new Error('The guide source revision could not be verified.');
    if (
      !step.evidence.every(
        (item) =>
          record(item) &&
          typeof item.kind === 'string' &&
          typeof item.label === 'string' &&
          typeof item.verified === 'boolean' &&
          optionalString(item.run_id) &&
          optionalString(item.candidate_id) &&
          optionalString(item.record_id) &&
          optionalString(item.revision),
      )
    )
      throw new Error('The guide evidence could not be verified.');
    observed.add(step.id);
  }
  if (value.next_step !== null && !ids.has(value.next_step as (typeof guidedSteps)[number]['id']))
    throw new Error('The next guide stage could not be verified.');
  return value as unknown as GuidedSession;
}
const uncertainMessage =
  'The start is unconfirmed. Refresh the guide to check existing work. No additional run will be submitted.';
/** `retryFrom` is the failed attempt a retry replaces; only a later attempt confirms it. */
export function createGuidedStepStart(
  repo: string,
  transport: GuidedTransport = api,
  journal?: GuidedStartJournal,
  retryFrom?: number,
) {
  let frozen: StartGuidedStep | undefined = journal?.read();
  let pending: Promise<GuidedSession> | undefined;
  let result: GuidedSession | undefined;
  let uncertain = !!frozen;
  const reconcile = async () => {
    if (!frozen) throw new Error('Choose a guide stage before checking its start.');
    const session = readGuidedSession(
      await transport(
        `repos/${encodeURIComponent(repo)}/guided_session?session_id=${encodeURIComponent(frozen.session_id)}`,
      ),
      frozen.session_id,
    );
    const stage = session.steps.find((step) => step.id === frozen?.step_id);
    const confirmed = frozen.retry
      ? (stage?.attempt ?? 1) > (retryFrom ?? 1)
      : stage &&
        stage.status !== 'ready' &&
        stage.status !== 'locked' &&
        (stage.run_ids.length || (stage.id === 'review' && !!stage.candidate_id));
    if (confirmed) {
      uncertain = false;
      journal?.clear();
      result = session;
      return session;
    }
    throw new Error(uncertainMessage);
  };
  return {
    get uncertain() {
      return uncertain;
    },
    reconcile,
    start(input: Omit<StartGuidedStep, 'request_id'>): Promise<GuidedSession> {
      if (pending) return pending;
      if (result) return Promise.resolve(result);
      if (uncertain) return reconcile();
      frozen ??= {
        request_id: crypto.randomUUID(),
        session_id: input.session_id,
        profile_id: guidedProfileId,
        step_id: input.step_id,
        expected_commit: input.expected_commit,
        expected_version: input.expected_version,
        ...(input.retry ? { retry: true as const } : {}),
      };
      try {
        journal?.save(frozen);
      } catch {
        throw new Error(
          'The guide start could not be saved in this browser. No work was submitted.',
        );
      }
      pending = (async () => {
        try {
          result = readGuidedSession(
            await transport(`repos/${encodeURIComponent(repo)}/start_guided_step`, frozen),
            frozen?.session_id,
          );
          journal?.clear();
          return result;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            ['REQUEST_TIMEOUT', 'ALREADY_EXISTS', 'REQUEST_FAILED'].includes(error.code)
          ) {
            uncertain = true;
            throw new Error(uncertainMessage);
          }
          frozen = undefined;
          journal?.clear();
          throw error;
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  };
}
