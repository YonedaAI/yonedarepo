// The model tool loop shared by every eval arm: the model proposes tool calls, the arm's
// executor runs them against the platform's public API, results go back as tool_result
// blocks. The loop ends on `finish`, a reply without tool calls, the turn cap, or a cap
// stop from the model client. What the model says about its work is never a result.
import { ArmError, type ModelClient, StopError } from './model';
import type { Json } from './study';

const RESULT_LIMIT = 16 * 1024;

export const author = { name: 'Eval model agent', email: 'agent@eval.invalid' };
export const SYSTEM =
  'You are a coding agent working on a TypeScript repository only through the tools you are given. ' +
  'Work efficiently: read what the task needs, make exactly the requested change, then call finish.';

export const string = (description: string) => ({ type: 'string', description });
export const tool = (name: string, description: string, properties: Json) => ({
  name,
  description,
  input_schema: { type: 'object', properties, required: Object.keys(properties) },
});
export const SEARCH = tool(
  'search',
  'Search file contents for a substring. Returns matching paths and lines.',
  { query: string('Text to find, 2-200 characters') },
);
export const FINISH = tool('finish', 'Call once the change is made (or you cannot make it).', {});

export const base64 = (text: string) => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export type LoopOutcome = {
  turns: number;
  stop: 'finished' | 'turn_cap' | 'model_error' | StopError['code'];
  tools: string[];
  /** Why a model_error stopped the task (also counted in the client's failures). */
  error?: string;
};
export type Execute = (name: string, input: Json) => Promise<string>;

export async function toolLoop(
  model: ModelClient,
  task: string,
  tools: Json[],
  execute: Execute,
  maxTurns: number,
): Promise<LoopOutcome> {
  const trace: string[] = [];
  const messages: Json[] = [{ role: 'user', content: task }];
  for (let turn = 1; turn <= maxTurns; turn++) {
    let reply: Json;
    try {
      reply = await model.messages({ system: SYSTEM, messages, tools });
    } catch (e) {
      if (e instanceof StopError) return { turns: turn, stop: e.code, tools: trace };
      const error =
        e instanceof ArmError
          ? `${e.code}: ${e.message}`
          : `unexpected: ${String((e as Error)?.message ?? e)}`;
      return { turns: turn, stop: 'model_error', tools: trace, error: error.slice(0, 200) };
    }
    messages.push({ role: 'assistant', content: reply.content });
    const calls = (reply.content as Json[]).filter((block) => block.type === 'tool_use');
    if (calls.length === 0) return { turns: turn, stop: 'finished', tools: trace };
    const results: Json[] = [];
    let finished = false;
    for (const call of calls) {
      const input = call.input ?? {};
      trace.push(
        call.name === 'search'
          ? `search:${String(input.query).slice(0, 40)}`
          : `${call.name}:${String(input.path ?? '')}`,
      );
      if (call.name === 'finish') finished = true;
      const output = call.name === 'finish' ? 'ok' : await execute(call.name, input);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: output.slice(0, RESULT_LIMIT),
      });
    }
    if (finished) return { turns: turn, stop: 'finished', tools: trace };
    messages.push({ role: 'user', content: results });
  }
  return { turns: maxTurns, stop: 'turn_cap', tools: trace };
}
