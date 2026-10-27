import { providerRegistry } from './provider-registry';

export type Harness = 'claude' | 'codex' | 'gemini';
export interface ModelOption {
  id: string;
  label: string;
  /** Exact canonical values from this model's official API, never a universal menu. */
  reasoning_efforts?: string[];
  reasoning_default?: string;
  reasoning_control?: 'effort' | 'toggle';
  reasoning_source_url?: string;
  /** Manual selection remains available; Auto seed selection needs compatibility evidence. */
  auto_seed_eligible?: boolean;
  conservative_pricing?: {
    input_microusd_per_million: number;
    output_microusd_per_million: number;
    source: 'owner-approved conservative rates';
  };
  pricing_source_url?: string;
  pricing_verified_at?: string;
  pricing_input_token_ceiling?: number;
  pricing_basis?: string;
}
export interface ProviderDefinition {
  id: string;
  name: string;
  harness: Harness;
  protocol: 'anthropic_messages' | 'openai_responses' | 'gemini_generate_content';
  api_base: string;
  auth_header: string;
  auth_prefix: string;
  secret_binding: string;
  default_model: string;
  allow_custom_model: boolean;
  catalog_url: string;
  models: ModelOption[];
  token_plan_regions?: Record<string, string>;
}

export const providers = providerRegistry as ProviderDefinition[];
export function providerDefinition(id: string): ProviderDefinition {
  const definition = providers.find((provider) => provider.id === id);
  if (!definition) throw new Error('Unknown provider');
  return definition;
}

/** The stock coding CLIs a sandbox runs, unmodified and headless (cloudflare/sandbox/Dockerfile). */
export type SandboxCli = 'claude' | 'codex' | 'opencode' | 'mimo';
export const sandboxCliNames: Record<SandboxCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'opencode',
  mimo: 'MiMo Code',
};
/**
 * The one place the sandbox model rule lives: which CLIs can drive a provider's API, the
 * default first. Claude Code speaks Anthropic Messages only, and Codex CLI the OpenAI
 * Responses API only (it dropped Chat Completions); opencode and its fork MiMo Code carry
 * all three protocols. The ledger enforces the same table (yoneda-app `commands/sandbox.rs`).
 */
const sandboxClisByHarness: Record<Harness, readonly SandboxCli[]> = {
  claude: ['claude', 'opencode', 'mimo'],
  codex: ['codex', 'opencode', 'mimo'],
  gemini: ['opencode', 'mimo'],
};
export function sandboxClis(provider: string): readonly SandboxCli[] {
  const definition = providers.find((entry) => entry.id === provider);
  return definition ? (sandboxClisByHarness[definition.harness] ?? []) : [];
}
/** Whether a provider's models can run in a sandbox (runtime `sandbox-cli-v1`). */
export function runsInSandbox(provider: string): boolean {
  return sandboxClis(provider).length > 0;
}
/** The CLI an agent of `provider` gets unless the owner picks another. */
export function defaultSandboxCli(provider: string): SandboxCli | undefined {
  return sandboxClis(provider)[0];
}
/** Whether `cli` can drive `provider`'s models. */
export function sandboxCliFits(provider: string, cli: unknown): cli is SandboxCli {
  return sandboxClis(provider).includes(cli as SandboxCli);
}
