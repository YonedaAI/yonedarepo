// Maintained agent identities, runtime choices and configurable settings.
export type ManagedAgentId = 'code-review' | 'security-review' | 'slop-review' | 'intent-drift';
/** The stock CLI a run drives inside its container. */
export type Harness = 'claude-code' | 'codex' | 'opencode';
export type ModelProvider = 'claude' | 'codex' | 'zai' | 'mimo';
export type Reasoning = 'low' | 'medium' | 'high';
/** `pass_fail`: the check passes or fails. `level`: low, medium or high (lower is better). */
export type ValueType = 'pass_fail' | 'level';
export type RunValue = 'pass' | 'fail' | 'low' | 'medium' | 'high';

export interface ModelChoice {
  harness: Harness;
  provider: ModelProvider;
  model: string;
}

export interface Trigger {
  /** `push`: every push to a change's branch; `ready`: when the change is marked ready. */
  when: 'push' | 'ready';
  /** Which changes: `ready_for_review` (every open change, where approvals are not gated). */
  changes: 'ready_for_review';
  /** Path prefixes a change must touch; empty means any. */
  paths: string[];
  /** Branch names (or `prefix/*`) a change's branch must match; empty means any. */
  branches: string[];
}

/** The fields a workspace (or a repository) can change; anything unset follows the default. */
export interface AgentSettings {
  name: string;
  description: string;
  harness: Harness;
  provider: ModelProvider;
  model: string;
  reasoning: Reasoning;
  timeout_minutes: number;
  instructions: string;
  trigger: Trigger;
  /** For level agents: the value at or above which the check fails (null: the owner's Never). */
  block_at: RunValue | null;
}

export interface ManagedAgentDefinition {
  id: ManagedAgentId;
  /** One line for the overview card. */
  pitch: string;
  icon: 'code' | 'shield' | 'siren' | 'compass';
  /** One verdict on the whole change instead of findings on lines (VERDICT_CONTRACT). */
  verdict?: boolean;
  /** The check recorded on the change's head (a landing policy may require it). */
  check: string;
  value_type: ValueType;
  polarity: 'lower_is_better';
  defaults: AgentSettings;
  /** Tried in order when the default model cannot run; each one is logged on the run. */
  fallback: ModelChoice[];
  /** Model spend a single run may reach before it is stopped, in USD. */
  cost_cap_usd: number;
}
