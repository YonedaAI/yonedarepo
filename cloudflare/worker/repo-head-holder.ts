// The repository's head holder (the land combiner class, named `<repo>#head`): it keeps the
// authority's latest `repo_head` answer for every isolate, so a commit begins and a read is
// authorized without an authority round trip. A landing or projection makes it stale and
// it reloads in the background; an access change reloads it before that change answers,
// so the access snapshot it serves is never older than the last change it was told of.
// It also serves the trees commits build on (see `trees`).
import { parseStore, RepoObjects, type TreeEntry } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { TreeMemo } from './repo-tree-memo';
import type { Env } from './types';

/** Tree entries a holder keeps (~20k: a few MB per repository). */
const HOLDER_TREES = 20_000;
/** Directories recent commits wrote under, warmed for each new head. */
const HOT_DIRS = 64;
/** Trees one `trees` answer carries at most. */
const ANSWER_TREES = 128;

/** Every directory above `paths`, with the root (''). */
function dirsOf(paths: string[]) {
  const dirs = new Set(['']);
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

/** The authority's head of main (a platform read; access is decided from its snapshot). */
export const fetchHead = (env: Env, repo: string) =>
  caller(env, repo, { _system: 'projection' })({ op: 'repo_head', ref: 'main' });

/** `head` without its access snapshot, and the snapshot alone. */
export const withoutTokens = ({ tokens: _, members: __, ...head }: Json) => head;
export const accessOf = (head: Json) => ({
  version: head.access_version,
  tokens: head.tokens,
  members: head.members ?? [],
});

/** The head holder's state, refreshed from the authority one call at a time. */
export class HeadHolder {
  #head: Json | null = null;
  #stale = true;
  #loading: Promise<Json> | null = null;
  /** Bumped by an access change: loads started before it never set the head. */
  #generation = 0;
  #trees = new TreeMemo(HOLDER_TREES);
  #objects: { spec: string; objects: RepoObjects } | null = null;
  #hot = new Set<string>();
  #warming: Promise<unknown> | null = null;

  constructor(private readonly env: Env) {}

  /** The head it holds when that is recent enough for the caller (a stale one is
   * refreshed in the background: begins validate their base when they land); otherwise
   * waits for a load that reaches `minVersion`. With the caller's `accessVersion` (null
   * when it holds none), the access snapshot travels too whenever the caller's differs. */
  async head(
    repo: string,
    minVersion: number,
    since?: number,
    accessVersion?: string | null,
  ): Promise<Json> {
    let head = this.#head;
    if (head && head.version >= minVersion) {
      if (this.#stale) void this.#load(repo, 0).catch(() => {});
    } else head = await this.#load(repo, minVersion);
    const access =
      accessVersion !== undefined && accessVersion !== head.access_version
        ? { access: accessOf(head) }
        : {};
    // A caller holding a copy at `since` gets only the overlay entries newer than it.
    if (since === undefined) return { ...withoutTokens(head), ...access };
    return {
      ...withoutTokens(head),
      overlay: (head.overlay as Json[]).filter((e) => e.version > since),
      overlay_since: since,
      ...access,
    };
  }

  async access(repo: string): Promise<Json> {
    return accessOf(this.#head ?? (await this.#load(repo, 0)));
  }

  /** Marks the head stale. After a landing or projection it reloads in the background.
   * After an access change (`access`) it drops the head it held, lets no load started
   * before the change set it again, and answers once a fresh load has it; if that load
   * fails, nothing is served until one succeeds. */
  async refresh(repo: string, access = false) {
    this.#stale = true;
    if (!access) {
      void this.#load(repo, 0).catch(() => {});
      return;
    }
    this.#generation++;
    this.#head = null;
    this.#loading = null;
    // A deleted repository has no head to serve; that is the refresh it needed.
    await this.#load(repo, 0).catch((e) => {
      if (e?.code !== 'GONE') throw e;
    });
  }

  /**
   * The trees along `paths` from root tree `root` (any commit's: trees are
   * content-addressed), in one answer for every level. Each is read once here for every
   * isolate: a commit's tree reads cost one call instead of an R2 walk per level, and on a
   * head this holder warmed, no R2 read at all. `commit` may hold them staged (it built
   * them and its objects have not drained to R2 yet).
   */
  async trees(
    repo: string,
    root: string,
    paths: string[],
    commit?: string,
  ): Promise<Record<string, TreeEntry[]>> {
    const dirs = dirsOf(paths);
    for (const dir of dirs) {
      if (!dir) continue;
      this.#hot.delete(dir);
      this.#hot.add(dir);
    }
    for (const dir of this.#hot) {
      if (this.#hot.size <= HOT_DIRS) break;
      this.#hot.delete(dir);
    }
    return this.#walk(repo, root, dirs, commit);
  }

  /** Reads trees from `root` down into the directories in `dirs` and, given the root
   * `before` it, into every subtree that differs from the one `before` held there (its
   * trees as far as this holder remembers them), level by level, each level at once. */
  async #walk(
    repo: string,
    root: string,
    dirs: Set<string>,
    commit?: string,
    before?: string,
  ): Promise<Record<string, TreeEntry[]>> {
    const objects = await this.#store(repo);
    const found: Record<string, TreeEntry[]> = {};
    let count = 0;
    let level: { dir: string; id: string; was?: string }[] = [{ dir: '', id: root, was: before }];
    while (level.length && count < ANSWER_TREES) {
      const batch = level.slice(0, ANSWER_TREES - count);
      count += batch.length;
      const read = await Promise.all(
        batch.map(async (at) => ({ ...at, entries: await objects.tree(at.id, commit) })),
      );
      level = [];
      for (const { dir, id, was, entries } of read) {
        found[id] = entries;
        const old = was === undefined ? undefined : objects.remembered(was);
        const oldIds = old && new Map(old.map((e) => [e.name, e.id]));
        for (const e of entries) {
          if (e.type !== 'tree') continue;
          const sub = dir ? `${dir}/${e.name}` : e.name;
          const changed = oldIds !== undefined && oldIds.get(e.name) !== e.id;
          if (dirs.has(sub) || changed)
            level.push({ dir: sub, id: e.id, was: oldIds?.get(e.name) });
        }
      }
    }
    return found;
  }

  async #store(repo: string) {
    const spec = String((this.#head ?? (await this.#load(repo, 0))).object_store);
    if (this.#objects?.spec !== spec)
      this.#objects = {
        spec,
        objects: new RepoObjects(this.env, repo, parseStore(this.env, spec), this.#trees),
      };
    return this.#objects.objects;
  }

  /** Reads a new head's trees along the directories commits wrote under lately and every
   * tree it changed since `before` (where the next commits most likely write), so the
   * commits that follow find them here. */
  #warm(repo: string, head: Json, before?: string) {
    const root = head.head?.tree;
    if (typeof root !== 'string') return;
    const dirs = new Set(['', ...this.#hot]);
    const warming: Promise<unknown> = this.#walk(repo, root, dirs, head.head.id, before)
      .catch(() => {})
      .finally(() => {
        if (this.#warming === warming) this.#warming = null;
      });
    this.#warming = warming;
  }

  /** Settles once no load or warming is running (tests stop in-process holders with it). */
  async idle() {
    while (this.#loading || this.#warming) {
      await this.#loading?.catch(() => {});
      await this.#warming;
    }
  }

  async #load(repo: string, minVersion: number): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A load already running may have started before the version this caller needs.
      this.#loading ??= this.#fetch(repo);
      const head = await this.#loading;
      if (head.version >= minVersion) return head;
    }
    return this.#head as Json;
  }

  #fetch(repo: string): Promise<Json> {
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    const loading: Promise<Json> = (async () => {
      this.#stale = false;
      const head = await fetchHead(this.env, repo).catch((e) => {
        // A deleted repository's head is never served again.
        if (e?.code === 'GONE' && current()) this.#head = null;
        throw e;
      });
      if (current()) {
        const before = this.#head?.head?.tree;
        this.#head = head;
        if (head.head?.tree !== before) this.#warm(repo, head, before);
      }
      return head;
    })().finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    return loading;
  }
}
