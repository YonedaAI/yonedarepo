// A read-only view of the server during a run: GETs on watched repositories (their log floor and
// tail, database size, object outbox and projection lag) and Cloudflare's analytics (queue depth,
// dead letters, resource kills, D1 traffic). Nothing here writes, and a source that cannot be
// read is named in `unreadable` rather than read as quiet. Its cost is in `requestsPerSample`.
const SEGMENT_VERSIONS = 1024;
/** Repositories watched at most, whatever the size of the run. */
export const WATCHED = 5;
/** A repository's status asks all 64 commit shards, so only this many report their outbox. */
export const OUTBOX_REPOS = 2;

/** What no source can give; repeated in every evidence file so nobody reads it as zero. */
export const NOT_READABLE = {
  d1_errors: 'Cloudflare publishes no D1 error count: see d1_errors from bench answers, and Worker errors',
  table_bytes: 'No dbstat on Durable Object SQLite: bytes are per database, table figures are row estimates',
};

/** Requests one sample sends to the platform for `repos` watched repositories. */
export const requestsPerSample = (repos) => {
  const watched = Math.min(repos, WATCHED);
  return watched + Math.min(watched, OUTBOX_REPOS) * 65;
};

/** Up to WATCHED ids, evenly spaced, so a large run is not judged by its first repositories. */
export function pickWatched(ids) {
  if (ids.length <= WATCHED) return [...ids];
  return Array.from({ length: WATCHED }, (_, i) => ids[Math.floor((i * ids.length) / WATCHED)]);
}

/** One repository's figures from `GET /repos/<id>/compaction` and, if read, `GET /repos/<id>`. */
export function repoFigures(repo, compaction, status) {
  return {
    repo,
    floor: compaction.floor ?? null,
    head: compaction.head ?? null,
    tail_rows: compaction.tail_rows ?? null,
    keep_versions: compaction.retention?.keep_versions ?? null,
    db_bytes: compaction.storage?.db_bytes ?? null,
    table_rows: compaction.storage?.table_rows ?? null,
    ...(status ? { outbox_pending: status.objects?.pending ?? null, projection_behind: Math.max(0, ...(status.projections ?? []).map((p) => p.target_version - p.projected_version)) } : {}),
  };
}

const reading = async (unreadable, source, read) => {
  try {
    return await read();
  } catch (e) {
    unreadable[source] = String(e?.message ?? e).slice(0, 200);
    return null;
  }
};

async function getOk(session, path) {
  const { status, body } = await session.call('GET', path);
  if (status !== 200) throw new Error(`${path.replace(/r[0-9a-f]{20}/, '<repo>')}: ${status} ${body?.error?.code ?? ''}`.trim());
  return body;
}

/** One sample: every watched repository, and Cloudflare's view of `window`. */
export async function sampleOnce(session, ids, analytics, window, at = Date.now()) {
  const unreadable = {};
  const repos = await Promise.all(
    ids.map(async (id, i) => {
      const compaction = await reading(unreadable, 'compaction', () => getOk(session, `/repos/${id}/compaction`));
      const status = i < OUTBOX_REPOS ? await reading(unreadable, 'status', () => getOk(session, `/repos/${id}`)) : null;
      return compaction ? repoFigures(id, compaction, status) : null;
    }),
  );
  const cloudflare = {};
  if (analytics) for (const [source, read] of Object.entries(analytics)) cloudflare[source] = await reading(unreadable, source, () => read(window));
  else unreadable.analytics = 'CF_ANALYTICS_TOKEN not set';
  return { at, repos: repos.filter(Boolean), cloudflare, unreadable };
}

const line = (s, began) => {
  const r = s.repos[0];
  const mb = r?.db_bytes === null || r?.db_bytes === undefined ? '?' : Math.round(r.db_bytes / 1e6);
  return `sample +${Math.round((s.at - began) / 1000)}s: floor ${r?.floor ?? '?'} tail ${r?.tail_rows ?? '?'} db ${mb} MB outbox ${r?.outbox_pending ?? '?'} jobs ${s.cloudflare.backlog?.jobs ?? '?'} dead ${s.cloudflare.backlog?.dead_letter ?? '?'}`;
};

/** Cloudflare resource kills seen in a sample: a limit error no answer shows. */
export const limitKills = (sample) => {
  const o = sample?.cloudflare?.objects;
  return o ? o.exceeded_cpu + o.exceeded_memory : 0;
};

const growthOf = (rows) => {
  const measured = rows.filter((r) => r.db_bytes !== null);
  if (measured.length < 2) return null;
  const [first, last] = [measured[0], measured.at(-1)];
  const versions = last.head - first.head;
  const perVersion = (n) => (versions > 0 ? Number((n / versions).toFixed(2)) : null);
  const tables = Object.keys(last.table_rows ?? {}).filter((t) => last.table_rows[t] !== first.table_rows?.[t]);
  return {
    versions,
    db_bytes_first: first.db_bytes,
    db_bytes_last: last.db_bytes,
    bytes_per_version: perVersion(last.db_bytes - first.db_bytes),
    rows_per_version: Object.fromEntries(tables.map((t) => [t, perVersion(last.table_rows[t] - (first.table_rows?.[t] ?? 0))])),
  };
};

const compactionOf = (rows) => {
  const seen = rows.filter((r) => r.tail_rows !== null);
  if (!seen.length) return null;
  const last = seen.at(-1);
  const bound = (last.keep_versions ?? 0) + SEGMENT_VERSIONS;
  return { floor_first: seen[0].floor, floor_last: last.floor, tail_max: Math.max(...seen.map((r) => r.tail_rows)), tail_last: last.tail_rows, bound, kept_up: last.tail_rows <= bound };
};

const span = (values) => {
  const seen = values.filter(Number.isFinite);
  return seen.length ? { max: Math.max(...seen), last: seen.at(-1) } : null;
};

/** What a run's samples add up to: growth and compaction per watched repository, backlogs. */
export function summarizeSamples(samples) {
  const ids = [...new Set(samples.flatMap((s) => s.repos.map((r) => r.repo)))];
  const rowsOf = (id) => samples.flatMap((s) => s.repos.filter((r) => r.repo === id));
  const last = samples.at(-1)?.cloudflare ?? {};
  const unreadable = {};
  for (const s of samples) for (const [source, why] of Object.entries(s.unreadable)) unreadable[source] = why;
  return {
    samples: samples.length,
    repos: ids.map((repo) => {
      const rows = rowsOf(repo);
      return { repo, growth: growthOf(rows), compaction: compactionOf(rows), outbox: span(rows.map((r) => r.outbox_pending)), projection_behind: span(rows.map((r) => r.projection_behind)) };
    }),
    queues: { jobs: span(samples.map((s) => s.cloudflare.backlog?.jobs)), checks: span(samples.map((s) => s.cloudflare.backlog?.checks)), dead_letter: span(samples.map((s) => s.cloudflare.backlog?.dead_letter)) },
    workers: last.workers ?? null,
    objects: last.objects ?? null,
    d1: last.d1 ?? null,
    unreadable,
    not_readable: NOT_READABLE,
  };
}

/** Samples every `every_ms` until `stop`, which waits `settle_ms` (background work catching up,
 * and analytics arriving) and then answers `{every_ms, summary, samples}`. */
export function startSampler({ session, repos, analytics, every_ms = 15_000, log = (text) => console.error(text) }) {
  const ids = pickWatched(repos);
  const began = Date.now();
  const samples = [];
  let running = true;
  let wake = () => {};
  const take = async () => {
    const sample = await sampleOnce(session, ids, analytics, { start: began, end: Date.now() });
    samples.push(sample);
    log(line(sample, began));
  };
  const loop = (async () => {
    while (running) {
      await take().catch((e) => log(`sample failed: ${e?.message ?? e}`));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, every_ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    /** Limit kills Cloudflare reports so far. */
    limits: () => limitKills(samples.at(-1)),
    async stop({ settle_ms = 0 } = {}) {
      if (settle_ms) await new Promise((resolve) => setTimeout(resolve, settle_ms));
      running = false;
      wake();
      await loop;
      await take().catch((e) => log(`sample failed: ${e?.message ?? e}`));
      return { every_ms, watched: ids, summary: summarizeSamples(samples), samples };
    },
  };
}

/** Runs `work(sampler)` with a sampler around it; `{sample: false}` runs it bare. */
export async function sampled(session, repos, o, work) {
  if (o.sample === false) return { value: await work(null), server: null };
  const sampler = startSampler({ session, repos, analytics: o.analytics, every_ms: o.sample_ms, log: o.log });
  try {
    const value = await work(sampler);
    return { value, server: await sampler.stop({ settle_ms: o.settle_ms ?? 0 }) };
  } catch (e) {
    await sampler.stop();
    throw e;
  }
}
