// Sandbox attempts (runtime sandbox-cli-v1) report what the coding CLI last did; these helpers
// turn the recorded activity into the "Last activity" line and the idle marker.
export const SANDBOX_RUNTIME = 'sandbox-cli-v1';
export const IDLE_MS = 10 * 60 * 1000;

export type SandboxActivityRecord = {
  phase?: string;
  last_activity_at?: number;
  summary?: string;
  idle_ms?: number;
};
export type SandboxActivityEntry = { seq: number; at: number; kind: string; text: string };
export type SandboxActivityPage = {
  entries: SandboxActivityEntry[];
  next: number;
  has_more: boolean;
  phase: string | null;
  last_activity_at: number | null;
};

export const isSandbox = (execution: Record<string, any>) => execution?.runtime === SANDBOX_RUNTIME;

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** "Last activity 2 min ago · Edit src/math.js", and whether a running CLI looks idle. */
export function lastActivity(
  execution: Record<string, any>,
  now: number,
): { text: string; idleMinutes: number | null } | null {
  const activity: SandboxActivityRecord | undefined = execution?.activity;
  if (!isSandbox(execution) || typeof activity?.last_activity_at !== 'number') return null;
  const quiet = now - activity.last_activity_at;
  const summary = activity.summary ? ` · ${activity.summary}` : '';
  const running = execution.status === 'running';
  return {
    text: `Last activity ${ago(quiet)}${summary}`,
    idleMinutes: running && quiet >= IDLE_MS ? Math.floor(quiet / 60_000) : null,
  };
}

export const activityLabels: Record<string, string> = {
  init: 'Started',
  text: 'Said',
  tool: 'Tool',
  tool_error: 'Tool failed',
  result: 'Result',
  error: 'Output',
};
