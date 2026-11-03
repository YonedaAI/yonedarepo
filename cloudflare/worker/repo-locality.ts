// Automatic on-demand read copies. Access, refs and publication remain at the repository
// authority. A private Rust store fences every copy before the existing purge job settles.
import { durableJson } from './durable';
import { log } from './log';
import { regionOfRequest } from './region';
import type { CachedObject } from './repo-stores';
import { record, timed } from './repo-timing';
import { currentScope } from './request-scope';
import type { Env } from './types';

type Region = 'enam' | 'weur';
type Permit = { epoch: number; regions: Region[]; blocked: string[]; disabled: boolean };
type Copies = { permits: Map<string, Promise<Permit>>; fills: number; bytes: number };
const requests = new WeakMap<object, Copies>();
const OBJECT_BYTES = 1024 * 1024;
const REQUEST_BYTES = 4 * OBJECT_BYTES;
const REQUEST_FILLS = 16;

export const automaticLocality = (env: Env) => env.AUTOMATIC_LOCALITY === 'on';

/** The actual client signal, never an account preference or a request header. Other
 * continents retain their existing path until a corresponding copy is available. */
export function localityRegion(env: Env): Region | null {
  const req = currentScope()?.req;
  if (!automaticLocality(env) || !req || new URL(req.url).pathname.startsWith('/internal/ssh/'))
    return null;
  const region = regionOfRequest(req);
  return region === 'enam' || region === 'weur' ? region : null;
}

function requestCopies(): Copies | null {
  const scope = currentScope();
  if (!scope) return null;
  let copies = requests.get(scope);
  if (!copies) {
    copies = { permits: new Map(), fills: 0, bytes: 0 };
    requests.set(scope, copies);
  }
  return copies;
}

const copyName = (repo: string, region: Region | 'registry') => `${repo}:read:${region}`;
async function command(env: Env, repo: string, region: Region | 'registry', body: object) {
  const namespace = env.READ_COPIES;
  if (!namespace) return null;
  const name = copyName(repo, region);
  const value = await durableJson<any>(
    () =>
      namespace.get(namespace.idFromName(name), {
        locationHint: region === 'registry' ? 'enam' : region,
      }),
    'https://read-copy/',
    JSON.stringify({
      ...body,
      repo,
      ...(region !== 'registry' && { region }),
      _system: 'local-copy',
    }),
  );
  if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
  return value;
}

async function permission(env: Env, repo: string) {
  const region = localityRegion(env);
  const request = requestCopies();
  if (!region || !request || !env.READ_COPIES) return null;
  let permit = request.permits.get(repo);
  if (!permit) {
    permit = command(env, repo, 'registry', { op: 'registry_permit', region }) as Promise<Permit>;
    request.permits.set(repo, permit);
  }
  const copy = await permit;
  return copy?.disabled ? null : { ...copy, region, request };
}

/** Only after the enclosing repository read authorized and checked withholding. Copies
 * of fork objects are deliberately left to their parent until provenance is explicit. */
export async function readNearby(env: Env, repo: string, id: string, kind: string) {
  if (kind === 'commit') return null;
  try {
    const permit = await timed('read.copy.permit', () => permission(env, repo));
    if (!permit || permit.blocked.includes(id)) {
      record(permit ? 'read.copy.blocked' : 'read.copy.skipped', 0);
      return null;
    }
    const get = () =>
      timed('read.copy.get', () =>
        command(env, repo, permit.region, { op: 'copy_get', epoch: permit.epoch, id, kind }),
      );
    let answer: any;
    try {
      answer = await get();
    } catch (e: any) {
      if (e?.code !== 'COPY_FENCED') throw e;
      await timed('read.copy.fence', () =>
        command(env, repo, permit.region, {
          op: 'copy_fence',
          epoch: permit.epoch,
          ids: permit.blocked,
        }),
      );
      answer = await get();
    }
    record(answer?.object ? 'read.copy.hit' : 'read.copy.miss', 0);
    return (answer?.object ?? null) as CachedObject | null;
  } catch (e) {
    record('read.copy.unavailable', 0);
    log.warn('read.copy_unavailable', { repo, error: e });
    return null;
  }
}

/** A bounded request-owned fill (optionally through waitUntil). Lost fills are misses;
 * the durable epoch fences publication after quarantine/purge. */
export async function keepNearby(env: Env, repo: string, object: CachedObject) {
  if (object.kind === 'commit') return;
  try {
    const permit = await timed('cache.copy.permit', () => permission(env, repo));
    if (!permit || permit.blocked.includes(object.id)) return;
    const bytes = new TextEncoder().encode(JSON.stringify(object)).byteLength;
    const state = permit.request;
    if (bytes > OBJECT_BYTES || state.fills >= REQUEST_FILLS || state.bytes + bytes > REQUEST_BYTES)
      return;
    state.fills++;
    state.bytes += bytes;
    await timed('cache.copy.put', () =>
      command(env, repo, permit.region, { op: 'copy_put', epoch: permit.epoch, object }),
    );
  } catch (e: any) {
    if (!['COPY_FENCED', 'COPY_TOO_LARGE', 'COPY_FULL'].includes(e?.code))
      log.warn('read.copy_fill_failed', { repo, error: e });
  }
}

/** Invoked by the existing durable purge/quarantine job, even when the read switch is
 * off. Every enrolled region is fenced before the job may acknowledge cleanup. */
export async function fenceReadCopies(env: Env, repo: string, ids: string[] = [], seal = false) {
  if (!env.READ_COPIES) return;
  const fenced = await command(env, repo, 'registry', { op: 'registry_fence', ids, seal });
  for (const region of fenced.regions as Region[])
    await command(env, repo, region, { op: 'copy_fence', epoch: fenced.epoch, ids, seal });
}
