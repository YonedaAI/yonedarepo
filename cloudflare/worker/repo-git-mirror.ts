// A fetch of history only the repository's mirror holds, served from the mirror (with
// `FAST_IMPORT` on). An import's objects stay in Artifacts: read one by one they would take
// minutes (repo-pack-build refuses them), but Artifacts holds the whole history the moment it
// has fetched the remote, so the pack it builds streams straight through. This is what makes
// `git clone` and `git fetch` work as soon as main lands, while history is still recorded.
//
// Only what any reader may fetch goes this way: every want must be a current branch or tag
// that the mirror holds too (its other refs are hidden commits), and nothing may be withheld
// (a mirror still holds quarantined blobs). Any other fetch gets the answer it got before. A
// filter is not sent on, since Artifacts has none: a partial clone receives every file, which
// Git accepts. A direct import's stored pack answers most of these before Artifacts can
// (`importedClone`); a fetch nothing can serve waits for Artifacts, then is refused whole.
import { directImportOn, wholeClone } from './repo-import-direct';
import { advertised, fetchPack, type ShallowLines } from './repo-mirror-git';
import type { RepoObjects } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { packKey, storedPack } from './repo-pack-cache';
import { CHUNK, end, failed, RESULT, sendStored, sideBand } from './repo-pack-stream';

/** What a client asked to fetch. */
export type Asked = {
  wants: string[];
  haves: string[];
  depth?: number | null;
  shallows?: string[];
};

/** The refusal of a fetch the mirror could not serve while history is still arriving (`e`,
 * the authority's, says how far it came), `waited_ms` after it was asked. Nothing was sent:
 * the walk stops where the recorded history does, so a pack built from it would be missing
 * commits. */
export function stillFilling(e: any, waited_ms: number) {
  const reached = /\(\d+ of \d+ commits\)/.exec(String(e?.message))?.[0] ?? '';
  const waited = waited_ms < 1000 ? '' : ` after waiting ${Math.round(waited_ms / 1000)} s`;
  return new ApiError(
    'IMPORT_IN_PROGRESS',
    `This repository's history is still importing ${reached} and this fetch needs a copy of all of it, which is not ready${waited}; nothing was sent. Try again in a minute`,
  );
}

/** What a client that has nothing gets from a direct import's stored pack, the first thing
 * that holds all of the history: `lead`, then that pack. A pack holding the whole history can
 * only give a fetch more than it asked for, so a filter (as on the mirror) and a depth get it
 * too: depth 1 is that clone with the head marked shallow, and any other depth the whole
 * clone, the commits at that depth being more than this history can tell yet. Null for any
 * other fetch, and for wants that are not this repository's current tips. */
export async function importedClone(
  ctx: RepoContext,
  objects: RepoObjects,
  asked: Json,
  lead: (lines: ShallowLines) => Uint8Array,
) {
  const shaped = asked.deepen_relative || asked.shallows?.length;
  if (!directImportOn(objects.env) || asked.haves.length > 0 || shaped) return null;
  if (await objects.withholdsAny()) return null;
  const stored = await storedPack(
    objects.env,
    await packKey(objects.repo, wholeClone(asked.wants)),
  );
  if (!stored) return null;
  const { refs } = await ctx.call({ op: 'repo_refs' });
  const tips = new Set(Object.values(refs as Json));
  if (asked.wants.every((want: string) => tips.has(want))) {
    const shallow = asked.depth === 1 ? [...new Set<string>(asked.wants)] : [];
    return sendStored(lead({ shallow, unshallow: [] }), stored, CHUNK);
  }
  await stored.body.cancel();
  return null;
}

/** Answers a fetch the walk refused because history is still arriving: from what a direct
 * import stored (version 2 and side-band 64k, as it is stored), else from the mirror, which
 * may mean waiting for Artifacts to finish, bounded by the store (STORE_WAIT_MS). */
export async function fetchWhileFilling(
  ctx: RepoContext,
  objects: RepoObjects,
  asked: Json,
  lead: (lines: ShallowLines) => Uint8Array,
  band: number,
  refused: unknown,
) {
  const started = Date.now();
  const served =
    (band === CHUNK ? await importedClone(ctx, objects, asked, lead) : null) ??
    (await mirrorClone(ctx, objects, asked, lead, band, true));
  if (served) return served;
  throw stillFilling(refused, Date.now() - started);
}

/** Whether a mirror can answer this: the checks above, none of which read an object.
 * `whole`: history is still arriving, so main is the head the mirror imported. */
async function mirrorFor(ctx: RepoContext, objects: RepoObjects, asked: Json, whole: boolean) {
  if (objects.env.FAST_IMPORT !== 'on' || !objects.store.cloneAccess) return null;
  if (await objects.withholdsAny()) return null;
  const { refs } = await ctx.call({ op: 'repo_refs' });
  const tips = new Set(Object.values(refs as Json));
  if (!asked.wants.every((want: string) => tips.has(want))) return null;
  const mirror = await objects.store.cloneAccess();
  if (whole) return mirror;
  const held = new Set((await advertised(mirror)).map((ref) => ref.id));
  return asked.wants.every((want: string) => held.has(want)) ? mirror : null;
}

/** `head` (it may depend on the shallow lines the mirror answered), then the mirror's pack on
 * side-band `band` (none when 0), or null when the mirror cannot serve this fetch: the caller
 * then answers as it would have. The first bytes are awaited, so a mirror that fails at once
 * leaves that answer open as well. */
export async function mirrorClone(
  ctx: RepoContext,
  objects: RepoObjects,
  asked: Json,
  head: (lines: ShallowLines) => Uint8Array,
  band: number,
  whole = false,
): Promise<Response | null> {
  let pack: AsyncGenerator<Uint8Array>;
  let first: Uint8Array;
  const lines: ShallowLines = { shallow: [], unshallow: [] };
  try {
    const mirror = await mirrorFor(ctx, objects, asked, whole);
    if (!mirror) return null;
    pack = fetchPack(mirror, asked.wants, asked.haves, asked, lines);
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
      controller.enqueue(head(lines));
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
