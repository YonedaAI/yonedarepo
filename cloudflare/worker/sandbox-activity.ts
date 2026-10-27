// The sandbox attempt's activity log is the CLI's own JSON event output, one event per line:
// Claude Code stream-json, Codex `--json` or opencode/MiMo Code `--format json`, each read by
// its parser (sandbox-events-*.ts; the four event vocabularies do not overlap). Lines come
// from the sandbox, so they are untrusted: each is parsed defensively, reduced to a short line
// of text, redacted and bounded before it is stored (in the AgentSandbox object's bounded
// `activity` table) or shown.

import {
  type Activity,
  type CliEvent,
  type CliEvents,
  type CliOutcome,
  clip,
  type ParsedActivity,
  record,
} from './sandbox-events';
import { claudeEvents } from './sandbox-events-claude';
import { codexEvents } from './sandbox-events-codex';
import { opencodeEvents } from './sandbox-events-opencode';

export {
  ACTIVITY_TEXT_LIMIT,
  type Activity,
  type ActivityKind,
  type CliOutcome,
  redact,
} from './sandbox-events';

const PARSERS: CliEvents[] = [claudeEvents, codexEvents, opencodeEvents];

function decode(line: string): { event: CliEvent; parser?: CliEvents } | null {
  try {
    const event = record(JSON.parse(line));
    return { event, parser: PARSERS.find((parser) => parser.owns(event)) };
  } catch {
    return null;
  }
}

function parsed(line: string): ParsedActivity[] {
  const decoded = decode(line);
  if (!decoded) return line.trim() ? [{ kind: 'error', text: clip(line) }] : [];
  return decoded.parser?.activity(decoded.event) ?? [];
}

const plain = ({ kind, text }: ParsedActivity): Activity => ({ kind, text });

/** The activity entries in one CLI output line; anything unrecognised yields none. */
export function parseActivity(line: string): Activity[] {
  return parsed(line).map(plain);
}

/** The entries of a batch of lines, each tool call once even when the CLI repeats its event. */
export function parseActivityLines(lines: string[]): Activity[] {
  const seen = new Set<string>();
  return lines
    .flatMap(parsed)
    .filter((entry) => {
      if (!entry.call) return true;
      const key = `${entry.kind}:${entry.call}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(plain);
}

/** The CLI's verdict if `line` ends its turn (a result, a completed or failed turn). */
export function resultOutcome(line: string): CliOutcome {
  const decoded = decode(line);
  return decoded?.parser?.outcome(decoded.event) ?? null;
}

/** Rows the Durable Object keeps of an attempt's activity log (the oldest are dropped). */
const ACTIVITY_ROWS = 2000;

/** Appends `entries` to the object's `activity` table and drops what exceeds its bound. */
export function storeActivity(sql: SqlStorage, at: number, entries: Activity[]) {
  for (const entry of entries)
    sql.exec('INSERT INTO activity(at, kind, text) VALUES(?, ?, ?)', at, entry.kind, entry.text);
  sql.exec('DELETE FROM activity WHERE seq <= (SELECT MAX(seq) FROM activity) - ?', ACTIVITY_ROWS);
}

/** One page of the activity log after `after`, oldest first. */
export function activityPage(sql: SqlStorage, after: number, limit: number) {
  const rows = sql
    .exec<{ seq: number; at: number; kind: string; text: string }>(
      'SELECT seq, at, kind, text FROM activity WHERE seq > ? ORDER BY seq LIMIT ?',
      after,
      limit + 1,
    )
    .toArray();
  const entries = rows.slice(0, limit);
  return { entries, next: entries.at(-1)?.seq ?? after, has_more: rows.length > limit };
}

/** The session id the line names, if any: what a team member's one resume continues. */
export function sessionId(line: string): string | null {
  const decoded = decode(line);
  const id = decoded?.parser?.session(decoded.event);
  // Untrusted: it becomes one argument of the resume command line.
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id) ? id : null;
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
