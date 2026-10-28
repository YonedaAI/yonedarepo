// Burst (the default workload): every writer commits one new file on main and lands it, all
// at once; then every file is read back at its landing's version. Reports client latency
// and the platform's Server-Timing totals, correctness counts, and how long main's Git
// projection lagged each landing.
import { b64 } from './driver.mjs';
import { latency } from '../load-metrics.mjs';
import { errors, failures, landPeak, landRate, ok, phases, shardLoad, stat } from './stats.mjs';

/** Waits (up to 5 min) until every changeset is projected; lag = projected - landed. */
async function projectionLag(session, repo) {
  const started = Date.now();
  let refused = 0;
  for (;;) {
    const entries = [];
    for (let after = 0; ; after += 500) {
      const { status, body: page } = await session.call('GET', `/repos/${repo}/txlog?after=${after}&limit=500`);
      // A busy authority may refuse a log read; count it and read again.
      if (status !== 200) {
        refused++;
        await new Promise((r) => setTimeout(r, 1000));
        after -= 500;
        continue;
      }
      entries.push(...page.entries);
      if (page.entries.length < 500) break;
    }
    const changes = entries.filter((e) => e.kind === 'changeset');
    const pending = changes.filter((e) => !e.projected?.at).length;
    if (!pending || Date.now() - started > 300_000)
      return { changesets: changes.length, unprojected: pending, refused_reads: refused, lag: latency(changes.filter((e) => e.projected?.at).map((e) => e.projected.at - e.committed_at_ms)) };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Read-back: latency of the correct reads, and each failure with its phases. */
function readSummary(rows) {
  const wrong = rows.filter((r) => !r.ok);
  return {
    client: latency(rows.filter((r) => r.ok).map((r) => r.ms)),
    correct: rows.length - wrong.length,
    errors: errors(rows),
    failures: failures(rows),
    phases: phases(rows, true),
    failed_phases: phases(wrong, true),
  };
}

export async function burst(session, { writers: count, principals, mode }) {
  const seed = Array.from({ length: 100 }, (_, i) => ({ path: `seed/${i}.txt`, content_b64: b64(`seed ${i}\n`) }));
  const repo = await session.createRepo(`fanout${count}`, seed);
  const tokens = principals === 'tokens' ? await session.mintTokens(repo, count) : [];
  const who = (i) => (tokens[i] ? { token: tokens[i] } : { cookie: session.cookie });

  const began = performance.now();
  const writes = await session.fanout(repo, Array.from({ length: count }, (_, i) => ({ ...who(i), mode, path: `writers/${i}.txt`, content: `writer ${i}\n` })));
  const elapsed = performance.now() - began;
  const projection = await projectionLag(session, repo);
  const reads = await session.fanout(repo, Array.from({ length: count }, (_, i) => ({ ...who(i), read: true, version: writes[i]?.land?.version, path: `writers/${i}.txt`, content: `writer ${i}\n` })));

  const commits = writes.map((w) => w.commit);
  const lands = writes.map((w) => w.land).filter(Boolean);
  return {
    repo,
    writers: count,
    principals,
    // Every writer shares one account session, verified on that account's one workspace
    // Durable Object per request (no auth result outlives its check, by decision).
    ...(principals === 'session' ? { known: 'shared-session auth serialization' } : {}),
    mode: mode ?? 'default',
    elapsed_ms: Math.round(elapsed),
    commit: { client: stat(commits, 'ms'), server: stat(commits, 'server'), ok: commits.filter(ok).length, errors: errors(commits), failures: failures(commits), phases: phases(commits), per_shard: shardLoad(commits) },
    land: { client: stat(lands, 'ms'), server: stat(lands, 'server'), ok: lands.filter(ok).length, errors: errors(lands), failures: failures(lands), phases: phases(lands), per_second: landRate(lands), peak_per_second: landPeak(lands) },
    projection,
    overloaded: [...commits, ...lands].filter((r) => r && !ok(r) && /overloaded/i.test(r.message ?? '')).length,
    read: readSummary(reads.map((r) => r.read)),
  };
}
