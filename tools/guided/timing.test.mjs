import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTiming, guidedTiming, stageOf, unionMs } from './timing.mjs';

const s = (seconds) => 1_000_000 + seconds * 1000;
const execution = (id, run_id, team_role, start, end) => ({ id, run_id, team_role, started_at: s(start), finished_at: s(end) });
const snapshot = {
  runs: [
    { id: 'build-run', created_at: s(0), guided: { check_phase: 'build' } },
    { id: 'filter-run', created_at: s(100), guided: { check_phase: 'parallel' } },
  ],
  executions: [
    execution('build-run:planner', 'build-run', 'planner', 5, 20),
    execution('build-run:task:ui', 'build-run', 'worker', 20, 60),
    execution('build-run:task:core', 'build-run', 'worker', 20, 50),
    execution('build-run:task:integrate', 'build-run', 'integrator', 70, 80),
    execution('conflict-resolver:filter-1', 'filter-run', 'resolver', 110, 130),
  ],
  team_tasks: [],
  nodes: [],
};
const events = [
  { kind: 'job.started', at: s(80), data: { id: 'capture:i', kind: 'capture', epoch: 1, run_id: 'build-run' } },
  { kind: 'job.completed', at: s(85), data: { id: 'capture:i', kind: 'capture', epoch: 1 } },
  { kind: 'job.started', at: s(85), data: { id: 'evaluate:i', kind: 'evaluate', epoch: 1, run_id: 'build-run' } },
  { kind: 'job.failed', at: s(90), data: { id: 'evaluate:i', kind: 'evaluate', epoch: 1 } },
  { kind: 'job.started', at: s(91), data: { id: 'evaluate:i', kind: 'evaluate', epoch: 2, run_id: 'build-run' } },
  { kind: 'job.completed', at: s(97), data: { id: 'evaluate:i', kind: 'evaluate', epoch: 2 } },
];

test('stages come from team roles and recorded identities', () => {
  assert.equal(stageOf({ team_role: 'planner' }), 'planning');
  assert.equal(stageOf({ id: 'r:task:integrate' }), 'integration');
  assert.equal(stageOf({ id: 'conflict-resolver:x' }), 'coordination');
  assert.equal(stageOf({ id: 'r:coordinator:1:0' }), 'coordination');
  assert.equal(stageOf({ team_role: 'worker' }), 'coding');
  assert.equal(unionMs([[0, 10], [5, 20], [30, 35]]), 25);
});

test('per-step and total durations count parallel specialists once and name the bottleneck', () => {
  const timing = guidedTiming(snapshot, { events });
  const build = timing.steps.build;
  assert.equal(build.wall_ms, 97_000);
  assert.equal(build.stages.planning.wall_ms, 15_000);
  assert.equal(build.stages.coding.wall_ms, 40_000);
  assert.equal(build.stages.coding.busy_ms, 70_000);
  assert.equal(build.stages.integration.wall_ms, 10_000);
  assert.equal(build.stages.capture.wall_ms, 5_000);
  assert.equal(build.stages.evaluation.wall_ms, 11_000, 'failed and retried evaluation attempts both count');
  assert.equal(build.unattributed_ms, 16_000, 'queue before planning, 60-70s gap, 1s between attempts');
  assert.equal(build.bottleneck.stage, 'coding');
  assert.equal(timing.steps.concurrent.stages.coordination.wall_ms, 20_000);
  assert.equal(timing.total.wall_ms, 130_000);
  assert.equal(timing.capture_evaluation_basis, 'job_events');
  const table = formatTiming(timing);
  assert.match(table, /^step\s+planning\s+coding/);
  assert.match(table, /bottleneck: coding 0:40/);
});

test('without job events capture is an explicitly labelled ledger estimate', () => {
  const timing = guidedTiming({
    ...snapshot,
    team_tasks: [{ id: 'build-run:task:ui', execution_id: 'build-run:task:ui', run_id: 'build-run', completed_at: s(65) }],
  });
  assert.equal(timing.steps.build.stages.capture.wall_ms, 5_000);
  assert.equal(timing.capture_evaluation_basis, 'ledger_estimate_capture_includes_evaluation');
  assert.match(formatTiming(timing), /includes evaluation time/);
});

test('driver state run ids override phases and unknown runs are reported as other', () => {
  const timing = guidedTiming(
    { ...snapshot, executions: [...snapshot.executions, execution('stray:task:x', 'stray', 'worker', 0, 1)] },
    { steps: { extend: { run_ids: ['filter-run'] } } },
  );
  assert.ok(timing.steps.extend);
  assert.equal(timing.steps.concurrent, undefined);
  assert.equal(timing.steps.other.stages.coding.wall_ms, 1_000);
});
