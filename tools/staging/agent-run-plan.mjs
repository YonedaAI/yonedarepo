// The pure half of kit item 29 (agent-run-flow.mjs): what each real agent is asked to do,
// the exact opencode command, what a run cost (from opencode's JSON events), and the verdict
// on the repository afterwards. No processes and no network, so it is unit-tested
// (tests/runtime/agent-run.test.mjs).

/** Small, distinct functions; every agent adds one to the same file (overlapping edits). */
const FUNCTIONS = [
  ['clamp', 'clamp(value, min, max) returns value limited to the range [min, max]', 'clamp(12, 0, 10) === 10'],
  ['slugify', 'slugify(text) lowercases text and joins its words with "-"', "slugify('Hello  World') === 'hello-world'"],
  ['chunk', 'chunk(list, size) splits an array into arrays of at most size items', 'chunk([1, 2, 3], 2) → [[1, 2], [3]]'],
  ['uniq', 'uniq(list) returns the array without repeated values, first occurrences kept', 'uniq([1, 1, 2]) → [1, 2]'],
  ['sum', 'sum(list) adds the numbers of an array (0 for an empty one)', 'sum([1, 2, 3]) === 6'],
  ['capitalize', 'capitalize(text) upper-cases the first character', "capitalize('yoneda') === 'Yoneda'"],
  ['range', 'range(n) returns [0, 1, …, n - 1]', 'range(3) → [0, 1, 2]'],
  ['zip', 'zip(a, b) pairs items by index up to the shorter array', "zip([1, 2], ['a']) → [[1, 'a']]"],
  ['last', 'last(list) returns the final item of an array, or undefined', 'last([1, 2]) === 2'],
  ['isEven', 'isEven(n) is true for even integers', 'isEven(4) === true'],
  ['countBy', 'countBy(list, key) counts items by the value key(item) returns', "countBy(['a', 'bb'], (s) => s.length) → { 1: 1, 2: 1 }"],
  ['pick', 'pick(object, keys) returns a new object with only those keys', "pick({ a: 1, b: 2 }, ['a']) → { a: 1 }"],
];

export const MAX_AGENTS = FUNCTIONS.length;

/** The tasks of one wave: agent `w<wave>a<n>` adds one function; waves never repeat one. */
export function tasks(count, wave, offset = 0) {
  if (count < 1 || offset + count > MAX_AGENTS) throw new Error(`1-${MAX_AGENTS - offset} agents in this wave`);
  return FUNCTIONS.slice(offset, offset + count).map(([fn, spec, example], i) => {
    const agent = `w${wave}a${i + 1}`;
    return { agent, fn, spec, example, changelog: `- ${agent}: added ${fn}`, email: `kit-agent-${agent}@yonedarepo.invalid` };
  });
}

/** What the agent is told; everything else comes from the yoneda plugin's start context. */
export function prompt(task) {
  return [
    `You are working in a Git clone of a YonedaRepo repository (remote origin). Task ${task.agent}:`,
    `1. Add an exported JavaScript function to src/util.js: ${task.spec}. Example: ${task.example}. Name it ${task.fn}.`,
    `2. Append exactly this line at the end of CHANGELOG.md: ${task.changelog}`,
    'Keep every existing line of both files and change no other file.',
    `3. Commit with the message "${task.agent}: add ${task.fn}" and push with: git push origin main`,
    'Other agents push to the same files at the same time. If the push is refused, run git pull --rebase origin main, resolve any conflict by keeping the lines of both sides, run git rebase --continue, and push again; repeat until git push succeeds. Never force-push.',
    'When the push has succeeded, answer with one sentence saying what you changed.',
  ].join('\n');
}

/** `opencode run` arguments for one agent (its own server, permissions pre-approved). */
export function opencodeArgs({ model, title, text }) {
  return ['run', '--standalone', '--auto', '--format', 'json', '--model', model, '--title', title, text];
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/** The command line to print and keep as evidence (its arguments carry no secret value). */
export function printable(argv) {
  return argv.map(quote).join(' ');
}

/** Dollars an opencode JSON event stream reports: each message's highest `cost` (messages
 * are re-sent as they grow), summed. `null` when no event carried a cost. */
export function costOf(lines) {
  const costs = new Map();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (typeof value.cost === 'number' && Number.isFinite(value.cost)) {
      const key = typeof value.id === 'string' ? value.id : `anon-${costs.size}`;
      costs.set(key, Math.max(costs.get(key) ?? 0, value.cost));
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const line of lines) {
    try {
      visit(JSON.parse(line), 0);
    } catch {}
  }
  if (!costs.size) return null;
  return [...costs.values()].reduce((a, b) => a + b, 0);
}

const PLATFORM = 'commits@yonedarepo.invalid';

/**
 * The verdict on main after the runs. `log`: main's commits `{ sha, parents, author, committer }`
 * (emails); `sessions`: commit → its session records; `contexts`: wave-2 agent → the start
 * context it got; `summaries`: wave-1 session summaries.
 */
export function verdict({ tasks: all, util, changelog, log, sessions, contexts = {}, summaries = [] }) {
  const problems = [];
  for (const t of all) {
    if (!new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${t.fn}\\b|const\\s+${t.fn}\\s*=)`).test(util)) problems.push(`${t.agent}: ${t.fn} is not on main`);
    if (!changelog.split('\n').some((l) => l.trim() === t.changelog)) problems.push(`${t.agent}: its CHANGELOG line is not on main`);
  }
  const agentEmails = new Set(all.map((t) => t.email));
  const merges = log.filter((c) => c.parents.length > 1);
  const localMerges = merges.filter((c) => c.committer !== PLATFORM);
  if (localMerges.length) problems.push(`history is not linear: ${localMerges.length} merge commit(s) made in a clone (${localMerges.map((c) => c.sha.slice(0, 7)).join(', ')})`);
  const agentCommits = log.filter((c) => c.parents.length === 1 && agentEmails.has(c.author));
  for (const t of all)
    if (!agentCommits.some((c) => c.author === t.email)) problems.push(`${t.agent}: no commit of its own on main`);
  const unrecorded = agentCommits.filter((c) => !(sessions[c.sha] ?? []).some((s) => s.cli === 'opencode' && String(s.session_id ?? '').startsWith('opencode:')));
  if (unrecorded.length) problems.push(`${unrecorded.length} agent commit(s) without an opencode session record: ${unrecorded.map((c) => c.sha.slice(0, 7)).join(', ')}`);
  const heads = summaries.map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean);
  for (const [agent, text] of Object.entries(contexts)) {
    const folded = text.replace(/\s+/g, ' ');
    if (!heads.some((h) => folded.includes(h))) problems.push(`${agent}: its start context names no first-wave session`);
  }
  return {
    ok: problems.length === 0,
    problems,
    metrics: { agent_commits: agentCommits.length, server_merges: merges.length - localMerges.length, local_merges: localMerges.length, recorded: agentCommits.length - unrecorded.length },
  };
}
