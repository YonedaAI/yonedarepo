// An agent's effective settings: the maintained defaults, then the workspace's overrides, then
// a repository's. Only fields someone changed are stored, so a field nobody changed follows
// the defaults as YonedaRepo updates them. Overrides are validated here, for the managed
// Worker (authoritative) and the settings form (early feedback) alike.
import {
  type AgentSettings,
  HARNESS_PROVIDERS,
  type ManagedAgentDefinition,
  modelRate,
  type RunValue,
} from './managed-agents';

export type SettingsOverrides = Partial<AgentSettings>;

const FIELDS: readonly (keyof AgentSettings)[] = [
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
export const MAX_INSTRUCTIONS = 20_000;
export const TIMEOUT_RANGE = { min: 5, max: 30 } as const;
const MAX_FILTERS = 20;

export function resolveSettings(
  agent: ManagedAgentDefinition,
  ...layers: (SettingsOverrides | null | undefined)[]
): AgentSettings {
  const out: AgentSettings = { ...agent.defaults, trigger: { ...agent.defaults.trigger } };
  for (const layer of layers) {
    if (!layer) continue;
    for (const field of FIELDS) if (layer[field] !== undefined) (out as any)[field] = layer[field];
  }
  return out;
}

/** The fields `overrides` changes from the defaults (what the page marks customized). */
export const customizedFields = (overrides: SettingsOverrides | null | undefined) =>
  FIELDS.filter((f) => overrides?.[f] !== undefined);

export class SettingsError extends Error {}

const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new SettingsError(`${field} must be 1 to ${max} characters`);
  return value;
};
const filters = (value: unknown, field: string) => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FILTERS ||
    !value.every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !v.includes('..'),
    )
  )
    throw new SettingsError(`${field} must list at most ${MAX_FILTERS} paths or branch names`);
  return value as string[];
};

/**
 * Validates a patch against the agent and the settings it lands on, and answers the overrides
 * to store: a field equal to the default is dropped, so it follows later default updates.
 */
export function validateOverrides(
  agent: ManagedAgentDefinition,
  current: SettingsOverrides,
  patch: Record<string, unknown>,
): SettingsOverrides {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!FIELDS.includes(key as keyof AgentSettings))
      throw new SettingsError(`Unknown setting ${key}`);
    if (value === null && key !== 'block_at') delete next[key];
    else next[key] = value;
  }
  const s = resolveSettings(agent, next as SettingsOverrides);
  text(s.name, 'name', 80);
  text(s.description, 'description', 300);
  text(s.instructions, 'instructions', MAX_INSTRUCTIONS);
  if (!HARNESS_PROVIDERS[s.harness]?.includes(s.provider))
    throw new SettingsError(`${s.harness} cannot run ${s.provider} models`);
  if (!modelRate(s.provider, s.model))
    throw new SettingsError(`${s.model} has no rate; pick a listed model`);
  if (!['low', 'medium', 'high'].includes(s.reasoning))
    throw new SettingsError('reasoning must be low, medium or high');
  if (
    !Number.isInteger(s.timeout_minutes) ||
    s.timeout_minutes < TIMEOUT_RANGE.min ||
    s.timeout_minutes > TIMEOUT_RANGE.max
  )
    throw new SettingsError(`timeout_minutes must be ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}`);
  const t = s.trigger as unknown as Record<string, unknown>;
  if (!t || (t.when !== 'push' && t.when !== 'ready') || t.changes !== 'ready_for_review')
    throw new SettingsError('trigger.when must be push or ready');
  filters(t.paths, 'trigger.paths');
  filters(t.branches, 'trigger.branches');
  const levels: (RunValue | null)[] = [null, 'medium', 'high'];
  if (agent.value_type === 'level' ? !levels.includes(s.block_at) : s.block_at !== null)
    throw new SettingsError(
      'block_at is medium, high or null, and only for low/medium/high agents',
    );
  const stored: SettingsOverrides = {};
  for (const field of FIELDS) {
    if (next[field] === undefined) continue;
    if (JSON.stringify(next[field]) === JSON.stringify(agent.defaults[field])) continue;
    (stored as any)[field] = next[field];
  }
  return stored;
}

/** Whether a change's paths and branch pass the trigger's filters. */
export function triggerMatches(trigger: AgentSettings['trigger'], branch: string, paths: string[]) {
  const branchOk =
    trigger.branches.length === 0 ||
    trigger.branches.some((b) =>
      b.endsWith('/*') ? branch.startsWith(b.slice(0, -1)) : b === branch,
    );
  const pathOk =
    trigger.paths.length === 0 ||
    paths.some((p) =>
      trigger.paths.some((prefix) => p === prefix || p.startsWith(prefix.replace(/\/?$/, '/'))),
    );
  return branchOk && pathOk;
}
