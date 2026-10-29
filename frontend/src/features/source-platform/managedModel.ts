// Managed agents as the Agents page reads them: the managed Worker's answers
// (`/api/managed/repos/:repo`, shared/managed-agents.ts) turned into what the cards, the
// credit meter and the runs list print. The server decides every request; `canToggle` only
// hides a button it would refuse.
import type { ManagedCredit, ManagedRun, RunStatus } from '../../../../shared/managed-agents';

export const managedPath = (repo: string) => `/repos/${repo}`;
export const agentPath = (repo: string, agent: string) =>
  `/repos/${repo}/agents/${encodeURIComponent(agent)}`;
export function runsPath(repo: string, agent?: string, limit = 50) {
  const query = new URLSearchParams();
  if (agent) query.set('agent', agent);
  query.set('limit', String(limit));
  return `/repos/${repo}/runs?${query}`;
}
/** The body that turns an agent on or off. */
export const toggleBody = (enabled: boolean) => ({ enabled });

/** Only the owner and admins enable or disable an agent; everyone else reads the state. */
export const canToggle = (admin: boolean) => admin;

/** `$0.0042`, `$1.25`, `$0.00`: cents for a dollar figure, two significant digits below a cent. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  return `$${usd.toFixed(2)}`;
}

/** `$0.42 used of $5.00 credit`. */
export const creditText = (credit: ManagedCredit) =>
  `${formatCost(credit.used_usd)} used of ${formatCost(credit.granted_usd)} credit`;

/** How full the meter is, 0–100. */
export function creditPercent(credit: ManagedCredit): number {
  if (credit.granted_usd <= 0) return credit.used_usd > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((credit.used_usd / credit.granted_usd) * 100)));
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  findings: 'Found issues',
  paused: 'Paused (no credit)',
  superseded: 'Replaced by a newer push',
  cancelled: 'Stopped (agent disabled)',
  failed: 'Failed',
};
export const runStatusLabel = (status: RunStatus) => RUN_STATUS_LABELS[status] ?? status;

/** The status chip's colour: good, attention, bad or neutral. */
export function runTone(status: RunStatus): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'passed') return 'good';
  if (status === 'findings' || status === 'paused') return 'warn';
  if (status === 'failed') return 'bad';
  return 'neutral';
}

/** `3 findings`, `1 finding, 2 withheld`, `none`. */
export function findingsText(run: Pick<ManagedRun, 'findings' | 'withheld'>): string {
  const found =
    run.findings === 0 ? 'none' : `${run.findings} finding${run.findings === 1 ? '' : 's'}`;
  return run.withheld > 0 ? `${found}, ${run.withheld} withheld` : found;
}

/** A read the front Worker answered 404: the managed Worker is not bound on this host. */
export const managedUnavailable = (failed: { errorStatus?: number; code?: string }) =>
  failed.errorStatus === 404 && failed.code !== 'FORBIDDEN';

/** How a landing policy requires an agent's check. */
export const requireCheckNote = (checks: string[], tokenName: string) =>
  `To require a review before landing, add ${checks.join(' or ')} to the required checks and allow the poster token:${tokenName}.`;
