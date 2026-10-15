import type { GuidedStep } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';

/** What the panel may know about a step's runs from the repository snapshot. */
export type GuidedRunFacts = {
  variant?: string;
  status?: string;
  failedTask?: string;
  /** A failed agent in a run that has not ended yet, with its recorded error. */
  blocked?: string;
  /** Whether any agent or job of the run is still queued or working. */
  active?: boolean;
  /** When the run's first agent started (epoch ms). */
  startedAt?: number;
  /** Agents working right now, by their recorded role or strategy. */
  working?: string[];
  /** The run's newest captured result failed its required checks. */
  checksFailed?: boolean;
};
export type GuidedStepLink = { runId: string; label: string; candidate?: string; primary: boolean };

const failedStatuses = ['failed', 'cancelled'];

export function guidedRunFacts(snapshot: Snapshot): Record<string, GuidedRunFacts> {
  const facts: Record<string, GuidedRunFacts> = {};
  for (const run of snapshot.runs) {
    const failedTask = (snapshot.team_tasks ?? []).find(
      (task) => task.run_id === run.id && task.status === 'failed',
    )?.title;
    const executions = (snapshot.executions ?? []).filter((item) => item.run_id === run.id);
    const failedAgent = executions.find((item) => item.status === 'failed');
    const firstLine = String(failedAgent?.error ?? '')
      .split('\n')[0]
      .slice(0, 200);
    facts[run.id] = {
      variant: typeof run.guided?.variant === 'string' ? run.guided.variant : undefined,
      status: typeof run.status === 'string' ? run.status : undefined,
      failedTask: typeof failedTask === 'string' ? failedTask : undefined,
      startedAt:
        executions
          .map((item) => Number(item.started_at))
          .filter((at) => Number.isFinite(at) && at > 0)
          .sort((a, b) => a - b)[0] ??
        (Number.isFinite(Number(run.created_at)) ? Number(run.created_at) : undefined),
      working: executions
        .filter((item) => item.status === 'running')
        .map((item) => String(item.team_role ?? item.strategy ?? 'agent')),
      checksFailed:
        (snapshot.candidates ?? []).filter((item) => item.run_id === run.id).at(-1)?.status ===
        'rejected',
      blocked: failedAgent
        ? `${failedAgent.strategy ?? failedAgent.team_role ?? 'An agent'}${firstLine ? `: ${firstLine}` : ''}`
        : undefined,
      active:
        executions.some((item) => ['queued', 'starting', 'running'].includes(item.status)) ||
        ((snapshot as { jobs?: Record<string, any>[] }).jobs ?? []).some(
          (job) => job.run_id === run.id && ['queued', 'running', 'deferred'].includes(job.status),
        ),
    };
  }
  return facts;
}

const variantNames: Record<string, string> = { filter: 'filter', sort: 'sort' };
function runName(facts: Record<string, GuidedRunFacts>, runIds: string[], runId: string) {
  const variant = variantNames[facts[runId]?.variant ?? ''];
  return variant ? `${variant} run` : `run ${runIds.indexOf(runId) + 1}`;
}
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Outcome-named links for a step: one primary action, then one link per concurrent run. */
export function guidedStepLinks(
  step: GuidedStep,
  facts: Record<string, GuidedRunFacts>,
): GuidedStepLink[] {
  const last = step.run_ids.at(-1);
  if (!last) return [];
  const failed = step.run_ids.find((id) => failedStatuses.includes(facts[id]?.status ?? ''));
  const links: GuidedStepLink[] =
    step.status === 'complete'
      ? [
          {
            runId: last,
            label: 'View result',
            candidate: step.candidate_id ?? undefined,
            primary: true,
          },
        ]
      : [{ runId: failed ?? last, label: 'Open run', primary: true }];
  if (step.id === 'concurrent' && step.run_ids.length > 1)
    for (const id of step.run_ids)
      links.push({
        runId: id,
        label: capitalize(runName(facts, step.run_ids, id)),
        primary: false,
      });
  return links;
}

/** One plain sentence on why a step needs attention, from recorded run status and evidence. */
export function guidedStepReason(step: GuidedStep, facts: Record<string, GuidedRunFacts>) {
  if (step.status !== 'needs_attention') return '';
  const rejection = step.evidence.find((item) => item.kind === 'owner_rejection');
  if (rejection)
    return `You rejected the reconciled result${rejection.reason ? `: “${rejection.reason}”` : ''}. Retry the concurrent changes to start again from the checked extend result; the rejected result stays in history.`;
  const failed = step.run_ids.filter((id) => failedStatuses.includes(facts[id]?.status ?? ''));
  const during = (id: string) => (facts[id]?.failedTask ? ` during “${facts[id].failedTask}”` : '');
  if (failed.length) {
    const finished = step.run_ids.filter(
      (id) => !failed.includes(id) && facts[id]?.status && facts[id].status !== 'running',
    );
    const failures = failed
      .map((id) => `the ${runName(facts, step.run_ids, id)} ${facts[id]?.status}${during(id)}`)
      .join(' and ');
    return finished.length
      ? `${capitalize(finished.map((id) => runName(facts, step.run_ids, id).replace(/ run$/, '')).join(' and '))} finished; ${failures}.`
      : `${capitalize(failures)}.`;
  }
  if (step.evidence.some((item) => item.kind.includes('resolution') && !item.verified))
    return 'Waiting for both runs to be reconciled and re-checked.';
  if (step.evidence.some((item) => !item.verified))
    return 'Some recorded evidence is not verified yet. Open the run to see which checks are missing.';
  return 'This step did not complete. Open the run to see what stopped it.';
}

/** The retry button names what it restarts; a rejected reconciliation retries both concurrent runs. */
export function guidedRetryLabel(step: GuidedStep) {
  return step.id === 'concurrent' && step.evidence.some((item) => item.kind === 'owner_rejection')
    ? 'Retry concurrent changes'
    : 'Retry this step';
}

/**
 * A running step whose run has a failed agent shows that block immediately. It is `stuck` when no
 * agent or job of the step is still working, so nothing will move it forward on its own.
 */
export function guidedStepBlock(step: GuidedStep, facts: Record<string, GuidedRunFacts>) {
  if (step.status !== 'running') return null;
  const blocked = step.run_ids.filter((id) => facts[id]?.blocked || facts[id]?.checksFailed);
  if (!blocked.length) return null;
  const stuck = step.run_ids.every((id) => !facts[id]?.active);
  return {
    message: blocked
      .map((id) => {
        const name = capitalize(runName(facts, step.run_ids, id));
        if (facts[id]?.blocked) return `${name} is blocked. ${facts[id]?.blocked}`;
        return stuck
          ? `${name}: its result failed a required check.`
          : `${name}: its result failed a required check; the coordinator is repairing it.`;
      })
      .join(' '),
    stuck,
  };
}

const roleNames: Record<string, string> = {
  worker: 'specialist',
  integrator: 'integrator',
  coordinator: 'coordinator',
  planner: 'planner',
};

/** Elapsed time of a running step and who is working now, e.g. "Running 6 min 12 s · now: integrator". */
export function guidedStepProgress(
  step: GuidedStep,
  facts: Record<string, GuidedRunFacts>,
  now: number,
) {
  if (step.status !== 'running') return '';
  const started = step.run_ids
    .map((id) => facts[id]?.startedAt)
    .filter((at): at is number => typeof at === 'number')
    .sort((a, b) => a - b)[0];
  if (started === undefined) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const elapsed = `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const working = [
    ...new Set(
      step.run_ids.flatMap((id) => facts[id]?.working ?? []).map((role) => roleNames[role] ?? role),
    ),
  ];
  return `Running ${elapsed}${working.length ? ` · now: ${working.join(', ')}` : ''}`;
}
