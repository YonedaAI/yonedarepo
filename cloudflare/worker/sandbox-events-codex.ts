// Codex CLI `codex exec --json`: JSONL events `thread.started`, `turn.started`,
// `turn.completed` (with usage), `turn.failed`, `item.started|updated|completed` and `error`.
// Items: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search,
// todo_list, error. Shapes as Codex CLI 0.164.0 printed them (tests/workers/sandbox-events).
import {
  type CliEvent,
  type CliEvents,
  clip,
  count,
  finished,
  type ParsedActivity,
  record,
  text,
  tokens,
} from './sandbox-events';

const PREFIXES = ['thread.', 'turn.', 'item.'];

function started(item: CliEvent): ParsedActivity[] {
  // A command shows when it starts: tests and builds run for minutes.
  if (item.type === 'command_execution')
    return [{ kind: 'tool', text: clip(`bash ${text(item.command)}`) }];
  return [];
}

function completed(item: CliEvent): ParsedActivity[] {
  switch (item.type) {
    case 'agent_message':
      return text(item.text).trim() ? [{ kind: 'text', text: clip(text(item.text)) }] : [];
    case 'command_execution': {
      const code = item.exit_code;
      return typeof code === 'number' && code !== 0
        ? [
            {
              kind: 'tool_error',
              text: clip(`exit ${code}: ${text(item.aggregated_output).slice(-1000)}`),
            },
          ]
        : [];
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
      const list = changes.map((change) => `${text(change.kind)} ${text(change.path)}`).join(', ');
      return [
        { kind: item.status === 'failed' ? 'tool_error' : 'tool', text: clip(`edit ${list}`) },
      ];
    }
    case 'mcp_tool_call': {
      const name = `${text(item.server)}.${text(item.tool)}`;
      return item.status === 'failed'
        ? [{ kind: 'tool_error', text: clip(`${name}: ${text(record(item.error).message)}`) }]
        : [{ kind: 'tool', text: clip(name) }];
    }
    case 'web_search':
      return [{ kind: 'tool', text: clip(`web_search ${text(item.query)}`) }];
    case 'error':
      return [{ kind: 'error', text: clip(text(item.message) || 'error') }];
    default:
      return [];
  }
}

export const codexEvents: CliEvents = {
  owns: (event) =>
    PREFIXES.some((prefix) => text(event.type).startsWith(prefix)) ||
    (event.type === 'error' && typeof event.message === 'string' && !('sessionID' in event)),
  activity(event) {
    const item = record(event.item);
    switch (event.type) {
      case 'thread.started':
        return [{ kind: 'init', text: 'Agent started (Codex CLI)' }];
      case 'item.started':
        return started(item);
      case 'item.completed':
        return completed(item);
      // Reconnects and other non-fatal errors; a fatal one is followed by `turn.failed`.
      case 'error':
        return [{ kind: 'error', text: clip(text(event.message) || 'error') }];
      case 'turn.completed': {
        // OpenAI counts cached and reasoning tokens inside input and output.
        const usage = record(event.usage);
        return [
          finished(false, [tokens(count(usage.input_tokens), count(usage.output_tokens))], ''),
        ];
      }
      case 'turn.failed':
        return [finished(true, [], text(record(event.error).message) || 'turn failed')];
      default:
        return [];
    }
  },
  outcome(event) {
    if (event.type === 'turn.completed') return { ok: true, result: '' };
    if (event.type === 'turn.failed')
      return { ok: false, error: clip(text(record(event.error).message) || 'turn failed') };
    return null;
  },
  session: (event) => (event.type === 'thread.started' ? event.thread_id : null),
};
