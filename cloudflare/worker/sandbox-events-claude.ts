// Claude Code `--output-format stream-json`: one JSON event per line (system init, assistant
// text and tool calls, tool results, a final result).
import {
  type CliEvents,
  clip,
  count,
  finished,
  type ParsedActivity,
  record,
  text,
  tokens,
  toolTarget,
} from './sandbox-events';

const TYPES = new Set(['system', 'assistant', 'user', 'result']);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => text(record(part).text)).join(' ');
  return '';
}

export const claudeEvents: CliEvents = {
  owns: (event) => TYPES.has(text(event.type)),
  activity(event) {
    const message = record(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init')
          return [{ kind: 'init', text: clip(`Agent started (${text(event.model) || 'model'})`) }];
        // A failing model endpoint shows as retries long before the final result.
        if (event.subtype === 'api_retry')
          return [
            {
              kind: 'error',
              text: clip(
                `Model request retry ${event.attempt ?? '?'}/${event.max_retries ?? '?'}${typeof event.error_status === 'number' ? ` (HTTP ${event.error_status})` : ''}: ${text(event.error) || 'error'}`,
              ),
            },
          ];
        return [];
      case 'assistant':
        return content.flatMap((part): ParsedActivity[] => {
          const block = record(part);
          if (block.type === 'text' && text(block.text).trim())
            return [{ kind: 'text', text: clip(text(block.text)) }];
          if (block.type === 'tool_use')
            return [
              {
                kind: 'tool',
                text: clip(`${text(block.name) || 'tool'} ${toolTarget(record(block.input))}`),
              },
            ];
          return [];
        });
      case 'user':
        // Successful tool output is noise here; failures say why the agent changed course.
        return content.flatMap((part): ParsedActivity[] => {
          const block = record(part);
          return block.type === 'tool_result' && block.is_error === true
            ? [{ kind: 'tool_error', text: clip(toolResultText(block.content)) }]
            : [];
        });
      case 'result': {
        const usage = record(event.usage);
        const input =
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens);
        return [
          finished(
            event.is_error === true,
            [
              typeof event.num_turns === 'number' ? `${event.num_turns} turns` : '',
              tokens(input, count(usage.output_tokens)),
            ],
            text(event.result) || text(event.subtype),
          ),
        ];
      }
      default:
        return [];
    }
  },
  outcome(event) {
    if (event.type !== 'result' || typeof event.is_error !== 'boolean') return null;
    const message = clip(text(event.result) || text(event.subtype) || 'no result text');
    return event.is_error ? { ok: false, error: message } : { ok: true, result: message };
  },
  session: (event) =>
    event.type === 'system' && event.subtype === 'init' ? event.session_id : null,
};
