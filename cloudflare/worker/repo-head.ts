// The published head of main: what a commit begins from and a read serves, without an
// authority round trip. Isolates copy it from the repository's head holder
// (repo-head-holder.ts) and keep the copy for ACCESS_MS. Stale is safe for the head itself:
// landing re-checks access and validates the base against the log, and a reader that
// passes the version it landed at waits until the head reaches it. Access is bounded: the
// holder reloads before an access change answers, the isolate that served the change drops
// its copy, and every other isolate decides on a copy fetched at most ACCESS_MS ago, so a
// revoked token or removed member is refused everywhere within ACCESS_MS of the change's
// answer. A deletion waits that bound out before it answers (`dropDeletedHead`).
import { rpcValue } from './durable';
import { teamEntries } from './platform-org-access';
import { awaitProjection } from './repo-changesets';
import { compute } from './repo-compute';
import { accessOf, fetchHead, withoutTokens } from './repo-head-holder';
import type { TreeEntry } from './repo-objects';
import { ApiError, type Json, noteWrite, type RepoContext } from './repo-ops';
import { timed } from './repo-timing';
import type { Env } from './types';

/** The oldest copy of the head (and its access snapshot) an isolate decides on. Past it,
 * the isolate asks the holder again, which answers from memory. */
export const ACCESS_MS = 1000;
/** Per repository: main's head (small, changes per landing) and the access snapshot
 * (live token digests and members' roles; changes only with access, versioned). */
const heads = new Map<string, { head: Json; at: number }>();
/** The least version this isolate's reads need: its own latest landing. */
const floors = new Map<string, number>();
/** This isolate's landings, with the paths each wrote (null: unknown, so every path): a
 * begin waits for the head to reach only the ones whose paths it writes again. */
const landings = new Map<string, { version: number; paths: string[] | null }[]>();
/** Paths of the commits this isolate built, by commit id, until they land (bounded). */
const built = new Map<string, string[]>();
const BUILT = 1024;
const accesses = new Map<string, Json>();
const loading = new Map<string, Promise<Json>>();

type Holder = {
  head(repo: string, minVersion: number, since?: number, access?: string | null): Promise<Json>;
  access(repo: string): Promise<Json>;
  refresh(repo: string, access?: boolean): Promise<void>;
  trees(
    repo: string,
    root: string,
    paths: string[],
    commit?: string,
  ): Promise<Record<string, TreeEntry[]>>;
};

function holder(env: Env, repo: string): Holder | null {
  const namespace = env.LAND_COMBINERS;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(`${repo}#head`)) as unknown as Partial<Holder>;
  return typeof stub.head === 'function' ? (stub as Holder) : null;
}

/** The member entries a session or personal token acts by: its account's and its teams'. */
function entriesOf(credentials: Json): string[] {
  const holder = credentials._session ?? credentials._pat;
  if (typeof holder?.workspace !== 'string') return [];
  return [holder.workspace, ...teamEntries(holder.orgs)];
}

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
  if (cached && cached.head.version >= minVersion && Date.now() - cached.at < ACCESS_MS)
    return cached.head;
  const fetched = await fetchInto(env, repo, minVersion);
  let head = fetched.head;
  // The holder answers below `minVersion` only when its reload is behind, and a shared
  // fetch may have started too long ago to decide on: once more.
  if (head.version < minVersion || Date.now() - fetched.at >= ACCESS_MS)
    head = (await fetchInto(env, repo, minVersion)).head;
  if (head.version < minVersion)
    throw new ApiError('STALE_READ', `main has not reached version ${minVersion} yet; retry`);
  return head;
}

/** Fetches main's head and caches it, dated when the fetch started (`at`). Fetches that
 * need no newer version than the copy share one call (the holder answers it from memory);
 * one that needs a landing waits for the holder to reach it, alone. With a cached copy,
 * only the overlay entries newer than it travel, and the access snapshot only when it
 * changed. */
async function fetchInto(env: Env, repo: string, minVersion: number) {
  const shared = holder(env, repo);
  const prev = heads.get(repo)?.head;
  const key = minVersion > (prev?.version ?? 0) ? `head:${repo}@${minVersion}` : `head:${repo}`;
  const { head, at } = await once(key, async () => {
    const at = Date.now();
    if (!shared) {
      const full = await fetchHead(env, repo);
      accesses.set(repo, accessOf(full));
      return { head: withoutTokens(full), at };
    }
    const base = heads.get(repo)?.head;
    const { access, ...next } = await rpcValue(
      shared.head(repo, minVersion, base?.version, accesses.get(repo)?.version ?? null),
    );
    if (access) accesses.set(repo, access);
    if (!base || next.overlay_since === null || next.overlay_since === undefined)
      return { head: next, at };
    const kept = (base.overlay as Json[]).filter(
      (e) => e.version > (next.projected_version ?? 0) && e.version <= next.overlay_since,
    );
    return { head: { ...next, overlay: [...kept, ...next.overlay] }, at };
  });
  const cached = heads.get(repo);
  if (!cached || cached.head.version <= head.version) heads.set(repo, { head, at });
  const reached = landings.get(repo)?.filter((l) => l.version > head.version);
  if (reached) landings.set(repo, reached);
  return { head: head as Json, at: at as number };
}

async function accessFor(env: Env, repo: string, head: Json): Promise<Json> {
  const cached = accesses.get(repo);
  if (cached && cached.version === head.access_version) return cached;
  const shared = holder(env, repo);
  const access = await once(`access:${repo}`, async () =>
    shared ? rpcValue(shared.access(repo)) : accessOf(await fetchHead(env, repo)),
  );
  accesses.set(repo, access);
  return access;
}

/** Main's published head for `credentials`, carrying only their token or member rows. */
async function headFor(
  env: Env,
  repo: string,
  credentials: Json,
  minVersion: number,
): Promise<Json> {
  const [digest, head] = await Promise.all([
    tokenDigest(credentials),
    headOf(env, repo, minVersion),
  ]);
  const access = await accessFor(env, repo, head);
  const token = digest && (access.tokens as Json[]).find((t) => t.digest === digest);
  const entries = entriesOf(credentials);
  const members = ((access.members ?? []) as Json[]).filter((m) => entries.includes(m.account));
  return { ...head, tokens: token ? [token] : [], members };
}

/** This isolate built `commit`, writing `paths`: its landing then holds back only begins
 * that write them again. */
export function noteBuilt(commit: string, paths: string[]) {
  if (built.size >= BUILT) built.delete(built.keys().next().value as string);
  built.set(commit, paths);
}

/** After this isolate landed `commit` at `version`, its reads need at least that version,
 * and its begins too when they write a path the commit wrote; without a version, its copy
 * of the head is dropped. */
export function forgetHead(repo: string, version?: number, commit?: string) {
  noteWrite(repo);
  if (version === undefined) {
    heads.delete(repo);
    return;
  }
  floors.set(repo, Math.max(version, floors.get(repo) ?? 0));
  const paths = (commit && built.get(commit)) || null;
  if (commit) built.delete(commit);
  if (version > (heads.get(repo)?.head.version ?? 0))
    landings.set(repo, [...(landings.get(repo) ?? []), { version, paths }]);
}

/** The version a begin writing `paths` needs: this isolate's latest landing it meets. */
function beginFloor(repo: string, paths: string[]) {
  let floor = 0;
  for (const l of landings.get(repo) ?? [])
    if (!l.paths || l.paths.some((p) => paths.some((path) => meets(path, p))))
      floor = Math.max(floor, l.version);
  return floor;
}

/** Marks the published head stale after a landing, projection or access change. After an
 * access change (`access`) it returns once the holder reloaded from a read that started
 * after the change, so no reader is admitted by the access snapshot that change replaced. */
export async function refreshHead(env: Env, repo: string, access = false) {
  noteWrite(repo);
  heads.delete(repo);
  await holder(env, repo)
    ?.refresh(repo, access)
    .catch((e) => console.warn(`head refresh failed: ${e?.message ?? e}`));
}

/** After the authority became a tombstone: drops main's published head everywhere before
 * the deletion answers. The holder must drop it (a failure fails the deletion, which is
 * retried), and every other isolate's copy was fetched before that, so it has expired once
 * ACCESS_MS has passed: no read that starts after the answer decides on a live head. */
export async function dropDeletedHead(env: Env, repo: string) {
  noteWrite(repo);
  heads.delete(repo);
  await holder(env, repo)?.refresh(repo, true);
  await new Promise((resolve) => setTimeout(resolve, ACCESS_MS));
}

/** The trees along `paths` from root tree `root`, from the repository's head holder in
 * one call (see HeadHolder.trees); null without a holder or when it cannot answer (the
 * caller reads them itself). */
export async function headTrees(
  env: Env,
  repo: string,
  root: string,
  paths: string[],
  commit?: string,
): Promise<Record<string, TreeEntry[]> | null> {
  const shared = holder(env, repo);
  if (!shared) return null;
  return rpcValue(shared.trees(repo, root, paths, commit)).catch((e) => {
    console.warn(`head trees failed: ${e?.message ?? e}`);
    return null;
  });
}

/** Paths meet when equal or when one is a directory of the other. */
const meets = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** `command` decided on main's head for `credentials`. A refusal from a copy this isolate
 * already held is asked of the holder once more (a token or member may be newer than the
 * copy); only a refusal on the holder's own snapshot goes to the authority (null). */
async function decided(ctx: RepoContext, credentials: Json, minVersion: number, command: Json) {
  const asked = Date.now();
  let head = await timed('head.fetch', () => headFor(ctx.env, ctx.repo, credentials, minVersion));
  let decision = decide(head, command);
  if (!decision && (heads.get(ctx.repo)?.at ?? 0) < asked) {
    heads.delete(ctx.repo);
    head = await timed('head.fetch', () => headFor(ctx.env, ctx.repo, credentials, minVersion));
    decision = decide(head, command);
  }
  return { head, decision };
}

/**
 * Authorizes a commit on the published head (stateless compute, the authority's rules), or
 * returns null when the authority must decide (see `decide`).
 * A commit writing a path that a landed but unprojected changeset wrote would build on
 * that path's old content (a conflict at landing for a writer who just landed it), so it
 * waits for the projection first; work on other paths begins at once on the projected
 * head and is validated at landing like any concurrent work. Likewise it waits for this
 * isolate's own landing only when it writes a path that landing wrote.
 */
export async function beginFromHead(ctx: RepoContext, paths: string[]): Promise<Json | null> {
  const credentials = ctx.call.sign({});
  const command = { op: 'head_begin', credentials, paths };
  let { head, decision } = await decided(ctx, credentials, beginFloor(ctx.repo, paths), command);
  for (let round = 0; round < 3; round++) {
    const pending = (head.overlay as Json[]).some((c) =>
      c.paths.some((p: Json) => paths.some((path) => meets(path, p.path))),
    );
    if (!pending) break;
    await awaitProjection(ctx.env, ctx.repo);
    heads.delete(ctx.repo);
    head = await headFor(ctx.env, ctx.repo, credentials, head.version);
    decision = decide(head, command);
  }
  return decision;
}

/** The caller's read access and main's head for a read served from the published head,
 * or null when the authority must decide (see `decide`). */
export async function readFromHead(ctx: RepoContext, minVersion = 0) {
  const credentials = ctx.call.sign({});
  const floor = Math.max(minVersion, floors.get(ctx.repo) ?? 0);
  const { head, decision } = await decided(ctx, credentials, floor, {
    op: 'head_access',
    credentials,
  });
  return decision && { head, access: decision };
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
    // NOT_FOUND: a stranger to a private repository, or a member the snapshot predates.
    if (['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(e.code)) return null;
    throw new ApiError(e.code ?? 'INVALID_INPUT', e.message);
  }
}
