// One small batch of requests from a regional client (region-worker.js): the page, read, Git or
// write a person or agent would send from this region, with where each one's time went. The
// driver decides what comes next and waits out the think time, so an invocation holds no idle
// connection. A step goes to the public platform, or (`serve`) to the platform's routes running
// inside this region (cloudflare/worker/repo-region-serve.ts). No Node imports: this runs in the
// Worker. Each answer is reported, never thrown.
import { OWN_TRAFFIC } from '../own-traffic.mjs';

export const REGION_VERSION = 4;
const MAX_STEPS = 12;
const STEP_MS = 60_000;
/** A kept JSON answer past this is cut: the driver needs ids from it, never a whole page. */
const KEEP_BYTES = 256 * 1024;
const LABEL = /^[a-z0-9_.-]{1,40}$/;
/** What the platform's routes answer; a page and its assets are the front Worker's. */
const SERVED = /^\/(api|git)\//;

export const validSteps = (steps) =>
  Array.isArray(steps) &&
  steps.length > 0 &&
  steps.length <= MAX_STEPS &&
  steps.every((s) => LABEL.test(s?.label ?? '') && typeof s.path === 'string' && s.path.startsWith('/') && !s.path.startsWith('//'));

const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes.subarray(0, 1 << 20));

function failure(raw, response) {
  const parsed = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(raw.subarray(0, 4096)));
    } catch {
      return null;
    }
  })();
  return { error: parsed?.error?.code ?? `HTTP_${response.status}`, message: parsed?.error?.message?.slice(0, 120) };
}

/** Sends `s` to `target`, or to `serve` when given and it can answer; `{status: 0}` when no
 * answer came, never a throw. */
export async function runStep(target, s, serve) {
  const started = Date.now();
  const report = { label: s.label, started_at: started };
  const headers = { ...s.headers };
  if (s.token) headers.authorization = `Bearer ${s.token}`;
  if (s.cookie) headers.cookie = s.cookie;
  if (s.json !== undefined) headers['content-type'] = 'application/json';
  const body = s.json !== undefined ? JSON.stringify(s.json) : s.body_b64 !== undefined ? bytesOf(s.body_b64) : undefined;
  const init = {
    method: s.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...OWN_TRAFFIC, ...headers },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(STEP_MS),
  };
  let response;
  try {
    response = await (serve && SERVED.test(s.path) ? serve(`${target}${s.path}`, init) : fetch(`${target}${s.path}`, init));
  } catch (e) {
    const code = e?.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'CLIENT_FETCH';
    return { ...report, status: 0, ok: false, ms: Date.now() - started, server: null, timing: '', error: code, message: String(e?.message ?? e).slice(0, 120) };
  }
  const first_byte_ms = Date.now() - started;
  const raw = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const ms = Date.now() - started;
  const timing = response.headers.get('server-timing') ?? '';
  const server = Number(timing.match(/total;dur=([\d.]+)/)?.[1]);
  const fine = response.status >= 200 && response.status < 400;
  const content = !s.contains || latin1(raw).includes(s.contains);
  const answer = {
    ...report,
    status: response.status,
    ok: fine && content,
    ms,
    first_byte_ms,
    bytes: raw.length,
    server: Number.isFinite(server) ? server : null,
    timing,
    // The colo the request entered Cloudflare at, and where the Worker it reached ran.
    edge: response.headers.get('cf-ray')?.split('-')[1] ?? null,
    placement: response.headers.get('cf-placement'),
    ...(fine ? (content ? {} : { error: 'WRONG_CONTENT' }) : failure(raw, response)),
  };
  // Optional public-asset attestation: keep bytes out of records, and never copy arbitrary
  // response headers (sign-in and create responses can carry credentials).
  if (s.sha256 === true) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    answer.sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    answer.cache = {
      status: response.headers.get('cf-cache-status'),
      control: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
    };
  }
  if (s.keep && fine && raw.length <= KEEP_BYTES) answer.value = JSON.parse(new TextDecoder().decode(raw));
  if (s.keep_cookie) answer.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? null;
  return answer;
}

/** Runs `steps` in order, or side by side (a page's requests), against one target. */
export async function runSteps(target, steps, parallel = false, serve) {
  if (parallel) return Promise.all(steps.map((s) => runStep(target, s, serve)));
  const out = [];
  for (const s of steps) out.push(await runStep(target, s, serve));
  return out;
}

/** The named region's serving object, as a `fetch`. A hint counts on its first `get` only, and
 * from then on the stored object stays. A binding call can't take an abort signal. */
export function servedFrom(env, hint) {
  const namespace = env.LAND_COMBINERS;
  const stub = namespace.get(namespace.idFromName(`region-serve:${hint}`), { locationHint: hint });
  return (url, { signal, ...init }) =>
    Promise.race([
      stub.fetch(url, init),
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    ]);
}
