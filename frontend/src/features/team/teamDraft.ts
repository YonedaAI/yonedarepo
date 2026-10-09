import type { RunMode, TeamPlan } from '../../../../shared/team';
import type { AgentDraft } from '../exploration/agentLimits';

export interface TeamTaskDraft {
  id: string;
  title: string;
  instructions: string;
  agentId: string;
  dependsOn: string[];
  writePaths: string;
}
export interface TeamDraft {
  contract: string;
  integratorId: string;
  integrationPaths: string;
  tasks: TeamTaskDraft[];
}
export const pathsFromText = (value: string) =>
  value
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
export function seedTeam(agents: AgentDraft[]): TeamDraft {
  return {
    contract: '',
    integratorId: agents[0]?.id ?? '',
    integrationPaths: '',
    tasks: [
      {
        id: 'task-1',
        title: '',
        instructions: '',
        agentId: agents[0]?.id ?? '',
        dependsOn: [],
        writePaths: '',
      },
    ],
  };
}
export function removeTeamTask(team: TeamDraft, id: string): TeamDraft {
  return {
    ...team,
    tasks: team.tasks
      .filter((task) => task.id !== id)
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => dependency !== id),
      })),
  };
}
export function restoreTeam(plan: TeamPlan | undefined, agents: AgentDraft[]): TeamDraft {
  if (!plan) return seedTeam(agents);
  return {
    contract: plan.contract,
    integratorId: agents[plan.integrator_agent]?.id ?? '',
    integrationPaths: plan.integration_paths.join('\n'),
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      agentId: agents[task.agent]?.id ?? '',
      dependsOn: [...task.depends_on],
      writePaths: task.write_paths.join('\n'),
    })),
  };
}
/** Removal clears assignments; it must never shift a task onto a different agent. */
export function reconcileTeam(team: TeamDraft, agents: AgentDraft[]): TeamDraft {
  const ids = new Set(agents.map((agent) => agent.id));
  return {
    ...team,
    integratorId: ids.has(team.integratorId) ? team.integratorId : '',
    tasks: team.tasks.map((task) => ({
      ...task,
      agentId: ids.has(task.agentId) ? task.agentId : '',
    })),
  };
}
function validPath(path: string) {
  const file = path.endsWith('/') ? path.slice(0, -1) : path;
  return (
    file.length > 0 &&
    new TextEncoder().encode(file).length <= 512 &&
    !file.startsWith('/') &&
    !/[\\\0:]/.test(file) &&
    !file
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}
function overlaps(a: string, b: string) {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}
function validatePaths(paths: string[], label: string) {
  if (
    !paths.length ||
    paths.length > 32 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !validPath(path))
  )
    throw new Error(
      `Choose 1–32 unique safe relative file paths or directory prefixes for ${label}.`,
    );
}
export function serializeTeam(team: TeamDraft, agents: AgentDraft[]): TeamPlan {
  if (!agents.length) throw new Error('Choose at least one agent for this run.');
  if (!team.tasks.length) throw new Error('Add at least one worker task to the advanced plan.');
  if (!team.contract.trim()) throw new Error('Describe the shared interface contract.');
  if (new TextEncoder().encode(team.contract).length > 16384 || team.contract.includes('\0'))
    throw new Error('Keep the shared contract under 16,384 bytes and omit null characters.');
  if (team.tasks.length > 16) throw new Error('A team plan supports up to 16 worker tasks.');
  const integrator = agents.findIndex((agent) => agent.id === team.integratorId);
  if (integrator < 0) throw new Error('Choose the final integrator.');
  const taskIds = new Set(team.tasks.map((task) => task.id));
  if (taskIds.size !== team.tasks.length) throw new Error('Give every task a unique ID.');
  const tasks = team.tasks.map((task) => {
    const agent = agents.findIndex((item) => item.id === task.agentId);
    if (agent < 0) throw new Error(`Choose an agent for ${task.title || task.id}.`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(task.id) || task.id === 'integrate')
      throw new Error(
        'Task IDs must use letters, numbers, hyphens or underscores, and cannot be integrate.',
      );
    if (
      !task.title.trim() ||
      !task.instructions.trim() ||
      task.title.includes('\0') ||
      task.instructions.includes('\0')
    )
      throw new Error(`Add a title and instructions for ${task.id}.`);
    if (
      new TextEncoder().encode(task.title).length > 128 ||
      new TextEncoder().encode(task.instructions).length > 8192
    )
      throw new Error('Keep task titles under 128 bytes and instructions under 8,192 bytes.');
    const paths = pathsFromText(task.writePaths);
    validatePaths(paths, task.id);
    if (task.dependsOn.some((id) => id === task.id || !taskIds.has(id)))
      throw new Error(`Review the dependencies for ${task.id}.`);
    return {
      id: task.id,
      title: task.title.trim(),
      instructions: task.instructions.trim(),
      agent,
      depends_on: task.dependsOn,
      write_paths: paths,
    };
  });
  const assigned = new Set([integrator, ...tasks.map((task) => task.agent)]);
  if (assigned.size !== agents.length)
    throw new Error(
      'Assign every configured team agent to a task or final integration, or remove unused agents.',
    );
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++)
      if (tasks[i].write_paths.some((a) => tasks[j].write_paths.some((b) => overlaps(a, b))))
        throw new Error(
          'Worker tasks need disjoint write paths. Give shared files to the integrator.',
        );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Task dependencies contain a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.find((task) => task.id === id)?.depends_on ?? [])
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  const integrationPaths = pathsFromText(team.integrationPaths);
  validatePaths(integrationPaths, 'final integration');
  return {
    version: 1,
    contract: team.contract.trim(),
    integrator_agent: integrator,
    integration_paths: integrationPaths,
    tasks,
  };
}
export function runMode(value: unknown): RunMode {
  return value === 'collaborate' ? value : 'compare';
}
/** The automatic path must not validate or send hidden manual fields. */
export function teamSubmission(
  mode: RunMode,
  manual: boolean,
  team: TeamDraft,
  agents: AgentDraft[],
  automaticSupported: boolean,
): { team?: TeamPlan } {
  if (mode !== 'collaborate') return {};
  if (manual) return { team: serializeTeam(team, agents) };
  if (!automaticSupported)
    throw new Error(
      'Automatic team planning is unavailable on this deployment. Enable Advanced task plan or update the backend.',
    );
  return {};
}
