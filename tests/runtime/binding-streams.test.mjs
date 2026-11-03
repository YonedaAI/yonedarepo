// Exercise real service-binding upload pumps and tail exceptions, not a Node fetch double.
// Use Wrangler's pinned workerd/Miniflare and bundler so this follows our deployed toolchain.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(createRequire(import.meta.url).resolve('wrangler'));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));

for (const [route, contents] of [
  ['forward helper', `import { forwardRequest } from './cloudflare/worker/forward-request';
    export default { fetch(req, env) { return forwardRequest(env.NEXT, req); } };`],
  ['regional edge', `import { edgeFetch } from './cloudflare/worker/cell-edge';
    export default { fetch(req, env) { return edgeFetch(req, {CELLS:'on', PLATFORM:env.NEXT}); } };`],
  ['wrong first region', `import { forwardTo } from './cloudflare/worker/cell-route';
    export default { fetch(req, env) { return forwardTo({CELL_WEUR:env.NEXT}, 'weur', req); } };`],
]) test(`slow uploads through ${route} finish without post-response runtime exceptions`, { timeout: 15_000 }, async () => {
  const compiled = await build({
    stdin: {
      contents,
      resolveDir: root,
      sourcefile: 'binding-test.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    plugins: [{ name: 'runtime-wasm', setup(b) { b.onResolve({ filter: /\.wasm$/ }, () => ({ path: './index_bg.wasm', external: true })); } }],
  });
  const traces = [];
  let received;
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [
      {
        name: 'front', modules: [
          { type: 'ESModule', path: `${root}/front.mjs`, contents: compiled.outputFiles[0].text },
          { type: 'CompiledWasm', path: `${root}/index_bg.wasm`, contents: readFileSync(`${root}/backend/crates/yoneda-worker/build/index_bg.wasm`) },
        ], compatibilityDate: '2026-10-07',
        compatibilityFlags: ['nodejs_compat'],
        serviceBindings: { NEXT: 'back' }, tails: ['tail'],
      },
      {
        name: 'back', modules: true, compatibilityDate: '2026-10-07', tails: ['tail'],
        script: `export default {fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === '/duplex') return new Response(req.body);
          if (path === '/refused') return new Response(null, {status: 401});
          return Response.json({connected: 0});
        }};`,
      },
      {
        name: 'tail', modules: true, compatibilityDate: '2026-10-07',
        script: `export default {async tail(events, env) {
          await env.CAPTURE.fetch('https://capture/', {method: 'POST', body: JSON.stringify(events)});
        }};`,
        serviceBindings: { CAPTURE: async req => {
          traces.push(...await req.json());
          received?.();
          return new Response(null);
        } },
      },
    ],
  }));
  try {
    const origin = await mf.ready;
    for (const [method, path, status, text] of [
      ['POST', '/ignored', 200, '{"connected":0}'],
      ['POST', '/refused', 401, ''],
      ['POST', '/duplex', 200, '{}'],
      // HTTP clients can send these bodies, although Fetch Request constructors forbid them.
      ['GET', '/ignored', 200, '{"connected":0}'],
      ['HEAD', '/ignored', 200, ''],
    ]) {
      const start = traces.length;
      let tailTimer;
      const tails = new Promise((resolve, reject) => {
        tailTimer = setTimeout(() => reject(new Error('Worker tail events missing')), 5_000);
        received = () => {
          if (traces.length < start + 2) return;
          clearTimeout(tailTimer);
          resolve();
        };
      });
      let request;
      let finish;
      try {
        const response = await new Promise((resolve, reject) => {
          request = http.request(new URL(path, origin), { method, headers: { 'transfer-encoding': 'chunked' } }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          request.on('error', reject);
          request.write('{');
          finish = setTimeout(() => request.end('}'), 100);
        });
        assert.deepEqual(response, { status, body: text }, `${method} ${path}`);
        await tails;
        assert.deepEqual(traces.slice(start).flatMap(t => t.exceptions), [], `${method} ${path}`);
      } finally {
        clearTimeout(tailTimer);
        clearTimeout(finish);
        request?.destroy();
      }
    }
  } finally {
    await mf.dispose();
  }
});
