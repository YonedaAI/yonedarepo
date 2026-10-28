// Bundles (repo_store/pushed/bundles.rs): a large push writes each batch of its verified
// objects as one R2 object, a run of frames (kind, 20-byte id, 4-byte length, content),
// and the authority indexes where each object starts. A Worker request has at most six R2
// operations waiting at a time, so one R2 object per Git object made a 12,000-file push or
// lazy checkout take minutes; a bundle is one write, and the objects a read wants come
// back in a few ranged reads. The bundle is durable before its index rows, and the rows
// before any commit naming the objects is recorded: a push that dies between them leaves
// an unreferenced bundle, never a row or commit without its bytes.
import { putBytes } from './repo-stores';
import type { Env } from './types';

type Json = Record<string, any>;
export type Location = { id: string; bundle: string; at: number; size: number; kind: string };
export type Wanted = { id: string; kind: string };

const KINDS = ['', 'commit', 'tree', 'blob'];
const HEADER = 25;
/** As many as one authority call takes (INDEX_OBJECTS, LOCATE_IDS). */
const INDEX_OBJECTS = 5_000;
const LOCATE_IDS = 2_000;
/** Authority calls in flight (they do not count against R2's six). */
const LOCATE_WIDTH = 4;
/** Ranged reads in flight, leaving room under the six for other reads. */
const READ_WIDTH = 3;
/** Neighbours closer than this are read in one range, of at most RANGE bytes. */
const GAP = 64 * 1024;
export const RANGE = 8 * 1024 * 1024;
/** Per-isolate locations (content-addressed: they never change), by repository and id. */
const memo = new Map<string, Location>();
const MEMO_ENTRIES = 50_000;

export const bundlesOn = (env: Env) => env.PUSH_BUNDLES === 'on';
export const bundleKey = (repo: string, bundle: string) => `platform/v1/${repo}/bundles/${bundle}`;
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A command to the repository's authority as the platform's object projector (callers
 * reach it only after the request was authorized for the repository). */
export async function platformCall(env: Env, repo: string, command: Json): Promise<Json> {
  const stub = env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  const response = await stub.fetch('https://source-repository/', {
    method: 'POST',
    body: JSON.stringify({ ...command, _system: 'projection' }),
  });
  const value = await response.json<Json & { error?: { code: string; message: string } }>();
  if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
  return value;
}

async function inWidth<T>(items: T[], width: number, work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += width)
    await Promise.all(items.slice(i, i + width).map(work));
}

function remember(repo: string, location: Location) {
  if (memo.size >= MEMO_ENTRIES) memo.clear();
  memo.set(`${repo}/${location.id}`, location);
}

/**
 * Writes `bytes` (frames from the receive session; each object's `data` is a view into
 * them) as one bundle, then indexes its objects. Nothing is recorded here.
 */
export async function storeBundle(
  env: Env,
  repo: string,
  bytes: Uint8Array,
  objects: { id: string; kind: string; data: Uint8Array }[],
) {
  const bundle = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  await putBytes(env, bundleKey(repo, bundle), 'bundle', bytes);
  const located = objects.map((o) => ({
    id: o.id,
    kind: o.kind,
    at: o.data.byteOffset - bytes.byteOffset,
    size: o.data.length,
  }));
  for (let i = 0; i < located.length; i += INDEX_OBJECTS)
    await platformCall(env, repo, {
      op: 'repo_bundle_index',
      bundle,
      objects: located.slice(i, i + INDEX_OBJECTS),
    });
  for (const l of located) remember(repo, { ...l, bundle });
}

/** Where the bundles hold `wanted` (of the kind asked); objects not bundled are absent. */
export async function locate(env: Env, repo: string, wanted: Wanted[]) {
  const found = new Map<string, Location>();
  const ask: string[] = [];
  for (const { id } of wanted) {
    const known = memo.get(`${repo}/${id}`);
    if (known) found.set(id, known);
    else if (!found.has(id)) ask.push(id);
  }
  const unique = [...new Set(ask)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += LOCATE_IDS) chunks.push(unique.slice(i, i + LOCATE_IDS));
  await inWidth(chunks, LOCATE_WIDTH, async (ids) => {
    const { located } = await platformCall(env, repo, { op: 'repo_bundle_locate', ids });
    for (const l of located as Location[]) {
      found.set(l.id, l);
      remember(repo, l);
    }
  });
  const kinds = new Map(wanted.map((w) => [w.id, w.kind]));
  for (const [id, l] of found) if (kinds.get(id) !== l.kind) found.delete(id);
  return found;
}

/** The content of `located` objects, by id: neighbours share one ranged read, and every
 * frame header read with its content must name the object the index says it holds. */
export async function readLocated(env: Env, repo: string, located: Location[]) {
  const sorted = [...located].sort((a, b) =>
    a.bundle === b.bundle ? a.at - b.at : a.bundle < b.bundle ? -1 : 1,
  );
  const ranges: { bundle: string; start: number; end: number; members: Location[] }[] = [];
  for (const l of sorted) {
    const last = ranges.at(-1);
    const start = l.at - HEADER;
    const end = l.at + l.size;
    if (last && last.bundle === l.bundle && start - last.end <= GAP && end - last.start <= RANGE) {
      last.end = Math.max(last.end, end);
      last.members.push(l);
    } else ranges.push({ bundle: l.bundle, start, end, members: [l] });
  }
  const out = new Map<string, Uint8Array>();
  await inWidth(ranges, READ_WIDTH, async (r) => {
    const object = await env.OBJECTS.get(bundleKey(repo, r.bundle), {
      range: { offset: r.start, length: r.end - r.start },
    });
    if (!object)
      throw Object.assign(new Error(`Object bundle ${r.bundle} is missing`), { code: 'NOT_FOUND' });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const m of r.members) {
      const head = m.at - HEADER - r.start;
      const intact =
        KINDS[bytes[head]] === m.kind &&
        hex(bytes.subarray(head + 1, head + 21)) === m.id &&
        view.getUint32(head + 21) === m.size;
      if (!intact)
        throw Object.assign(new Error(`Object bundle ${r.bundle} does not hold ${m.id}`), {
          code: 'STORE_MISMATCH',
        });
      out.set(m.id, bytes.subarray(head + HEADER, head + HEADER + m.size));
    }
  });
  return out;
}

/** The content of whichever of `wanted` the bundles hold, by id. */
export async function fromBundles(env: Env, repo: string, wanted: Wanted[]) {
  if (wanted.length === 0) return new Map<string, Uint8Array>();
  return readLocated(env, repo, [...(await locate(env, repo, wanted)).values()]);
}
