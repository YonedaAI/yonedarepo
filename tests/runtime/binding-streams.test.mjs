// Exercise real service-binding upload pumps and tail exceptions, not a Node fetch double.
// Use Wrangler's pinned workerd/Miniflare and bundler so this follows our deployed toolchain.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(createRequire(import.meta.url).resolve('wrangler'));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));

test('slow uploads through a binding finish without post-response runtime exceptions', { timeout: 15_000 }, async () => {
  const compiled = await build({
    stdin: {
      contents: `import { forwardRequest } from './cloudflare/worker/forward-request';
        export default { fetch(req, env) { return forwardRequest(env.NEXT, req); } };`,
      resolveDir: root,
      sourcefile: 'binding-test.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const traces = [];
  let received;
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [
      {
        name: 'front', modules: true, compatibilityDate: '2026-10-07',
        script: compiled.outputFiles[0].text,
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
    for (const [path, status, text] of [
      ['/ignored', 200, '{"connected":0}'],
      ['/refused', 401, ''],
      ['/duplex', 200, '{}'],
    ]) {
      const start = traces.length;
      const tails = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker tail events missing')), 5_000);
        received = () => {
          if (traces.length < start + 2) return;
          clearTimeout(timer);
          resolve();
        };
      });
      let request;
      let finish;
      try {
        const response = await new Promise((resolve, reject) => {
          request = http.request(new URL(path, origin), { method: 'POST' }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          request.on('error', reject);
          request.write('{');
          finish = setTimeout(() => request.end('}'), 100);
        });
        await tails;
        assert.deepEqual(response, { status, body: text }, path);
        assert.deepEqual(traces.slice(start).flatMap(t => t.exceptions), [], path);
      } finally {
        clearTimeout(finish);
        request?.destroy();
      }
    }
  } finally {
    await mf.dispose();
  }
});
