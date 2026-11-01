// The pure half of the memory test (memory-flow.mjs, memory-run.mjs): the run schedule and its
// guarded fork names, what opencode's JSON events say a run used, the oracle over a pushed
// branch, what reached each session, each run's validity and the estimate. No processes and no network, so it is
// unit-tested (tests/runtime/memory-test.test.mjs). The verdict is memory-verdict.mjs.

/** `plain`: stock Git, nothing on its fork. `context`: the yoneda plugin and tools, with every
 * memory but the trap. `memory`: the same plus the trap memory, its one difference. */
export const ARMS = ['plain', 'context', 'memory'];
/** The plan's floor: 3 per arm can't reach significance on Fisher's test. */
export const MIN_RUNS = 5;
/** One spare over the floor, and 2 runs of each of the 3 traps per arm. At 6 blocks the sign test
 * on reading needs all 6; `--memory-runs 9` allows one block against the rest (8 of 9). */
export const DEFAULT_RUNS = 6;

const FORK = /^memtest-\d+-[a-z-]+-(plain|context|memory)-\d+$/;

/** The fork of one run. The time keeps names unique: a name can stay held after a delete, and
 * deletes will become a 30-day window. */
export const forkName = (ts, trap, arm, round) => `memtest-${ts}-${trap}-${arm}-${round}`;
export const branchName = (trap, round) => `memtest/${trap}-${round}`;
/** Whether `name` is a fork this test made: nothing else is ever deleted. */
export const isTestFork = (name) => FORK.test(String(name));

/** `runs` per arm in blocks of one run of each arm: the same trap, at the same time, so
 * provider load falls on all arms. Traps take turns, so each gets as near the same share as can be. */
export function schedule(runs, traps) {
  if (!Number.isInteger(runs) || runs < MIN_RUNS) throw new Error(`--memory-runs is at least ${MIN_RUNS} per arm: fewer can't show a difference on Fisher's test`);
  return Array.from({ length: runs }, (_, i) => ({ trap: traps[i % traps.length], round: i + 1 }));
}

/** Time and quota before a run, from the run of 2026-10-31 (12 agents, 35 min). A block's arms
 * are prepared at once, so it costs its slowest: a `yoneda::` fork, memories and clone took
 * 100-390 s, 250 with the judging. A block's slowest agent took 41-143 s, mean 96. Tokens per run
 * averaged 111k plain and 227k with the plugin; the context arm is taken as the memory arm. */
export function memoryEstimate({ runs, parallel, timeoutS, traps }) {
  const setupS = 250;
  const typicalS = 100;
  const tokens = { plain: 111_000, context: 227_000, memory: 227_000 };
  const rounds = Math.ceil(runs / parallel);
  const minutes = (agentS) => Math.ceil((rounds * (setupS + agentS)) / 60);
  return { agents: runs * ARMS.length, forks: runs * ARMS.length, traps, typical_minutes: minutes(typicalS), worst_minutes: minutes(timeoutS), tokens: runs * ARMS.reduce((sum, arm) => sum + tokens[arm], 0) };
}

/** What `--memory-test` prints before anything starts. */
export function planText({ runs, parallel, timeoutS, model, traps }) {
  const e = memoryEstimate({ runs, parallel, timeoutS, traps: traps.length });
  return [
    `Memory test: ${e.agents} real agent runs (${runs} per arm: ${ARMS.join(', ')}), ${e.forks} forks, ${traps.length} traps (${traps.map((t) => `${t.id} on ${t.repo}`).join(', ')}).`,
    `Model: ${model}, ${parallel * ARMS.length} agents at once, ${timeoutS} s limit each.`,
    `Time: about ${e.typical_minutes} min, at worst ${e.worst_minutes} min.`,
    `Cost: coding-plan quota, about ${(e.tokens / 1e6).toFixed(1)} M tokens at the means of the 2026-10-31 run; opencode reports $0 for this plan.`,
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

/** A shell command with its quoted words emptied, so a `\|` in a grep pattern splits nothing. */
const unquoted = (command) => String(command).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** The file arguments of each `head`, `tail` or `sed -n` in a shell command (no pipe or redirect
 * after it): part of a file, the way agents read most of it. */
function sliced(command) {
  return unquoted(command)
    .split(/&&|;|\n/)
    .map((s) => s.replace(/\s2>\S+/g, '').trim())
    .filter((s) => /^(head|tail|sed)\s/.test(s) && !/[|<>]/.test(s))
    .flatMap((s) => {
      const [verb, ...rest] = s.split(/\s+/);
      if (verb === 'sed' && !rest.includes('-n')) return [];
      const args = rest.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
      return (verb === 'sed' ? args.slice(1) : args).filter((a) => a !== '""');
    });
}

/** A shell step that only looks at the clone. */
const LOOKS = /^(cat|head|tail|sed -n|grep|rg|find|ls|wc|echo|cd|command -v|git (grep|log|show|diff|status|blame|branch|ls-files)|yoneda (grep|symbols|blame|log|diff|context|memory list))\b/;
/** Whether every step of a shell command only looks, so its output counts as reading. */
const looksOnly = (command) =>
  unquoted(command)
    .split(/&&|\|\|?|;|\n/)
    .map((s) => s.replace(/^\s*git -C \S+/, 'git').trim())
    .filter(Boolean)
    .every((s) => LOOKS.test(s));

const YONEDA_CALL = /(^|[\s;&|])yoneda\s+(grep|symbols|blame|log|diff|context|memory)\b/;
const SEARCHES = new Set(['grep', 'glob']);
/** A path as the clone names it, whichever way the agent wrote it. */
const inClone = (path) => String(path).replace(/^\/work\//, '').replace(/^\.\//, '');

/**
 * What one run used, from opencode's `--format json` events: tokens from each `step_finish`
 * (input excludes what the cache served; `fresh_tokens` leaves out what the cache re-read), and
 * tool use from each `tool_use`. A whole-file read is a completed `read` of a file with no
 * `offset` or `limit` whose output was not cut short, or a plain `cat`; `head`, `tail` and
 * `sed -n` are partial reads. `files_read` counts distinct files. `read_bytes` is every byte of
 * looking: `read`, `grep`, `glob` and shell commands that only look, `yoneda` read calls
 * included, so a tool that moves reading elsewhere gets no credit for it. opencode's tools are
 * lower case (`read`, `shell`); the proof harness's counter matched `Read`, so it counted none.
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
  const used = { session, steps: steps.size, tokens: { ...tokens, total: Object.values(tokens).reduce((a, b) => a + b, 0) }, fresh_tokens: tokens.input + tokens.output + tokens.reasoning, tool_calls: tools.size, failed_calls: 0, by_tool: {}, file_reads: 0, files_read: 0, whole_file_reads: 0, partial_reads: 0, read_bytes: 0, yoneda_calls: 0 };
  const files = new Set();
  for (const part of tools.values()) {
    const tool = String(part.tool).toLowerCase();
    const { status, input = {}, output } = part.state ?? {};
    used.by_tool[tool] = (used.by_tool[tool] ?? 0) + 1;
    if (status === 'error') used.failed_calls++;
    if (tool === 'read' || tool === 'view') {
      const text = String(output ?? '');
      if (status !== 'completed' || !/^Read file /.test(text)) continue;
      used.file_reads++;
      used.read_bytes += text.length;
      files.add(inClone(input.path));
      const cut = input.offset != null || input.limit != null || /\[Output truncated\b/.test(text);
      if (cut) used.partial_reads++;
      else used.whole_file_reads++;
    } else if (SEARCHES.has(tool)) {
      used.read_bytes += String(output ?? '').length;
    } else if (tool === 'shell' || tool === 'bash') {
      const [whole, part] = [catted(input.command), sliced(input.command)];
      used.file_reads += whole.length + part.length;
      used.whole_file_reads += whole.length;
      used.partial_reads += part.length;
      for (const file of [...whole, ...part]) files.add(inClone(file));
      if (looksOnly(input.command)) used.read_bytes += String(output ?? '').length;
      if (YONEDA_CALL.test(String(input.command ?? ''))) used.yoneda_calls++;
    }
  }
  used.files_read = files.size;
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

/** What reached one session, from `/context/deliveries`: whether it got start context, by which
 * triggers, the bytes, each item type and the memories shown. */
export function shownIn(deliveries) {
  const list = deliveries ?? [];
  const items = list.flatMap((d) => d.items ?? []);
  const by_type = {};
  for (const item of items) by_type[item.type] = (by_type[item.type] ?? 0) + 1;
  const memories = [...new Set(items.filter((i) => i.type === 'memory').map((i) => i.id))];
  return { start: list.some((d) => d.trigger === 'start'), triggers: list.map((d) => d.trigger), bytes: list.reduce((n, d) => n + (d.bytes ?? 0), 0), by_type, memories };
}

/** The session's side of delivery, from the plugin's hook log: what its hooks really handed the
 * model, and whether the rule was in it. The platform's record says what it served; this says
 * it arrived. `rule` is the trap memory's text; a delivered line keeps its start. */
export function hookReport(lines, rule) {
  const injected = lines.map(parse).filter((e) => e && /^opencode-(start|prompt|read)$/.test(e.event) && e.output);
  const bytes = (list) => list.reduce((n, e) => n + e.output.length, 0);
  return { start_bytes: bytes(injected.filter((e) => e.event === 'opencode-start')), injected_bytes: bytes(injected), rule_seen: injected.some((e) => e.output.includes(rule.slice(0, 80))) };
}

/**
 * Why a run doesn't count ([] when it does). `hook` is `hookReport` of its hook log, null when
 * it has none. Plain arm: no delivery, no memory on its fork, no hook log and no `yoneda` read
 * call, so nothing could reach it. Both plugin arms: start context served by the platform and
 * handed over by the hook. Memory arm: the trap memory delivered, and seen in what the hooks
 * handed over. Context arm: the trap memory neither on its fork nor seen. A run that did not
 * finish (killed, crashed, refused by the sandbox guard) says nothing about the trap.
 */
export function runProblems({ arm, code, killed, session, delivery, deliveries = [], memories = 0, yonedaCalls = 0, hook = null, trapOnFork = false }) {
  const problems = [];
  if (killed || code !== 0) problems.push(`the agent did not finish: ${killed ?? `exit ${code}`}`);
  if (!session) problems.push('no session id in its events, so deliveries cannot be read back');
  if (arm === 'plain') {
    if (deliveries.length) problems.push(`${deliveries.length} context deliveries in the plain arm`);
    if (memories) problems.push(`${memories} memories on the plain arm's fork`);
    if (yonedaCalls) problems.push(`${yonedaCalls} yoneda read calls in the plain arm`);
    if (hook) problems.push('a hook log in the plain arm');
    return problems;
  }
  if (!shownIn(deliveries).start) problems.push('no start context was delivered');
  if (!hook?.start_bytes) problems.push('its hook handed over no start context');
  if (arm === 'memory') {
    if (!delivery?.delivered) problems.push('the trap memory was not delivered');
    else if (!hook?.rule_seen) problems.push('the trap memory was delivered but its hooks never handed it over');
  }
  if (arm === 'context') {
    if (trapOnFork) problems.push("the trap memory is on the context arm's fork");
    if (hook?.rule_seen) problems.push('the trap memory reached the context arm');
  }
  return problems;
}

/** A clone the platform was too busy to serve: `info/refs` answered 503 OVERLOADED, the fetch an
 * ERR line naming it (repo-git-retry.ts), or the edge a bare 503. Git doesn't retry it, and a
 * person would run it again. */
export const retryableClone = (message) => /HTTP 503|OVERLOADED/.test(String(message));
