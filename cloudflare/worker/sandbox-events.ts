// The shared vocabulary of the sandbox CLIs' event parsers (sandbox-events-*.ts): every line a
// CLI prints comes from the sandbox, so it is untrusted. Each parser reduces one decoded event
// to short activity lines, redacted and bounded, plus the CLI's verdict and session id.

export type ActivityKind = 'init' | 'text' | 'tool' | 'tool_error' | 'result' | 'error';
export type Activity = { kind: ActivityKind; text: string };
/** `call`: the CLI's tool call id, when a CLI repeats one call's event (MiMo Code does). */
export type ParsedActivity = Activity & { call?: string };

/** The CLI's verdict on its run: Claude Code, for one, exits 0 even when a model call failed. */
export type CliOutcome = { ok: true; result: string } | { ok: false; error: string } | null;

export type CliEvent = Record<string, unknown>;
/** One CLI's JSON event stream (Claude Code stream-json, Codex `--json`, opencode `json`). */
export type CliEvents = {
  /** Whether `event` has this CLI's shape; the event types of the four CLIs do not overlap. */
  owns(event: CliEvent): boolean;
  activity(event: CliEvent): ParsedActivity[];
  /** The verdict when `event` ends the CLI's turn, else null. */
  outcome(event: CliEvent): CliOutcome;
  /** The session id `event` names (unvalidated), for a team member's one resume. */
  session(event: CliEvent): unknown;
};

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

export function clip(text: string): string {
  const flat = redact(text.replace(/\s+/g, ' ').trim());
  return flat.length > ACTIVITY_TEXT_LIMIT ? `${flat.slice(0, ACTIVITY_TEXT_LIMIT - 1)}…` : flat;
}

export const record = (value: unknown): CliEvent =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as CliEvent) : {};
export const text = (value: unknown) => (typeof value === 'string' ? value : '');
export const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** The one argument that says what a tool call does (a path, a command, a pattern). */
export function toolTarget(input: CliEvent): string {
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'command',
    'cmd',
    'pattern',
    'url',
    'description',
    'prompt',
  ])
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  return '';
}

/** `Agent finished (facts): detail`, the line every CLI's final event becomes. */
export function finished(failed: boolean, facts: string[], detail: string): Activity {
  const outcome = failed ? 'Agent failed' : 'Agent finished';
  const shown = facts.filter(Boolean);
  return {
    kind: 'result',
    text: clip(
      `${outcome}${shown.length ? ` (${shown.join(', ')})` : ''}${detail ? `: ${detail}` : ''}`,
    ),
  };
}

/** Token counts, never a CLI's dollar figure: each CLI prices models at its own vendor's rates. */
export const tokens = (input: number, output: number) =>
  input || output ? `${input} input / ${output} output tokens` : '';
