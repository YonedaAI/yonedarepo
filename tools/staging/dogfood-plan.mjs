// The pure half of kit item 30 (`--dogfood`, dogfood-flow.mjs): scratch branch names and the
// guard every write goes through, the repository lookup, secret scrubbing, named and timed
// steps, and what each agent is asked and judged on. No processes and no network, so it is
// unit-tested (tests/runtime/dogfood.test.mjs).

/** Every ref this run writes starts with `dogfood/<ts>-`; `ts` is the run's digits. */
export const scratchPrefix = (ts) => `dogfood/${ts}-`;

/** This run's scratch branches (short names). */
export function scratchRefs(ts) {
  const p = scratchPrefix(ts);
  return {
    base: `${p}base`,
    work: `${p}work`,
    pick: `${p}pick`,
    changeBase: `${p}cbase`,
    change: `${p}change`,
    behind: `${p}behind`,
    tag: `${p}tag`,
    agent: (n) => `${p}agent-${n}`,
  };
}

/**
 * The short branch name of `ref`, or a throw when it is not one of this run's scratch
 * branches: main, dev and every other ref of the owner's repository are never written.
 */
export function scratch(ref, ts) {
  const name = String(ref).replace(/^refs\/(heads|tags)\//, '');
  if (!/^\d+$/.test(String(ts)) || !name.startsWith(scratchPrefix(ts)) || name.length === scratchPrefix(ts).length || /\.\.|[\s~^:?*[\\]|@\{/.test(name))
    throw new Error(`refusing to write ${ref}: not a ${scratchPrefix(ts)}* scratch ref`);
  return name;
}

/** The repository named (or with the id) `wanted` among the account's; exactly one. */
export function pickRepo(repos, wanted) {
  const hits = (repos ?? []).filter((r) => r.id === wanted || r.name === wanted);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`no repository named ${wanted} in the owner's list (${(repos ?? []).length} repositories)`);
  throw new Error(`${hits.length} repositories match ${wanted} (${hits.map((r) => r.id).join(', ')}); pass --dogfood-repo <id>`);
}

/** Replaces every secret (the set may grow later) in `text`; short values are ignored. */
export function scrubber(secrets) {
  return (text) => [...secrets].filter((s) => typeof s === 'string' && s.length >= 8).reduce((t, s) => t.split(s).join('[secret]'), String(text));
}

/**
 * Runs `list` (`[name, run, { soft }]`) in order, timing each into `metrics.steps`. A failed
 * step names itself; a soft failure is kept in `metrics.findings` and the remaining steps
 * still run, then the first finding fails the whole list. A step returning `{ skip }` is
 * recorded as skipped.
 */
export async function timedSteps(metrics, list, scrub = String) {
  metrics.steps ??= {};
  metrics.findings ??= [];
  for (const [name, run, options = {}] of list) {
    const started = performance.now();
    try {
      const outcome = await run();
      metrics.steps[name] = outcome?.skip ? `skipped: ${outcome.skip}` : Math.round(performance.now() - started);
    } catch (e) {
      const message = `${name}: ${scrub(e?.message ?? e)}`;
      if (!options.soft) throw new Error(message);
      metrics.steps[name] = 'FAILED';
      metrics.findings.push(message);
    }
  }
  if (metrics.findings.length) throw new Error(metrics.findings.join('; '));
}

/** This run's refs still on the platform (`refs` is GET /refs' map). */
export function leftovers(refs, ts) {
  const p = scratchPrefix(ts);
  return Object.entries(refs ?? {})
    .filter(([name]) => name.startsWith(`refs/heads/${p}`) || name.startsWith(`refs/tags/${p}`))
    .map(([ref, commit]) => ({ ref, commit }));
}

/** The largest `ext` file in `git ls-tree -r -l` output, for a blame of a big file. */
export function largestFile(lsTree, ext = '.rs') {
  let best = null;
  for (const line of String(lsTree).split('\n')) {
    const match = line.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/);
    if (match && match[2].endsWith(ext) && (!best || Number(match[1]) > best.bytes)) best = { path: match[2], bytes: Number(match[1]) };
  }
  return best;
}

/** An older log version to read at: halfway back, at least 1. */
export const olderVersion = (version) => Math.max(1, Math.floor(Number(version) / 2));

/** Real files agents read and summarize (one each); a missing one falls back to README.md. */
export const AGENT_FILES = [
  'README.md',
  'AGENTS.md',
  'backend/crates/yoneda-core/src/lib.rs',
  'cloudflare/worker/repo-api.ts',
  'backend/crates/yoneda-platform/src/repo_store/land.rs',
  'backend/crates/yoneda-cli/src/change_cmd.rs',
  'docs/runbook.md',
  'tools/staging-realworld.mjs',
];
export const MAX_DOGFOOD_AGENTS = AGENT_FILES.length;

/** Agent `n`'s harmless task: one new file under .dogfood/ on its own scratch branch. */
export function agentTask(n, ts) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DOGFOOD_AGENTS) throw new Error(`1-${MAX_DOGFOOD_AGENTS} dogfood agents`);
  const branch = scratchRefs(ts).agent(n);
  const note = `.dogfood/agent-${n}.md`;
  const read = AGENT_FILES[n - 1];
  const text = [
    `You are working in a Git clone of the YonedaRepo codebase (remote origin), on the branch ${branch}.`,
    `1. Read ${read} (if it does not exist, read README.md instead).`,
    `2. Create the file ${note} with exactly two lines: "# Dogfood agent ${n}" and one sentence saying what the file you read is for.`,
    'Change, add or delete no other file.',
    `3. Commit with the message "dogfood agent ${n}: note on ${read}" and push with: git push origin ${branch}`,
    'Never push to main or dev, never force-push and never open a change; the operator does that.',
    'When the push has succeeded, answer with one sentence saying what you changed.',
  ].join('\n');
  return { agent: `agent-${n}`, n, branch, note, read, text, email: `dogfood-agent-${n}@yonedarepo.invalid` };
}

/**
 * What is wrong with agent `task`'s result: `head` its branch head (null: never pushed),
 * `base` the commit it started from, `paths` the files changed between them, `sessions` the
 * head's session records, `listed` the session ids the change page lists ([] when none).
 */
export function agentProblems(task, { head, base, paths = [], sessions = [], listed = [] }) {
  if (!head) return [`${task.agent}: ${task.branch} was not pushed`];
  if (head === base) return [`${task.agent}: ${task.branch} has no commit of its own`];
  const problems = [];
  if (paths.join() !== task.note) problems.push(`${task.agent}: changed ${paths.join(', ') || 'nothing'}, not only ${task.note}`);
  const recorded = sessions.filter((s) => s.cli === 'opencode' && String(s.session_id ?? '').startsWith('opencode:'));
  if (!recorded.length) problems.push(`${task.agent}: its head has no opencode session record`);
  else if (!recorded.some((s) => listed.includes(s.id))) problems.push(`${task.agent}: its session is not listed on its change`);
  return problems;
}
