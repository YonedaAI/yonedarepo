// Batch, resumable object fetch (Scion GetObjects, `POST /objects`) and the download of one
// large blob's bytes (`GET /objects/<id>`). A JSON page holds objects base64-encoded, so a
// blob of many megabytes costs several copies of itself in the isolate's memory: a clone of a
// history with large files (claude-code's 16 MiB demo.gif, several versions) ended 503 on
// exceeded resources. A client that asks with `large: true` gets such blobs as a stub
// (`{id, kind, size, large}`) and downloads each one's bytes on its own request instead.
import { compute } from './repo-compute';
import { decide, outside } from './repo-grants';
import { guardInherited } from './repo-inherit';
import { type ObjectKind, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext, SHA, walk } from './repo-ops';
import { quarantined } from './repo-quarantine-guard';

/** Response bytes per page (base64 text for blobs, JSON otherwise). A streamed page holds
 * only its batch in flight, so the budget bounds the client's wait, not the isolate's
 * memory: 4 MiB pages cost a 77 MB clone about 54 of them (claude-code, measured). */
const OBJECT_BUDGET = 16 * 1024 * 1024;
/** Object bytes one page may read, stubs included: the page stops once past it. */
const READ_BUDGET = 64 * 1024 * 1024;
/** Objects read at once: trees and commits are small; blobs (up to `LARGE_BLOB` inline, a
 * stub's whole content until it is known to be large) are a few at a time. */
const READ_WIDTH = 64;
const BLOB_WIDTH = 8;
/** Blobs above this many bytes come as stubs to a client that downloads them separately. */
export const LARGE_BLOB = 2 * 1024 * 1024;
const OBJECT_KINDS = ['tree', 'blob', 'commit'];
/**
 * The same for a page: a batch still reading past `ms` from the page's start ends the page at
 * what it served (the client asks again from `next`), or, before the first object, is a
 * retryable TIMEOUT (503). Mutable only so tests can shorten it.
 */
export const PAGE_DEADLINE = { ms: 20_000 };

/**
 * A path-restricted caller may fetch only objects it can name by path inside its grant at
 * a commit (no lookups by bare id, which would be a content oracle). Commit objects carry
 * only ids and are allowed.
 */
export async function authorizeObjects(ctx: RepoContext, wanted: Json[], commitId: unknown) {
  if (!SHA.test(String(commitId ?? '')))
    throw new ApiError('FORBIDDEN', 'Path-restricted callers fetch objects by commit and path');
  const where = await ctx.call({ op: 'repo_commit', commit: commitId });
  const objects = await ctx.objects();
  for (const object of wanted) {
    if (object.kind === 'commit') continue;
    const path = String(object.path ?? '');
    if (!path || !(await decide(ctx, [path])).paths[0]) throw outside();
    const entry = await walk(objects, where.tree, path).catch(() => null);
    const kind = entry?.type === 'tree' ? 'tree' : 'blob';
    if (!entry || entry.id !== object.id || kind !== object.kind) throw outside();
  }
}

/** One page's request and progress (`openPage` validates and authorizes it). */
type Wanted = { id: string; kind: ObjectKind; path?: string };
type Page = {
  ctx: RepoContext;
  objects: Awaited<ReturnType<RepoContext['objects']>>;
  wanted: Wanted[];
  start: number;
  index: number;
  raw: boolean;
  large: boolean;
  served: number;
  missing: string[];
  bytes: number;
  read: number;
  largest: number;
  phase: string;
  began: number;
};

/** The next batch read at once from `index`: up to `READ_WIDTH` objects, `BLOB_WIDTH`
 * blobs of them (a blob's size is known only once read, so blobs in flight are few). */
export function nextBatch(wanted: Wanted[], index: number): Wanted[] {
  let blobs = 0;
  let end = index;
  while (end < wanted.length && end - index < READ_WIDTH) {
    if (wanted[end].kind === 'blob' && ++blobs > BLOB_WIDTH) break;
    end++;
  }
  return wanted.slice(index, end);
}

/** Validates and authorizes a page request; throws the API error before any answer. */
async function openPage(ctx: RepoContext, args: Json): Promise<Page> {
  const wanted = args.objects;
  if (
    !Array.isArray(wanted) ||
    wanted.length === 0 ||
    wanted.length > 10_000 ||
    !wanted.every((o) => SHA.test(o?.id) && OBJECT_KINDS.includes(o?.kind))
  )
    throw new ApiError('INVALID_INPUT', 'objects must be 1-10000 {id, kind} entries');
  const start = Number(args.after ?? 0);
  if (!Number.isSafeInteger(start) || start < 0 || start > wanted.length)
    throw new ApiError('INVALID_INPUT', 'after is outside the request');
  const objects = await ctx.objects();
  // Ids named by the caller: a fork serves inherited ones only to readers of its parent.
  guardInherited(ctx, objects);
  const grant = await decide(ctx, []);
  if (grant.restricted) await authorizeObjects(ctx, wanted, args.commit);
  // `raw`: commits as their exact Git content (`data_b64`) from the store of record, so a
  // client writes the platform's commit byte for byte. A commit only the object store
  // holds (imported history) keeps the tree-and-parents form. Path-restricted callers get
  // that form too: a message may name paths outside their grant.
  const raw = args.raw === true && !grant.restricted;
  // A withheld blob fails the page before it starts (451), never after a streamed answer
  // has begun and would read as a page cut short.
  const held = [
    ...(await objects.withheldAmong(
      wanted
        .slice(start)
        .filter((o) => o.kind === 'blob')
        .map((o) => o.id),
    )),
  ];
  if (held.length) throw quarantined(held[0][0], held[0][1]);
  return {
    ctx,
    objects,
    wanted,
    start,
    index: start,
    raw,
    large: args.large === true,
    served: 0,
    missing: [],
    bytes: 0,
    read: 0,
    largest: 0,
    phase: 'read',
    began: Date.now(),
  };
}

/** One line per page (and per failure) in the Worker's logs: what the page cost. */
function logPage(page: Page, event: string, extra: Json = {}) {
  // This isolate's Wasm memory (it only grows): a page that pushed it up shows here.
  const wasm = compute({ op: 'memory' }).wasm_bytes ?? null;
  const { ctx, wanted, start, index, served, missing, bytes, read, largest, large, raw } = page;
  console.log(
    JSON.stringify({
      event,
      repo: ctx.repo,
      requested: wanted.length,
      after: start,
      index,
      served,
      missing: missing.length,
      bytes,
      read,
      largest,
      large,
      raw,
      ms: Date.now() - page.began,
      tiers: page.objects.hits,
      wasm,
      ...extra,
    }),
  );
}

/**
 * A page's objects in request order, until its response budget or `READ_BUDGET` object
 * bytes read (stubs included); ids the platform lacks go to `page.missing`. With `large`,
 * blobs over `LARGE_BLOB` are stubs (see the header).
 */
async function* readPage(page: Page): AsyncGenerator<Json> {
  const { objects, wanted, raw, large } = page;
  /** A blob as served: inline, or a stub the client downloads (never base64 of its bytes). */
  const blob = async (id: string) => {
    const content = await objects.blob(id);
    page.read += content.length;
    page.largest = Math.max(page.largest, content.length);
    return large && content.length > LARGE_BLOB
      ? { id, kind: 'blob', size: content.length, large: true }
      : { id, kind: 'blob', data_b64: toBase64(content) };
  };
  while (page.index < wanted.length && page.read < READ_BUDGET) {
    const batch = nextBatch(wanted, page.index);
    const commits = raw ? batch.filter((o) => o.kind === 'commit') : [];
    page.phase = commits.length ? 'raw commits' : 'read';
    const exact = new Map(
      (commits.length ? await objects.raw(commits) : [])
        .filter((o) => o.kind === 'commit')
        .map((o) => [o.id, o]),
    );
    page.phase = 'read';
    const left = page.began + PAGE_DEADLINE.ms - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((done) => {
      timer = setTimeout(() => done('late'), Math.max(0, left));
    });
    const reading = Promise.all(
      batch.map((o) =>
        o.kind === 'commit' && exact.has(o.id)
          ? exact.get(o.id)
          : (o.kind === 'blob' ? blob(o.id) : objects.object(o.id, o.kind)).catch((e) => {
              if (e?.code === 'NOT_FOUND') return null;
              throw e;
            }),
      ),
    );
    const results = await Promise.race([reading, late]).finally(() => clearTimeout(timer ?? null));
    if (results === 'late') {
      reading.catch(() => {});
      logPage(page, 'objects.deadline', { phase: page.phase });
      if (page.served > 0) return;
      throw new ApiError('TIMEOUT', `Reading objects took over ${PAGE_DEADLINE.ms} ms; retry`);
    }
    page.phase = 'serve';
    for (const [offset, object] of results.entries()) {
      if (!object) page.missing.push(batch[offset].id);
      else {
        // A blob's size is its base64 text; stringifying it would copy it once more.
        const text = (object as Json).data_b64;
        const size = typeof text === 'string' ? text.length + 96 : JSON.stringify(object).length;
        if (page.served > 0 && page.bytes + size > OBJECT_BUDGET) return;
        page.bytes += size;
        page.served++;
        yield object;
      }
      page.index++;
    }
  }
}

const nextOf = (page: Page) => (page.index < page.wanted.length ? page.index : null);
const failed = (page: Page, e: any) =>
  logPage(page, 'objects.failed', {
    phase: page.phase,
    error: `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`,
  });

/** Immutable objects by id and kind, in request order, up to a response budget, as one JSON
 * value (MCP). `next` resumes after the last object served, so an interrupted client never
 * refetches what it already has. */
export async function getObjects(ctx: RepoContext, args: Json) {
  const page = await openPage(ctx, args);
  const served: Json[] = [];
  try {
    for await (const object of readPage(page)) served.push(object);
  } catch (e) {
    failed(page, e);
    throw e;
  }
  logPage(page, 'objects.page');
  return { objects: served, missing: page.missing, next: nextOf(page), tiers: page.objects.hits };
}

/** `POST /objects` over REST: the same page as `getObjects`, streamed as each batch is read,
 * so a page holds only the batch in flight rather than its whole answer twice (the objects
 * and their JSON). A failure mid-page ends the body early: the client keeps the objects that
 * arrived whole and asks again from the first one that did not. */
export async function streamObjects(ctx: RepoContext, args: Json): Promise<Response> {
  const page = await openPage(ctx, args);
  const objects = readPage(page);
  // The first object is read before answering, so a refusal or failure there (an inherited
  // object the caller may not read, an unavailable tier) is an API error with its status.
  let ahead: IteratorResult<Json> | undefined;
  try {
    ahead = await objects.next();
  } catch (e) {
    failed(page, e);
    throw e;
  }
  const text = new TextEncoder();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      out.enqueue(text.encode('{"objects":['));
    },
    async pull(out) {
      try {
        const step = ahead ?? (await objects.next());
        ahead = undefined;
        if (!step.done) {
          out.enqueue(text.encode(`${first ? '' : ','}${JSON.stringify(step.value)}`));
          first = false;
          return;
        }
        const tail = { missing: page.missing, next: nextOf(page), tiers: page.objects.hits };
        out.enqueue(text.encode(`],${JSON.stringify(tail).slice(1)}`));
        logPage(page, 'objects.page');
        out.close();
      } catch (e) {
        failed(page, e);
        out.error(e);
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}
