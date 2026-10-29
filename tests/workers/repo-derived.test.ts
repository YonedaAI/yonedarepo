// N5: derived data recomputes only changed partitions; blame, path history and renames
// come from the log and objects; bisect finds an injected bad commit using platform
// check runs; vacuum releases only safe hidden refs.
import { expect, it } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import { projectRefs } from '../../cloudflare/worker/repo-projection';
import { api, author, executed, file, pushes, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function setup(name: string, policy: unknown, files: ReturnType<typeof file>[]) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy, files, author } });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  // Lands one commit and returns main's Git head after it: the commit built for its batch,
  // which is what main's history (log, blame, bisect) is made of.
  const land = async (changes: unknown[], message: string) => {
    const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes, message, author } });
    expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } })).body.landed).toBe(true);
    return (await api(`${repo}/refs`, owner)).body.refs['refs/heads/main'] as string;
  };
  return { owner, repo, root: created.body.commit as string, land };
}

it('searches with partition reuse, blames lines and detects renames', async () => {
  const policy = { required_checks: [], approvals: 0 };
  const { owner, repo, root, land } = await setup('searcher', policy, [
    file('src/retry.rs', 'fn retry_with_backoff() {}\n'),
    file('docs/guide.md', 'Use retry_with_backoff for flaky calls.\n'),
    file('README.md', 'top level\n'),
  ]);
  const first = await api(`${repo}/search?query=retry_with`, owner);
  expect(first.body.results.map((r: any) => r.path).sort()).toEqual(['docs/guide.md', 'src/retry.rs']);
  expect(first.body.results.find((r: any) => r.path === 'src/retry.rs').lines[0]).toEqual({
    line: 1,
    text: 'fn retry_with_backoff() {}',
    ranges: [[3, 13]],
  });
  expect(first.body.partitions_built).toBe(3);

  const docs = await land([file('docs/guide.md', 'Use retry_with_backoff.\nAlso RETRY_WITH caps.\n')], 'docs');
  const second = await api(`${repo}/search?query=retry_with&ignore_case=true`, owner);
  expect(second.body.partitions_built).toBe(1); // only docs/ changed
  expect(second.body.results.find((r: any) => r.path === 'docs/guide.md').lines).toHaveLength(2);
  expect((await api(`${repo}/search?query=retry_with&at=1`, owner)).body.partitions_built).toBe(0);
  expect((await api(`${repo}/search?query=README`, owner)).body.results.map((r: any) => r.path)).toEqual(['README.md']);

  const beforeFix = (await api(`${repo}/refs`, owner)).body.version;
  const fix = await land([file('src/retry.rs', 'fn retry_with_backoff() {}\nfn jitter() {}\n')], 'jitter');
  const blame = await api(`${repo}/blame?path=src/retry.rs`, owner);
  expect(blame.body.lines.map((l: any) => l.commit)).toEqual([root, fix]);
  const history = await api(`${repo}/log?ref=main&path=docs/`, owner);
  expect(history.body.commits.map((c: any) => c.commit)).toEqual([docs, root]);
  // Time travel: blame and path history as of an earlier version, like the other reads.
  const then = await api(`${repo}/blame?path=src/retry.rs&at=${beforeFix}`, owner);
  expect(then.body.lines.map((l: any) => l.commit)).toEqual([root]);
  const past = await api(`${repo}/log?ref=main&path=docs/&at=1`, owner);
  expect(past.body.commits.map((c: any) => c.commit)).toEqual([root]);

  const renamed = await land([{ path: 'README.md', delete: true }, file('README.txt', 'top level\n')], 'rename');
  const diff = await api(`${repo}/diff?head=${renamed}`, owner);
  expect(diff.body.changes).toEqual([
    expect.objectContaining({ op: 'rename', path: 'README.txt', old_path: 'README.md' }),
  ]);
});

it('keeps search and codemod paths right when a directory is renamed or duplicated unchanged', async () => {
  // Part II's key-sufficiency defect: a renamed subtree keeps its tree id, so a segment
  // keyed by that id alone used to answer with the old directory's paths.
  const retry = 'fn retry_with_backoff() {}\n';
  const { owner, repo, land } = await setup('renamer', { required_checks: [], approvals: 0 }, [
    file('src/retry.rs', retry),
    file('README.md', 'top level\n'),
  ]);
  const paths = async (query: string) =>
    (await api(`${repo}/search?query=${query}`, owner)).body.results.map((r: any) => r.path).sort();
  expect(await paths('retry_with')).toEqual(['src/retry.rs']);

  await land([{ path: 'src/retry.rs', delete: true }, file('lib/retry.rs', retry)], 'rename src to lib');
  const renamed = await api(`${repo}/search?query=retry_with`, owner);
  expect(renamed.body.results.map((r: any) => r.path)).toEqual(['lib/retry.rs']);
  expect(renamed.body.partitions_built).toBe(0); // same subtree: its segment is reused
  expect(await paths('lib/retry')).toEqual(['lib/retry.rs']);
  expect(await paths('src/retry')).toEqual([]);

  await land([file('vendor/retry.rs', retry)], 'duplicate lib as vendor');
  const both = await api(`${repo}/search?query=retry_with`, owner);
  expect(both.body.results.map((r: any) => r.path).sort()).toEqual(['lib/retry.rs', 'vendor/retry.rs']);
  expect(both.body.partitions_built).toBe(0);

  const codemod = await api(`${repo}/codemods`, owner, { body: { find: 'retry_with_backoff', replace: 'retry_later', author } });
  expect(codemod.status).toBe(200);
  expect(codemod.body.touches.map((t: any) => t.path).sort()).toEqual(['lib/retry.rs', 'vendor/retry.rs']);
});

it('bisects to the first bad commit through platform check runs', async () => {
  // The fake executor passes when a.txt starts with "good".
  const policy = { required_checks: [], approvals: 0, runners: { unit: { command: ['true'] } } };
  const { owner, repo, root, land } = await setup('bisecter', policy, [file('a.txt', 'good\n')]);
  const commits = [];
  for (let i = 1; i <= 7; i++)
    commits.push(await land([file(`n${i}.txt`, `${i}\n`), ...(i === 4 ? [file('a.txt', 'bad\n')] : [])], `step ${i}`));
  queued.length = 0; // per-commit runs are not needed; bisect requests only what it reads
  let state = await api(`${repo}/bisect`, owner, { body: { good: root, bad: commits[6], check: 'unit' } });
  const before = executed.length;
  while (state.body.status === 'running') {
    const runs = queued.splice(0).filter((m) => m.kind === 'platform_check');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) await executeCheckRun(scoped, run);
    state = await api(`${repo}/bisect/${state.body.id}`, owner);
  }
  expect(state.body.status).toBe('found');
  expect(state.body.result.first_bad ?? JSON.parse(state.body.result).first_bad).toBe(commits[3]);
  // 7 candidates need at most ceil(log2 7) = 3 executions on candidate commits; duplicate
  // messages are fenced. (Landed failures also propose repairs, whose runs are excluded.)
  const tested = new Set<string>();
  for (const { name } of executed.slice(before)) {
    const run = await api(`${repo}/check-runs/${name.split(':')[0]}`, owner);
    if (commits.includes(run.body.commit_id)) tested.add(run.body.commit_id);
  }
  expect(tested.size).toBeLessThanOrEqual(3);
  expect(tested.has(commits[3])).toBe(true);
});

it('vacuums only hidden refs that are safe to release', async () => {
  const policy = { required_checks: [], approvals: 0 };
  // Too many objects to stage: pushed under its own hidden ref before it was accepted.
  const many = Array.from({ length: 300 }, (_, i) => file(`bulk/${i}.txt`, `${i}\n`));
  const { owner, repo, root } = await setup('vacuumer', policy, [file('a.txt', 'a\n'), ...many]);
  const unprojected = await api(`${repo}/vacuum`, owner, { body: {} });
  expect(unprojected.body).toMatchObject({ covered: 0, released: 0 });
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(scoped, message);
  const swept = await api(`${repo}/vacuum`, owner, { body: {} });
  expect(swept.body).toMatchObject({ covered: 1, released: 1, failed: [] });
  expect(pushes.at(-1)).toBe(`${root} ${'0'.repeat(40)} refs/yoneda/c/${root}`);
  expect((await api(`${repo}/vacuum`, owner, { body: {} })).body.released).toBe(0);
  expect((await api(`${repo}/blob?path=a.txt`, owner)).body.content).toBe('a\n');
});

it('pre-builds search segments after landing so queries find them ready', async () => {
  const { deriveAfterLanding } = await import('../../cloudflare/worker/repo-derived');
  const { owner, repo, land } = await setup('deriver', { required_checks: [], approvals: 0 }, [file('a/x.txt', 'alpha\n')]);
  await land([file('b/y.txt', 'beta\n')], 'add b');
  const jobs = queued.splice(0).filter((m) => m.kind === 'platform_derive');
  expect(jobs).toHaveLength(1);
  const built = await deriveAfterLanding(scoped, jobs[0]);
  expect(built.built).toBe(2);
  const found = await api(`${repo}/search?query=beta`, owner);
  expect(found.body).toMatchObject({ partitions_built: 0, results: [{ path: 'b/y.txt' }] });
});
