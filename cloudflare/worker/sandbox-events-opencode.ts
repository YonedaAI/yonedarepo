// opencode `run --format json`, and MiMo Code (an opencode fork) with the same events: each
// carries `sessionID` and a `part`. `step_start`, `text`, `reasoning`, `tool_use` (one per
// finished call; MiMo Code repeats it), `step_finish` (per model step, its tokens and a
// reason, `stop` on the last) and `error`. There is no final result event: the last
// `step_finish` with reason `stop` ends the turn. Shapes as opencode 1.19.4 and MiMo Code
// 0.1.16 printed them (tests/workers/sandbox-events).
import {
  type CliEvents,
  clip,
  count,
  finished,
  record,
  text,
  tokens,
  toolTarget,
} from './sandbox-events';

const TYPES = new Set(['step_start', 'text', 'reasoning', 'tool_use', 'step_finish', 'error']);

function errorText(event: Record<string, unknown>): string {
  const error = record(event.error);
  const message = text(record(error.data).message) || text(error.message);
  return `${text(error.name) || 'Error'}${message ? `: ${message}` : ''}`;
}

export const opencodeEvents: CliEvents = {
  owns: (event) => typeof event.sessionID === 'string' && TYPES.has(text(event.type)),
  activity(event) {
    const part = record(event.part);
    switch (event.type) {
      case 'text':
        return text(part.text).trim() ? [{ kind: 'text', text: clip(text(part.text)) }] : [];
      case 'tool_use': {
        const state = record(part.state);
        const call = text(part.callID) || undefined;
        const tool = {
          kind: 'tool' as const,
          text: clip(`${text(part.tool) || 'tool'} ${toolTarget(record(state.input))}`),
          call,
        };
        return state.status === 'error'
          ? [tool, { kind: 'tool_error', text: clip(text(state.error) || 'tool failed'), call }]
          : [tool];
      }
      case 'step_finish': {
        if (part.reason !== 'stop') return [];
        // Per step, not per run: the last step's tokens (sandbox spend metering is separate).
        const usage = record(part.tokens);
        const cache = record(usage.cache);
        const input = count(usage.input) + count(cache.read) + count(cache.write);
        const used = tokens(input, count(usage.output));
        return [finished(false, [used ? `last step ${used}` : ''], '')];
      }
      case 'error':
        return [{ kind: 'error', text: clip(errorText(event)) }];
      default:
        return [];
    }
  },
  outcome(event) {
    if (event.type === 'step_finish' && record(event.part).reason === 'stop')
      return { ok: true, result: '' };
    if (event.type === 'error') return { ok: false, error: clip(errorText(event)) };
    return null;
  },
  session: (event) => event.sessionID,
};
