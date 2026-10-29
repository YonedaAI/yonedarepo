// The workspace's managed agents as the Agents pages read them (`/api/managed/workspaces/:ws`,
// shared/managed-agents.ts): card state, the settings form and the body it saves, model options
// with prices, history tiles, runs and billing figures. The managed Worker decides every
// request; this module only shapes what the pages print and send.
import {
  AGENT_MARGIN,
  type AgentSettings,
  type AgentState,
  type AgentUpdate,
  type BillingState,
  type CostEntry,
  HARNESS_LABELS,
  type Harness,
  harnessModels,
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type ManagedCredit,
  type ManagedRun,
  type ModelProvider,
  type RunStatus,
  type RunTile,
  type RunValue,
} from '../../../../shared/managed-agents';
import { SettingsError, validateOverrides } from '../../../../shared/managed-settings';

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

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  zai: 'Z.ai',
  mimo: 'Xiaomi MiMo',
};

/** What an overview card shows: off, or enabled with its newest result and run count. */
export function cardState(agent: Pick<AgentState, 'enabled_repos' | 'history' | 'runs'>) {
  return {
    enabled: agent.enabled_repos.length > 0,
    last: agent.history[0] ?? null,
    runs: agent.runs,
    repos: agent.enabled_repos.length,
  };
}

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

/** The harness choices, in a stable order. */
export const harnessOptions = () =>
  (Object.keys(HARNESS_LABELS) as Harness[]).map((h) => ({ value: h, label: HARNESS_LABELS[h] }));

/** `0.195`: a provider list rate per million tokens with the agent margin. */
export const priced = (usd: number) => Number((usd * AGENT_MARGIN).toFixed(6));

export interface ModelOption {
  /** `provider/model`, the select's value. */
  value: string;
  provider: ModelProvider;
  model: string;
  label: string;
  /** `GLM-5.3 Flash · Z.ai · $0.195 / $0.65 per million tokens`. */
  text: string;
}

export function modelOptions(harness: Harness): ModelOption[] {
  return harnessModels(harness).map((r) => ({
    value: `${r.provider}/${r.model}`,
    provider: r.provider,
    model: r.model,
    label: r.label,
    text: `${r.label} · ${PROVIDER_LABELS[r.provider]} · ${formatRate(priced(r.input))} in / ${formatRate(priced(r.output))} out per million tokens`,
  }));
}

/** `$0.195`, `$13`: every significant digit of a per-million rate. */
export function formatRate(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  return `$${Number(usd.toPrecision(6))}`;
}

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

const FIELD_LABELS: Record<keyof AgentSettings, string> = {
  name: 'name',
  description: 'description',
  harness: 'harness',
  provider: 'model',
  model: 'model',
  reasoning: 'reasoning',
  timeout_minutes: 'timeout',
  instructions: 'instructions',
  trigger: 'trigger',
  block_at: 'blocking level',
};
/** `model and instructions`: the customized fields as the maintained note names them. */
export function customizedText(fields: string[]): string {
  const names = [...new Set(fields.map((f) => FIELD_LABELS[f as keyof AgentSettings] ?? f))];
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The settings form's state. */
export interface AgentForm extends AgentSettings {
  repos: string[];
}

/** The form for an agent: its effective settings, and the repositories it runs on, or, the
 * first time it is enabled, every repository the caller owns here. */
export function initialForm(agent: AgentState, repos: { id: string }[]): AgentForm {
  return {
    ...agent.settings,
    trigger: { ...agent.settings.trigger },
    repos: agent.enabled_repos.length ? [...agent.enabled_repos] : repos.map((r) => r.id),
  };
}

/** A new custom agent's form: the Code review harness and model, no instructions. */
export function newAgentForm(repos: { id: string }[]): AgentForm {
  const base = MANAGED_AGENTS[0].defaults;
  return {
    ...base,
    name: '',
    description: '',
    instructions: '',
    trigger: { ...base.trigger },
    repos: repos.map((r) => r.id),
  };
}

/** Switching harness keeps the model when that harness runs it, else picks its first model. */
export function withHarness(form: AgentForm, harness: Harness): AgentForm {
  const options = modelOptions(harness);
  const keep = options.find((o) => o.provider === form.provider && o.model === form.model);
  const next = keep ?? options[0];
  return { ...form, harness, provider: next.provider, model: next.model };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SETTINGS_FIELDS: (keyof AgentSettings)[] = [
  'name',
  'description',
  'harness',
  'provider',
  'model',
  'reasoning',
  'timeout_minutes',
  'instructions',
  'trigger',
  'block_at',
];

/**
 * What saving the form sends: only fields that changed from the effective settings, with a
 * field set back to its maintained default sent as null (so it follows later updates), and
 * the repositories when they changed or the agent is enabled for the first time.
 */
export function updateBody(agent: AgentState, form: AgentForm): AgentUpdate {
  const settings: NonNullable<AgentUpdate['settings']> = {};
  for (const field of SETTINGS_FIELDS) {
    if (same(form[field], agent.settings[field])) continue;
    (settings as Record<string, unknown>)[field] = same(form[field], agent.defaults[field])
      ? null
      : form[field];
  }
  const body: AgentUpdate = {};
  if (Object.keys(settings).length) body.settings = settings;
  const first = agent.enabled_repos.length === 0;
  if (first || !same([...form.repos].sort(), [...agent.enabled_repos].sort()))
    body.repos = [...form.repos];
  return body;
}

/** The form's first problem (the server checks again), or '' when it looks valid. */
export function formProblem(agent: ManagedAgentDefinition, form: AgentForm): string {
  try {
    const patch: Record<string, unknown> = {};
    for (const field of SETTINGS_FIELDS) patch[field] = form[field];
    validateOverrides(agent, {}, patch);
  } catch (e) {
    if (e instanceof SettingsError) return e.message;
    throw e;
  }
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
 * enabled ones. */
export function visibleAgents<T extends AgentState>(
  agents: T[],
  query: string,
  enabledOnly: boolean,
) {
  const q = query.trim().toLowerCase();
  return agents.filter(
    (a) =>
      (!enabledOnly || a.enabled_repos.length > 0) &&
      (!q || a.settings.name.toLowerCase().includes(q) || a.pitch.toLowerCase().includes(q)),
  );
}
