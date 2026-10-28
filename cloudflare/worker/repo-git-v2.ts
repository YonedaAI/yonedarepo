// `git clone`/`fetch` over HTTPS with Git protocol version 2 (sent as `Git-Protocol:
// version=2`, Git's default since 2.26): `ls-refs`, and `fetch` with partial clones
// (`--filter=blob:none`, then single blobs wanted by id when a checkout needs them) and
// shallow ones (`--depth`, `--deepen`, `--unshallow`). The authority walks what to send
// (`repo_git_walk`); the pack streams as for version 0 (`repo-git-upload.ts`), always on
// side-band 64k. A client that does not ask for version 2 is served version 0 unchanged.
import { transient } from './durable';
import { compute } from './repo-compute';
import { UploadSession } from './repo-git-sessions';
import { CHUNK, errLine, REQUEST_BYTES, RESULT, readAll, sendPack } from './repo-git-upload';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import type { Json, RepoContext } from './repo-ops';

const ADVERTISEMENT = {
  'content-type': 'application/x-git-upload-pack-advertisement',
  'cache-control': 'no-cache',
};

/** Whether the client asked for protocol version 2 (`Git-Protocol` holds `key=value`
 * pairs separated by colons). */
export function wantsV2(req: Request) {
  return (req.headers.get('git-protocol') ?? '').split(':').includes('version=2');
}

/** The `info/refs` answer for a version 2 client: commands and capabilities, no refs. */
export function advertiseV2() {
  const { body_b64 } = compute({ op: 'git_v2_capabilities' });
  return new Response(fromBase64(body_b64), { headers: ADVERTISEMENT });
}

const none = new Uint8Array();
const answer = (body_b64: string) => new Response(fromBase64(body_b64), { headers: RESULT });

export async function uploadPackV2(
  ctx: RepoContext,
  objects: RepoObjects,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const bytes = await readAll(body, REQUEST_BYTES);
  try {
    const request = compute({ op: 'git_v2_request', body_b64: toBase64(bytes) });
    if (request.command === 'ls-refs') {
      const { refs, annotated } = await ctx.call({ op: 'repo_refs' });
      const { symrefs, peel, prefixes } = request;
      return answer(
        compute({ op: 'git_ls_refs', refs, annotated, symrefs, peel, prefixes }).body_b64,
      );
    }
    return await serveFetch(ctx, objects, request);
  } catch (e: any) {
    // Nothing is sent yet: an overloaded authority is an HTTP 503 Git can retry.
    if (transient(e)) throw e;
    return errLine(none, e);
  }
}

/** A `fetch`: a negotiation round without a common commit answers NAK; otherwise the
 * acknowledgments (when still negotiating, ending `ready`), the shallow-info, and the pack. */
async function serveFetch(ctx: RepoContext, objects: RepoObjects, request: Json) {
  const negotiating = !request.done && request.haves.length > 0;
  const walk = { op: 'repo_git_walk', wants: request.wants, haves: request.haves, objects: true };
  if (negotiating) {
    const { common } = await ctx.call({ ...walk, common_only: true });
    if (!common.length) return answer(compute({ op: 'git_v2_fetch_head', nak: true }).body_b64);
  }
  const walked = await ctx.call({
    ...walk,
    shallows: request.shallows,
    depth: request.depth,
    deepen_relative: request.deepen_relative,
  });
  const head = compute({
    op: 'git_v2_fetch_head',
    acknowledged: negotiating ? walked.common : null,
    shallow_info: request.depth != null || request.shallows.length > 0,
    shallow: walked.shallow,
    unshallow: walked.unshallow,
  });
  const session = UploadSession.open({ ...walked, omit_blobs: request.omit_blobs });
  return sendPack(fromBase64(head.body_b64), session, objects, CHUNK);
}
