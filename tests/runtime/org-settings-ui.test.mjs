// Focused organization UI checks against the served app with simulated API responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
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
      vite.stdout.on('data',data=>{log+=data;const url=/http:\/\/127\.0\.0\.1:\d+/.exec(stripVTControlCharacters(log))?.[0];if(url){clearTimeout(timer);resolve(url);}});
      vite.stderr.on('data',data=>{log+=data;});
    });
    browser=await chromium.launch({channel:'chrome'});
    for(const width of [1440,375]) for(const colorScheme of ['light','dark']) {
      const context=await browser.newContext({viewport:{width,height:900},colorScheme});
      const page=await context.newPage();
      let mode='full', deleted=[removed], members=[...org.members], release, releaseSearch, searchFinished;
      const searches=[], grants=[];
      let retrySearch=false;
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        let body={};
        if(path==='/api/auth/session')body={authenticated:true,username:'fixture',handle:'fixture'};
        else if(path==='/api/v1/repos')body={repos:[]};
        else if(path==='/api/v1/orgs')body={orgs:[{org:org.org,role:mode==='member'?'member':'owner'},{org:'other_demo',role:'owner'}]};
        else if(path==='/api/v1/favorites')body={favorites:[]};
        else if(path==='/api/v1/orgs/other_demo')body={...org,org:'other_demo',members:[],teams:[]};
        else if(path==='/api/v1/orgs/other_demo/repos')body={repos:[]};
        else if(path==='/api/v1/orgs/other_demo/hold')body={org:null,repos:{}};
        else if(path==='/api/v1/orgs/other_demo/repos/deleted')body={window_days:30,repos:[]};
        else if(path==='/api/v1/orgs/ui_demo'){
          if(mode==='loading')await new Promise(resolve=>{release=resolve;});
          if(mode==='error')return route.fulfill({status:400,json:{error:{code:'INVALID_INPUT',message:'Could not load the organization.'}}});
          body={...org,members,role:mode==='member'?'member':'owner',teams:mode==='empty'?[]:org.teams};
        }
        else if(path==='/api/v1/orgs/ui_demo/member-candidates'){
          const q=new URL(route.request().url()).searchParams.get('q');
          searches.push(q);
          if(q==='@slow'){
            await new Promise(resolve=>{releaseSearch=resolve;});
            await route.fulfill({json:{candidates:[{identifier:'stale',handle:'stale',member:false}]}});
            searchFinished();return;
          }
          if(q==='@retry'&&!retrySearch){retrySearch=true;return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Search is unavailable.'}}});}
          body={candidates:q==='@ali'?[{identifier:'alice',handle:'alice',member:false}]:q==='friend@example.com'?[{identifier:q,handle:'friend',member:false}]:q==='@owner'?[{identifier:'owner',handle:'owner',member:true}]:q==='@bob'?[{identifier:'bob',handle:'bob',member:false}]:q==='@retry'?[{identifier:'retry_user',handle:'retry_user',member:false}]:q==='legacy@example.com'?[{identifier:q,handle:null,member:false}]:[]};
        }
        else if(path==='/api/v1/orgs/ui_demo/members'){
          const added=route.request().postDataJSON();grants.push(added);const existing=members.findIndex(member=>member.account===added.account);if(existing>=0)members[existing]={...members[existing],role:added.role};else members.push({account:added.account,role:added.role,added_at:stamp,added_by:`user:${owner}`});body={added:true};
        }
        else if(path.startsWith('/api/v1/orgs/ui_demo/members/')){members=members.filter(m=>m.account!==decodeURIComponent(path.split('/').at(-1)));body={removed:true};}
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
      const open=async(state)=>{mode=state;if(state==='multiowner')members=members.map((member,index)=>({...member,role:index<2?'owner':member.role}));await page.goto(`${origin}/orgs/ui_demo`);};
      const shot=async(name)=>{
        await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${colorScheme} ${name} must not scroll sideways`);
        await page.screenshot({path:`${evidence}/${width}-${colorScheme}-${name}.png`,fullPage:true});
      };
      await open('full');
      await page.getByRole('heading',{name:'Members',exact:true}).waitFor().catch(async error=>{
        await shot('boot-error');
        throw new Error(`${error.message}\nPage errors: ${errors.join('; ')}\n${await page.locator('body').innerText()}`);
      });
      const ownerRow=page.getByRole('row').filter({has:page.locator('.org-member-name').getByText(owner,{exact:true})});
      assert.equal(await ownerRow.getByRole('combobox').count(),0,'the only owner cannot be demoted');
      assert.equal(await ownerRow.getByRole('button',{name:'Remove',exact:true}).count(),0,'the only owner cannot be removed');
      assert.equal(await ownerRow.locator('.chip').getByText('Owner',{exact:true}).count(),1);
      const accountInput=page.getByRole('combobox',{name:'Account',exact:true});
      assert.equal(await accountInput.count(),1,'Account must search for an existing user');
      const addMember=page.getByRole('button',{name:'Add member',exact:true});
      await accountInput.fill('@al');await page.waitForTimeout(260);assert.deepEqual(searches,[],'short handles must not search');
      await accountInput.fill('friend@');await page.waitForTimeout(260);assert.deepEqual(searches,[],'partial emails must not search');
      await accountInput.fill('@ali');await accountInput.fill('@bob');
      await page.getByRole('option',{name:'@bob',exact:true}).waitFor();
      assert.deepEqual(searches,['@bob'],'typing is debounced to the last complete query');
      await accountInput.fill('@ali');
      await page.getByRole('option',{name:'@alice',exact:true}).waitFor();
      await shot('member-search-results');
      assert.equal(await addMember.isDisabled(),true,'typing must not select or add an account');
      await accountInput.press('Enter');assert.equal(await addMember.isDisabled(),true,'Enter without an active option must not select');
      await accountInput.press('ArrowDown');await accountInput.press('Enter');
      assert.equal(await addMember.isEnabled(),true);
      await accountInput.press('Enter');assert.deepEqual(grants,[],'Enter selects only; a separate Add action grants membership');
      await addMember.click();
      const alice=page.getByRole('row').filter({has:page.getByText('alice',{exact:true})});
      await alice.waitFor();assert.equal(await accountInput.inputValue(),'');
      page.once('dialog',dialog=>dialog.accept());await alice.getByRole('button',{name:'Remove',exact:true}).click();await alice.waitFor({state:'detached'});
      await accountInput.fill('friend@example.com');await page.getByRole('option',{name:'@friend',exact:true}).click();assert.equal(await addMember.isEnabled(),true);
      await addMember.click();await page.locator('.org-member-name').getByText('friend@example.com',{exact:true}).waitFor();
      assert.deepEqual(grants.map(grant=>grant.account),['alice','friend@example.com'],'email selection must submit the resolved identifier, not the display handle');
      await accountInput.fill('legacy@example.com');await page.getByRole('option',{name:'legacy@example.com',exact:true}).click();assert.equal(await addMember.isEnabled(),true);
      await accountInput.fill('@al');assert.equal(await addMember.isDisabled(),true,'editing clears the selected identity');
      await accountInput.fill('@owner');const existing=page.getByRole('option',{name:/@owner.*Already a member/});await existing.waitFor();assert.equal(await existing.getAttribute('aria-disabled'),'true');
      await accountInput.press('ArrowDown');await accountInput.press('Enter');await existing.dispatchEvent('click');assert.equal(await addMember.isDisabled(),true,'an existing member cannot be selected');
      await accountInput.press('Escape');assert.equal(await accountInput.getAttribute('aria-expanded'),'false');
      await accountInput.fill('@ali');await page.getByRole('option',{name:'@alice',exact:true}).waitFor();await accountInput.press('Tab');assert.equal(await accountInput.getAttribute('aria-expanded'),'false','blur closes suggestions');
      await accountInput.fill('@retry');await page.getByText('Could not search accounts.',{exact:true}).waitFor();await shot('member-search-error');
      await accountInput.press('Tab');
      assert.equal(await page.locator('.org-member-search-error').getByRole('button',{name:'Retry',exact:true}).evaluate(button=>button===document.activeElement),true,'Tab must reach the search Retry button');
      await page.keyboard.press('Enter');await page.getByRole('option',{name:'@retry_user',exact:true}).waitFor();
      await accountInput.press('Tab');assert.equal(await accountInput.getAttribute('aria-expanded'),'false','Tab out of the picker closes suggestions');
      assert.equal(searches.filter(q=>q==='@retry').length,2,'failed searches retry only after the explicit Retry action');
      const slowFinished=new Promise(resolve=>{searchFinished=resolve;});
      await accountInput.fill('@slow');await page.waitForRequest(request=>new URL(request.url()).searchParams.get('q')==='@slow');await page.getByText('Searching accounts…',{exact:true}).waitFor();await shot('member-search-loading');
      const aborted=page.waitForEvent('requestfailed',{predicate:request=>new URL(request.url()).searchParams.get('q')==='@slow'});
      await accountInput.fill('@ali');await aborted;await page.getByRole('option',{name:'@alice',exact:true}).waitFor();releaseSearch();await slowFinished;
      assert.equal(await page.getByRole('option',{name:'@stale',exact:true}).count(),0,'an aborted late result must never replace the current query');
      await accountInput.fill('absent@example.com');await page.getByText('No matching account.',{exact:true}).waitFor();assert.equal(await addMember.isDisabled(),true);await shot('member-search-empty');
      await accountInput.fill('');
      await shot('full');
      await accountInput.fill('friend@example.com');await page.getByRole('option',{name:'@friend',exact:true}).click();assert.equal(await addMember.isEnabled(),true);
      if(width===375)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
      await page.locator('.rail-repo-name').getByText('other_demo',{exact:true}).click();
      await page.getByRole('heading',{level:1,name:'other_demo',exact:true}).waitFor();
      assert.equal(await addMember.isDisabled(),true,'a selected account from another organization cannot enable Add');
      assert.equal(await accountInput.inputValue(),'','the account query belongs to the organization');
      await open('full');await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
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
      await open('multiowner');await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
      assert.equal(await ownerRow.getByRole('combobox',{name:`Role of ${owner}`,exact:true}).count(),1,'another owner allows role changes');
      assert.equal(await ownerRow.getByRole('button',{name:'Remove',exact:true}).count(),1,'another owner allows removal with confirmation');await shot('multiowner');
      await ownerRow.getByRole('combobox',{name:`Role of ${owner}`,exact:true}).selectOption('member');
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.org-member-name')).some(name=>name.textContent==='teammate.with.a.long.address@example.com'&&name.closest('tr').querySelector('.chip')?.textContent==='Owner'));
      assert.equal(members.find(member=>member.account===owner).role,'member','role changes reach the membership API');
      await ownerRow.getByRole('combobox',{name:`Role of ${owner}`,exact:true}).selectOption('owner');
      await page.getByRole('combobox',{name:'Role of teammate.with.a.long.address@example.com',exact:true}).waitFor();
      page.once('dialog',dialog=>dialog.accept());await ownerRow.getByRole('button',{name:'Remove',exact:true}).click();await ownerRow.waitFor({state:'detached'});
      assert.equal(await page.getByRole('combobox',{name:'Role of teammate.with.a.long.address@example.com',exact:true}).count(),0,'after removal the remaining owner loses refused controls');
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
