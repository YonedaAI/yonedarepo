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
/** Per repository: main's head (small, changes per landing) and the access snapshot
 * (live token digests; changes only with access, versioned), each fetched once per
 * isolate at a time. */
const heads = new Map<string, { head: Json; at: number }>();
const accesses = new Map<string, Json>();
const loading = new Map<string, Promise<Json>>();

type Holder = {
  head(repo: string, minVersion: number): Promise<Json>;
  access(repo: string): Promise<Json>;
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

/** `head` without its token snapshot, and the snapshot alone. */
const withoutTokens = ({ tokens: _, ...head }: Json) => head;
const accessOf = (head: Json) => ({ version: head.access_version, tokens: head.tokens });

/** The digest the authority files a repository token under (as `auth.rs` computes it). */
async function tokenDigest(credentials: Json): Promise<string | null> {
  if (typeof credentials._token !== 'string') return null;
  const bytes = new TextEncoder().encode(`yonedarepo:repo-token:v1:${credentials._token}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One fetch per key at a time in this isolate; concurrent callers share it. */
function once(key: string, load: () => Promise<Json>) {
  let pending = loading.get(key);
  if (!pending) {
    pending = load().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

async function headOf(env: Env, repo: string, minVersion: number): Promise<Json> {
  const cached = heads.get(repo);
  if (cached && Date.now() - cached.at < ISOLATE_MS && cached.head.version >= minVersion)
    return cached.head;
  const shared = holder(env, repo);
  let head = await once(`head:${repo}`, async () => {
    if (shared) return shared.head(repo, minVersion);
    const full = await fetchHead(env, repo);
    accesses.set(repo, accessOf(full));
    return withoutTokens(full);
  });
  // A shared fetch may have started before this caller's landing: fetch again once.
  if (head.version < minVersion)
    head = shared ? await shared.head(repo, minVersion) : withoutTokens(await fetchHead(env, repo));
  if (head.version < minVersion)
    throw new ApiError('STALE_READ', `main has not reached version ${minVersion} yet; retry`);
  heads.set(repo, { head, at: Date.now() });
  return head;
}

async function accessFor(env: Env, repo: string, head: Json): Promise<Json> {
  const cached = accesses.get(repo);
  if (cached && cached.version === head.access_version) return cached;
  const shared = holder(env, repo);
  const access = await once(`access:${repo}`, async () =>
    shared ? shared.access(repo) : accessOf(await fetchHead(env, repo)),
  );
  accesses.set(repo, access);
  return access;
}

/** Main's published head for `credentials` (carrying only their token row), at least at
 * `minVersion` (a reader's own landing). */
export async function publishedHead(
  env: Env,
  repo: string,
  credentials: Json,
  minVersion = 0,
): Promise<Json> {
  const [digest, head] = await Promise.all([
    tokenDigest(credentials),
    headOf(env, repo, minVersion),
  ]);
  const access = await accessFor(env, repo, head);
  const token = digest && (access.tokens as Json[]).find((t) => t.digest === digest);
  return { ...head, tokens: token ? [token] : [] };
}

/** Marks the published head stale after a landing, projection or access change. */
export async function refreshHead(env: Env, repo: string) {
  heads.delete(repo);
  await holder(env, repo)
    ?.refresh(repo)
    .catch((e) => console.warn(`head refresh failed: ${e?.message ?? e}`));
}

/** Authorizes a commit on the published head (stateless compute, the authority's rules). */
export async function beginFromHead(ctx: RepoContext, paths: string[]) {
  const credentials = ctx.call.sign({});
  const head = await publishedHead(ctx.env, ctx.repo, credentials);
  try {
    return compute({ op: 'head_begin', head, credentials, paths });
  } catch (e: any) {
    throw new ApiError(e.code ?? 'FORBIDDEN', e.message);
  }
}

/** The caller's read access and main's head for a read served from the published head. */
export async function readFromHead(ctx: RepoContext, minVersion = 0) {
  const credentials = ctx.call.sign({});
  const head = await publishedHead(ctx.env, ctx.repo, credentials, minVersion);
  try {
    const access = compute({ op: 'head_access', head, credentials });
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
    const head =
      this.#head && !this.#stale && this.#head.version >= minVersion
        ? this.#head
        : await this.#load(repo, minVersion);
    return withoutTokens(head);
  }

  async access(repo: string): Promise<Json> {
    return accessOf(this.#head ?? (await this.#load(repo, 0)));
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
