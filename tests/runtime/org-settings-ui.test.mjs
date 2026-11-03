// Focused organization UI checks against the served app with simulated API responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stamp = Date.UTC(2026, 10, 2, 18);
const owner = 'owner@example.com';
const org = {org:'ui_demo',created_at:stamp,created_by:`user:${owner}`,role:'owner',members:[
  {account:owner,role:'owner',added_at:stamp,added_by:`user:${owner}`},
  {account:'teammate.with.a.long.address@example.com',role:'member',added_at:stamp,added_by:`user:${owner}`}
],teams:[{name:'engineering',created_at:stamp,created_by:`user:${owner}`,members:[owner]}]};
const removed = {id:`r${'1'.repeat(20)}`,name:'example-service',owner:'ui_demo',visibility:'private',created_at:stamp,deleted_at:stamp,purge_at:stamp+30*86400000};

test('organization layout, recovery focus and permission states in the served app', {timeout:60_000}, async()=>{
  const evidence=`${root}/.local/org-settings-ui`;
  await mkdir(evidence,{recursive:true});
  const config=`${root}/.local/org-vite-${process.pid}.mjs`;
  await writeFile(config,`import config from '${root}/frontend/vite.config.ts'; export default {...config,server:{...config.server,fs:{allow:${JSON.stringify([root,await realpath(`${root}/node_modules`)])}}}};`);
  const vite=spawn(process.execPath,[`${root}/node_modules/vite/bin/vite.js`,'--host','127.0.0.1','--port','0','--config',config],{cwd:`${root}/frontend`,stdio:['ignore','pipe','pipe']});
  let browser, timer, log='';
  try {
    const origin=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(log)),10_000);
      vite.on('error',reject);
      vite.stdout.on('data',data=>{log+=data;const url=/http:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0];if(url){clearTimeout(timer);resolve(url);}});
      vite.stderr.on('data',data=>{log+=data;});
    });
    browser=await chromium.launch({channel:'chrome'});
    for(const width of [1440,375]) for(const colorScheme of ['light','dark']) {
      const context=await browser.newContext({viewport:{width,height:900},colorScheme});
      const page=await context.newPage();
      let mode='full', deleted=[removed], release;
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        let body={};
        if(path==='/api/auth/session')body={authenticated:true,username:'fixture',handle:'fixture'};
        else if(path==='/api/v1/repos')body={repos:[]};
        else if(path==='/api/v1/orgs')body={orgs:[{org:org.org,role:mode==='member'?'member':'owner'}]};
        else if(path==='/api/v1/favorites')body={favorites:[]};
        else if(path==='/api/v1/orgs/ui_demo'){
          if(mode==='loading')await new Promise(resolve=>{release=resolve;});
          if(mode==='error')return route.fulfill({status:400,json:{error:{code:'INVALID_INPUT',message:'Could not load the organization.'}}});
          body={...org,role:mode==='member'?'member':'owner',teams:mode==='empty'?[]:org.teams};
        }
        else if(path==='/api/v1/orgs/ui_demo/repos')body={repos:mode==='empty'?[]:[{id:`r${'2'.repeat(20)}`,name:'active-service',created_at:stamp,owner:'ui_demo'}]};
        else if(path==='/api/v1/orgs/ui_demo/hold')body={org:mode==='held'?{owner:{at:stamp,by:`user:${owner}`}}:null,repos:{}};
        else if(path==='/api/v1/orgs/ui_demo/repos/deleted'){
          if(mode==='deleted-error')return route.fulfill({status:400,json:{error:{code:'INVALID_INPUT',message:'Could not load deleted repositories.'}}});
          body={window_days:30,repos:mode==='empty'?[]:deleted};
        }
        else if(path===`/api/v1/repos/${removed.id}/restore`){deleted=[];body={restored:true};}
        return route.fulfill({json:body});
      });
      await page.route('**/health',route=>route.fulfill({json:{service:'simulated'}}));
      const open=async(state)=>{mode=state;await page.goto(`${origin}/orgs/ui_demo`);};
      const shot=async(name)=>{
        await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${colorScheme} ${name} must not scroll sideways`);
        await page.screenshot({path:`${evidence}/${width}-${colorScheme}-${name}.png`,fullPage:true});
      };
      await open('full');
      await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
      await shot('full');
      const disclosure=page.locator('.org-deleted > summary');
      await disclosure.focus(); await page.keyboard.press('Enter');
      const restore=page.getByRole('button',{name:`Restore ${removed.name}`,exact:true});
      await restore.waitFor(); await shot('recovery');
      await restore.focus(); await page.keyboard.press('Enter');
      await disclosure.waitFor({state:'detached'});
      await page.waitForFunction(()=>document.activeElement?.id==='org-repos-heading',null,{timeout:3000});
      await open('deleted-error');await page.getByText('Could not load deleted repositories.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Retry',exact:true}).waitFor(); await shot('deleted-error');
      await open('empty');await page.getByText('No teams yet.',{exact:true}).waitFor();await page.getByText('No repositories yet.',{exact:true}).waitFor();await shot('empty');
      assert.equal(await disclosure.count(),0);
      const confirm=page.getByRole('textbox',{name:'Organization name',exact:true});
      const deleteButton=page.getByRole('button',{name:'Delete this organization',exact:true});
      assert.equal(await deleteButton.isDisabled(),true);
      await confirm.fill('wrong_name');assert.equal(await deleteButton.isDisabled(),true);
      await confirm.fill('ui_demo');assert.equal(await deleteButton.isEnabled(),true);
      await open('held');await page.getByText('Under a legal hold: this cannot be deleted until the hold is released.',{exact:true}).waitFor();assert.equal(await confirm.isDisabled(),true);assert.equal(await deleteButton.isDisabled(),true);await shot('held');
      await open('member');await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Add member',exact:true}).count(),0);
      assert.equal(await deleteButton.count(),0);await shot('member');
      await open('error');await page.getByText('Could not load the organization.',{exact:true}).waitFor();await shot('error');
      await open('loading');await page.getByText('Loading the organization…',{exact:true}).waitFor();await shot('loading');
      mode='full';release();await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
      assert.deepEqual(errors,[]);
      await context.close();
    }
  } finally {
    clearTimeout(timer);await browser?.close();
    if(vite.exitCode===null&&vite.signalCode===null){const closed=once(vite,'close');vite.kill('SIGTERM');await closed;}
    await rm(config,{force:true});
  }
});
