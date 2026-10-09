import manifest from '../backend/crates/yoneda-core/src/providers.json';

export type Harness = 'claude' | 'codex' | 'gemini';
export interface ModelOption {
  id: string;
  label: string;
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

export const providers = manifest as ProviderDefinition[];
export function providerDefinition(id: string): ProviderDefinition {
  const definition = providers.find((provider) => provider.id === id);
  if (!definition) throw new Error('Unknown provider');
  return definition;
}
