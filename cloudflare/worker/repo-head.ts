// The published head of main: what a commit begins from and a read serves, without an
// authority round trip. The repository's head holder (the land combiner class, named
// `<repo>#head`) keeps the authority's latest `repo_head` answer and refreshes it when a
// land batch, a projection or an access change makes it stale; isolates keep it briefly.
// Stale is safe: landing re-checks access and validates the base against the log, and a
// reader that passes the version it landed at waits until the head reaches it.
import { compute } from './repo-compute';
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

const ISOLATE_MS = 1000;
const isolate = new Map<string, { head: Json; at: number }>();

type Holder = {
  head(repo: string, minVersion: number): Promise<Json>;
  refresh(repo: string): Promise<void>;
};

function holder(env: Env, repo: string): Holder | null {
  const namespace = env.LAND_COMBINERS;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(`${repo}#head`)) as unknown as Partial<Holder>;
  return typeof stub.head === 'function' ? (stub as Holder) : null;
}

/** The authority's head of main (a platform read; access is decided from its snapshot). */
export const fetchHead = (env: Env, repo: string) =>
  caller(env, repo, { _system: 'projection' })({ op: 'repo_head', ref: 'main' });

/** Main's published head, at least at `minVersion` (a reader's own landing). */
export async function publishedHead(env: Env, repo: string, minVersion = 0): Promise<Json> {
  const cached = isolate.get(repo);
  if (cached && Date.now() - cached.at < ISOLATE_MS && cached.head.version >= minVersion)
    return cached.head;
  const shared = holder(env, repo);
  const head = shared ? await shared.head(repo, minVersion) : await fetchHead(env, repo);
  if (head.version < minVersion)
    throw new ApiError('STALE_READ', `main has not reached version ${minVersion} yet; retry`);
  isolate.set(repo, { head, at: Date.now() });
  return head;
}

/** Marks the published head stale after a landing, projection or access change. */
export async function refreshHead(env: Env, repo: string) {
  isolate.delete(repo);
  await holder(env, repo)
    ?.refresh(repo)
    .catch((e) => console.warn(`head refresh failed: ${e?.message ?? e}`));
}

/** Authorizes a commit on the published head (stateless compute, the authority's rules). */
export async function beginFromHead(ctx: RepoContext, paths: string[]) {
  const head = await publishedHead(ctx.env, ctx.repo);
  try {
    return compute({ op: 'head_begin', head, credentials: ctx.call.sign({}), paths });
  } catch (e: any) {
    throw new ApiError(e.code ?? 'FORBIDDEN', e.message);
  }
}

/** The caller's read access and main's head for a read served from the published head. */
export async function readFromHead(ctx: RepoContext, minVersion = 0) {
  const head = await publishedHead(ctx.env, ctx.repo, minVersion);
  try {
    const access = compute({ op: 'head_access', head, credentials: ctx.call.sign({}) });
    return { head, access };
  } catch (e: any) {
    throw new ApiError(e.code ?? 'FORBIDDEN', e.message);
  }
}

/** The head holder's state, refreshed from the authority one call at a time. */
export class HeadHolder {
  #head: Json | null = null;
  #stale = true;
  #loading: Promise<Json> | null = null;

  constructor(private readonly env: Env) {}

  async head(repo: string, minVersion: number): Promise<Json> {
    if (this.#head && !this.#stale && this.#head.version >= minVersion) return this.#head;
    return this.#load(repo, minVersion);
  }

  refresh(repo: string) {
    this.#stale = true;
    // Loads in the background; readers that need it sooner wait for the same load.
    void this.#load(repo, 0).catch(() => {});
  }

  async #load(repo: string, minVersion: number): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A load already running may have started before the version this caller needs.
      this.#loading ??= (async () => {
        this.#stale = false;
        const head = await fetchHead(this.env, repo);
        this.#head = head;
        return head;
      })().finally(() => {
        this.#loading = null;
      });
      const head = await this.#loading;
      if (head.version >= minVersion) return head;
    }
    return this.#head as Json;
  }
}
