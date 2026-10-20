// The published head of main: what a commit begins from and a read serves, without an
// authority round trip. The repository's head holder (the land combiner class, named
// `<repo>#head`) keeps the authority's latest `repo_head` answer and refreshes it when a
// land batch, a projection or an access change makes it stale; isolates keep it briefly.
// Stale is safe: landing re-checks access and validates the base against the log, and a
// reader that passes the version it landed at waits until the head reaches it.
import { awaitProjection } from './repo-changesets';
import { compute } from './repo-compute';
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import { timed } from './repo-timing';
import type { Env } from './types';

const ISOLATE_MS = 1000;
/** An isolate never serves a head older than this without fetching first. */
const STALE_MS = 10_000;
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
  if (cached && cached.head.version >= minVersion) {
    const age = Date.now() - cached.at;
    if (age < ISOLATE_MS) return cached.head;
    // Recent enough to serve while a fresh copy loads (a begin validates its base when it
    // lands; a reader that needs its own landing passes min_version and waits).
    if (age < STALE_MS) {
      void fetchInto(env, repo, 0).catch(() => {});
      return cached.head;
    }
  }
  let head = await fetchInto(env, repo, minVersion);
  // A shared fetch may have started before this caller's landing: fetch again once.
  if (head.version < minVersion) {
    forgetHead(repo);
    head = await fetchInto(env, repo, minVersion);
  }
  if (head.version < minVersion)
    throw new ApiError('STALE_READ', `main has not reached version ${minVersion} yet; retry`);
  return head;
}

/** Fetches main's head (one fetch per isolate at a time) and caches it. */
async function fetchInto(env: Env, repo: string, minVersion: number): Promise<Json> {
  const shared = holder(env, repo);
  const head = await once(`head:${repo}`, async () => {
    if (shared) return shared.head(repo, minVersion);
    const full = await fetchHead(env, repo);
    accesses.set(repo, accessOf(full));
    return withoutTokens(full);
  });
  const cached = heads.get(repo);
  if (!cached || cached.head.version <= head.version) heads.set(repo, { head, at: Date.now() });
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

/** Drops this isolate's copy of the head (after this isolate landed something). */
export function forgetHead(repo: string) {
  heads.delete(repo);
}

/** Marks the published head stale after a landing, projection or access change. */
export async function refreshHead(env: Env, repo: string) {
  heads.delete(repo);
  await holder(env, repo)
    ?.refresh(repo)
    .catch((e) => console.warn(`head refresh failed: ${e?.message ?? e}`));
}

/** Paths meet when equal or when one is a directory of the other. */
const meets = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Authorizes a commit on the published head (stateless compute, the authority's rules), or
 * returns null when the authority must decide (see `decide`).
 * A commit writing a path that a landed but unprojected changeset wrote would build on
 * that path's old content (a conflict at landing for a writer who just landed it), so it
 * waits for the projection first; work on other paths begins at once on the projected
 * head and is validated at landing like any concurrent work.
 */
export async function beginFromHead(ctx: RepoContext, paths: string[]): Promise<Json | null> {
  const credentials = ctx.call.sign({});
  let head = await timed('head.fetch', () => publishedHead(ctx.env, ctx.repo, credentials));
  for (let round = 0; round < 3; round++) {
    const pending = (head.overlay as Json[]).some((c) =>
      c.paths.some((p: Json) => paths.some((path) => meets(path, p.path))),
    );
    if (!pending) break;
    await awaitProjection(ctx.env, ctx.repo);
    forgetHead(ctx.repo);
    head = await publishedHead(ctx.env, ctx.repo, credentials, head.version);
  }
  return decide(head, { op: 'head_begin', credentials, paths });
}

/** The caller's read access and main's head for a read served from the published head,
 * or null when the authority must decide (see `decide`). */
export async function readFromHead(ctx: RepoContext, minVersion = 0) {
  const credentials = ctx.call.sign({});
  const head = await timed('head.fetch', () =>
    publishedHead(ctx.env, ctx.repo, credentials, minVersion),
  );
  const access = decide(head, { op: 'head_access', credentials });
  return access && { head, access };
}

/**
 * Runs an access decision on the head's snapshot (without its overlay, which access never
 * reads). A refusal may come from a snapshot older than the caller's token, so it returns
 * null and the caller asks the authority, which refuses for real if it must.
 */
function decide(head: Json, command: Json): Json | null {
  const { overlay: _, ...access } = head;
  try {
    return compute({ ...command, head: access });
  } catch (e: any) {
    if (['UNAUTHORIZED', 'FORBIDDEN'].includes(e.code)) return null;
    throw new ApiError(e.code ?? 'INVALID_INPUT', e.message);
  }
}

/** The head holder's state, refreshed from the authority one call at a time. */
export class HeadHolder {
  #head: Json | null = null;
  #stale = true;
  #loading: Promise<Json> | null = null;

  constructor(private readonly env: Env) {}

  /** The head it holds when that is recent enough for the caller (a stale one is
   * refreshed in the background: begins validate their base when they land); otherwise
   * waits for a load that reaches `minVersion`. */
  async head(repo: string, minVersion: number): Promise<Json> {
    if (this.#head && this.#head.version >= minVersion) {
      if (this.#stale) void this.#load(repo, 0).catch(() => {});
      return withoutTokens(this.#head);
    }
    return withoutTokens(await this.#load(repo, minVersion));
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
