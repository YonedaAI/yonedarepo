// Real served Overview components with labelled API fixtures, not live latency proof.
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { checkOverviewLayout } from '../../tools/staging/overview-layout.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RepoOverview} from '../../src/features/source-platform/RepoOverview';
import {RepoFacts} from '../../src/features/source-platform/RepoFacts';
import '../../src/styles.css';
const repo='r'+'1'.repeat(20),commit='a'.repeat(40),navigate=()=>{};
const status={name:'example',visibility:'public',version:503,refs:[{name:'refs/heads/main',commit_id:commit}],viewer:{owner:true},policy:{approvals:1,required_checks:[]}};
const bootstrap={ref:'main',tree:{commit,path:'',entries:[{name:'README.md',type:'blob',id:'b'.repeat(40)}]},latest:{commit,message:'Keep repository content ready',principal:'user:example',author_name:'Example',landings:[],checks:[]},activity:null,activity_request:{ref:'main',from:commit,at:503},readme:{commit,path:'README.md',encoding:'utf-8',content:'# Example\\n\\nContent is ready before activity.'},empty:false};
createRoot(document.getElementById('root')!).render(<main className="repo-page"><RepoOverview repo={repo} refName="main" status={status} facts={<RepoFacts repo={repo} status={status} owner={true} readOnly={false} canFork={true} navigate={navigate}/>} navigate={navigate} account="example" bootstrap={bootstrap}/></main>);`;

const geometry = (page) => page.evaluate(() => ({
  readme: document.querySelector('.readme').getBoundingClientRect().top,
  activity: document.querySelector('.overview-numbers').getBoundingClientRect().height,
  overflow: document.documentElement.scrollWidth > innerWidth,
}));

test('Overview settles next to README without an oversized activity reserve', { timeout: 120_000 }, async () => {
  const name = `overview-layout-${process.pid}`;
  const fixtureDir = join(root, 'frontend/.local', name);
  const evidenceDir = join(root, '.local/repo-overview-layout');
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(fixtureDir, 'fixture.tsx'), fixture);
  await writeFile(join(fixtureDir, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/.local/${name}/fixture.tsx"></script>`);
  const server = await createServer({
    root: join(root, 'frontend'), configFile: join(root, 'frontend/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, await realpath(join(root, 'node_modules'))] } },
  });
  let browser;
  const results = [];
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ channel: 'chrome' });
    for (const width of [1440, 375]) for (const colorScheme of ['light', 'dark']) {
      for (const state of ['single', 'full', 'old', 'empty', 'error']) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme });
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        try {
          await context.route('**/api/**', async (route) => {
            if (!new URL(route.request().url()).pathname.endsWith('/log')) return route.fulfill({ json: {} });
            await held;
            const commits = state === 'empty' ? [] : Array.from({ length: state === 'single' ? 1 : 200 }, (_, i) => ({
              commit: i.toString(16).padStart(40, '0'), principal: `user:example${i % 8}`,
              author_name: `Example contributor ${i % 8}`, authored_at: state === 'old' ? 1000 : Date.now(),
            }));
            return route.fulfill(state === 'error'
              ? { status: 503, json: { error: { code: 'OVERLOADED', message: 'Unable to read activity' } } }
              : { json: { commits } });
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${origin}.local/${name}/index.html`);
          await page.locator('.readme-body').waitFor();
          await page.locator('.overview-numbers [aria-busy=true]').waitFor();
          await page.evaluate(() => document.fonts.ready);
          const before = await geometry(page);
          if (state === 'full') await page.screenshot({ path: join(evidenceDir, `${width}-${colorScheme}-loading.png`) });
          release();
          await page.locator('.overview-numbers [aria-busy=true]').waitFor({ state: 'detached' });
          if (state === 'error') await page.getByRole('alert').waitFor();
          else if (state === 'empty') await page.getByText('No activity yet.', { exact: true }).waitFor();
          else await page.locator('.overview-people li').first().waitFor();
          const after = await geometry(page);
          assert.equal(after.overflow, false, `${width}/${state}: page overflow`);
          const layout = await checkOverviewLayout(page); // Existing <=32px assertion stays strict.
          if (width === 1440 && ['full', 'single'].includes(state)) {
            assert.ok(Math.abs(after.readme - before.readme) <= 1, `desktop ${state} README shifted`);
          }
          if (state === 'full') {
            assert.equal(await page.locator('.overview-people li').count(), 6);
            const slider = page.getByRole('slider');
            await slider.focus();
            await page.keyboard.press('Home');
            assert.equal(await slider.getAttribute('aria-valuenow'), '0');
          } else if (state === 'error') {
            await page.getByRole('button', { name: 'Retry' }).focus();
          } else {
            await page.getByRole('combobox', { name: 'Branch or tag' }).focus();
          }
          assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(evidenceDir, `${width}-${colorScheme}-${state}.png`) });
          results.push({ width, colorScheme, state, before, after, layout, readme_delta: after.readme - before.readme });
        } finally {
          release();
          await context.close();
        }
      }
    }
  } finally {
    await writeFile(join(evidenceDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await browser?.close();
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
