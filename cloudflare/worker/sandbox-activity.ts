// The sandbox attempt's activity log is the CLI's own `--output-format stream-json` output:
// one JSON event per line (system init, assistant text and tool calls, tool results, a final
// result). Lines come from the sandbox, so they are untrusted: each is parsed defensively,
// reduced to a short line of text, redacted and bounded before it is stored or shown.

export type ActivityKind = 'init' | 'text' | 'tool' | 'tool_error' | 'result' | 'error';
export type Activity = { kind: ActivityKind; text: string };

/** Characters kept per entry; the whole log is bounded by the Durable Object. */
export const ACTIVITY_TEXT_LIMIT = 300;

// Defense in depth: the sandbox only ever holds placeholders, but a tool may print anything.
const SECRETS: RegExp[] = [
  /yrp_[A-Za-z0-9_-]{8,}/g,
  /ypat_[A-Za-z0-9_-]{8,}/g,
  /\b(?:sk|tp|ttp)-[A-Za-z0-9_-]{12,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,}/gi,
  /\b[A-Fa-f0-9]{48,}\b/g,
];

export function redact(text: string): string {
  return SECRETS.reduce((value, pattern) => value.replace(pattern, '[redacted]'), text);
}

function clip(text: string): string {
  const flat = redact(text.replace(/\s+/g, ' ').trim());
  return flat.length > ACTIVITY_TEXT_LIMIT ? `${flat.slice(0, ACTIVITY_TEXT_LIMIT - 1)}…` : flat;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The one argument that says what a tool call does (a path, a command, a pattern). */
function toolTarget(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'prompt'])
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  return '';
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => text(record(part).text)).join(' ');
  return '';
}

/** The activity entries in one stream-json line; anything unrecognised yields none. */
export function parseActivity(line: string): Activity[] {
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(line));
  } catch {
    return line.trim() ? [{ kind: 'error', text: clip(line) }] : [];
  }
  const message = record(event.message);
  const content = Array.isArray(message.content) ? message.content : [];
  switch (event.type) {
    case 'system':
      return event.subtype === 'init'
        ? [{ kind: 'init', text: clip(`Agent started (${text(event.model) || 'model'})`) }]
        : [];
    case 'assistant':
      return content.flatMap((part): Activity[] => {
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
      return content.flatMap((part): Activity[] => {
        const block = record(part);
        return block.type === 'tool_result' && block.is_error === true
          ? [{ kind: 'tool_error', text: clip(toolResultText(block.content)) }]
          : [];
      });
    case 'result': {
      const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
      const turns = typeof event.num_turns === 'number' ? event.num_turns : undefined;
      const facts = [
        turns !== undefined ? `${turns} turns` : '',
        cost !== undefined ? `CLI cost estimate $${cost.toFixed(4)}` : '',
      ].filter(Boolean);
      const outcome = event.is_error === true ? 'Agent failed' : 'Agent finished';
      return [
        {
          kind: 'result',
          text: clip(
            `${outcome}${facts.length ? ` (${facts.join(', ')})` : ''}: ${text(event.result) || text(event.subtype)}`,
          ),
        },
      ];
    }
    default:
      return [];
  }
}

/** The final `result` event's verdict; Claude Code exits 0 even when a model call failed. */
export type CliOutcome = { ok: true; result: string } | { ok: false; error: string } | null;

export function resultOutcome(line: string): CliOutcome {
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (event.type !== 'result' || typeof event.is_error !== 'boolean') return null;
  const message = clip(text(event.result) || text(event.subtype) || 'no result text');
  return event.is_error ? { ok: false, error: message } : { ok: true, result: message };
}

/**
 * Splits newly read bytes into complete lines. A partial last line stays unread (its bytes
 * are not consumed) unless the chunk is full, so one oversized line cannot stall the reader.
 */
export function completeLines(
  bytes: Uint8Array,
  full: boolean,
): { consumed: number; lines: string[] } {
  let end = bytes.lastIndexOf(0x0a) + 1;
  if (end === 0 && full) end = bytes.length;
  const lines = new TextDecoder()
    .decode(bytes.subarray(0, end))
    .split('\n')
    .filter((line) => line.trim());
  return { consumed: end, lines };
}
