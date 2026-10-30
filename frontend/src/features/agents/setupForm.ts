// The set-up page's form: only when an agent runs, on which repositories, and whether it is
// active (YonedaRepo maintains the rest), the body saving it sends, and its early checks.
import type {
  AgentState,
  AgentUpdate,
  ManagedAgentDefinition,
  Trigger,
} from '../../../../shared/managed-agents';
import { SettingsError, validateOverrides } from '../../../../shared/managed-settings';

/** The set-up form's state: only what a workspace decides. YonedaRepo maintains the rest. */
export interface AgentForm {
  trigger: Trigger;
  /** Run on every repository the workspace owns, new ones included (instead of `repos`). */
  all_repos: boolean;
  repos: string[];
  /** Runs or is paused; a first set-up starts active. */
  active: boolean;
}

/** The form for an agent: when it runs and where. At its first set-up every repository the
 * caller owns is chosen, or, with none yet, all repositories including new ones. */
export function initialForm(agent: AgentState, repos: { id: string }[]): AgentForm {
  const first = agent.created_at === null;
  return {
    trigger: { ...agent.settings.trigger },
    all_repos: first ? repos.length === 0 : agent.all_repos,
    repos: first ? repos.map((r) => r.id) : [...agent.enabled_repos],
    active: first ? true : agent.active,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What saving the form sends: the trigger when it changed (null when it is back on the default,
 * so it follows later updates), all repositories or the chosen ones when that changed or at the
 * first set-up, and Active. Never a field YonedaRepo maintains.
 */
export function updateBody(agent: AgentState, form: AgentForm): AgentUpdate {
  const body: AgentUpdate = {};
  if (!same(form.trigger, agent.settings.trigger))
    body.settings = { trigger: same(form.trigger, agent.defaults.trigger) ? null : form.trigger };
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

/** The form's first problem (the server checks again), or '' when it can be saved. */
export function formProblem(agent: ManagedAgentDefinition, form: AgentForm): string {
  try {
    validateOverrides(agent, {}, { trigger: form.trigger });
  } catch (e) {
    if (e instanceof SettingsError) return e.message;
    throw e;
  }
  if (!form.all_repos && form.repos.length === 0)
    return 'Choose at least one repository, or all repositories.';
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
