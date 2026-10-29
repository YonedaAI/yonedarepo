// The pure half of the agent-tools kit item (30.6, realuser-agent-tools.mjs): which items a
// run takes, the source file and function a contract is recorded on, the edit that makes it
// stale, the bisect branch with its one breaking commit and the tiny command check that finds
// it, the policy change and its exact restore, and the answers each step looks for. No
// processes and no network, so it is unit-tested (tests/runtime/agent-tools.test.mjs).

/** `--agent-tools` alone: sign-in, the repository, the agent tools and cleanup (no clones,
 * everyday Git, change or reads). `--realuser` (or `--dogfood`) runs them after the reads. */
export function realuserItems(values) {
  const everyday = Boolean(values.realuser || values.dogfood);
  return { everyday, tools: everyday || Boolean(values['agent-tools']) };
}

/** Languages the platform's symbol extractor reads (platform_symbols::language). */
const SYMBOL_SOURCE = /\.(rs|ts|tsx|js|jsx|mjs|cjs)$/;
const NOT_SOURCE = /\.(min\.js|d\.ts)$|\.(test|spec)\.[a-z]+$/;
const SKIPPED_DIRS = /(^|\/)(node_modules|dist|build|vendor|target|tests?|__tests__|fixtures)(\/|$)/;

/** Repository paths of the files in `entries` (one tree listing of `dir`) whose symbols the
 * platform reads: Rust, TypeScript and JavaScript, never tests, vendored or minified. */
export function sourceCandidates(dir, entries) {
  if (SKIPPED_DIRS.test(dir)) return [];
  return (entries ?? [])
    .filter((e) => e.type === 'blob' && SYMBOL_SOURCE.test(e.name) && !NOT_SOURCE.test(e.name))
    .map((e) => (dir ? `${dir}/${e.name}` : e.name));
}

/** Directories of a tree listing worth walking for sources. */
export const subdirectories = (dir, entries) =>
  (entries ?? [])
    .filter((e) => e.type === 'tree')
    .map((e) => (dir ? `${dir}/${e.name}` : e.name))
    .filter((path) => !SKIPPED_DIRS.test(path) && !path.split('/').some((p) => p.startsWith('.')));

/** A real, mid-sized function of a file's symbols (a method when there is none): the one a
 * person would write a contract for. */
export function pickFunction(symbols) {
  const sized = (symbols ?? []).filter((s) => s.end - s.start >= 80 && s.end - s.start <= 8000);
  return sized.find((s) => s.kind === 'function') ?? sized.find((s) => s.kind === 'method');
}

/** The function's text with a marker comment inside its body (after the first `{`), or after
 * an arrow function's expression: the node digest changes and the file still parses. */
export function editedSource(source, ts) {
  if (!source) throw new Error('the symbol has no source to edit');
  const marker = ` /* realuser ${ts} */`;
  const brace = source.indexOf('{');
  return brace < 0 ? `${source}${marker}` : `${source.slice(0, brace + 1)}${marker}${source.slice(brace + 1)}`;
}

/**
 * `n` commits on a scratch file, each a child of the one before; commit `breakAt` (1-based)
 * and every later one write BROKEN. `breaking` is the 0-based index bisect must name.
 */
export function bisectPlan(ts, n, breakAt) {
  if (!/^\d+$/.test(String(ts))) throw new Error('ts must be the run digits');
  if (breakAt < 2) throw new Error('break after the first commit, so a midpoint passes');
  if (breakAt > n) throw new Error(`breakAt ${breakAt} is not within ${n} commits`);
  const file = `.realuser/${ts}-bisect.txt`;
  const commits = Array.from({ length: n }, (_, i) => ({
    message: `realuser ${ts}: bisect step ${i + 1}`,
    text: i + 1 >= breakAt ? `BROKEN since step ${breakAt}; step ${i + 1}\n` : `ok at step ${i + 1}\n`,
  }));
  return { file, commits, breaking: breakAt - 1 };
}

/** The policy runner bisect runs: a tiny command check, failing only on the BROKEN file. */
export function bisectRunner(plan) {
  const ts = plan.file.match(/\.realuser\/(\d+)-bisect\.txt$/)?.[1];
  return {
    name: `realuser-${ts}-bisect`,
    runner: { command: ['sh', '-c', `test ! -f '${plan.file}' || ! grep -q BROKEN '${plan.file}'`], timeout_seconds: 60 },
  };
}

/** `policy` with one more runner (not required: it runs only when asked). */
export function withRunner(policy, name, runner) {
  if (policy.runners?.[name]) throw new Error(`the policy already has a runner ${name}`);
  return { ...policy, runners: { ...(policy.runners ?? {}), [name]: runner } };
}

/** `policy` without runner `name`, leaving out `runners` when none remain (as the server does). */
export function withoutRunner(policy, name) {
  const { [name]: _, ...rest } = policy.runners ?? {};
  const { runners: __, ...others } = policy;
  return Object.keys(rest).length ? { ...others, runners: rest } : others;
}

/** Our authored record among `GET /contracts` records. */
export const contractListed = (records, { commit, path, symbol_path, contract }) =>
  (records ?? []).find(
    (r) => r.commit === commit && r.path === path && r.symbol_path === symbol_path && r.contract?.summary === contract.summary,
  );

/** Whether `GET /pins` lists `commit` with `reason`. */
export const pinListed = (pins, commit, reason) => (pins ?? []).some((p) => p.commit === commit && p.reason === reason);

/** Runs of check `name` across commit details (`GET /commits/:sha`) and their summed time. */
export function checkSeconds(details, name) {
  let runs = 0;
  let ms = 0;
  for (const detail of details ?? [])
    for (const run of detail.check_runs ?? []) {
      if (run.name !== name) continue;
      runs += 1;
      const result = typeof run.result === 'string' ? JSON.parse(run.result) : run.result;
      ms += Number(result?.duration_ms ?? 0);
    }
  return { runs, seconds: ms / 1000 };
}

/** The expected strings a page's text does not contain. */
export const missingText = (text, expected) => expected.filter((e) => !String(text).includes(e));

/**
 * What a finished bisect shows, for its evidence and its failure message: the final record
 * as answered, the first bad commit only when `result` is an object naming one, and every
 * run of check `name` on the candidates (step = 1-based position on the branch) with its
 * status, exit code and duration.
 */
export function bisectReport(done, commits, details, name) {
  const runs = [];
  commits.forEach((commit, i) => {
    for (const run of details[i]?.check_runs ?? []) {
      if (run.name !== name) continue;
      const result = typeof run.result === 'string' ? JSON.parse(run.result) : run.result;
      runs.push({ commit: commit.slice(0, 10), step: i + 1, status: run.status, exit_code: result?.exit_code, duration_ms: result?.duration_ms });
    }
  });
  const first_bad = typeof done?.result === 'object' && done.result ? done.result.first_bad : undefined;
  const lines = runs.map((r) => `step ${r.step} ${r.commit} ${r.status} exit ${r.exit_code ?? '?'} ${((r.duration_ms ?? 0) / 1000).toFixed(1)} s`);
  return { record: done, first_bad, runs, text: `bisect ${JSON.stringify(done)}; check runs: ${lines.join('; ') || 'none'}` };
}
