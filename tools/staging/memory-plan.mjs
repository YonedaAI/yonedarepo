// The pure half of the memory test (memory-flow.mjs, memory-run.mjs): the run schedule and its
// guarded fork names, what opencode's JSON events say a run used, the oracle over a pushed
// branch, each run's validity and the estimate. No processes and no network, so it is
// unit-tested (tests/runtime/memory-test.test.mjs). The verdict is memory-verdict.mjs.

export const ARMS = ['plain', 'memory'];
/** The plan's floor: 3 per arm can't reach significance on Fisher's test. */
export const MIN_RUNS = 5;
/** One spare over the floor, and 2 runs of each of the 3 traps per arm. */
export const DEFAULT_RUNS = 6;

const FORK = /^memtest-\d+-[a-z-]+-(plain|memory)-\d+$/;

/** The fork of one run. The time keeps names unique: a name can stay held after a delete, and
 * deletes will become a 30-day window. */
export const forkName = (ts, trap, arm, round) => `memtest-${ts}-${trap}-${arm}-${round}`;
export const branchName = (trap, round) => `memtest/${trap}-${round}`;
/** Whether `name` is a fork this test made: nothing else is ever deleted. */
export const isTestFork = (name) => FORK.test(String(name));

/** `runs` per arm in blocks of one run of each arm: the same trap, at the same time, so
 * provider load falls on both. Traps take turns, so each gets as near the same share as can be. */
export function schedule(runs, traps) {
  if (!Number.isInteger(runs) || runs < MIN_RUNS) throw new Error(`--memory-runs is at least ${MIN_RUNS} per arm: fewer can't show a difference on Fisher's test`);
  return Array.from({ length: runs }, (_, i) => ({ trap: traps[i % traps.length], round: i + 1 }));
}

/** Time and quota before a run. The per-run numbers are measured: kit item 30 took 22-37 s per
 * small edit on 2026-10-30 and up to its 600 s limit on a slow provider day; these tasks read
 * more, so 3 minutes is the working guess. opencode reported 17k-380k tokens, median 100k, over
 * 64 past runs, and $0: the coding plan is a subscription. */
export function memoryEstimate({ runs, parallel, timeoutS, traps }) {
  const setupS = 90;
  const typicalS = 180;
  const rounds = Math.ceil(runs / parallel);
  const minutes = (agentS) => Math.ceil((rounds * (setupS + agentS)) / 60);
  return { agents: runs * 2, forks: runs * 2, traps, typical_minutes: minutes(typicalS), worst_minutes: minutes(timeoutS), tokens: runs * 2 * 100_000 };
}

/** What `--memory-test` prints before anything starts. */
export function planText({ runs, parallel, timeoutS, model, traps }) {
  const e = memoryEstimate({ runs, parallel, timeoutS, traps: traps.length });
  return [
    `Memory test: ${e.agents} real agent runs (${runs} per arm), ${e.forks} forks, ${traps.length} traps (${traps.map((t) => `${t.id} on ${t.repo}`).join(', ')}).`,
    `Model: ${model}, ${parallel * 2} agents at once, ${timeoutS} s limit each.`,
    `Time: about ${e.typical_minutes} min, at worst ${e.worst_minutes} min.`,
    `Cost: coding-plan quota, about ${(e.tokens / 1e6).toFixed(1)} M tokens at the 100k median of past runs; opencode reports $0 for this plan.`,
  ].join('\n');
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** The file arguments of each plain `cat` in a shell command (no pipe or redirect after it). */
function catted(command) {
  return String(command)
    .split(/&&|;|\n/)
    .map((s) => s.trim())
    .filter((s) => /^cat\s/.test(s) && !/[|<>]/.test(s))
    .flatMap((s) => s.split(/\s+/).slice(1).filter((a) => !a.startsWith('-')));
}

const YONEDA_CALL = /(^|[\s;&|])yoneda\s+(grep|symbols|blame|log|diff|context|memory)\b/;

/**
 * What one run used, from opencode's `--format json` events: tokens from each `step_finish`
 * (input excludes what the cache served), and tool use from each `tool_use`. A whole-file read
 * is a completed `read` of a file with no `offset` or `limit` whose output was not cut short,
 * or a plain `cat`. opencode's tools are lower case (`read`, `shell`); the proof harness's
 * counter matched `Read`, so it counted none.
 */
export function opencodeUsage(lines) {
  const steps = new Map();
  const tools = new Map();
  let session = null;
  for (const event of lines.map(parse)) {
    if (!event || typeof event !== 'object') continue;
    session ??= event.sessionID ?? null;
    const part = event.part ?? {};
    if (event.type === 'step_finish' && part.tokens) steps.set(part.id ?? `step-${steps.size}`, part.tokens);
    if (event.type === 'tool_use' && part.tool) tools.set(part.id ?? part.partID ?? `tool-${tools.size}`, part);
  }
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  for (const t of steps.values()) {
    tokens.input += t.input ?? 0;
    tokens.output += t.output ?? 0;
    tokens.reasoning += t.reasoning ?? 0;
    tokens.cache_read += t.cache?.read ?? 0;
    tokens.cache_write += t.cache?.write ?? 0;
  }
  const used = { session, steps: steps.size, tokens: { ...tokens, total: Object.values(tokens).reduce((a, b) => a + b, 0) }, tool_calls: tools.size, by_tool: {}, file_reads: 0, whole_file_reads: 0, partial_reads: 0, read_bytes: 0, yoneda_calls: 0 };
  for (const part of tools.values()) {
    const tool = String(part.tool).toLowerCase();
    const { status, input = {}, output } = part.state ?? {};
    used.by_tool[tool] = (used.by_tool[tool] ?? 0) + 1;
    if (tool === 'read' || tool === 'view') {
      const text = String(output ?? '');
      if (status !== 'completed' || !/^Read file /.test(text)) continue;
      used.file_reads++;
      used.read_bytes += text.length;
      const cut = input.offset != null || input.limit != null || /\[Output truncated\b/.test(text);
      if (cut) used.partial_reads++;
      else used.whole_file_reads++;
    } else if (tool === 'shell' || tool === 'bash') {
      const files = catted(input.command);
      used.file_reads += files.length;
      used.whole_file_reads += files.length;
      if (YONEDA_CALL.test(String(input.command ?? ''))) used.yoneda_calls++;
    }
  }
  return used;
}

/** Each changed path's added lines, from `/diff?patch=1` changes (unified patches). */
export function addedLines(changes) {
  const added = {};
  for (const { path, patch } of changes ?? [])
    added[path] = String(patch ?? '')
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
  return added;
}

/**
 * The trap's verdict on what the agent pushed: `avoided` when the task is done and the rule
 * held, `fell` when the task is done and the rule broke, and `unfinished` or `no_push` when
 * there is nothing to judge. Only `avoided` counts as avoiding the trap.
 */
export function judgeTrap(trap, { head, base, changes }) {
  if (!head || head === base) return { outcome: 'no_push', paths: [] };
  const paths = (changes ?? []).map((c) => c.path);
  const { done, avoided } = trap.oracle(paths, addedLines(changes));
  return { outcome: !done ? 'unfinished' : avoided ? 'avoided' : 'fell', paths };
}

/** Where memory `id` reached the session, from `/context/deliveries`: how it was triggered, its
 * place among that delivery's items and how many other items came before it in the session. */
export function deliveryOf(deliveries, id) {
  let before = 0;
  for (const d of deliveries ?? []) {
    const at = (d.items ?? []).findIndex((i) => i.type === 'memory' && i.id === id);
    if (at >= 0) return { delivered: true, trigger: d.trigger, position: at + 1, items_before: before + at, deliveries: deliveries.length };
    before += d.items?.length ?? 0;
  }
  return { delivered: false, trigger: null, position: null, items_before: before, deliveries: deliveries?.length ?? 0 };
}

/**
 * Why a run doesn't count ([] when it does). Memory arm: the trap memory must read back as
 * delivered. Plain arm: no delivery at all and no memory on its fork, so nothing could reach
 * it; and it must not have found the platform's tools by itself. A run that did not finish
 * (killed, crashed, refused by the sandbox guard) says nothing about the trap.
 */
export function runProblems({ arm, code, killed, session, delivery, deliveries = [], memories = 0, yonedaCalls = 0 }) {
  const problems = [];
  if (killed || code !== 0) problems.push(`the agent did not finish: ${killed ?? `exit ${code}`}`);
  if (!session) problems.push('no session id in its events, so deliveries cannot be read back');
  if (arm === 'memory' && !delivery?.delivered) problems.push('the trap memory was not delivered');
  if (arm === 'plain') {
    if (deliveries.length) problems.push(`${deliveries.length} context deliveries in the plain arm`);
    if (memories) problems.push(`${memories} memories on the plain arm's fork`);
    if (yonedaCalls) problems.push(`${yonedaCalls} yoneda read calls in the plain arm`);
  }
  return problems;
}

/** A clone the platform was too busy to serve: `info/refs` answered 503 OVERLOADED, the fetch an
 * ERR line naming it (repo-git-retry.ts), or the edge a bare 503. Git doesn't retry it, and a
 * person would run it again. */
export const retryableClone = (message) => /HTTP 503|OVERLOADED/.test(String(message));
