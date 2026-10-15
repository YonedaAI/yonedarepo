import type { TeamPlan, TeamTaskPlan } from '../../../../shared/team';

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);
const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function isTask(value: unknown): value is TeamTaskPlan {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return (
    isText(task.id) &&
    isText(task.title) &&
    isText(task.instructions) &&
    isIndex(task.agent) &&
    isTextList(task.depends_on) &&
    isTextList(task.write_paths)
  );
}

/**
 * A recorded plan is history, not a contract with this browser build: an unreadable plan is
 * omitted so the brief stays editable instead of failing the whole page.
 */
export function readTeamPlan(value: unknown): TeamPlan | undefined {
  if (!value || typeof value !== 'object') return;
  const plan = value as Record<string, unknown>;
  if (
    !isText(plan.contract) ||
    !isIndex(plan.integrator_agent) ||
    !isTextList(plan.integration_paths) ||
    !Array.isArray(plan.tasks) ||
    !plan.tasks.every(isTask)
  )
    return;
  return {
    version: 1,
    contract: plan.contract,
    integrator_agent: plan.integrator_agent,
    integration_paths: [...plan.integration_paths],
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      agent: task.agent,
      depends_on: [...task.depends_on],
      write_paths: [...task.write_paths],
    })),
  };
}
