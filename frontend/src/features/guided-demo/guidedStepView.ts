import type { GuidedStep } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';

/** What the panel may know about a step's runs from the repository snapshot. */
export type GuidedRunFacts = { variant?: string; status?: string; failedTask?: string };
export type GuidedStepLink = { runId: string; label: string; candidate?: string; primary: boolean };

const failedStatuses = ['failed', 'cancelled'];

export function guidedRunFacts(snapshot: Snapshot): Record<string, GuidedRunFacts> {
  const facts: Record<string, GuidedRunFacts> = {};
  for (const run of snapshot.runs) {
    const failedTask = (snapshot.team_tasks ?? []).find(
      (task) => task.run_id === run.id && task.status === 'failed',
    )?.title;
    facts[run.id] = {
      variant: typeof run.guided?.variant === 'string' ? run.guided.variant : undefined,
      status: typeof run.status === 'string' ? run.status : undefined,
      failedTask: typeof failedTask === 'string' ? failedTask : undefined,
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
