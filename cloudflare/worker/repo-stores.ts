// A repository's Git objects live in R2, the store of record (repo-platform-store), and a fork
// reads through to its parent's. Each repository records its store; the tiered reads in front
// of it live in repo-objects.

import { PLATFORM_SPEC, PlatformStore } from './repo-platform-store';
import type { Env } from './types';

export type TreeEntry = {
  name: string;
  type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
  id: string;
};
export type CachedObject =
  | { id: string; kind: 'tree'; entries: TreeEntry[] }
  | { id: string; kind: 'commit'; tree: string; parents: string[] }
  | { id: string; kind: 'blob'; data_b64: string };
export type CommitHeader = { tree: string; parents: string[] };

// R2 writes of objects live in repo-r2-writes (re-exported for the object layer).
export {
  putBytes,
  putObjects,
  putRaw,
  putRawBytes,
  type RawObject,
} from './repo-r2-writes';

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
/** The Git object store behind one repository. */
export interface ObjectStore {
  readonly spec: string;
  /** Accepts a receive-pack request body and returns Git's report-status. */
  push(body: Uint8Array): Promise<Uint8Array>;
  readCommit(id: string): Promise<CommitHeader | null>;
  readTree(id: string): Promise<TreeEntry[] | null>;
  readBlob(id: string): Promise<Uint8Array | null>;
  /** A fork's store: the parent repository and store its objects fall back to. */
  readonly inherits?: { repo: string; spec: string };
}

/** Forks of forks nest their parents' specs; this many levels at most. */
export const FORK_DEPTH = 4;
const FORK = /^fork:/;
/** What repositories made before R2 became the store of record have on file, `yr-<repo>` by
 * name. Their objects are read the same way as any other's, so no spec ever fails to parse. */
const RETIRED_SPEC = /^(?:artifacts:[^/]+\/|r2:)(?:yr-)?([A-Za-z0-9._-]+)$/;

/** A fork's store spec: its own store and its parent's (repository and spec), whose
 * objects it inherits (repo-objects reads fall back to them; nothing is copied). */
export function forkSpec(parent: string, parentSpec: string, own: string) {
  return `fork:${JSON.stringify({ parent, store: parentSpec, own })}`;
}

/** How many fork levels `spec` nests (0: not a fork). */
export const forkDepth = (spec: string) => spec.match(/fork:/g)?.length ?? 0;

/** The store a repository writes and purges: a fork's own, never its parent's. */
export function ownSpec(spec: string): string {
  return FORK.test(spec) ? String(JSON.parse(spec.slice(5)).own) : spec;
}

/** Whether `spec` names a store that has gone (a fork: by its own store). */
export const retiredSpec = (spec: string) => RETIRED_SPEC.test(ownSpec(spec));

/** Parses a recorded store: `platform:<repo>`, a retired one (`RETIRED_SPEC`), or a fork's
 * (`forkSpec`): its own store, carrying the parent it inherits from. */
export function parseStore(env: Env, spec: string): ObjectStore {
  if (FORK.test(spec)) {
    const fork = JSON.parse(spec.slice(5));
    if (!/^r[0-9a-f]{20}$/.test(fork.parent) || forkDepth(spec) > FORK_DEPTH || FORK.test(fork.own))
      throw new Error('Repository object store is not a valid fork');
    const own = parseStore(env, fork.own);
    return Object.assign(own, { inherits: { repo: fork.parent, spec: String(fork.store) } });
  }
  const platform = PLATFORM_SPEC.exec(spec) ?? RETIRED_SPEC.exec(spec);
  if (platform) return new PlatformStore(env, platform[1]);
  throw new Error('Repository object store is outside this deployment');
}
