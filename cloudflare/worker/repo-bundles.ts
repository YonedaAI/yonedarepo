// Bundles (repo_store/pushed/bundles.rs): a large push writes each batch of its verified
// objects as one R2 object, a run of frames (kind, 20-byte id, 4-byte length, content),
// and the authority indexes where each object starts. A Worker request has at most six R2
// operations waiting at a time, so one R2 object per Git object made a 12,000-file push or
// lazy checkout take minutes; a bundle is one write, and the objects a read wants come
// back in a few ranged reads. The bundle is durable before its index rows, and the rows
// before any commit naming the objects is recorded: a push that dies between them leaves
// an unreferenced bundle, never a row or commit without its bytes.
//
// Readers ask the authority where objects are only for repositories known to hold bundles:
// a single read that missed R2 asks in the staged-object call it makes anyway, so a
// repository without bundles (API commits under a burst) costs its authority nothing more.
import { putBytes } from './repo-stores';
import type { Env } from './types';

type Json = Record<string, any>;
export type Location = { id: string; bundle: string; at: number; size: number; kind: string };
export type Wanted = { id: string; kind: string };

const KINDS = ['', 'commit', 'tree', 'blob'];
export const HEADER = 25;
/** As many as one authority call takes (INDEX_OBJECTS, LOCATE_IDS). */
const INDEX_OBJECTS = 5_000;
const LOCATE_IDS = 2_000;
/** Authority calls in flight (they do not count against R2's six). */
const LOCATE_WIDTH = 4;
/** Ranged reads in flight, leaving room under the six for other reads. */
const READ_WIDTH = 3;
/** Neighbours closer than this are read in one range, of at most RANGE bytes. */
const GAP = 64 * 1024;
/** The gap bridged where reads are many and sequential (a clone's walk and pack): a ranged
 * read waits ~60-80 ms (hosted), far longer than a MiB takes to arrive, so a pushed
 * history's scattered trees and files cost a few long reads, not one read each. */
export const WIDE_GAP = 1024 * 1024;
export const RANGE = 8 * 1024 * 1024;
/** Ranged bytes per read for callers that hold every result at once (the projection). */
export const SMALL_RANGE = 1024 * 1024;

/**
 * Object locations by repository and id, least recently used leaving first (about 300
 * bytes each), and the repositories known to hold bundles. Both are content-addressed
 * facts: a location never changes and index rows outlive no repository.
 */
export class LocationMemo {
  #places = new Map<string, Location>();
  #repos = new Set<string>();

  constructor(private readonly limit: number) {}

  get size() {
    return this.#places.size;
  }

  get(repo: string, id: string) {
    const key = `${repo}/${id}`;
    const place = this.#places.get(key);
    if (place) {
      this.#places.delete(key);
      this.#places.set(key, place);
    }
    return place;
  }

  set(repo: string, place: Location) {
    this.bundled(repo);
    this.#places.delete(`${repo}/${place.id}`);
    this.#places.set(`${repo}/${place.id}`, place);
    for (const oldest of this.#places.keys()) {
      if (this.#places.size <= this.limit) break;
      this.#places.delete(oldest);
    }
  }

  /** Notes that `repo` holds bundles. */
  bundled(repo: string) {
    this.#repos.delete(repo);
    this.#repos.add(repo);
    for (const oldest of this.#repos) {
      if (this.#repos.size <= REPOS) break;
      this.#repos.delete(oldest);
    }
  }

  holds(repo: string) {
    return this.#repos.has(repo);
  }

  clear() {
    this.#places.clear();
    this.#repos.clear();
  }
}
const REPOS = 1_024;

/** This isolate's locations: ~8k objects, a few MB (50k entries measured ~15 MB). */
export const isolateLocations = new LocationMemo(8_192);

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
  for (const l of located) isolateLocations.set(repo, { ...l, bundle });
}

/** Whether this isolate knows `repo` holds bundles (its status says so, or it read one). */
const holdsBundles = (repo: string) => isolateLocations.holds(repo);
export const noteBundles = (repo: string) => isolateLocations.bundled(repo);

/** Of `found` (locations answered for `wanted`), those of the kind asked, by id. */
function ofKind(wanted: Wanted[], found: Map<string, Location>) {
  const kinds = new Map(wanted.map((w) => [w.id, w.kind]));
  for (const [id, l] of found) if (kinds.get(id) !== l.kind) found.delete(id);
  return found;
}

/** Where the memo says bundles hold `wanted`, with no I/O. */
function remembered(repo: string, wanted: Wanted[]) {
  const found = new Map<string, Location>();
  for (const { id } of wanted) {
    const known = isolateLocations.get(repo, id);
    if (known) found.set(id, known);
  }
  return ofKind(wanted, found);
}

/** Where the bundles hold `wanted` (of the kind asked); objects not bundled are absent. */
export async function locate(env: Env, repo: string, wanted: Wanted[]) {
  const found = remembered(repo, wanted);
  const ask: string[] = [];
  for (const { id } of wanted) if (!found.has(id)) ask.push(id);
  const unique = [...new Set(ask)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += LOCATE_IDS) chunks.push(unique.slice(i, i + LOCATE_IDS));
  await inWidth(chunks, LOCATE_WIDTH, async (ids) => {
    const { located } = await platformCall(env, repo, { op: 'repo_bundle_locate', ids });
    for (const l of located as Location[]) {
      found.set(l.id, l);
      isolateLocations.set(repo, l);
    }
  });
  return ofKind(wanted, found);
}

/** How `readLocated` reads: neighbours closer than `gap` share a range; `copy` keeps
 * copies (not views pinning whole ranges); `frame` sees every object in each range read. */
export type ReadOptions = {
  gap?: number;
  copy?: boolean;
  frame?: (kind: string, id: string, data: Uint8Array) => void;
};

/** The content of `located` objects, by id: neighbours share one ranged read of at most
 * `range` bytes, and every frame header read with its content must name the object the
 * index says it holds. */
export async function readLocated(
  env: Env,
  repo: string,
  located: Location[],
  range = RANGE,
  { gap = GAP, copy = false, frame }: ReadOptions = {},
) {
  const sorted = [...located].sort((a, b) =>
    a.bundle === b.bundle ? a.at - b.at : a.bundle < b.bundle ? -1 : 1,
  );
  const ranges: { bundle: string; start: number; end: number; members: Location[] }[] = [];
  for (const l of sorted) {
    const last = ranges.at(-1);
    const start = l.at - HEADER;
    const end = l.at + l.size;
    if (last && last.bundle === l.bundle && start - last.end <= gap && end - last.start <= range) {
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
      const data = bytes.subarray(head + HEADER, head + HEADER + m.size);
      out.set(m.id, copy ? data.slice() : data);
    }
    // A range starts and ends on frame boundaries; a frame that does not fit ends the walk
    // (whoever keeps one checks it against its id, as for any stored object).
    for (let at = 0; frame && at + HEADER <= bytes.length; ) {
      const kind = KINDS[bytes[at]];
      const size = view.getUint32(at + 21);
      if (!kind || at + HEADER + size > bytes.length) break;
      frame(
        kind,
        hex(bytes.subarray(at + 1, at + 21)),
        bytes.subarray(at + HEADER, at + HEADER + size),
      );
      at += HEADER + size;
    }
  });
  return out;
}

/** The content of whichever of `wanted` the bundles hold, by id. */
export async function fromBundles(
  env: Env,
  repo: string,
  wanted: Wanted[],
  range = RANGE,
  options: ReadOptions = {},
) {
  if (wanted.length === 0) return new Map<string, Uint8Array>();
  return readLocated(env, repo, [...(await locate(env, repo, wanted)).values()], range, options);
}

/** The content of whichever of `wanted` this isolate has located, with `located` (the rows a
 * staged read answered) remembered first: no locate call. */
export function readKnown(
  env: Env,
  repo: string,
  wanted: Wanted[],
  located: Location[] = [],
  range = RANGE,
  options: ReadOptions = {},
) {
  for (const l of located) isolateLocations.set(repo, l);
  return readLocated(env, repo, [...remembered(repo, wanted).values()], range, options);
}

/** `fromBundles` where `repo` is known to hold bundles, else `readKnown`. */
export function readBundled(
  env: Env,
  repo: string,
  wanted: Wanted[],
  range = RANGE,
  options: ReadOptions = {},
) {
  return holdsBundles(repo)
    ? fromBundles(env, repo, wanted, range, options)
    : readKnown(env, repo, wanted, [], range, options);
}
