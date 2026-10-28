// Requests the bench client sends to the target platform, shared by the burst (worker.js)
// and the open-loop generator (open-loop.js). Each answer is reported, never thrown: one
// failed request must not hide the other results of its invocation.
const AUTHOR = { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' };

/** Client latency (from here) and the target's Server-Timing total of one request. */
export async function timed(url, init, timeoutMs) {
  const started = Date.now();
  const at = { started_at: started };
  let response;
  try {
    response = await fetch(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
  } catch (e) {
    const code = e?.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'CLIENT_FETCH';
    return { ...at, status: 0, ms: Date.now() - started, server: null, timing: '', body: { error: { code, message: String(e?.message ?? e) } } };
  }
  const body = await response.json().catch(() => ({}));
  const timing = response.headers.get('server-timing') ?? '';
  const server = Number(timing.match(/total;dur=([\d.]+)/)?.[1]);
  return { ...at, status: response.status, ms: Date.now() - started, server: Number.isFinite(server) ? server : null, timing, body };
}

export const headers = (w) => ({
  'content-type': 'application/json',
  ...(w.token ? { authorization: `Bearer ${w.token}` } : { cookie: w.cookie }),
});

const brief = (r) =>
  r && {
    started_at: r.started_at,
    status: r.status,
    ms: r.ms,
    server: r.server,
    timing: r.timing,
    version: r.body?.version,
    // The snapshot a commit began from: what its declared reads were read at.
    base_version: r.body?.base_version,
    commit: r.body?.commit,
    error: r.body?.error?.code,
    message: r.body?.error?.message?.slice(0, 120),
  };

/** One writer: commits one file on main (declaring `read_set` when given), then lands it. */
export async function commitAndLand(target, repo, w, timeoutMs) {
  const made = await timed(
    `${target}/api/v1/repos/${repo}/commits`,
    {
      method: 'POST',
      headers: headers(w),
      body: JSON.stringify({
        ref: 'main',
        changes: [{ path: w.path, content_b64: btoa(w.content) }],
        message: w.path,
        author: AUTHOR,
        ...(w.read_set ? { read_set: w.read_set } : {}),
      }),
    },
    timeoutMs,
  );
  const land =
    made.status === 200
      ? await timed(
          `${target}/api/v1/repos/${repo}/land`,
          {
            method: 'POST',
            // The landing mode, honored only where the target allows a per-request choice.
            headers: { ...headers(w), ...(w.mode ? { 'x-yoneda-land-mode': w.mode } : {}) },
            body: JSON.stringify({ ref: 'main', commit: made.body.commit }),
          },
          timeoutMs,
        )
      : null;
  return { commit: brief(made), land: brief(land) };
}

/** One reader: `w.get` (a path under the repository, e.g. `/refs`) must answer 200; a blob
 * read (`w.path`, read-your-writes from `w.version`) must also return `w.content`. A read
 * past `timeoutMs` fails alone (CLIENT_TIMEOUT), not with its whole invocation. */
export async function read(target, repo, w, timeoutMs) {
  if (w.get !== undefined && !/^\/[a-z-]+(\?[\w.%=&/-]*)?$/.test(String(w.get)))
    return { read: { started_at: Date.now(), status: 0, ms: 0, server: null, timing: '', ok: false, error: 'BAD_READ', message: 'get must be /<resource>?<query>' } };
  const url = w.get
    ? `${target}/api/v1/repos/${repo}${w.get}`
    : `${target}/api/v1/repos/${repo}/blob?path=${encodeURIComponent(w.path)}${w.version ? `&min_version=${w.version}` : ''}`;
  const r = await timed(url, { headers: headers(w) }, timeoutMs);
  const content = w.content === undefined || r.body.content === w.content;
  const ok = r.status === 200 && content;
  return { read: { ...r, ok, error: r.body?.error?.code ?? (r.status === 200 && !content ? 'WRONG_CONTENT' : undefined), message: r.body?.error?.message?.slice(0, 120), body: undefined } };
}
