// Many blobs for one job (search indexing and grep, blame, warm-start seeds), a bounded wave
// at a time: bundled ones in a few ranged reads (bridging WIDE_GAP), the rest through the
// read tiers WIDTH at a time. One tiered walk per file, all at once, held every walk of a 12,000-file push in one isolate
// (the jobs consumer ended exceededMemory) and cost about five subrequests per file.
import { RANGE, readBundled, WIDE_GAP } from './repo-bundles';
import { inBatches } from './repo-git-objects';
import type { RepoObjects } from './repo-objects';
import { quarantined } from './repo-quarantine-guard';

/** Tiered reads in flight at a time. */
const WIDTH = 32;
/** Blobs asked of the bundles per wave; a wave's bytes are held until the caller uses them. */
const WAVE = 512;

/** The content of `ids` (each once), a wave at a time, as `[id, bytes]` pairs. Throws as
 * the tiers do when no tier holds one, and QUARANTINED for a withheld blob, before reading. */
export async function* blobWaves(objects: RepoObjects, ids: string[]) {
  const unique = [...new Set(ids)];
  const [held] = await objects.withheldAmong(unique);
  if (held) throw quarantined(held[0], held[1]);
  for (let i = 0; i < unique.length; i += WAVE) {
    const wave = unique.slice(i, i + WAVE);
    // Only a repository this isolate knows holds bundles is asked where they are.
    // Copies, so a long read bridging gaps is let go once its files are taken out.
    const bundled = await readBundled(
      objects.env,
      objects.repo,
      wave.map((id) => ({ id, kind: 'blob' })),
      RANGE,
      { gap: WIDE_GAP, copy: true },
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
