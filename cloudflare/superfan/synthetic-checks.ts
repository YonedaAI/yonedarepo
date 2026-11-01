// What a synthetic check does: the requests a person or a Git client would make, from outside the
// platform, marked as our own. Budget: docs/observability-plan.md. Nothing here touches the ledger
// or a Cloudflare binding, so tests/workers can run each check against the real platform. A check
// keeps a status, an id and how long it took: never an answer's text, a repository or a token.
import { FRONT_SERVICE, revisionOf } from './probes';

export const PROBE_CHECKS = ['health', 'page', 'api', 'clone', 'land'] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];
export interface ProbeResult {
  check: ProbeCheck;
  ok: boolean;
  status: number | null;
  ms: number;
  /** What failed and the request's id; null on success. */
  detail: string | null;
  revision: string | null;
}
export interface ProbeTargets {
  front: string;
  api: string;
  /** A small public repository; unset: `clone` does not run. */
  cloneRepo?: string;
  /** A repository and a token that may write and land on it; unset: `land` does not run. */
  land?: { repo: string; token: string };
}
export type Fetcher = typeof fetch;
type Answer = { revision?: string | null } | undefined;
type Call = (url: string, init?: RequestInit) => Promise<Response>;

/** Every finding key the checks can file. */
export const PROBE_KEYS = PROBE_CHECKS.map((check) => `synthetic:probe_${check}`);

const TRY_MS = 15_000;
const RETRY_MS = 2_000;
const CLONE_MAX_BYTES = 1024 * 1024;
const DETAIL_LIMIT = 120;
const LAND_PATH = 'probe/landing.txt';
const AUTHOR = { name: 'YonedaRepo probe', email: 'probe@yonedarepo.invalid' };
const HEADERS = { 'user-agent': 'yonedarepo-probe/1', 'x-yoneda-own-traffic': '1' };
const REPO = /^r[0-9a-f]{20}$/;
const SHA1_BYTES = 20;

class Failed extends Error {
  constructor(
    readonly detail: string,
    readonly status: number | null = null,
  ) {
    super(detail);
  }
}

const idOf = (res: Response) => res.headers.get('x-request-id') ?? res.headers.get('cf-ray');

/** `res` when it is a 200; otherwise what failed, with the id that finds its log lines. */
async function ok(res: Response, what: string) {
  if (res.status === 200) return res;
  await res.body?.cancel().catch(() => {});
  const id = idOf(res);
  throw new Failed(`${what}: HTTP ${res.status}${id ? `, id ${id}` : ''}`, res.status);
}

async function json(res: Response, what: string) {
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!body) throw new Failed(`${what}: unreadable answer`, res.status);
  return body;
}

async function health(call: Call, { front }: ProbeTargets) {
  const res = await ok(await call(`${front}/health`), 'health');
  const body = await json(res, 'health');
  if (body.service !== FRONT_SERVICE) throw new Failed('health: not the website', res.status);
  return { revision: revisionOf(body) };
}

async function page(call: Call, { front }: ProbeTargets) {
  const res = await ok(await call(`${front}/`), 'page');
  if (!/<!doctype html/i.test(await res.text())) throw new Failed('page: no HTML', res.status);
  return undefined;
}

async function api(call: Call, { front }: ProbeTargets) {
  const res = await ok(await call(`${front}/api/v1/explore?limit=1`), 'api');
  if (!Array.isArray((await json(res, 'api')).repos)) throw new Failed('api: no list', res.status);
  return undefined;
}

const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

/** What Git sends for a full clone of `commit`: protocol version 0, no capabilities, so the pack
 * comes bare after `NAK`. */
export const cloneRequest = (commit: string) => `${line(`want ${commit}\n`)}0000${line('done\n')}`;

/** The whole answer, or a failure past `limit`: a clone of the wrong repository must stop. */
async function bounded(res: Response, limit: number) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Failed('clone: the probe repository is too large', res.status);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** The pack after `NAK` must end with the SHA-1 of what came before it: what Git itself checks. */
async function checkPack(bytes: Uint8Array, status: number) {
  const nak = new TextEncoder().encode(line('NAK\n')).length;
  const pack = bytes.subarray(nak);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK')
    throw new Failed('clone: no pack in the answer', status);
  const body = pack.subarray(0, -SHA1_BYTES);
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  const stated = pack.subarray(-SHA1_BYTES);
  if (sum.length !== stated.length || sum.some((b, i) => b !== stated[i]))
    throw new Failed('clone: the pack fails its checksum', status);
}

async function clone(call: Call, { api: origin, cloneRepo }: ProbeTargets) {
  if (!REPO.test(cloneRepo ?? '')) throw new Failed('clone: PROBE_CLONE_REPO is malformed');
  const base = `${origin}/git/${cloneRepo}.git`;
  const refs = await ok(await call(`${base}/info/refs?service=git-upload-pack`), 'refs');
  const listed = new TextDecoder().decode(await refs.arrayBuffer());
  const main = /([0-9a-f]{40}) refs\/heads\/main/.exec(listed)?.[1];
  if (!main) throw new Failed('refs: no main', refs.status);
  const answer = await call(`${base}/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: cloneRequest(main),
  });
  await ok(answer, 'clone');
  await checkPack(await bounded(answer, CLONE_MAX_BYTES), answer.status);
  return undefined;
}

async function land(call: Call, { api: origin, land: probe }: ProbeTargets) {
  if (!probe || !REPO.test(probe.repo)) throw new Failed('land: PROBE_LAND_REPO is malformed');
  const send = async (path: string, what: string, body: unknown) => {
    const res = await call(`${origin}/api/v1/repos/${probe.repo}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${probe.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return json(await ok(res, what), what);
  };
  const { commit } = await send('commits', 'commit', {
    ref: 'main',
    changes: [{ path: LAND_PATH, content_b64: btoa(new Date().toISOString()) }],
    message: 'Probe landing',
    author: AUTHOR,
  });
  if (typeof commit !== 'string') throw new Failed('commit: no commit');
  const { version } = await send('land', 'land', { ref: 'main', commit });
  if (!Number.isInteger(version)) throw new Failed('land: no version');
  return undefined;
}

const WORK: Record<ProbeCheck, (call: Call, targets: ProbeTargets) => Promise<Answer>> = {
  health,
  page,
  api,
  clone,
  land,
};

async function attempt(check: ProbeCheck, targets: ProbeTargets, fetcher: Fetcher) {
  const started = Date.now();
  const signal = AbortSignal.timeout(TRY_MS);
  const call: Call = (url, init = {}) =>
    fetcher(url, {
      redirect: 'manual',
      ...init,
      headers: { ...HEADERS, ...init.headers },
      signal,
    });
  const done = { check, ms: 0, revision: null };
  try {
    const answer = await WORK[check](call, targets);
    const ms = Date.now() - started;
    return { ...done, ok: true, status: 200, ms, detail: null, ...answer } as ProbeResult;
  } catch (e) {
    const ms = Date.now() - started;
    const timedOut = (e as Error)?.name === 'TimeoutError';
    const failure = e instanceof Failed ? e : new Failed(timedOut ? 'timed out' : 'no answer');
    return {
      ...done,
      ok: false,
      status: failure.status,
      ms,
      detail: `${failure.detail}`.slice(0, DETAIL_LIMIT),
    } as ProbeResult;
  }
}

/** One check, tried again once after a pause: one lost packet is not an outage. */
export async function runCheck(
  check: ProbeCheck,
  targets: ProbeTargets,
  pause: (ms: number) => Promise<void>,
  fetcher: Fetcher = fetch,
) {
  const first = await attempt(check, targets, fetcher);
  if (first.ok) return first;
  await pause(RETRY_MS);
  return attempt(check, targets, fetcher);
}
