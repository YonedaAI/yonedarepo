// Bench client Worker for many concurrent writers (tools/platform-fanout-bench.mjs). One
// laptop cannot hold thousands of open connections and one Worker invocation holds at most
// six, so the driver sends many small batches here: each invocation runs up to five writers
// side by side (commit, then land) against the target over the public internet, and
// returns each request's client latency and the target's Server-Timing total. Placed in
// aws:us-east-1, next to the platform, so it is also the near-region client.
const json = (value, status = 200) => Response.json(value, { status });

async function timed(url, init) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    // Reported, not thrown: one failed request must not hide the batch's other results.
    return { status: 0, ms: Date.now() - started, server: null, timing: '', body: { error: { code: 'CLIENT_FETCH', message: String(e?.message ?? e) } } };
  }
  const body = await response.json().catch(() => ({}));
  const timing = response.headers.get('server-timing') ?? '';
  const server = Number(timing.match(/total;dur=([\d.]+)/)?.[1]);
  return { status: response.status, ms: Date.now() - started, server: Number.isFinite(server) ? server : null, timing, body };
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
          const read = await timed(`${target}/api/v1/repos/${repo}/blob?path=${encodeURIComponent(w.path)}`, { headers: headers(w) });
          return { read: { ...read, ok: read.status === 200 && read.body.content === w.content, body: undefined } };
        }
        const made = await timed(`${target}/api/v1/repos/${repo}/commits`, {
          method: 'POST',
          headers: headers(w),
          body: JSON.stringify({ ref: 'main', changes: [{ path: w.path, content_b64: btoa(w.content) }], message: w.path, author: { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' } }),
        });
        const land =
          made.status === 200
            ? await timed(`${target}/api/v1/repos/${repo}/land`, { method: 'POST', headers: headers(w), body: JSON.stringify({ ref: 'main', commit: made.body.commit }) })
            : null;
        const brief = (r) =>
          r && {
            status: r.status,
            ms: r.ms,
            server: r.server,
            timing: r.timing,
            error: r.body?.error?.code,
            message: r.body?.error?.message?.slice(0, 120),
          };
        return { commit: brief(made), land: brief(land) };
      }),
    );
    return json({ results });
  },
};
