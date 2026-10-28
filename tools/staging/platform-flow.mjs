// Platform items of the staging kit, through the public /api/v1 as a signed-in human:
// `git clone` of protected main from Artifacts checked byte for byte against the API tree,
// one check run in a container with no instance left afterwards, and a many-repo burst
// through the bench client Worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phases } from '../fanout-bench/stats.mjs';
import { latency } from '../load-metrics.mjs';
import { b64, until } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const wrangler = (args) => execFileSync('node_modules/.bin/wrangler', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

async function newRepo(platform, name, policy, files) {
  return platform.post('/repos', { name: `${name}-${Date.now()}`, policy, files, author });
}

/** Every regular file of `commit`, walked through the API: path → { bytes, executable }. */
async function apiTree(platform, repo, commit, path = '', files = new Map()) {
  const tree = await platform.get(`/repos/${repo}/tree?commit=${commit}&path=${encodeURIComponent(path)}`);
  for (const entry of tree.entries) {
    const full = path ? `${path}/${entry.name}` : entry.name;
    if (entry.type === 'tree') await apiTree(platform, repo, commit, full, files);
    else {
      const blob = await platform.get(`/repos/${repo}/blob?commit=${commit}&path=${encodeURIComponent(full)}`);
      files.set(full, { bytes: Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8'), executable: entry.type === 'exec' });
    }
  }
  return files;
}

export async function cloneMatchesApi(platform, metrics) {
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const repo = await newRepo(platform, 'kit-clone', { required_checks: [], approvals: 0 }, [
    { path: 'README.md', content_b64: b64('# Clone check\n') },
    { path: 'bin/run.sh', content_b64: b64('#!/bin/sh\necho staged\n'), executable: true },
    { path: 'assets/bytes.bin', content_b64: binary.toString('base64') },
    { path: 'src/deep/nested/unicode.txt', content_b64: b64('héllo wörld ✓\n') },
  ]);
  const made = await platform.post(`/repos/${repo.id}/commits`, { ref: 'main', changes: [{ path: 'src/added.txt', content_b64: b64('landed\n') }], message: 'Kit commit', author });
  await platform.post(`/repos/${repo.id}/land`, { ref: 'main', commit: made.commit });
  const access = await platform.post(`/repos/${repo.id}/clone`, {});
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${access.token}` };
  const git = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  // Batched landing projects main as its own Git commit (N11): the clone must hold the
  // commit the API reports for main, whose tree contains the landed change.
  const projected = performance.now();
  const main = await until(
    async () => {
      const head = (await platform.get(`/repos/${repo.id}/refs`)).refs['refs/heads/main'];
      return head && head !== repo.commit && git(['ls-remote', access.remote, 'refs/heads/main']).split(/\s/)[0] === head && head;
    },
    { timeoutMs: 180_000, intervalMs: 2000, what: 'main projected to Artifacts' },
  );
  metrics.projection_s = ((performance.now() - projected) / 1000).toFixed(1);
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-staging-clone-'));
  try {
    const started = performance.now();
    git(['clone', '--quiet', access.remote, dir]);
    metrics.clone_ms = Math.round(performance.now() - started);
    assert.equal(git(['rev-parse', 'HEAD'], dir), main, 'Clone HEAD differs from the API main');
    git(['fsck', '--strict'], dir);
    const expected = await apiTree(platform, repo.id, main);
    assert.ok(expected.has('src/added.txt'), 'Projected main lacks the landed change');
    const cloned = git(['ls-files'], dir).split('\n').filter(Boolean).sort();
    assert.deepEqual(cloned, [...expected.keys()].sort(), 'Cloned file set differs from the API tree');
    for (const [path, file] of expected) {
      assert.ok(readFileSync(join(dir, path)).equals(file.bytes), `Bytes differ: ${path}`);
      assert.equal(Boolean(statSync(join(dir, path)).mode & 0o100), file.executable, `Mode differs: ${path}`);
    }
    metrics.files_matched = expected.size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Live (not inactive) instances of the staging check container application. */
function liveCheckContainers() {
  const app = JSON.parse(wrangler(['containers', 'list', '--json'])).find((a) => a.name === 'yonedarepo-dev-platform-checkcontainer');
  assert.ok(app, 'Staging check container application not found');
  return JSON.parse(wrangler(['containers', 'instances', app.id, '--json'])).filter((i) => i.state !== 'inactive');
}

export async function containerCheck(platform, metrics) {
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test -f README.md && echo staged-ok'], timeout_seconds: 300 } } };
  const repo = await newRepo(platform, 'kit-check', policy, [{ path: 'README.md', content_b64: b64('# Check\n') }]);
  const made = await platform.post(`/repos/${repo.id}/commits`, { ref: 'main', changes: [{ path: 'src/a.txt', content_b64: b64('a\n') }], message: 'Kit check commit', author });
  let run = made.check_runs?.find((r) => r.name === 'unit');
  run ??= (await platform.post(`/repos/${repo.id}/commits/${made.commit}/check-runs`, { name: 'unit' })).runs[0];
  const started = performance.now();
  const done = await until(
    async () => {
      const current = await platform.get(`/repos/${repo.id}/check-runs/${run.id}`);
      return ['passed', 'failed', 'errored'].includes(current.status) && current;
    },
    { timeoutMs: 10 * 60_000, intervalMs: 5000, what: 'check run' },
  );
  metrics.check_s = ((performance.now() - started) / 1000).toFixed(1);
  metrics.check_duration_ms = done.result?.duration_ms;
  assert.equal(done.status, 'passed', `Check ${done.status}`);
  const log = await platform.get(`/repos/${repo.id}/check-runs/${run.id}/log`);
  assert.match(log.log ?? '', /staged-ok/, 'Check log lacks the command output');
  const idle = await until(() => liveCheckContainers().length === 0 || null, { timeoutMs: 5 * 60_000, intervalMs: 10_000, what: 'check containers to stop' }).catch(() => null);
  metrics.live_containers_after = idle ? 0 : liveCheckContainers().length;
  assert.ok(idle, 'Check containers still running five minutes after the run');
}

/** Sends writers to the bench client in batches of five; failed invocations count as failed writers. */
async function bench(client, key, target, jobs) {
  const replies = await Promise.all(
    jobs.map(async ({ repo, writers }) => {
      const response = await fetch(client, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bench-key': key }, body: JSON.stringify({ target, repo, writers }) });
      if (response.status !== 200) {
        const failed = { status: 0, error: `BENCH_CLIENT_${response.status}` };
        return writers.map(() => ({ commit: failed, land: null, read: { ...failed, ok: false } }));
      }
      return (await response.json()).results;
    }),
  );
  return replies.flat();
}

export async function manyRepoBurst(platform, { client, key, target, repos = 20, writers = 10 }, metrics) {
  const policy = { required_checks: [], approvals: 0 };
  const made = await Promise.all(
    Array.from({ length: repos }, async (_, r) => {
      const repo = await newRepo(platform, `kit-burst${r}`, policy, [{ path: 'README.md', content_b64: b64('# burst\n') }]);
      const { token } = await platform.post(`/repos/${repo.id}/tokens`, { name: 'burst', scopes: ['read', 'write', 'land'] });
      return { id: repo.id, token };
    }),
  );
  // `versions` maps repo/path to the version its landing returned: each reader passes it as
  // min_version (read-your-writes). An unpinned read of main is served from a published head
  // that may lag a landing by a few seconds (see git_cat_file in platform_tools.json).
  const jobs = (versions) =>
    made.flatMap(({ id, token }) =>
      [0, 5].filter((k) => k < writers).map((k) => ({
        repo: id,
        writers: Array.from({ length: Math.min(5, writers - k) }, (_, i) => {
          const path = `w/${k + i}.txt`;
          const writer = { token, path, content: `writer ${k + i}\n` };
          return versions ? { ...writer, read: true, version: versions.get(`${id}/${path}`) } : writer;
        }),
      })),
    );
  const order = (list) => list.flatMap(({ repo, writers: ws }) => ws.map((w) => `${repo}/${w.path}`));
  assert.ok(writers <= 10, 'The burst sends at most ten writers per repository');
  const started = performance.now();
  const writeJobs = jobs(null);
  const writes = await bench(client, key, target, writeJobs);
  const elapsed = performance.now() - started;
  const versions = new Map(order(writeJobs).map((at, i) => [at, writes[i]?.land?.version]));
  const readJobs = jobs(versions);
  const reads = await bench(client, key, target, readJobs);
  const ok = (r) => r?.status === 200;
  const lands = writes.map((w) => w.land).filter(ok);
  // Each failed read with what the platform answered (status, error code, message).
  const readFailures = order(readJobs)
    .map((at, i) => ({ at, read: reads[i]?.read }))
    .filter(({ read }) => !read?.ok)
    .map(({ at, read }) => `${at}@${versions.get(at) ?? '?'}: ${read?.status ?? 0} ${read?.error ?? (read?.status === 200 ? 'WRONG_CONTENT' : '')} ${read?.message ?? ''}`.trim());
  Object.assign(metrics, {
    writers: repos * writers,
    commits_ok: writes.filter((w) => ok(w.commit)).length,
    lands_ok: lands.length,
    reads_ok: reads.filter((r) => r.read?.ok).length,
    read_failures: readFailures,
    elapsed_s: (elapsed / 1000).toFixed(1),
    lands_per_s: (lands.length / (elapsed / 1000)).toFixed(1),
    land_p95_ms: latency(lands.map((l) => l.ms)).p95_ms,
    commit_p95_ms: latency(writes.filter((w) => ok(w.commit)).map((w) => w.commit.ms)).p95_ms,
    // Where commit time goes: each Server-Timing phase's p50/p95 across the writers.
    commit_phases: Object.fromEntries(Object.entries(phases(writes.map((w) => w.commit))).map(([k, v]) => [k, `${v.p50_ms}/${v.p95_ms}`])),
    // Phases only some commits report (a shard instance that had just started, a shard
    // already serving others): how many commits reported each.
    commit_phase_samples: Object.fromEntries(Object.entries(phases(writes.map((w) => w.commit))).filter(([, v]) => v.samples < writes.filter((w) => ok(w.commit)).length).map(([k, v]) => [k, v.samples])),
  });
  assert.equal(metrics.lands_ok, repos * writers, 'Not every writer landed');
  assert.equal(metrics.reads_ok, repos * writers, `Not every file read back: ${readFailures.slice(0, 5).join('; ')}`);
}
