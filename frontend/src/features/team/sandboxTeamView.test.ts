import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { runCandidates } from '../exploration/runResults';
import { landingText, sandboxMembers, teamHead } from './sandboxTeamView';

const run = { id: 'run-t', mode: 'collaborate', runtime: 'sandbox-cli-v1' };
const member = (n: number, extra: Record<string, unknown>) => ({
  id: `run-t:agent-${n}`,
  run_id: 'run-t',
  sandbox_task: { id: `t${n}`, title: `Task ${n}` },
  ...extra,
});

describe('sandbox team members', () => {
  const landed = member(1, {
    status: 'landed',
    landing: { status: 'landed', team_commit: 'a'.repeat(40), version: 3, resumed: false },
  });
  const merged = member(2, {
    status: 'landed',
    landing: { status: 'landed', team_commit: 'b'.repeat(40), version: 5, resumed: true },
  });
  const failed = member(10, {
    status: 'failed',
    landing: { status: 'conflict', paths: ['src/a.js'], round: 1, resumed: true },
  });
  const snapshot = {
    executions: [failed, merged, landed, { id: 'run-t:team', run_id: 'run-t' }],
    candidates: [],
  } as unknown as Snapshot;

  it('lists one member per task in plan order with what became of its landing', () => {
    expect(sandboxMembers(snapshot, run).map((e) => e.id)).toEqual([
      'run-t:agent-1',
      'run-t:agent-2',
      'run-t:agent-10',
    ]);
    expect(landingText(landed)).toBe('Landed on the team branch');
    expect(landingText(merged)).toBe('Landed on the team branch after one resume');
    expect(landingText(failed)).toBe('Conflict on src/a.js after one resume: not landed');
    expect(
      landingText(
        member(3, { status: 'running', landing: { status: 'conflict', paths: ['x'], round: 0 } }),
      ),
    ).toBe('Conflict on x: resumed once to merge the team branch');
  });

  it('shows the latest landing as the team branch head until the capture names it', () => {
    const members = sandboxMembers(snapshot, run);
    expect(teamHead(snapshot, run, members)).toBe('b'.repeat(40));
    const captured = {
      ...snapshot,
      candidates: [
        { id: 'c', run_id: 'run-t', execution: 'run-t:team', revision: { commit: 'c'.repeat(40) } },
      ],
    } as unknown as Snapshot;
    expect(teamHead(captured, run, members)).toBe('c'.repeat(40));
    // The team branch candidate is the run's result (no integrator task row exists).
    expect(runCandidates(captured, run).map((candidate) => candidate.id)).toEqual(['c']);
  });
});
