import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function reachable(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  const imports = /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const [, binding, spec] of source.matchAll(imports)) {
    if (!spec.startsWith('.') || /\.css$/.test(spec)) continue;
    if (/^\s*\{/.test(binding) && binding.replace(/[{}]/g, '').split(',').filter(s => s.trim()).every(s => s.trim().startsWith('type '))) continue;
    const base = resolve(dirname(file), spec);
    for (const path of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (await stat(path).then(s => s.isFile()).catch(() => false)) {
        await reachable(path, seen);
        break;
      }
    }
  }
  return seen;
}
test('the workspace entry does not statically import public pages or their written content', async () => {
  const paths = await reachable(resolve(root, 'frontend/src/main.tsx'));
  for (const name of ['SiteRoot.tsx', 'seo.ts', 'content.ts', 'docs/docsContent.ts'])
    assert(!paths.has(resolve(root, `frontend/src/features/site/${name}`)), `Initial app imports public ${name}`);
});

const { publicEntryTemplates } = await import('../../frontend/vite-public-entry.ts');
const { runInNewContext } = await import('node:vm');
test('public documents preload their code and styles; workspace documents preload neither', () => {
  const templates = publicEntryTemplates('<head></head><div id="root"></div>', 'assets/public-hash.js', ['assets/public-hash.css']);
  assert.match(templates.site, /<link rel="modulepreload" crossorigin href="\/assets\/public-hash.js">/);
  assert.match(templates.site, /<link rel="stylesheet" crossorigin href="\/assets\/public-hash.css">/);
  assert(!templates.app.includes('<link rel="modulepreload"'));
  const script = templates.app.match(/<script data-yoneda-public-entry>([\s\S]+?)<\/script>/)[1];
  for (const pathname of ['/example/project', '/agents', '/signin-extra', '/signup/extra']) {
    const added = [];
    runInNewContext(script, { location: { pathname }, document: { createElement: () => ({}), head: { append: (node) => added.push(node) } } });
    assert.equal(added.length, 0, pathname);
  }
  for (const pathname of ['/signin', '/signup', '/signin/', '/signup/']) {
    const added = [];
    runInNewContext(script, { location: { pathname }, document: { createElement: () => ({}), head: { append: (node) => added.push(node) } } });
    assert.deepEqual(added.map(n => n.rel), ['modulepreload', 'stylesheet'], pathname);
  }
});

const { overviewEntryTemplate } = await import('../../frontend/vite-public-entry.ts');
const { plainNamedOverview } = await import('../../frontend/src/lib/overviewEntryRoute.ts');
const { reservedHandlesSchema } = await import('../../shared/contracts/reserved-handles.ts');
test('renderer head code shares the admission guard and requests no API or data', () => {
  const output = overviewEntryTemplate('<head></head>', 'assets/renderer-hash.js', reservedHandlesSchema.enum, plainNamedOverview.toString());
  const script = output.match(/<script data-yoneda-overview-code>([\s\S]+?)<\/script>/)[1];
  for (const path of ['/sample/repo', '/sample/name_1/', '/sample/repo?ref=main', '/sample/repo#part', '/sample/repo/files', '/agents', '/docs/guide', ...reservedHandlesSchema.enum.map(r => `/${r}/repo`)]) {
    const added = [];
    const location = new URL(path, 'https://example.test');
    runInNewContext(script, { location, document: { createElement: () => ({}), head: { append: node => added.push(node) } } });
    const expected = plainNamedOverview(location, reservedHandlesSchema.enum) ? 1 : 0;
    assert.equal(added.length, expected, path);
    if (expected) assert.deepEqual(added.map(n => [n.rel, n.href, n.crossOrigin]), [['modulepreload', '/assets/renderer-hash.js', '']]);
  }
});
