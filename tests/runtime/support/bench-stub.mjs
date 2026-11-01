// A fake platform and the real bench client Worker on loopback, for load tool dry runs: no
// network beyond this process, and nothing that resembles dev. `refuse(path)` scripts failures.
import { createServer } from 'node:http';
import worker from '../../../tools/fanout-bench/worker.js';

const read = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

async function listen(handler) {
  const server = createServer(async (req, res) => {
    const out = await handler(req, await read(req));
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const json = (value, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });

export async function startStub({ landing = () => null } = {}) {
  const state = { calls: [], blobs: new Map(), repos: new Map(), tokens: new Set(), pats: new Map(), head: new Map(), repoCount: 0, patCount: 0 };
  const platform = await listen((req, raw) => {
    const url = new URL(req.url, 'http://stub');
    const path = url.pathname;
    state.calls.push({ method: req.method, path, bearer: (req.headers.authorization ?? '').slice(7, 11) });
    const body = raw.length ? JSON.parse(raw) : {};
    if (path === '/api/auth/login') return json({ username: 'stub' }, 200, { 'set-cookie': 'session=stub; Path=/' });
    const api = path.replace('/api/v1', '');
    if (api === '/repos' && req.method === 'POST') {
      const id = `r${String(++state.repoCount).padStart(20, '0')}`;
      state.repos.set(id, body.name);
      return json({ id });
    }
    if (api === '/tokens' && req.method === 'POST') {
      const id = `pat_${++state.patCount}`;
      state.pats.set(id, body);
      return json({ id, token: `ypat_${'a'.repeat(43)}` });
    }
    if (api.startsWith('/tokens/') && req.method === 'DELETE') {
      state.pats.delete(api.split('/')[2]);
      return json({ revoked: true });
    }
    const [, , repo, resource, name] = api.split('/');
    const head = state.head.get(repo) ?? 0;
    if (resource === 'tokens' && req.method === 'POST') {
      state.tokens.add(`${repo}/${body.name}`);
      return json({ token: `yrp_${body.name}` });
    }
    if (resource === 'tokens' && req.method === 'DELETE') {
      state.tokens.delete(`${repo}/${name}`);
      return json({ revoked: true });
    }
    if (resource === 'txlog') return json({ entries: [] });
    if (resource === 'blob') return json({ content: state.blobs.get(`${repo}/${url.searchParams.get('path')}`) ?? null, version: head });
    if (resource === 'refs') return json({ refs: { 'refs/heads/main': 'c'.repeat(40) }, version: 1 });
    if (resource === 'commits') {
      for (const change of body.changes ?? []) state.blobs.set(`${repo}/${change.path}`, Buffer.from(change.content_b64, 'base64').toString());
      return json({ commit: 'c'.repeat(40), base_version: head });
    }
    if (resource === 'land') {
      const refused = landing(body);
      if (refused) return json({ error: refused }, refused.status ?? 500);
      state.head.set(repo, head + 1);
      return json({ version: head + 1 }, 200, { 'server-timing': 'total;dur=2' });
    }
    if (resource === 'compaction') return json({ floor: 0, head, tail_rows: head, retention: { keep_versions: 10_000 }, storage: { db_bytes: 8192 + head * 5000, table_rows: { commits: head, txlog: head } } });
    return json({ version: head, objects: { pending: 0 } });
  });
  const client = await listen(async (req, raw) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(raw.length ? { body: raw } : {}) });
    const response = await worker.fetch(request, { BENCH_KEY: 'stub-key' });
    return { status: response.status, headers: { 'content-type': 'application/json' }, body: await response.text() };
  });
  return {
    state,
    url: platform.url,
    client: client.url,
    stop: async () => {
      platform.server.closeAllConnections();
      client.server.closeAllConnections();
      await Promise.all([platform, client].map((s) => new Promise((resolve) => s.server.close(resolve))));
    },
  };
}
