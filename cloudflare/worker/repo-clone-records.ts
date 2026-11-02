// What a clone hands to the platform, a part at a time: objects as a push stores them, commits as
// a push records them, and the repository's refs. `CloneSession` (repo-clone) calls these.

import { NonRetryableError } from 'cloudflare:workflows';
import { log } from './log';
import { HEADER, storeBundle } from './repo-bundles';
import { putLarge, SPILL_BYTES } from './repo-large-files';
import { caller, type Json } from './repo-ops';
import { framed, WRITE_BUDGET } from './repo-pack-copy';
import { concat } from './repo-pack-stream';
import type { Env } from './types';

export const MAIN = 'refs/heads/main';
/** Bundles written at once. */
const BUNDLES = 3;
/** Commits one authority call records. */
const RECORD_COMMITS = 100;
/** JSON one authority call carries (one larger commit goes alone). */
const RECORD_BYTES = 1024 * 1024;
const REF_BATCH = 100;
const REFUSED_REF = ['INVALID_INPUT', 'GIT_OBJECT_INVALID'];

/** What `POST /clone` answers (clone_import.rs). */
export type Cloned = {
  default_branch: string | null;
  pack_bytes: number;
  pack_objects: number;
  objects: number;
  commits: number;
  refs: number;
  refs_skipped: number;
};
/** A branch or tag as `/clone/refs` lists it. */
export type RemoteRef = { ref: string; id: string; commit: string; tag_b64?: string };
/** Reads a stream by exact counts. */
class Exact {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #held: Uint8Array = new Uint8Array();

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async ended() {
    while (this.#held.length === 0) {
      const { done, value } = await this.#reader.read();
      if (done) return true;
      this.#held = value;
    }
    return false;
  }

  /** Up to `limit` bytes as they come; fails at an end that was not due. */
  async #piece(limit: number) {
    if (await this.ended()) throw new Error('The stream ended early');
    const piece = this.#held.subarray(0, limit);
    this.#held = this.#held.subarray(piece.length);
    return piece;
  }

  async take(count: number) {
    const pieces: Uint8Array[] = [];
    for (let left = count; left > 0; left -= pieces[pieces.length - 1].length)
      pieces.push(await this.#piece(left));
    return pieces.length === 1 ? pieces[0] : concat(pieces);
  }

  /** The next `count` bytes, not held. */
  stream(count: number) {
    let left = count;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const piece = await this.#piece(left);
        left -= piece.length;
        controller.enqueue(piece);
        if (left === 0) controller.close();
      },
    });
  }

  cancel() {
    return this.#reader.cancel();
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Stores the frames `body` streams as a push does: bundles, and a large file as its own raw
 * object. Stops at a frame's end once `until` has passed. Answers how many it took, and whether
 * that was all of them. */
export async function storeObjects(
  env: Env,
  repo: string,
  body: ReadableStream<Uint8Array>,
  until: number,
) {
  const from = new Exact(body);
  let pieces: Uint8Array[] = [];
  let filled = 0;
  let objects = 0;
  let going: Promise<void>[] = [];
  const flush = async () => {
    if (filled === 0) return;
    const bytes = concat(pieces);
    pieces = [];
    filled = 0;
    going.push(storeBundle(env, repo, bytes, framed(bytes)));
    if (going.length < BUNDLES) return;
    await Promise.all(going);
    going = [];
  };
  let ended = false;
  for (;;) {
    ended = await from.ended();
    // At least one object a step, however late it started: every step moves the import on.
    if (ended || (objects > 0 && Date.now() >= until)) break;
    const header = await from.take(HEADER);
    const size = new DataView(header.buffer, header.byteOffset, HEADER).getUint32(21);
    objects++;
    if (size > SPILL_BYTES && header[0] === 3) {
      const key = `platform/v1/${repo}/git/${hex(header.subarray(1, 21))}`;
      await putLarge(env, key, size, from.stream(size));
      continue;
    }
    if (filled + HEADER + size > WRITE_BUDGET) await flush();
    pieces.push(header, await from.take(size));
    filled += HEADER + size;
  }
  await flush();
  await Promise.all(going);
  if (!ended) await from.cancel();
  return { objects, ended };
}

/** Records `lines` (commits parents first, a line each) in calls of RECORD_COMMITS commits or
 * RECORD_BYTES of JSON. Answers how many. */
export async function recordCommits(env: Env, repo: string, lines: string[]) {
  const call = caller(env, repo, { _system: 'import' });
  let waiting: Json[] = [];
  let bytes = 0;
  const record = async () => {
    if (waiting.length > 0) await call({ op: 'repo_record_pushed', commits: waiting });
    waiting = [];
    bytes = 0;
  };
  for (const line of lines) {
    if (waiting.length >= RECORD_COMMITS || bytes + line.length > RECORD_BYTES) await record();
    waiting.push(JSON.parse(line));
    bytes += line.length;
  }
  await record();
}

/** Where the repository's main starts: the branch asked for, else the remote's own main, else
 * its default branch. The platform's trunk is called main (docs/clone-import.md); a remote
 * without one keeps its default branch beside it, under its own name. */
export function trunkOf(refs: RemoteRef[], cloned: Cloned, branch?: string) {
  const branches = refs.filter((r) => r.ref.startsWith('refs/heads/'));
  const own = branches.find((r) => r.ref === MAIN);
  const named = branch ?? (own ? 'main' : (cloned.default_branch ?? undefined));
  const found =
    branches.find((r) => r.ref === `refs/heads/${named}`) ??
    (branch === undefined ? branches[0] : undefined);
  if (!found)
    throw new NonRetryableError(
      branch
        ? `NOT_FOUND: Branch ${branch} was not found`
        : 'NOT_FOUND: The remote has no branches',
    );
  return found;
}

/** Creates `refs` in calls of REF_BATCH. One the platform cannot name is left out on its own,
 * and counted. */
export async function createRefs(env: Env, repo: string, refs: RemoteRef[]) {
  const call = caller(env, repo, { _system: 'import' });
  const update = (r: RemoteRef) => ({
    ref: r.ref,
    commit: r.commit,
    ...(r.tag_b64 ? { tag: { data_b64: r.tag_b64 } } : {}),
  });
  let left_out = 0;
  for (let at = 0; at < refs.length; at += REF_BATCH) {
    const batch = refs.slice(at, at + REF_BATCH);
    await call({ op: 'repo_import_refs', updates: batch.map(update) }).catch(async (e) => {
      if (!REFUSED_REF.includes(e?.code)) throw e;
      for (const one of batch)
        await call({ op: 'repo_import_refs', updates: [update(one)] }).catch((why) => {
          left_out++;
          log.warn('import.ref_left_out', { repo, reason: `${one.ref}: ${why?.code}` });
        });
    });
  }
  return left_out;
}
