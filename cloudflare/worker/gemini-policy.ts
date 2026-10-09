import { providerDefinition } from '../../shared/providers';
import { outputCeiling } from './model-budget';
import type { Json } from './types';

/** Gemini uses its native GenerateContent protocol, never the Anthropic adapter. */
export function prepareGeminiRequest(job: Json, path: string, input: Json) {
  const definition = providerDefinition(job.payload?.execution?.provider);
  if (
    job.kind !== 'agent' ||
    definition.protocol !== 'gemini_generate_content' ||
    job.payload.execution.harness !== 'gemini'
  )
    throw new Error('Provider outside attempt scope');
  const match =
    /^\/v1beta\/models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent|countTokens)$/.exec(
      path,
    );
  if (!match) throw new Error('Provider endpoint not allowed');
  if (typeof job.model !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(job.model))
    throw new Error('Configured Gemini model required');
  const body: Json = {};
  for (const key of ['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig'])
    if (input[key] !== undefined) body[key] = structuredClone(input[key]);
  if (
    body.tools &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool: Json) => !tool || Object.keys(tool).some((key) => key !== 'functionDeclarations'),
      ))
  )
    throw new Error('Server-side paid tools are unavailable');
  function validate(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) validate(item);
      return;
    }
    const object = value as Json;
    if (['fileData', 'inlineData', 'fileUri'].some((key) => key in object))
      throw new Error('Testing accepts text and local tools only');
    for (const child of Object.values(object)) validate(child);
  }
  validate(body);
  if (match[1] !== 'countTokens') {
    const ceiling = outputCeiling(job);
    body.generationConfig = {
      ...body.generationConfig,
      candidateCount: 1,
      maxOutputTokens: Math.max(
        1,
        Math.min(Math.floor(Number(body.generationConfig?.maxOutputTokens)) || ceiling, ceiling),
      ),
      responseModalities: ['TEXT'],
    };
  } else {
    delete body.generationConfig;
    delete body.toolConfig;
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > 256 * 1024)
    throw new Error('Model input exceeds 256 KiB testing limit');
  return {
    provider: definition.id,
    url: `${definition.api_base}/v1beta/models/${job.model}:${match[1]}${match[1] === 'streamGenerateContent' ? '?alt=sse' : ''}`,
    body,
    reservation: 0,
  };
}
