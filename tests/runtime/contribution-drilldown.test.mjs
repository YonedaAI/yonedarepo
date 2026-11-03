// Focused feature QA: the served app with explicitly simulated account/API responses.
// Backend scope and pagination run separately in platform-account-activity.test.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hours = [Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 1, 6)];
const repo = 'r00000000000000000001';
const activity = { now: Date.UTC(2026, 10, 2, 18), since: Date.UTC(2026, 9, 3), repositories: 1, public: 0, capturing: 0, landed: 0, commits: hours.map(h => [h, 1]), sessions: [], pending: 0, contributionSnapshots: { enam: 'fixture-snapshot' }, steps: {} };

test('contribution details work by keyboard in four served-app views', { timeout: 60_000 }, async () => {
  await mkdir(`${root}/.local`, {recursive:true});
  const viteConfig=`${root}/.local/contribution-vite-${process.pid}.mjs`;
  await writeFile(viteConfig, `import config from '${root}/frontend/vite.config.ts'; export default {...config,server:{...config.server,fs:{allow:${JSON.stringify([root,await realpath(`${root}/node_modules`)])}}}};`);
  const vite = spawn(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, '--host', '127.0.0.1', '--port', '0', '--config', viteConfig], { cwd: `${root}/frontend`, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let browser;
  let startupTimer;
  const fixture = `${root}/frontend/.local/contribution-props-${process.pid}.tsx`;
  try {
    const origin = await new Promise((resolve, reject) => {
    const timer = startupTimer = setTimeout(() => reject(new Error(`Vite did not start: ${log}`)), 10_000);
    vite.on('error', reject);
    vite.stdout.on('data', data => {
      log += data;
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    });
    vite.stderr.on('data', data => { log += data; });
  });
    browser = await chromium.launch({ channel: 'chrome' });
    const evidence = `${root}/.local/contribution-drilldown`;
    await mkdir(evidence, { recursive: true });
    for (const width of [1440, 375]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, timezoneId: 'America/New_York' });
      const page = await context.newPage();
      let mode = 'full';
      let release;
      let requests = 0;
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        let body = {};
        if (url.pathname === '/api/auth/session') body = { authenticated: true, username: 'fixture', handle: 'fixture' };
        else if (url.pathname === '/api/v1/activity') body = mode === 'empty' ? { ...activity, commits: [] } : activity;
        else if (url.pathname === '/api/v1/repos') body = { repos: [] };
        else if (url.pathname === '/api/v1/orgs') body = { orgs: [] };
        else if (url.pathname === '/api/v1/favorites') body = { favorites: [] };
        else if (url.pathname === '/api/v1/activity/contributions') {
          requests++;
          assert.equal(url.searchParams.get('hours'), hours.join(','));
          if (mode === 'loading') await new Promise(resolve => { release = resolve; });
          if (mode === 'stale') return route.fulfill({ status: 409, json: { error: { code: 'ACTIVITY_CHANGED', message: 'Activity changed. Refresh to see the latest contributions.' } } });
          if (mode === 'error') return route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT', message: 'Could not load contributions.' } } });
          const more = Boolean(url.searchParams.get('cursors'));
          body = { total: 2, items: mode === 'empty' ? [] : [{ repo, name: 'fixture-repo', commit: (more ? 'b' : 'a').repeat(40), subject: more ? 'Second contribution' : 'First contribution', at: hours[more ? 1 : 0] }], cursors: { enam: mode === 'empty' || more ? null : 'fixture-next' } };
        }
        return route.fulfill({ json: body });
      });
      await page.route('**/health', route=>route.fulfill({json:{service:'simulated'}}));
      await page.goto(origin);
      const bubble = page.getByRole('button', { name: /Nov 1, 01:00: 2 commits/ });
      await bubble.waitFor();
      await page.evaluate(()=>document.fonts.ready);
      await bubble.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('link', { name: /First contribution/ }).waitFor();
      assert.match(await dialog.innerText(), /05:00–06:00 UTC/);
      assert.match(await dialog.innerText(), /06:00–07:00 UTC/);
      await dialog.getByRole('button', { name: 'Load more' }).click();
      await dialog.getByRole('link', { name: /Second contribution/ }).waitFor();
      assert.equal(await dialog.getByRole('link').count(), 2);
      assert.match(await dialog.getByRole('link').first().getAttribute('href'), new RegExp(`/commit/${'a'.repeat(40)}$`));
      await page.screenshot({ path: `${evidence}/${width}-${colorScheme}-full.png` });
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await bubble.evaluate(el => el === document.activeElement), true);
      for (const state of ['loading', 'error', 'stale']) {
        mode = state;
        await bubble.press('Space');
        await dialog.waitFor();
        const target = state === 'loading' ? dialog.getByText('Loading contributions…') : state === 'stale' ? dialog.getByRole('button', { name: 'Refresh activity' }) : state === 'error' ? dialog.getByRole('button', { name: 'Retry' }) : dialog.getByText('No contributions in this hour.');
        await target.waitFor();
        await page.screenshot({ path: `${evidence}/${width}-${colorScheme}-${state}.png` });
        if (state === 'loading') { mode = 'full'; release(); await dialog.getByRole('link').first().waitFor(); }
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      }
      mode = 'empty';
      await page.reload();
      await page.getByText('No commits yet.', { exact: true }).waitFor();
      assert.equal(await page.locator('.chart-bubble').count(), 0);
      await page.screenshot({ path: `${evidence}/${width}-${colorScheme}-empty.png` });
      assert.ok(requests >= 5);
      await context.close();
    }
    // React props may refresh behind an open dialog. The clicked chart is a snapshot.
    await mkdir(`${root}/frontend/.local`, {recursive:true});
    await writeFile(fixture, `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {HomeDashboard} from '../src/features/shell/HomeDashboard';
      import '../src/styles.css';
      const initial=${JSON.stringify(activity)};
      function Fixture(){const [activity,setActivity]=useState(initial);
        window.refreshContributionFixture=()=>setActivity({...initial,now:initial.now+86400000,commits:[[initial.now,9]],contributionSnapshots:{enam:'new-snapshot'}});
        return <HomeDashboard activity={activity} loading={false} error="" onRetry={()=>{}} navigate={()=>{}} onNew={()=>{}}/>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);`);
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const snapshots = [];
    await page.route(`${origin}/props-fixture`, async route => {const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('/src/main.tsx',`/@fs${fixture}`)});});
    await page.route('**/api/v1/activity/contributions?**', route => {
      const query = new URL(route.request().url()).searchParams;
      snapshots.push(JSON.parse(query.get('snapshots')));
      if (query.has('cursors')) return route.fulfill({status:409,json:{error:{code:'ACTIVITY_CHANGED',message:'Activity changed. Refresh to see the latest contributions.'}}});
      return route.fulfill({json:{total:2,items:[{repo,name:'fixture-repo',commit:'a'.repeat(40),subject:'Original contribution',at:hours[0]}],cursors:{enam:'next'}}});
    });
    const fixtureErrors=[];
    page.on('pageerror', error=>fixtureErrors.push(error.message));
    await page.goto(`${origin}/props-fixture`);
    await page.waitForSelector('.chart-bubble', {timeout:5000}).catch(error=>{throw new Error(`${error.message}; fixture errors: ${fixtureErrors.join('; ')}; ${log}`)});
    await page.getByRole('button', {name:/Nov 1, 01:00: 2 commits/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('link').waitFor();
    await page.evaluate(()=>window.refreshContributionFixture());
    await page.waitForFunction(()=>document.querySelector('.chart-bubble')?.getAttribute('aria-label')?.includes('9 commits'));
    assert.equal(await dialog.locator('h2').innerText(),'Nov 1, 01:00','the clicked hour must not change with live props');
    assert.ok(snapshots.every(snapshot=>snapshot.enam==='fixture-snapshot'),'the open dialog must retain its clicked snapshot');
    await dialog.getByRole('button',{name:'Load more'}).click();
    await dialog.getByRole('button',{name:'Refresh activity'}).waitFor();
    assert.equal(snapshots.at(-1).enam,'fixture-snapshot');
    await context.close();
  } finally {
    clearTimeout(startupTimer);
    await browser?.close();
    await rm(fixture, {force:true});
    if (vite.exitCode === null && vite.signalCode === null) {
      const closed = once(vite, 'close');
      vite.kill('SIGTERM');
      await closed;
    }
    await rm(viteConfig,{force:true});
  }
});
