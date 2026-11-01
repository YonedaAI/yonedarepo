// Many repositories at once: every repository gets its own writers (each commits one new file
// on main, in a directory unique to the run, and lands it), all side by side through the bench
// client's relay, then optionally one post-land check per repository on its main head. Reports
// landing throughput across repositories, per-repository latency, commit latency, overload
// refusals, check queue wait and container cold starts.
import { latency } from '../load-metrics.mjs';
import { runId, writerCredentials } from './credentials.mjs';
import { waves } from './repo-pool.mjs';
import { sampled } from './sampler.mjs';
import { errors, ok } from './stats.mjs';
import { d1Errors, expectedConflict, limitErrors, stopReasons, TARGETS } from './stop.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One repository's writers as bench client batches of five. */
export function batchesFor(repo, r, writers, run, tokenFor) {
  const batches = [];
  for (let k = 0; k < writers; k += 5)
    batches.push({
      repo,
      writers: Array.from({ length: Math.min(5, writers - k) }, (_, j) => ({ token: tokenFor(r, k + j), path: `bench/${run}/w${k + j}.txt`, content: `${run} writer ${k + j}\n` })),
    });
  return batches;
}

/** One post-land check per repository (setup retries; the wait is measured). Starts containers:
 * `checks: false` leaves it out. */
async function checkEach(session, repos) {
  const runner = { combined: { command: ['sh', '-c', 'test -f README.md'], timeout_seconds: 120 } };
  const checks = await waves(repos, 25, async (repo) => {
    await session.setup('PUT', `/repos/${repo}/policy`, { policy: { required_checks: [], approvals: 0, runners: runner } });
    const head = (await session.setup('GET', `/repos/${repo}/refs`)).refs['refs/heads/main'];
    await session.setup('POST', `/repos/${repo}/commits/${head}/check-runs`, { name: 'combined' });
    return { repo, head };
  });
  const deadline = Date.now() + 10 * 60_000;
  const finished = new Map();
  while (finished.size < checks.length && Date.now() < deadline) {
    await waves(checks.filter((c) => !finished.has(c.repo)), 25, async (c) => {
      const shown = await session.setup('GET', `/repos/${c.repo}/commits/${c.head}`).catch(() => null);
      const run = shown?.check_runs?.find((r) => r.name === 'combined');
      if (run && ['passed', 'failed', 'errored'].includes(run.status)) finished.set(c.repo, run);
    });
    if (finished.size < checks.length) await sleep(3000);
  }
  const runs = [...finished.values()];
  const evidence = runs.map((r) => (typeof r.result === 'string' ? JSON.parse(r.result) : (r.result ?? {})));
  return {
    requested: checks.length,
    finished: runs.length,
    statuses: Object.entries(runs.reduce((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {})),
    queue_wait: latency(evidence.map((e) => e.queued_ms).filter(Number.isFinite)),
    cold_starts: evidence.filter((e) => Number.isFinite(e.start_ms)).length,
    cold_start: latency(evidence.map((e) => e.start_ms).filter(Number.isFinite)),
    duration: latency(evidence.map((e) => e.duration_ms).filter(Number.isFinite)),
  };
}

/** A burst's figures and the stop rules it trips. */
export function summarizeBurst(writes, repos, { target_ms = TARGETS.many_repos_ms, server_limits = 0 } = {}) {
  const commits = writes.map((w) => w.commit);
  const lands = writes.map((w) => w.land).filter(Boolean);
  const landed = lands.filter(ok);
  const failed = writes.filter((w) => !ok(w.land)).map((w) => (ok(w.commit) ? w.land : w.commit));
  const first = Math.min(...landed.map((r) => r.started_at));
  const last = Math.max(...landed.map((r) => r.started_at + r.ms));
  const perRepo = repos.map((repo) => latency(writes.filter((w) => w.repo === repo && ok(w.land)).map((w) => w.land.ms)));
  const client = latency(landed.map((r) => r.ms));
  const counted = failed.filter((f) => !expectedConflict(f));
  return {
    commit: { client: latency(commits.filter(ok).map((r) => r.ms)), server: latency(commits.filter((r) => ok(r) && r.server !== null).map((r) => r.server)), ok: commits.filter(ok).length, errors: errors(commits) },
    land: {
      ok: landed.length,
      errors: errors(lands),
      per_second: landed.length ? Number(((landed.length * 1000) / Math.max(1, last - first)).toFixed(1)) : 0,
      client,
      per_repo_p50: latency(perRepo.map((l) => l.p50_ms).filter((v) => v !== null)),
      per_repo_p95: latency(perRepo.map((l) => l.p95_ms).filter((v) => v !== null)),
    },
    conflicts: failed.length - counted.length,
    failed: counted.length,
    d1_errors: d1Errors(failed).length,
    overloaded: failed.filter((r) => /overloaded/i.test(r?.message ?? '')).length,
    stop: stopReasons({ total: writes.length, errors: counted.length, p95_ms: client.p95_ms, target_ms, limits: limitErrors(failed).length + server_limits }),
  };
}

/** `o`: `repos` (ids, reused), `writers` per repository, `principals`, `checks`. */
export async function manyRepo(session, options) {
  const o = { principals: 'tokens', checks: false, target_ms: TARGETS.many_repos_ms, run: runId(), ...options };
  const { repos, writers, run } = o;
  const credentials = await writerCredentials(session, repos, { principals: o.principals, slots: writers, run, pats: o.pats });
  try {
    const batches = repos.flatMap((repo, r) => batchesFor(repo, r, writers, run, credentials.tokenFor));
    const { value, server } = await sampled(session, repos, o, async (sampler) => {
      const began = performance.now();
      const writes = await session.relayed(batches);
      const elapsed = performance.now() - began;
      const burst = summarizeBurst(writes, repos, { target_ms: o.target_ms, server_limits: sampler?.limits() ?? 0 });
      // A run that tripped a stop rule starts no containers on top of what broke.
      const checks = o.checks && !burst.stop.length ? await checkEach(session, repos) : null;
      return { elapsed, burst, checks };
    });
    const { burst } = value;
    const firstError = burst.land.errors[0]?.[0] ?? burst.commit.errors[0]?.[0];
    return {
      run,
      repos: repos.length,
      writers_per_repo: writers,
      principals: o.principals,
      clients: session.clients,
      elapsed_ms: Math.round(value.elapsed),
      ...burst,
      checks: value.checks,
      server,
      summary: {
        stage: o.stage ?? null,
        size: `${repos.length} × ${writers}`,
        arm: o.principals,
        clients: session.clients,
        rate_per_s: burst.land.per_second,
        land_p95_ms: burst.land.client.p95_ms,
        arrivals: repos.length * writers,
        errors: burst.failed,
        d1_errors: burst.d1_errors,
        bytes_per_version: null,
        compaction_kept_up: null,
        what_broke: burst.stop.length ? `${burst.stop.join(', ')}${firstError ? `: ${firstError}` : ''}` : null,
      },
    };
  } finally {
    const left = await credentials.revoke();
    if (left) console.error(`${left} credentials of run ${run} could not be revoked`);
  }
}
