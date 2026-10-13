import { providerDefinition } from '../../shared/providers';
import { claudeBudgetRates } from './claude-pricing';
import { prepareGeminiRequest } from './gemini-policy';
import { mimoUpstream } from './mimo-routing';
import { outputCeiling } from './model-budget';
import { enforceFrozenReasoning } from './model-reasoning';
import type { Json } from './types';
import { type WorkspaceSpendContext, workspaceSpendApprovesJob } from './workspace-spend';
export function prepareModelRequest(
  job: Json,
  harness: 'codex' | 'claude' | 'gemini',
  path: string,
  input: Json,
  workspaceApproval: WorkspaceSpendContext | null = null,
) {
  if (harness === 'gemini') {
    const result = prepareGeminiRequest(job, path, input);
    enforceFrozenReasoning(job, result.body, harness);
    return result;
  }
  const execution = job.payload?.execution;
  const provider = execution?.provider ?? execution?.harness;
  const definition = providerDefinition(provider);
  if (job.kind !== 'agent' || execution.harness !== harness || definition.harness !== harness)
    throw new Error('Provider outside attempt scope');
  if (
    !(
      harness === 'codex' ? ['/v1/responses'] : ['/v1/messages', '/v1/messages/count_tokens']
    ).includes(path)
  )
    throw new Error('Provider endpoint not allowed');
  const model = job.model;
  if (typeof model !== 'string' || !model || model.length > 128)
    throw new Error('Configured model required');
  if (!definition.allow_custom_model && !definition.models.some((entry) => entry.id === model))
    throw new Error('Model is not permitted for this provider');
  if (provider === 'claude' && model === 'claude-opus-5-5') {
    if (workspaceApproval) {
      if (!workspaceSpendApprovesJob(workspaceApproval, job))
        throw new Error('Opus workspace approval differs from the frozen attempt');
    } else if (
      job.payload?.execution?.campaign_opus !== true ||
      job.payload?.execution?.repair_round !== 2 ||
      job.payload?.run?.repair_escalation?.model !== model
    )
      throw new Error('Opus 5.5 requires the preapproved second repair execution');
  }
  const body = structuredClone(input);
  enforceFrozenReasoning(job, body, harness);
  const ceiling = outputCeiling(job);
  body.model = model;
  for (const key of [
    'service_tier',
    'speed',
    'inference_geo',
    'mcp_servers',
    'container',
    'context_management',
    'previous_response_id',
    'campaign',
    'campaign_id',
    'campaign_version',
    'campaign_opus',
    'repair_round',
    'chain_id',
    'bucket',
  ])
    delete body[key];
  if (harness === 'codex') {
    body.max_output_tokens = Math.max(
      1,
      Math.min(Math.floor(Number(body.max_output_tokens)) || ceiling, ceiling),
    );
    body.store = false;
    if (body.tools?.some((tool: Json) => !['function', 'custom'].includes(tool.type)))
      throw new Error('Server-side paid tools are unavailable');
    function validateText(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const child of value) validateText(child);
        return;
      }
      const object = value as Json;
      if (['input_image', 'input_audio', 'input_file', 'video'].includes(object.type))
        throw new Error('Testing accepts text and local tools only');
      for (const child of Object.values(object)) validateText(child);
    }
    validateText(body);
  } else {
    if (body.tools?.some((tool: Json) => tool.type && tool.type !== 'custom'))
      throw new Error('Server-side paid tools are unavailable');
    function validate(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) validate(item);
        return;
      }
      const object = value as Json;
      if (['image', 'document', 'container_upload'].includes(object.type))
        throw new Error('Testing accepts text and local tools only');
      for (const child of Object.values(object)) validate(child);
    }
    validate(body);
    body.max_tokens = Math.max(
      1,
      Math.min(Math.floor(Number(body.max_tokens)) || ceiling, ceiling),
    );
    if (provider === 'claude') {
      // The proxy sends no beta headers. Claude Code 2.1.293 requests the
      // beta-only "updates" display even in adaptive mode; use stable summaries.
      if (body.thinking?.display === 'updates') body.thinking.display = 'summarized';
      if (model === 'claude-opus-5-5') {
        if (['any', 'tool'].includes(body.tool_choice?.type))
          throw new Error('Forced tool selection is unsupported by Opus 5.5');
        if (['disabled', 'between_tools'].includes(body.thinking?.type))
          throw new Error('Opus 5.5 requires adaptive thinking');
        if (body.thinking?.type === 'enabled') {
          if (
            !Number.isSafeInteger(body.thinking.budget_tokens) ||
            body.thinking.budget_tokens < 1024
          )
            throw new Error('Manual thinking requires an integer budget of at least 1024 tokens');
          body.thinking = {
            type: 'adaptive',
            ...(body.thinking.display ? { display: body.thinking.display } : {}),
          };
        }
      } else if (model === 'claude-sonnet-5-5') {
        if (['any', 'tool'].includes(body.tool_choice?.type))
          throw new Error('Forced tool selection is unsupported by Sonnet 5.5');
        if (body.thinking?.type === 'enabled') {
          const budget = body.thinking.budget_tokens;
          if (!Number.isSafeInteger(budget) || budget < 1024)
            throw new Error('Manual thinking requires an integer budget of at least 1024 tokens');
          body.thinking = {
            type: 'adaptive',
            ...(body.thinking.display ? { display: body.thinking.display } : {}),
          };
        } else if (body.thinking?.type === 'disabled') {
          body.thinking = { type: 'between_tools' };
        }
        if (
          body.thinking?.type === 'between_tools' &&
          ['xhigh', 'max'].includes(body.output_config?.effort)
        )
          throw new Error('Sonnet 5.5 between_tools requires low, medium or high effort');
      } else if (body.thinking?.type === 'enabled') {
        const budget = body.thinking.budget_tokens;
        if (!Number.isSafeInteger(budget) || budget < 1024)
          throw new Error('Manual thinking requires an integer budget of at least 1024 tokens');
        // count_tokens has no output allowance and must retain its thinking config.
        if (path === '/v1/messages') {
          // Without the interleaved-thinking beta, the budget must be strictly
          // below max_tokens. Never raise the owner's cap to make room for it.
          body.thinking =
            body.max_tokens > 1024
              ? { ...body.thinking, budget_tokens: Math.min(budget, body.max_tokens - 1) }
              : { type: 'disabled' };
        }
      }
    }
    if (path.endsWith('/count_tokens')) delete body.max_tokens;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  if (bytes > 256 * 1024) throw new Error('Model input exceeds 256 KiB testing limit');
  // One token per UTF-8 byte plus protocol overhead deliberately over-reserves.
  // No server tools, images, premium tier or residency. Model-specific input
  // ceilings cover one-hour cache creation; historical rates remain unchanged.
  if (workspaceApproval && !workspaceSpendApprovesJob(workspaceApproval, job))
    throw new Error('Workspace model approval differs from the frozen attempt');
  // Shared runs reserve against their exact frozen group in the authoritative ledger.
  const rates = provider === 'claude' && !workspaceApproval ? claudeBudgetRates(model) : null;
  const reservation =
    rates && !path.endsWith('/count_tokens')
      ? (bytes + 8192) * rates.input + body.max_tokens * rates.output
      : 0;
  return {
    provider,
    url: (provider === 'mimo' ? mimoUpstream(execution.routing) : definition.api_base) + path,
    body,
    reservation,
  };
}
