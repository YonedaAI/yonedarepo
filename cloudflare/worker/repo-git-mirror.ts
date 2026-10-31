// A clone of history only the repository's mirror holds, served from the mirror (with
// `FAST_IMPORT` on). An import's objects stay in Artifacts: read one by one they would take
// minutes (repo-pack-build refuses them), but Artifacts holds the whole history the moment it
// has fetched the remote, so the pack it builds streams straight through. This is what makes
// a clone work as soon as main lands, while history is still being recorded.
//
// Only what any reader may fetch goes this way: every want must be a current branch or tag
// that the mirror holds too (its other refs are hidden commits), and nothing may be withheld
// (a mirror still holds quarantined blobs). A clone that wants anything else, a depth (not
// sent on) or an incremental fetch gets the answer it got before. A filter is not sent on
// either, since Artifacts has none: a partial clone receives every file, which Git accepts.
import { advertised, fetchPack } from './repo-mirror-git';
import type { RepoObjects } from './repo-objects';
import type { Json, RepoContext } from './repo-ops';
import { end, failed, RESULT, sideBand } from './repo-pack-stream';

/** What a client asked to fetch. */
export type Asked = {
  wants: string[];
  haves: string[];
  depth?: number | null;
  shallows?: string[];
};

/** Whether a mirror can answer this: the checks above, none of which read an object. */
async function mirrorFor(ctx: RepoContext, objects: RepoObjects, asked: Json) {
  if (objects.env.FAST_IMPORT !== 'on' || !objects.store.cloneAccess) return null;
  if (asked.haves.length > 0 || asked.depth != null || asked.shallows?.length) return null;
  if (await objects.withholdsAny()) return null;
  const { refs } = await ctx.call({ op: 'repo_refs' });
  const tips = new Set(Object.values(refs as Json));
  if (!asked.wants.every((want: string) => tips.has(want))) return null;
  const mirror = await objects.store.cloneAccess();
  const held = new Set((await advertised(mirror)).map((ref) => ref.id));
  return asked.wants.every((want: string) => held.has(want)) ? mirror : null;
}

/** `head`, then the mirror's pack on side-band `band` (none when 0), or null when the mirror
 * cannot serve this fetch: the caller then answers as it would have. The first bytes are
 * awaited, so a mirror that fails at once leaves that answer open as well. */
export async function mirrorClone(
  ctx: RepoContext,
  objects: RepoObjects,
  asked: Json,
  head: Uint8Array,
  band: number,
): Promise<Response | null> {
  let pack: AsyncGenerator<Uint8Array>;
  let first: Uint8Array;
  try {
    const mirror = await mirrorFor(ctx, objects, asked);
    if (!mirror) return null;
    pack = fetchPack(mirror, asked.wants, []);
    const next = await pack.next();
    if (next.done) return null;
    first = next.value;
  } catch (e: any) {
    console.warn(`mirror clone unavailable: ${e?.code ?? ''} ${e?.message ?? e}`);
    return null;
  }
  const packet = (bytes: Uint8Array) => (band ? sideBand(1, bytes, band) : bytes);
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      controller.enqueue(packet(first));
    },
    async pull(controller) {
      try {
        const next = await pack.next();
        if (next.done) end(controller, band);
        else controller.enqueue(packet(next.value));
      } catch (e) {
        failed(controller, band, e);
      }
    },
    async cancel() {
      await pack.return(undefined);
    },
  });
  return new Response(out, { headers: RESULT });
}
