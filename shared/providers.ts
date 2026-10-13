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
