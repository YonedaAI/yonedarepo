// Many blobs for one job (search indexing, warm-start seeds), a bounded wave at a time:
// bundled ones in a few ranged reads, the rest through the read tiers WIDTH at a time. One
// tiered walk per file, all at once, held every walk of a 12,000-file push in one isolate
// (the jobs consumer ended exceededMemory) and cost about five subrequests per file.
import { readBundled, SMALL_RANGE } from './repo-bundles';
import { inBatches } from './repo-git-objects';
import type { RepoObjects } from './repo-objects';

/** Tiered reads in flight at a time. */
const WIDTH = 32;
/** Blobs asked of the bundles per wave; a wave's bytes are held until the caller uses them. */
const WAVE = 512;

/** The content of `ids` (each once), a wave at a time, as `[id, bytes]` pairs. Throws as
 * the tiers do when no tier holds one. */
export async function* blobWaves(objects: RepoObjects, ids: string[]) {
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += WAVE) {
    const wave = unique.slice(i, i + WAVE);
    // Only a repository this isolate knows holds bundles is asked where they are.
    const bundled = await readBundled(
      objects.env,
      objects.repo,
      wave.map((id) => ({ id, kind: 'blob' })),
      SMALL_RANGE,
    );
    const rest = wave.filter((id) => !bundled.has(id));
    const tiered = await inBatches(
      rest,
      WIDTH,
      async (id) => [id, await objects.blob(id)] as const,
    );
    yield [...bundled, ...tiered] as (readonly [string, Uint8Array])[];
  }
}

/** Runs `work` over `items`, WIDTH at a time (tree reads of a walk). */
export const inWaves = <T, R>(items: T[], work: (item: T) => Promise<R>) =>
  inBatches(items, WIDTH, work);
