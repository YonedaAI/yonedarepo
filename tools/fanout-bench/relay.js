// One Worker invocation holds at most six connections, so a large fan-out cannot leave one
// invocation, and thousands of requests should not leave one laptop. A relay request carries
// many `{repo, writers}` batches; this Worker splits them across six calls to itself until each
// call is one batch, which runs as usual. A driver connection covers RELAY_MAX batches, and each
// hop adds one Worker-to-Worker call to when a batch starts.
export const BENCH_VERSION = 4;
export const RELAY_MAX = 50;
const WIDTH = 6;
const REPO = /^r[0-9a-f]{20}$/;

export const validRelay = (batches) =>
  Array.isArray(batches) && batches.length > 0 && batches.length <= RELAY_MAX && batches.every((b) => REPO.test(b?.repo ?? '') && Array.isArray(b.writers) && b.writers.length > 0 && b.writers.length <= 5);

/** Splits `batches` into at most WIDTH groups, in order, of nearly equal size. */
export function splitBatches(batches, width = WIDTH) {
  const count = Math.min(width, batches.length);
  const groups = [];
  for (let i = 0, from = 0; i < count; i++) {
    const size = Math.ceil((batches.length - from) / (count - i));
    groups.push(batches.slice(from, from + size));
    from += size;
  }
  return groups;
}

const failedBatch = (batch, message) => {
  const failed = { status: 0, error: 'BENCH_CLIENT', message, started_at: Date.now() };
  return { repo: batch.repo, results: batch.writers.map(() => ({ commit: failed, land: null })) };
};

/** Sends each group to this Worker; a failed call counts its writers as failed, not the run. */
export async function fanOut({ origin, key, target, batches }, send = fetch) {
  const replies = await Promise.all(
    splitBatches(batches).map(async (group) => {
      const body = group.length === 1 ? { target, ...group[0] } : { target, relay: group };
      const response = await send(origin, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bench-key': key }, body: JSON.stringify(body) }).catch((e) => ({ status: 0, text: async () => String(e?.message ?? e) }));
      if (response.status !== 200) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
        return group.map((batch) => failedBatch(batch, `relay answered ${response.status}: ${detail}`));
      }
      const value = await response.json();
      return group.length === 1 ? [{ repo: group[0].repo, results: value.results }] : value.batches;
    }),
  );
  return replies.flat();
}
