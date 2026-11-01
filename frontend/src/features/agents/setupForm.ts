// The set-up page's form: only when an agent runs, the level that blocks landing, on which
// repositories, and whether it is active (YonedaRepo maintains the rest), the body saving it
// sends, and its early checks.
import type {
  AgentState,
  AgentUpdate,
  ManagedAgentDefinition,
  RunValue,
  Trigger,
} from '../../../../shared/managed-agents';
import { SettingsError, validateOverrides } from '../../../../shared/managed-settings';

/** The set-up form's state: only what a workspace decides. YonedaRepo maintains the rest. */
export interface AgentForm {
  trigger: Trigger;
  /** For a level agent: the level that fails its check (null: it reports only). */
  block_at: RunValue | null;
  /** Run on every repository the workspace owns, new ones included (instead of `repos`). */
  all_repos: boolean;
  repos: string[];
  /** Runs or is paused; a first set-up starts active. */
  active: boolean;
}

/** The form for an agent: when it runs and where. At its first set-up nothing is chosen, since
 * an agent spends credit wherever it runs; with no repositories to choose from, it joins those
 * to come, which the page says. */
export function initialForm(agent: AgentState, repos: { id: string }[]): AgentForm {
  const first = agent.created_at === null;
  return {
    trigger: { ...agent.settings.trigger },
    block_at: agent.settings.block_at,
    all_repos: first ? repos.length === 0 : agent.all_repos,
    repos: first ? [] : [...agent.enabled_repos],
    active: first ? true : agent.active,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What saving the form sends: the trigger when it changed (null when it is back on the default,
 * so it follows later updates), a level agent's blocking level when it changed, all repositories
 * or the chosen ones when that changed or at the first set-up, and Active. Never a field
 * YonedaRepo maintains.
 */
export function updateBody(agent: AgentState, form: AgentForm): AgentUpdate {
  const body: AgentUpdate = {};
  const settings: NonNullable<AgentUpdate['settings']> = {};
  if (!same(form.trigger, agent.settings.trigger))
    settings.trigger = same(form.trigger, agent.defaults.trigger) ? null : form.trigger;
  if (agent.value_type === 'level' && form.block_at !== agent.settings.block_at)
    settings.block_at = form.block_at;
  if (Object.keys(settings).length > 0) body.settings = settings;
  const first = agent.created_at === null;
  if (form.all_repos) {
    if (first || !agent.all_repos) body.all_repos = true;
  } else if (
    first ||
    agent.all_repos ||
    !same([...form.repos].sort(), [...agent.enabled_repos].sort())
  )
    body.repos = [...form.repos];
  if (first || form.active !== agent.active) body.active = form.active;
  return body;
}

/** No repository chosen: where a set-up starts, so a hint and never an error. */
export const NO_REPO_CHOSEN = 'Choose at least one repository, or all repositories.';

/** The form's first problem (the server checks again), or '' when it can be saved. */
export function formProblem(agent: ManagedAgentDefinition, form: AgentForm): string {
  try {
    validateOverrides(agent, {}, { trigger: form.trigger, block_at: form.block_at });
  } catch (e) {
    if (e instanceof SettingsError) return e.message;
    throw e;
  }
  if (!form.all_repos && form.repos.length === 0) return NO_REPO_CHOSEN;
  return '';
}

/** Repositories whose name or id contains `query` (case-insensitive). */
export function filterRepos<T extends { id: string; name: string }>(repos: T[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q)) : repos;
}

/** Paths or branches typed one per line or comma-separated. */
export const parseFilters = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
