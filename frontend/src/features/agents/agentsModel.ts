// The workspace's managed agents as the Agents pages read them (`/api/managed/workspaces/:ws`,
// shared/managed-agents.ts): card state, history tiles, runs and billing figures (the set-up
// form is in ./setupForm). The managed Worker decides every request; this module only shapes
// what the pages print and send.
import {
  type AgentState,
  type BillingState,
  type CostEntry,
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type ManagedCredit,
  type ManagedRun,
  type RepoAgentRow,
  type RunNowResult,
  type RunStatus,
  type RunTile,
  type RunValue,
  type Trigger,
} from '../../../../shared/managed-agents';

const ws = (workspace: string) => `/workspaces/${encodeURIComponent(workspace)}`;
export const workspacePath = ws;
export const agentPath = (workspace: string, agent: string) =>
  `${ws(workspace)}/agents/${encodeURIComponent(agent)}`;
export function runsPath(
  workspace: string,
  filter: { agent?: string; repo?: string } = {},
  limit = 100,
) {
  const query = new URLSearchParams();
  if (filter.agent) query.set('agent', filter.agent);
  if (filter.repo) query.set('repo', filter.repo);
  query.set('limit', String(limit));
  return `${ws(workspace)}/runs?${query}`;
}
export const runPath = (workspace: string, repo: string, run: string) =>
  `${ws(workspace)}/runs/${encodeURIComponent(repo)}/${encodeURIComponent(run)}`;
export const billingPath = (workspace: string) => `${ws(workspace)}/billing`;
export const runNowPath = (workspace: string, agent: string) =>
  `${agentPath(workspace, agent)}/run`;
export const archivePath = (workspace: string, agent: string) =>
  `${agentPath(workspace, agent)}/archive`;
export const repoAgentsPath = (workspace: string, repo: string) =>
  `${ws(workspace)}/repos/${encodeURIComponent(repo)}/agents`;
export const syncPath = (workspace: string) => `${ws(workspace)}/sync`;

/**
 * Asks the managed Worker to connect repositories the workspace gained (for agents set to run
 * on all repositories), with the owner's session: after the web app creates or imports one, and
 * when the Agents page opens. Best effort: a workspace without agents, a non-owner (403) or a
 * deployment without managed agents (404) answers nothing worth showing. Answers how many
 * repositories it connected.
 */
export async function syncAgents(
  workspace: string | undefined,
  call: (path: string, init: { method: 'POST'; body: object }) => Promise<{ connected?: number }>,
): Promise<number> {
  if (!workspace) return 0;
  try {
    const answer = await call(syncPath(workspace), { method: 'POST', body: {} });
    return Number(answer?.connected ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** An agent's standing in the workspace: not set up (off), set up and paused, or active. */
export function agentStatus(
  agent: Pick<AgentState, 'created_at' | 'active'>,
): 'off' | 'paused' | 'active' {
  if (agent.created_at === null) return 'off';
  return agent.active ? 'active' : 'paused';
}
export const STATUS_BADGES = { active: 'Active', paused: 'Paused', off: 'Off' } as const;

/** What an overview card shows: not set up, or set up with its status, newest result and runs. */
export function cardState(
  agent: Pick<
    AgentState,
    'enabled_repos' | 'all_repos' | 'history' | 'runs' | 'created_at' | 'active'
  >,
) {
  return {
    configured: agent.created_at !== null,
    status: agentStatus(agent),
    last: agent.history[0] ?? null,
    runs: agent.runs,
    repos: reposText(agent),
  };
}

export type MenuAction = 'pause' | 'resume' | 'run' | 'configure' | 'create-own' | 'archive';
export interface MenuItem {
  action: MenuAction;
  label: string;
  disabled?: boolean;
  /** Why a disabled item is disabled. */
  hint?: string;
  danger?: boolean;
}

/** Why "Create your own" is not open yet: custom agents need billing, which is coming. */
export const CREATE_OWN_GATE = 'Set up billing to create your own agents';

/** A set-up agent's ⋮ menu: Pause or Resume, Run now (active only), Configure, Create your own
 * (shown, but closed until billing exists) and Archive. */
export function menuItems(agent: Pick<AgentState, 'created_at' | 'active'>): MenuItem[] {
  const status = agentStatus(agent);
  if (status === 'off') return [];
  return [
    status === 'active'
      ? { action: 'pause', label: 'Pause' }
      : { action: 'resume', label: 'Resume' },
    status === 'active'
      ? { action: 'run', label: 'Run now' }
      : { action: 'run', label: 'Run now', disabled: true, hint: 'Resume the agent to run it' },
    { action: 'configure', label: 'Configure' },
    { action: 'create-own', label: 'Create your own', disabled: true, hint: CREATE_OWN_GATE },
    { action: 'archive', label: 'Archive', danger: true },
  ];
}

/** `Started 2 reviews.` / `Every open change is already reviewed at its head.` */
export function runNowText(result: RunNowResult): string {
  if (result.started === 0)
    return result.already
      ? 'Every open change is already reviewed at its head.'
      : 'There is no open change to review.';
  const started = `Started ${result.started} review${result.started === 1 ? '' : 's'}`;
  return result.already ? `${started}; ${result.already} already reviewed.` : `${started}.`;
}

/** `2026-10-30 12:19 UTC`. */
export function formatUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `just now`, `5 minutes ago`, `3 hours ago`, `2 days ago`, then the UTC date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return plural(Math.floor(s / 60), 'minute');
  if (s < 86_400) return plural(Math.floor(s / 3600), 'hour');
  if (s < 30 * 86_400) return plural(Math.floor(s / 86_400), 'day');
  return new Date(ms).toISOString().slice(0, 10);
}

/** `Created by ada, 5 minutes ago`. */
export const createdText = (agent: Pick<AgentState, 'created_by' | 'created_at'>, now?: number) =>
  agent.created_at === null
    ? 'Not set up yet'
    : `Created by ${agent.created_by ?? 'someone'}, ${relativeTime(agent.created_at, now)}`;

/** How "Ready for review" decides (shared readyForReview). */
export const READY_HELP =
  'A change counts as ready for review while it is open, unless its title starts with Draft: or WIP:.';

/** `On every push` / `When marked ready`, then which changes and any filters. */
export function triggerText(trigger: Trigger): string {
  const when = trigger.when === 'push' ? 'On every push' : 'When marked ready';
  const filters = [
    trigger.paths.length ? `paths ${trigger.paths.join(', ')}` : '',
    trigger.branches.length ? `branches ${trigger.branches.join(', ')}` : '',
  ].filter(Boolean);
  return `${when}, changes ready for review${filters.length ? `, ${filters.join('; ')}` : ''}`;
}

/** What a result looks like on a change, for the set-up page's check preview. */
export function checkPreview(agent: Pick<ManagedAgentDefinition, 'check' | 'value_type'>) {
  return agent.value_type === 'pass_fail'
    ? [
        { tone: 'good' as Tone, text: `${agent.check}: pass`, note: 'No problem found' },
        {
          tone: 'bad' as Tone,
          text: `${agent.check}: fail`,
          note: '2 findings, commented on their lines',
        },
      ]
    : [
        { tone: 'good' as Tone, text: `${agent.check}: low`, note: 'Little to tidy' },
        { tone: 'warn' as Tone, text: `${agent.check}: medium`, note: '3 findings to look at' },
      ];
}

export const REPO_STATUS_LABELS: Record<RepoAgentRow['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  off: 'Not on this repository',
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** A result tile's colour: pass and low are good, medium attention, fail and high bad; a run
 * with no value yet (queued, paused, stopped) is neutral, a failed run bad. */
export function tileTone(tile: Pick<RunTile, 'value' | 'status'>): Tone {
  if (tile.value === 'pass' || tile.value === 'low') return 'good';
  if (tile.value === 'medium') return 'warn';
  if (tile.value === 'fail' || tile.value === 'high') return 'bad';
  return tile.status === 'failed' ? 'bad' : 'neutral';
}

const VALUE_LABELS: Record<RunValue, string> = {
  pass: 'Pass',
  fail: 'Fail',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
export const valueLabel = (value: RunValue | null) => (value ? VALUE_LABELS[value] : 'No result');

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  findings: 'Found issues',
  paused: 'Paused (no credit)',
  superseded: 'Replaced by a newer push',
  cancelled: 'Stopped',
  failed: 'Failed',
};
export const statusLabel = (status: RunStatus) => STATUS_LABELS[status] ?? status;

export const valueTypeLabel = (agent: Pick<ManagedAgentDefinition, 'value_type'>) =>
  agent.value_type === 'pass_fail' ? 'Pass or fail' : 'Low, medium or high';

/** `$0.0042`, `$1.25`, `$0.00`: cents for a dollar figure, two significant digits below a cent. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  return `$${usd.toFixed(2)}`;
}

/** `$0.42 used`. */
export const usedText = (credit: ManagedCredit) => `${formatCost(credit.used_usd)} used`;

/** How full the credit bar is, 0–100. */
export function creditPercent(credit: ManagedCredit): number {
  if (credit.granted_usd <= 0) return credit.used_usd > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((credit.used_usd / credit.granted_usd) * 100)));
}

/** `42 s`, `3 min 5 s`, `—` while a run has not finished. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
export const runDuration = (run: Pick<ManagedRun, 'created_at' | 'finished_at'>) =>
  formatDuration(run.finished_at === null ? null : run.finished_at - run.created_at);

/** One cost line: a model call (tokens) or the container's time. */
export function costLabel(entry: CostEntry): string {
  if (entry.input_tokens !== null || entry.output_tokens !== null)
    return `${entry.model ?? 'Model'} · ${entry.input_tokens ?? 0} in / ${entry.output_tokens ?? 0} out tokens`;
  return entry.note ?? 'Charge';
}
/** A charge's amount in USD (entries store negative micro-USD). */
export const costUsd = (entry: Pick<CostEntry, 'amount'>) => Math.abs(entry.amount) / 1_000_000;

/** Billing usage totals across repositories and agents. */
export function usageTotals(billing: Pick<BillingState, 'usage'>) {
  return billing.usage.reduce(
    (t, u) => ({ runs: t.runs + u.runs, cost_usd: t.cost_usd + u.cost_usd }),
    { runs: 0, cost_usd: 0 },
  );
}

export const agentName = (id: string) =>
  MANAGED_AGENTS.find((a) => a.id === id)?.defaults.name ?? id;

/** "All repositories, including new ones", as the page and detail name it. */
export const ALL_REPOS_LABEL = 'All repositories, including new ones';

/** Where an agent runs, in short: all repositories, or how many. */
export function reposText(agent: Pick<AgentState, 'all_repos' | 'enabled_repos'>): string {
  if (agent.all_repos) return 'All repositories';
  const n = agent.enabled_repos.length;
  return n ? `${n} repositor${n === 1 ? 'y' : 'ies'}` : 'No repository';
}

/** The workspaces the caller can manage agents for: their account, then each org they own. */
export function workspaceOptions(
  account: string | undefined,
  orgs: { org: string; role: string }[],
) {
  return [
    ...(account ? [{ value: account, label: `${account} (you)` }] : []),
    ...orgs
      .filter((o) => o.role === 'owner')
      .map((o) => o.org)
      .sort()
      .map((org) => ({ value: org, label: `${org} (organization)` })),
  ];
}

/** The overview's search and filter: agents whose name or pitch matches, optionally only
 * set-up ones. */
export function visibleAgents<T extends AgentState>(
  agents: T[],
  query: string,
  enabledOnly: boolean,
) {
  const q = query.trim().toLowerCase();
  return agents.filter(
    (a) =>
      (!enabledOnly || a.created_at !== null) &&
      (!q || a.settings.name.toLowerCase().includes(q) || a.pitch.toLowerCase().includes(q)),
  );
}
