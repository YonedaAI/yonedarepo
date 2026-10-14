#!/usr/bin/env node
// Per-stage durations of a guided rehearsal, from the authoritative repository snapshot.
// Agent stages come from execution started_at/finished_at; capture and evaluation come from
// the recorded_at of the candidate/evaluation graph nodes (or job timestamps when present).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateFile, reviewerClient } from './credentials.mjs';

export const stages = ['planning', 'coding', 'integration', 'coordination', 'capture', 'evaluation'];
const stepOrder = ['build', 'extend', 'concurrent', 'other'];
const finite = (value) => (Number.isFinite(value) ? value : null);

export function stageOf(execution) {
  const role = execution.team_role ?? '';
  const id = String(execution.id ?? '');
  if (role === 'planner' || id.endsWith(':planner')) return 'planning';
  if (role === 'integrator' || id.endsWith(':task:integrate')) return 'integration';
  if (['coordinator', 'resolver'].includes(role) || id.startsWith('conflict-resolver:') || id.includes(':coordinator:'))
    return 'coordination';
  return 'coding';
}

/** Guided step of a run: driver state run_ids first, then the server's frozen check phase. */
export function stepIndex(runs = [], steps = {}) {
  const index = new Map();
  for (const [id, step] of Object.entries(steps ?? {}))
    for (const run of step?.run_ids ?? []) index.set(run, id);
  for (const run of runs) {
    if (index.has(run.id)) continue;
    const phase = run.guided?.check_phase;
    if (phase) index.set(run.id, phase === 'parallel' || phase === 'final' ? 'concurrent' : phase);
  }
  return index;
}

/** Total covered length of possibly overlapping intervals (parallel work counts once). */
export function unionMs(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [start, end] = [null, null];
  for (const [a, b] of sorted) {
    if (end === null || a > end) {
      if (end !== null) total += end - start;
      [start, end] = [a, b];
    } else end = Math.max(end, b);
  }
  return end === null ? total : total + end - start;
}

/** Capture/evaluate job spans from job.started -> job.completed|job.failed events (per epoch). */
export function jobSpans(events = [], jobs = []) {
  const spans = [];
  const open = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    if (!['capture', 'evaluate'].includes(data.kind)) continue;
    const key = `${data.id}\0${data.epoch}`;
    if (event.kind === 'job.started') open.set(key, { ...data, start: event.at });
    else if (['job.completed', 'job.failed'].includes(event.kind) && open.has(key)) {
      const begun = open.get(key);
      open.delete(key);
      spans.push({ id: data.id, kind: data.kind, run_id: data.run_id ?? begun.run_id, start: begun.start, end: event.at });
    }
  }
  for (const job of jobs) {
    const start = finite(job.started_at ?? job.claimed_at);
    const end = finite(job.finished_at);
    if (['capture', 'evaluate'].includes(job.kind) && start !== null && end !== null && !spans.some((span) => span.id === job.id))
      spans.push({ id: job.id, kind: job.kind, run_id: job.payload?.execution?.run_id ?? job.payload?.candidate?.run_id ?? job.run_id, start, end });
  }
  return spans;
}

/**
 * Returns {intervals, basis}. Without job timing, capture is estimated from the ledger: team
 * task captured_at (completed_at) after the agent finished, and for a candidate its graph node
 * time, which is rewritten when evaluation lands, so that span includes evaluation.
 */
export function intervals(snapshot, { steps = {}, events = [], now } = {}) {
  const runStep = stepIndex(snapshot.runs, steps);
  const stepFor = (run) => runStep.get(run) ?? 'other';
  const out = [];
  const executions = new Map((snapshot.executions ?? []).map((item) => [item.id, item]));
  const latest = Math.max(
    0,
    ...[...executions.values()].flatMap((item) => [item.started_at, item.finished_at]).filter(Number.isFinite),
    ...(snapshot.nodes ?? []).map((node) => node.recorded_at).filter(Number.isFinite),
    ...events.map((event) => event.at).filter(Number.isFinite),
  );
  for (const execution of executions.values()) {
    const start = finite(execution.started_at);
    if (start === null) continue;
    const end = finite(execution.finished_at);
    // A static snapshot has no "now": open executions are measured to its latest timestamp.
    out.push({ stage: stageOf(execution), step: stepFor(execution.run_id), start, end: end ?? now ?? latest, open: end === null, id: execution.id });
  }
  const spans = jobSpans(events, snapshot.jobs);
  if (spans.length) {
    for (const span of spans)
      out.push({ stage: span.kind === 'capture' ? 'capture' : 'evaluation', step: stepFor(span.run_id), start: span.start, end: span.end, id: span.id });
    return { intervals: out, runStep, basis: 'job_events' };
  }
  for (const task of snapshot.team_tasks ?? []) {
    const from = finite(executions.get(task.execution_id)?.finished_at);
    const at = finite(task.completed_at);
    if (from !== null && at !== null && at >= from)
      out.push({ stage: 'capture', step: stepFor(task.run_id), start: from, end: at, id: task.id });
  }
  const covered = new Set(out.filter((item) => item.stage === 'capture').map((item) => item.id));
  for (const node of (snapshot.nodes ?? []).filter((item) => item.kind === 'candidate')) {
    const execution = executions.get(node.data?.execution);
    const from = finite(execution?.finished_at);
    const at = finite(node.recorded_at);
    if (from !== null && at !== null && at >= from && !covered.has(execution.team_task))
      out.push({ stage: 'capture', step: stepFor(node.data?.run_id), start: from, end: at, id: node.id });
  }
  return { intervals: out, runStep, basis: 'ledger_estimate_capture_includes_evaluation' };
}

function summarize(items, runs) {
  const starts = [...runs.map((run) => finite(run.created_at)).filter((v) => v !== null), ...items.map((i) => i.start)];
  if (!starts.length) return null;
  const begin = Math.min(...starts);
  const end = Math.max(begin, ...items.map((item) => item.end));
  const result = { started_at: begin, finished_at: end, wall_ms: end - begin, stages: {} };
  for (const stage of stages) {
    const own = items.filter((item) => item.stage === stage);
    result.stages[stage] = {
      wall_ms: unionMs(own.map((item) => [item.start, item.end])),
      busy_ms: own.reduce((sum, item) => sum + (item.end - item.start), 0),
      count: own.length,
    };
  }
  result.unattributed_ms = result.wall_ms - unionMs(items.map((item) => [item.start, item.end]));
  return result;
}

export function bottleneck(summary) {
  if (!summary) return null;
  const ranked = [...stages.map((stage) => [stage, summary.stages[stage].wall_ms]), ['unattributed', summary.unattributed_ms]]
    .sort((a, b) => b[1] - a[1]);
  const [stage, ms] = ranked[0];
  return { stage, wall_ms: ms, share: summary.wall_ms ? Number((ms / summary.wall_ms).toFixed(3)) : 0 };
}

/** Timing evidence: per guided step and total, with the slowest stage named. */
export function guidedTiming(snapshot, options = {}) {
  const { intervals: items, runStep, basis } = intervals(snapshot, options);
  const runs = snapshot.runs ?? [];
  const steps = {};
  for (const step of stepOrder) {
    const own = items.filter((item) => item.step === step);
    const ownRuns = runs.filter((run) => (runStep.get(run.id) ?? 'other') === step);
    if (!own.length && !ownRuns.length) continue;
    steps[step] = summarize(own, ownRuns);
    if (steps[step]) steps[step].bottleneck = bottleneck(steps[step]);
  }
  const total = summarize(items, runs);
  return {
    schema: 'guided-timing-v1',
    source: options.events?.length ? 'repository_snapshot+events' : 'repository_snapshot',
    capture_evaluation_basis: basis,
    open_intervals: items.filter((item) => item.open).length,
    steps,
    total: total && { ...total, bottleneck: bottleneck(total) },
  };
}

const clock = (ms) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
export function formatTiming(timing) {
  const columns = [...stages, 'unattributed', 'wall'];
  const rows = [...Object.entries(timing.steps), ['total', timing.total]].filter(([, value]) => value);
  const cell = (summary, column) =>
    column === 'wall' ? summary.wall_ms : column === 'unattributed' ? summary.unattributed_ms : summary.stages[column].wall_ms;
  const lines = [['step', ...columns].map((text) => text.padEnd(13)).join('')];
  for (const [name, summary] of rows)
    lines.push([name, ...columns.map((column) => clock(cell(summary, column)))].map((text) => text.padEnd(13)).join(''));
  const slow = timing.total?.bottleneck;
  if (slow) lines.push(`bottleneck: ${slow.stage} ${clock(slow.wall_ms)} (${Math.round(slow.share * 100)}% of total wall)`);
  lines.push('Stage columns are wall time (parallel work counted once); unattributed = queue/startup/idle.');
  if (timing.open_intervals) lines.push(`${timing.open_intervals} execution(s) still running; measured to the latest recorded time.`);
  if (timing.capture_evaluation_basis !== 'job_events')
    lines.push('No job events: capture is a ledger estimate and includes evaluation time.');
  return lines.join('\n');
}

/** Reads the ordered event log (200 per page) for capture/evaluate job timing. */
export async function readEvents(api, repo, { maxPages = 200 } = {}) {
  const events = [];
  let after = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = (await api(`repos/${repo}/events?after=${after}`)).events ?? [];
    events.push(...batch.map(({ seq, kind, at, data }) => ({ seq, kind, at, data })));
    if (batch.length < 200) return events;
    after = batch.at(-1).seq;
  }
  throw new Error('Event paging bound exceeded');
}

export const usage = `node tools/guided/timing.mjs --snapshot SNAPSHOT.json [--events EVENTS.json] [--state DRIVER_STATE.json] [--json]
node tools/guided/timing.mjs --repo REPO [--origin URL] [--key-file MODE0600_FILE | --username ACCOUNT] [--state FILE] [--json]`;

export async function main(args = process.argv.slice(2)) {
  const names = { '--snapshot': 'snapshot', '--events': 'events', '--state': 'state', '--repo': 'repo', '--origin': 'origin', '--key-file': 'keyFile', '--username': 'username' };
  const options = { origin: 'https://yonedarepo.com' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') options.json = true;
    else if (args[index] === '--help') return console.log(usage);
    else if (names[args[index]] && args[index + 1]) options[names[args[index]]] = args[++index];
    else throw new Error('Invalid timing arguments; use --help');
  }
  if (!options.snapshot && !options.repo) throw new Error('--snapshot or --repo required');
  const state = options.state ? JSON.parse(await privateFile(options.state)) : {};
  let snapshot;
  let events = [];
  if (options.snapshot) {
    snapshot = JSON.parse(await readFile(options.snapshot, 'utf8'));
    if (options.events) {
      const saved = JSON.parse(await readFile(options.events, 'utf8'));
      events = Array.isArray(saved) ? saved : (saved.events ?? []);
    }
  } else {
    const { api } = await reviewerClient(options.origin, options);
    snapshot = await api(`repos/${options.repo}/snapshot`);
    events = await readEvents(api, options.repo);
  }
  const timing = guidedTiming(snapshot, { steps: state.steps, events });
  console.log(options.json ? JSON.stringify(timing, null, 2) : formatTiming(timing));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`Timing stopped: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
    process.exitCode = 1;
  });
