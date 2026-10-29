// Model calls through Cloudflare AI Gateway (one gateway per environment), Anthropic Messages
// protocol. Each request carries five metadata entries (account, repo, change, agent, run) so
// the gateway's logs attribute its cost. No tools are offered to the model: a reply is text,
// read only as JSON data. Provider keys come from Secrets Store bindings at call time and are
// sent only to the gateway.
import { AGENT_MARGIN } from '../../shared/managed-agents';
import { providerDefinition } from '../../shared/providers';
import { type AgentConfig, gatewaySlug, type ManagedEnv, type RunParams } from './config';
import type { Usage } from './ledger';

/** `sent`: the request may have reached the provider (its hold is charged, not released). */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}

export interface Reply {
  text: string;
  usage: Usage;
}

/** Price of a call from the provider's reported usage: ceil(cost) and ceil(cost × margin). */
export function priceOf(agent: AgentConfig, inputTokens: number, outputTokens: number): Usage {
  const cost =
    (inputTokens * agent.price.input_microusd_per_million +
      outputTokens * agent.price.output_microusd_per_million) /
    1_000_000;
  return {
    inputTokens,
    outputTokens,
    costMicrousd: Math.ceil(cost),
    chargeMicrousd: Math.ceil(cost * AGENT_MARGIN),
  };
}

/** The most a call with this prompt can be charged: every byte a token, full output. */
export function worstCase(agent: AgentConfig, system: string, prompt: string): number {
  const input = new TextEncoder().encode(system + prompt).length + 64;
  return priceOf(agent, input, agent.caps.maxOutputTokens).chargeMicrousd;
}

const keyBinding = (env: ManagedEnv, agent: AgentConfig) =>
  agent.provider === 'claude'
    ? env.CLAUDE_KEY
    : agent.provider === 'zai'
      ? env.ZAI_KEY
      : env.MIMO_KEY;

export async function callModel(
  env: ManagedEnv,
  agent: AgentConfig,
  run: RunParams,
  system: string,
  prompt: string,
): Promise<Reply> {
  const key = await keyBinding(env, agent)
    ?.get()
    .catch(() => '');
  if (!key) throw new ModelError(`${agent.provider} key is not bound`, false);
  const definition = providerDefinition(agent.provider);
  // The gateway appends this path to the provider's base URL (its root domain).
  const path = new URL(definition.api_base).pathname.replace(/\/$/, '');
  const url = `${env.AI_GATEWAY_URL.replace(/\/$/, '')}/${gatewaySlug(env, agent.provider)}${path}/v1/messages`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    [definition.auth_header]: definition.auth_prefix + key,
    'cf-aig-metadata': JSON.stringify({
      account: run.account,
      repo: run.repo,
      change: run.change,
      agent: run.agent,
      run: run.run,
    }),
  };
  if (env.AI_GATEWAY_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: agent.model,
      max_tokens: agent.caps.maxOutputTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(90_000),
  }).catch(() => null);
  if (!res) throw new ModelError('Model request did not complete', true);
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (res.status !== 200) throw new ModelError(`Model returned HTTP ${res.status}`, true);
  const text = Array.isArray(body?.content)
    ? body.content
        .filter((c: Record<string, unknown>) => c?.type === 'text')
        .map((c: Record<string, unknown>) => String(c.text ?? ''))
        .join('')
    : '';
  const usage = body?.usage ?? {};
  const input = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]
    .filter(Number.isSafeInteger)
    .reduce((a: number, b: number) => a + b, 0);
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens))
    throw new ModelError('Model reply had no usage', true);
  return { text, usage: priceOf(agent, input, usage.output_tokens) };
}
