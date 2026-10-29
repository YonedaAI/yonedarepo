// The pure half of kit item 30, the real-user flow (`--realuser`, realuser-flow.mjs): scratch
// branch names and the guard every write goes through, the repository lookup, imports and the
// default open-source set, secret scrubbing, named and timed steps, what to read in a repository
// of any language, and each agent's small real task and verdict. No processes and no network,
// so it is unit-tested (tests/runtime/realuser.test.mjs).
import { basename } from 'node:path';

/** Every ref this run writes starts with `realuser/<ts>-`; `ts` is the run's digits. */
export const scratchPrefix = (ts) => `realuser/${ts}-`;

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
    agentBase: `${p}abase`,
    agent: (n) => `${p}agent-${n}`,
  };
}

/**
 * The short branch name of `ref`, or a throw when it is not one of this run's scratch
 * branches: main, dev and every other ref of a repository are never written.
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
  throw new Error(`${hits.length} repositories match ${wanted} (${hits.map((r) => r.id).join(', ')}); pass the id`);
}

/**
 * Small, popular open-source repositories (permissive licences) for agents on several
 * repositories at once; sizes as measured on 2026-10-28 (GitHub size, default branch).
 */
export const DEFAULT_IMPORTS = [
  { name: 'oss-cobra', source: 'https://github.com/spf13/cobra.git', note: 'Go, Apache-2.0, 2.1 MB, 1106 commits, 66 files' },
  { name: 'oss-commander', source: 'https://github.com/tj/commander.js.git', note: 'JavaScript, MIT, 4.1 MB, 1517 commits, 219 files' },
  { name: 'oss-click', source: 'https://github.com/pallets/click.git', note: 'Python, BSD-3-Clause, 5.1 MB, 3379 commits, 178 files' },
];

const REPO_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** `--import name=source` values as `{ name, source }`; a source is an HTTPS Git URL or a path. */
export function parseImports(values = []) {
  return values.map((value) => {
    const at = value.indexOf('=');
    const [name, source] = at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [null, value];
    if (!name || !REPO_NAME.test(name)) throw new Error(`--import ${value}: expected <repository name>=<git url or local path>`);
    // https:// or a path; never ssh, git://, http:// or scp-like host:path.
    if (!source || !(/^https:\/\/\S+$/.test(source) || !/^[^/]*:/.test(source))) throw new Error(`--import ${value}: the source must be an https:// URL or a local path`);
    return { name, source };
  });
}

/**
 * Why `source` must not be imported (null when it may): the platform's own codebase is never
 * test data. `sourceTop` is a local source's Git top level (null for a URL), `root` the kit's.
 */
export function importRefusal({ source, sourceTop, root }) {
  if (/yonedarepo/i.test(source) || (sourceTop && /yonedarepo/i.test(basename(sourceTop)))) return 'the yonedarepo codebase is never test data';
  if (sourceTop && root && sourceTop === root) return "the kit's own checkout is never test data";
  return null;
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

/**
 * Problems and warnings for a repository's protected refs (`refs`) after the run: `was` and
 * `now` map each to its commit (absent and null are the same), `entries` are the log entries
 * since the snapshot. A move this run's tokens made (`token:realuser-<ts>-*`) or that the log
 * does not explain fails the run; one by anyone else (the owner committing meanwhile) is a
 * warning naming who.
 */
export function protectedMoves({ repo, refs, was, now, entries = [], ts }) {
  const problems = [];
  const warnings = [];
  for (const ref of refs) {
    const [before, after] = [was[ref] ?? null, now[ref] ?? null];
    if (before === after) continue;
    const moves = entries.filter((e) => e.refname === ref);
    const actors = [...new Set(moves.map((e) => String(e.actor)))];
    const line = `${repo} ${ref} moved during the run: ${before} -> ${after}`;
    if (!moves.length) problems.push(`${line} (no log entry explains it)`);
    else if (actors.some((a) => a.startsWith(`token:realuser-${ts}-`))) problems.push(`${line} by this run (${actors.join(', ')})`);
    else warnings.push(`${line} by ${actors.join(', ')}, not this run`);
  }
  return { problems, warnings };
}

/** This run's refs still on the platform (`refs` is GET /refs' map). */
export function leftovers(refs, ts) {
  const p = scratchPrefix(ts);
  return Object.entries(refs ?? {})
    .filter(([name]) => name.startsWith(`refs/heads/${p}`) || name.startsWith(`refs/tags/${p}`))
    .map(([ref, commit]) => ({ ref, commit }));
}

const TEXT = /\.(md|markdown|rst|txt|adoc|js|mjs|cjs|jsx|ts|tsx|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|lua|ex|exs|scala|clj|hs|ml|toml|ya?ml|json|html|css|scss|vue|svelte)$/i;
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|(^|\/)(vendor|node_modules|dist|build)\/|\.min\.(js|css)$/;
const DOC = /\.(md|markdown|rst|txt|adoc)$/i;
const SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|lua|ex|exs|scala)$/i;

/** `{ path, bytes }` of the text blobs in `git ls-tree -r -l` output (no lockfiles or vendored). */
export function textFiles(lsTree) {
  const files = [];
  for (const line of String(lsTree).split('\n')) {
    const match = line.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/);
    if (match && TEXT.test(match[2]) && !GENERATED.test(match[2])) files.push({ path: match[2], bytes: Number(match[1]) });
  }
  return files;
}

/** What the reads step blames and searches: the README, the largest text file (under 1 MB). */
export function readTargets(lsTree) {
  const files = textFiles(lsTree);
  const largest = files.filter((f) => f.bytes <= 1 << 20).sort((a, b) => b.bytes - a.bytes)[0] ?? null;
  const readme = files.find((f) => /^readme(\.[a-z]+)?$/i.test(f.path)) ?? largest;
  return { readme: readme?.path ?? null, largest };
}

const COMMON = new Set(
  'this that with from return function const class import export public private static void true false null none self string number await async else elif then while for each case break continue default struct impl type interface package module require include define where when what which there their have been will would should could about into only also more than some such each other these those value values data name names file files test tests error errors func main'.split(' '),
);

/** A common identifier of `text` to search the repository for (4-30 characters, not a keyword). */
export function commonIdentifier(text) {
  const counts = new Map();
  for (const [word] of String(text).matchAll(/[A-Za-z_][A-Za-z0-9_]{3,29}/g)) {
    if (COMMON.has(word.toLowerCase())) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/** An older log version to read at: halfway back, at least 1. */
export const olderVersion = (version) => Math.max(1, Math.floor(Number(version) / 2));

/**
 * Files agents may edit in one repository, `count` of them, all distinct: documentation
 * first (a clarity fix), then source files (a short comment), 300 B to 40 KB each.
 */
export function agentTargets(lsTree, count) {
  const sized = textFiles(lsTree).filter((f) => f.bytes >= 300 && f.bytes <= 40_000 && !f.path.startsWith('.'));
  const docs = sized.filter((f) => DOC.test(f.path)).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const sources = sized.filter((f) => SOURCE.test(f.path)).sort((a, b) => b.bytes - a.bytes);
  const picked = [];
  for (let i = 0; picked.length < count && (i < docs.length || i < sources.length); i++)
    for (const f of [docs[i], sources[i]]) if (f && picked.length < count) picked.push(f.path);
  return picked;
}

/** The kind of harmless real task a file gets. */
export const taskKind = (path) => (DOC.test(path) ? 'doc' : 'comment');

/** Agent `n`'s task on repository `repo`: one small real edit to `target` on its own branch. */
export function agentTask({ n, ts, repo, target }) {
  if (!Number.isInteger(n) || n < 1) throw new Error('agents are numbered from 1');
  if (!target) throw new Error(`no file for agent ${n} in ${repo}`);
  const branch = scratchRefs(ts).agent(n);
  const kind = taskKind(target);
  const edit =
    kind === 'doc'
      ? `In ${target}, fix one typo or make one unclear sentence clearer. If you find neither, add one short sentence that clarifies the text nearby.`
      : `In ${target}, add one short comment (one or two lines, in the file's own comment syntax) explaining what a function or block near the top does. Change no code.`;
  const text = [
    `You are working in a Git clone of the open-source repository ${repo} (remote origin), on the branch ${branch}.`,
    `1. ${edit}`,
    `Change only ${target}: edit, add or delete no other file, and keep the change small.`,
    `2. Commit with the message "${kind === 'doc' ? 'docs' : 'comment'}: ${kind === 'doc' ? 'clarify' : 'explain'} ${target}" and push with: git push origin ${branch}`,
    'Never push to main or any other branch, never force-push and never open a change; the operator does that.',
    'When the push has succeeded, answer with one sentence saying what you changed.',
  ].join('\n');
  return { agent: `${repo}-agent-${n}`, n, repo, branch, target, kind, text, email: `realuser-agent-${n}@yonedarepo.invalid` };
}

/**
 * What is wrong with agent `task`'s result: `head` its branch head (null: never pushed),
 * `base` the commit it started from, `paths` the files changed between them, `sessions` the
 * head's session records, `listed` the session ids its change lists ([] when none), `status`
 * the change's status after landing through it.
 */
export function agentProblems(task, { head, base, paths = [], sessions = [], listed = [], status }) {
  if (!head) return [`${task.agent}: ${task.branch} was not pushed`];
  if (head === base) return [`${task.agent}: ${task.branch} has no commit of its own`];
  const problems = [];
  if (paths.join() !== task.target) problems.push(`${task.agent}: changed ${paths.join(', ') || 'nothing'}, not only ${task.target}`);
  const recorded = sessions.filter((s) => s.cli === 'opencode' && String(s.session_id ?? '').startsWith('opencode:'));
  if (!recorded.length) problems.push(`${task.agent}: its head has no opencode session record`);
  else if (!recorded.some((s) => listed.includes(s.id))) problems.push(`${task.agent}: its session is not listed on its change`);
  // The plugin records the model the session ran on (`provider/model`), never a placeholder.
  if (recorded.length && !recorded.some((s) => /^[^/\s]+\/\S+$/.test(String(s.model ?? '')))) problems.push(`${task.agent}: its session record names no model (${recorded.map((s) => s.model ?? 'null').join(', ')})`);
  if (status !== 'landed') problems.push(`${task.agent}: its change is ${status ?? 'not opened'}, not landed on its base`);
  return problems;
}
