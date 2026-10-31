// An import that fetches the remote itself (`DIRECT_IMPORT=on`): to the platform a public
// GitHub repository is a big `git push`, and a Worker can run the fetch (docs/direct-import.md
// has the numbers). From the import's request, beside Artifacts' own fetch:
// 1. the remote names its head, and its whole pack streams into a Rust session, which hashes
//    every object, and into R2 as the pack a clone of that head is served (repo-pack-cache);
// 2. the head's trees and files are written as bundles, as a push's are (its commit is not:
//    a commit in the store of record says the walk can serve it, repo-pack-build);
// 3. main lands at the head, once both are durable, so files and `git clone` work at once
//    (a `--depth` too: repo-git-mirror's `importedClone` answers those from the same pack).
// Artifacts still ends up holding the whole history, as for any import: only it can serve a
// fetch other than a clone of the head, since first parents are all that is recorded. Its
// Workflow carries on as before, finds main landed and then records history, from this pack
// when it can (`fillFromPack` in repo-import-fill.ts). Nothing here can fail an import: any
// failure leaves that Workflow to do what it always did, and only a landed main stays.

import { bundlesOn } from './repo-bundles';
import { githubRemote, remoteHead, remotePack } from './repo-git-remote';
import type { ImportParams, Timing } from './repo-import-head';
import { caller, type Json } from './repo-ops';
import { type Fresh, PART, PackWriter, packCacheOn, packKey } from './repo-pack-cache';
import { copyHeader, PackCopy } from './repo-pack-copy';
import { CHUNK, sideBand } from './repo-pack-stream';
import type { Env } from './types';

/** Pack bytes a direct import takes: 28 MiB held 93 MiB of Wasm (axios, 2026-10-31), and an
 * isolate has 128 MB for that, the stored pack's parts and its other requests. */
export const PACK_BYTES = 24 * 1024 * 1024;
/** All of it fits the 30 s a request has after its answer. */
const DEADLINE_MS = 20_000;
/** Bundles written at once, leaving room for the stored pack under R2's six. */
const BUNDLES = 3;

/** Whether imports may fetch directly: the switch, and the switches its parts stand on. */
export const directImportOn = (env: Env) =>
  env.DIRECT_IMPORT === 'on' && env.FAST_IMPORT === 'on' && packCacheOn(env) && bundlesOn(env);

/** Whether `url` is imported directly. */
export const directOn = (env: Env, url: string) =>
  directImportOn(env) && githubRemote(url) !== null;

/** What a clone of `head` and nothing else asks for. */
export const wholeClone = (wants: string[]): Fresh => ({
  wants,
  omit_blobs: false,
  depth: null,
  deepen_relative: false,
});

/** A session on one fetched pack, as its Worker memory will hold it. Close it. */
export function fetchedPack(env: Env, repo: string) {
  return new PackCopy(env, repo, (id) => `platform/v1/${repo}/git/${id}`, new Set());
}

/** Fetches the head, keeps its pack and lands main. Answers the timing of what it did, or
 * null when main was left to Artifacts' path: the remote did not suit, the fetch failed,
 * or that path landed first. */
export async function directImport(env: Env, params: ImportParams): Promise<Timing | null> {
  const remote = githubRemote(params.url);
  if (!remote) return null;
  const started = Date.now();
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const { head } = await remoteHead(remote, params.branch, signal);
    const asked_at = Date.now();
    const key = await packKey(params.repo, wholeClone([head]));
    const writer = new PackWriter(env, params.repo, key, PART);
    const copy = fetchedPack(env, params.repo);
    try {
      await copy.feed(copyHeader(head));
      let bytes = 0;
      for await (const piece of remotePack(remote, head, signal)) {
        bytes += piece.length;
        if (bytes > PACK_BYTES) throw new Error(`The pack is over ${PACK_BYTES} bytes`);
        await writer.add(sideBand(1, piece, CHUNK));
        await copy.feed(piece);
      }
      const fetched_at = Date.now();
      copy.check();
      const { commits: whole } = copy.call({ op: 'import_chain', tip: head, max: params.max });
      const [commit]: Json[] = copy.call({ op: 'import_commits', from: 0, count: 1 }).commits;
      const read_at = Date.now();
      const [objects] = await Promise.all([
        copy.write({ op: 'import_head', tip: head }, BUNDLES),
        writer.complete(),
      ]);
      const stored_at = Date.now();
      const call = caller(env, params.repo, { _system: 'import' });
      // A head too large to record its changes lands alone, as on Artifacts' path.
      const generation = commit.touches ? whole : 1;
      await call({
        ...commit,
        op: 'repo_record_imported',
        generation,
        touches: commit.touches ?? [],
      });
      await call({ op: 'repo_import', ref: 'main', commit: head });
      const landed_at = Date.now();
      // Two R2 calls no reader waits for, so not before main; an unlisted pack is only kept
      // longer than it would have been.
      await writer.keep().catch((e) => console.warn(`stored pack not listed: ${e?.message ?? e}`));
      const asked = params.asked_at ?? started;
      return {
        landed_by: 'direct',
        start_ms: started - asked,
        remote_ms: asked_at - started,
        pack_ms: fetched_at - asked_at,
        read_ms: read_at - fetched_at,
        store_ms: stored_at - read_at,
        land_ms: landed_at - stored_at,
        usable_ms: landed_at - asked,
        pack_bytes: bytes,
        head_objects: objects,
        whole,
      };
    } catch (e) {
      await writer.abort().catch(() => {});
      throw e;
    } finally {
      await copy.close();
    }
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 300);
    console.warn(JSON.stringify({ event: 'import.direct_declined', repo: params.repo, reason }));
    return null;
  }
}
