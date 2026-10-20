// Bench client Worker for many concurrent writers (tools/platform-fanout-bench.mjs). One
// laptop cannot hold thousands of open connections and one Worker invocation holds at most
// six, so the driver sends many small batches here: each invocation runs up to five writers
// side by side (commit, then land) against the target over the public internet, and
// returns each request's client latency and the target's Server-Timing total. Placed in
// aws:us-east-1, next to the platform, so it is also the near-region client.
const json = (value, status = 200) => Response.json(value, { status });

async function timed(url, init) {
  const started = Date.now();
  const at = { started_at: started };
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    // Reported, not thrown: one failed request must not hide the batch's other results.
    return { ...at, status: 0, ms: Date.now() - started, server: null, timing: '', body: { error: { code: 'CLIENT_FETCH', message: String(e?.message ?? e) } } };
  }
  const body = await response.json().catch(() => ({}));
  const timing = response.headers.get('server-timing') ?? '';
  const server = Number(timing.match(/total;dur=([\d.]+)/)?.[1]);
  return { ...at, status: response.status, ms: Date.now() - started, server: Number.isFinite(server) ? server : null, timing, body };
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || request.headers.get('x-bench-key') !== env.BENCH_KEY)
      return json({ error: 'forbidden' }, 403);
    const { target, repo, writers } = await request.json();
    if (!/^https:\/\/[a-z0-9.-]+$/.test(target) || !Array.isArray(writers) || writers.length > 5)
      return json({ error: 'bad request' }, 400);
    const headers = (w) => ({
      'content-type': 'application/json',
      ...(w.token ? { authorization: `Bearer ${w.token}` } : { cookie: w.cookie }),
    });
    const results = await Promise.all(
      writers.map(async (w) => {
        if (w.read) {
          // Read-your-writes: a reader passes the version its landing reported.
          const since = w.version ? `&min_version=${w.version}` : '';
          const read = await timed(`${target}/api/v1/repos/${repo}/blob?path=${encodeURIComponent(w.path)}${since}`, {
            headers: headers(w),
          });
          const ok = read.status === 200 && read.body.content === w.content;
          return { read: { ...read, ok, error: read.body?.error?.code, message: read.body?.error?.message?.slice(0, 120), body: undefined } };
        }
        const made = await timed(`${target}/api/v1/repos/${repo}/commits`, {
          method: 'POST',
          headers: headers(w),
          body: JSON.stringify({ ref: 'main', changes: [{ path: w.path, content_b64: btoa(w.content) }], message: w.path, author: { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' } }),
        });
        const land =
          made.status === 200
            ? await timed(`${target}/api/v1/repos/${repo}/land`, {
                method: 'POST',
                // The landing mode, honored only where the target allows a per-request choice.
                headers: { ...headers(w), ...(w.mode ? { 'x-yoneda-land-mode': w.mode } : {}) },
                body: JSON.stringify({ ref: 'main', commit: made.body.commit }),
              })
            : null;
        const brief = (r) =>
          r && {
            started_at: r.started_at,
            status: r.status,
            ms: r.ms,
            server: r.server,
            timing: r.timing,
            version: r.body?.version,
            commit: r.body?.commit,
            error: r.body?.error?.code,
            message: r.body?.error?.message?.slice(0, 120),
          };
        return { commit: brief(made), land: brief(land) };
      }),
    );
    return json({ results });
  },
};
