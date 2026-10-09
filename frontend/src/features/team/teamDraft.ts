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
    contract:
      'Search exports filterEvents(events, query, now) from public/search.mjs. RSVP exports rsvp(event, identity, storage) from public/rsvp.mjs. Both modules preserve existing data and remain independent. The integrator connects both modules to the existing UI and checks the complete journey.',
    integratorId: agents[2]?.id ?? '',
    integrationPaths: 'public/index.html\npublic/styles.css',
    tasks: [
      {
        id: 'event-search',
        title: 'Event search',
        instructions:
          'Implement accessible event filtering, including clear empty results. Follow the shared API contract.',
        agentId: agents[0]?.id ?? '',
        dependsOn: [],
        writePaths: 'public/search.mjs',
      },
      {
        id: 'event-rsvp',
        title: 'RSVP flow',
        instructions:
          'Implement RSVP validation and clear confirmation, preserving privacy and capacity rules. Follow the shared API contract.',
        agentId: agents[1]?.id ?? '',
        dependsOn: [],
        writePaths: 'public/rsvp.mjs',
      },
    ],
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
  if (agents.length < 3)
    throw new Error(
      'Build together needs at least two specialist agents and a separate integrator.',
    );
  if (!team.contract.trim()) throw new Error('Describe the shared interface contract.');
  if (new TextEncoder().encode(team.contract).length > 16384 || team.contract.includes('\0'))
    throw new Error('Keep the shared contract under 16,384 bytes and omit null characters.');
  if (team.tasks.length < 2 || team.tasks.length > 16)
    throw new Error('A team plan needs 2–16 complementary worker tasks.');
  const integrator = agents.findIndex((agent) => agent.id === team.integratorId);
  if (integrator < 0) throw new Error('Choose the final integrator.');
  const taskIds = new Set(team.tasks.map((task) => task.id));
  if (taskIds.size !== team.tasks.length) throw new Error('Give every task a unique ID.');
  const tasks = team.tasks.map((task) => {
    const agent = agents.findIndex((item) => item.id === task.agentId);
    if (agent < 0) throw new Error(`Choose an agent for ${task.title || task.id}.`);
    if (agent === integrator)
      throw new Error(
        'Assign worker tasks to specialist agents, separate from the final integrator.',
      );
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
