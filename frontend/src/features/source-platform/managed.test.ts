// Agent tools → Managed: the credit meter's words and fill, run statuses and costs, who sees
// the Enable button, and the request paths and bodies the page sends to /api/managed.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ManagedRun, RunStatus } from '../../../../shared/managed-agents';
import { RunStatusChip } from './ManagedAgents';
import {
  agentPath,
  canToggle,
  creditPercent,
  creditText,
  findingsText,
  formatCost,
  managedPath,
  managedUnavailable,
  RUN_STATUS_LABELS,
  requireCheckNote,
  runStatusLabel,
  runsPath,
  runTone,
  toggleBody,
} from './managedModel';

const repo = 'r0123456789abcdef0123';
const credit = (used: number, granted = 5) => ({
  granted_usd: granted,
  used_usd: used,
  balance_usd: Math.max(0, granted - used),
  paused: used >= granted,
});

describe('managed agents', () => {
  it('prints the credit meter as used of granted', () => {
    expect(creditText(credit(0))).toBe('$0.00 used of $5.00 credit');
    expect(creditText(credit(1.234))).toBe('$1.23 used of $5.00 credit');
    expect(creditText(credit(0.0042))).toBe('$0.0042 used of $5.00 credit');
    expect(creditPercent(credit(0))).toBe(0);
    expect(creditPercent(credit(1.25))).toBe(25);
    expect(creditPercent(credit(7))).toBe(100);
    expect(creditPercent(credit(0, 0))).toBe(0);
    expect(creditPercent(credit(1, 0))).toBe(100);
  });

  it('formats costs in cents, or two significant digits below a cent', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(-1)).toBe('$0.00');
    expect(formatCost(Number.NaN)).toBe('$0.00');
    expect(formatCost(0.000123)).toBe('$0.00012');
    expect(formatCost(0.019)).toBe('$0.02');
    expect(formatCost(2.5)).toBe('$2.50');
  });

  it('labels every run status in plain words, with a tone', () => {
    const statuses = Object.keys(RUN_STATUS_LABELS) as RunStatus[];
    expect(statuses).toHaveLength(8);
    for (const status of statuses) expect(runStatusLabel(status)).not.toBe(status);
    expect(runStatusLabel('paused')).toBe('Paused (no credit)');
    expect(runStatusLabel('superseded')).toBe('Replaced by a newer push');
    expect(runTone('passed')).toBe('good');
    expect(runTone('findings')).toBe('warn');
    expect(runTone('paused')).toBe('warn');
    expect(runTone('failed')).toBe('bad');
    expect(runTone('queued')).toBe('neutral');
    const html = renderToStaticMarkup(createElement(RunStatusChip, { run: { status: 'failed' } }));
    expect(html).toBe('<span class="chip run-status run-bad">Failed</span>');
  });

  it('counts findings and withheld ones', () => {
    const run = (findings: number, withheld: number) =>
      ({ findings, withheld }) as Pick<ManagedRun, 'findings' | 'withheld'>;
    expect(findingsText(run(0, 0))).toBe('none');
    expect(findingsText(run(1, 0))).toBe('1 finding');
    expect(findingsText(run(3, 2))).toBe('3 findings, 2 withheld');
  });

  it('offers Enable and Disable only to the owner and admins', () => {
    expect(canToggle(true)).toBe(true);
    expect(canToggle(false)).toBe(false);
  });

  it('sends the documented paths and bodies', () => {
    expect(managedPath(repo)).toBe(`/repos/${repo}`);
    expect(agentPath(repo, 'code-review')).toBe(`/repos/${repo}/agents/code-review`);
    expect(toggleBody(true)).toEqual({ enabled: true });
    expect(runsPath(repo)).toBe(`/repos/${repo}/runs?limit=50`);
    expect(runsPath(repo, 'security-review', 10)).toBe(
      `/repos/${repo}/runs?agent=security-review&limit=10`,
    );
  });

  it('tells an unbound managed Worker apart from other failures', () => {
    expect(managedUnavailable({ errorStatus: 404, code: 'NOT_FOUND' })).toBe(true);
    expect(managedUnavailable({ errorStatus: 403, code: 'FORBIDDEN' })).toBe(false);
    expect(managedUnavailable({ errorStatus: 500 })).toBe(false);
  });

  it('says how a landing policy requires the checks', () => {
    expect(requireCheckNote(['code-review', 'security-review'], 'yoneda-managed-agents')).toBe(
      'To require a review before landing, add code-review or security-review to the required checks and allow the poster token:yoneda-managed-agents.',
    );
  });
});
