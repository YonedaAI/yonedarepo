// Served app: page content precedes optional diagnostics and offscreen image bytes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
const root=fileURLToPath(new URL('../../',import.meta.url));
const repo=`r${'1'.repeat(20)}`, sha='a'.repeat(40);
const status={name:'demo',version:1,owner:'fixture',object_store:'r2',visibility:'private',viewer:{owner:true,public:false,role:'owner',principal:'user:fixture'},policy:{approvals:0,required_checks:[],runners:{}},policy_digest:'d'.repeat(64),refs:[{name:'refs/heads/main',commit_id:sha,version:1}],automation:null,landings:{create:false,agents:false},parent:null,forks:0,grant:null,quarantined:[],quarantine_epoch:0,bundled:false};
test('repository loading does not wait for storage diagnostics or offscreen README images',{timeout:60000},async()=>{
 await mkdir(`${root}/.local/repo-loading-ui`,{recursive:true});
 const config=`${root}/.local/repo-loading-vite-${process.pid}.mjs`;
 await writeFile(config,`import config from '${root}/frontend/vite.config.ts';export default {...config,server:{...config.server,fs:{allow:${JSON.stringify([root,await realpath(`${root}/node_modules`)])}}}};`);
 const vite=spawn(process.execPath,[`${root}/node_modules/vite/bin/vite.js`,'--host','127.0.0.1','--port','0','--config',config],{cwd:`${root}/frontend`,stdio:['ignore','pipe','pipe']});
 let browser,timer,log='';
 try{
  const origin=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(log)),10000);vite.on('error',reject);vite.stdout.on('data',d=>{log+=d;const url=/http:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0];if(url){clearTimeout(timer);resolve(url);}});vite.stderr.on('data',d=>{log+=d;});});
  browser=await chromium.launch({channel:'chrome'});
  for(const width of [1440,375])for(const colorScheme of ['dark','light']){
   const c=await browser.newContext({viewport:{width,height:900},colorScheme});const p=await c.newPage();let summary=false,images=0,activity=0,releaseStatus,releaseLog;const statusGate=new Promise(resolve=>{releaseStatus=resolve;});const errors=[];p.on('pageerror',e=>errors.push(e.message));
   await p.route('**/api/**',async r=>{const u=new URL(r.request().url()),path=u.pathname;let body={};
    if(path==='/api/auth/session')body={authenticated:true,username:'fixture',handle:'fixture'};
    else if(path==='/api/v1/repos')body={repos:[]};
    else if(path==='/api/v1/orgs')body={orgs:[]};
    else if(path==='/api/v1/favorites')body={favorites:[]};
    else if(path==='/api/v1/activity'){activity++;return r.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Fixture activity held back'}}});}
    else if(path===`/api/v1/repos/${repo}`){summary=u.searchParams.get('summary')==='true';await statusGate;body=status;}
    else if(path.endsWith('/tree'))body={commit:sha,entries:[{name:'README.md',type:'blob',id:'b'.repeat(40)}]};
    else if(path.endsWith('/log')){await new Promise(resolve=>{releaseLog=resolve;});body={commits:[]};}
    else if(path.endsWith('/blob')&&u.searchParams.get('path')==='README.md')body={encoding:'utf-8',content:'# Visible repository\n\n'+Array.from({length:70},(_,i)=>`Paragraph ${i}: repository content loads before pictures.\n\n`).join('')+'![Deferred diagram](diagram.png)'};
    else if(path.endsWith('/blob')){images++;body={encoding:'base64',size:68,content:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lDEAAAAASUVORK5CYII='};}
    else if(path.includes('/commits/'))body={commit:sha,author_name:'Fixture',message:'Initial content',landings:[],parents:[],checks:[]};
    await r.fulfill({json:body}).catch(()=>{});
   });
   await p.goto(`${origin}/source/${repo}`);
   await p.getByText('Loading repository…',{exact:true}).waitFor();assert.equal(summary,true);assert.equal(activity,0,'optional activity must wait for repository metadata');releaseStatus();
   await p.getByRole('heading',{name:/^Visible repository\b/}).waitFor({timeout:5000}).catch(async e=>{await p.screenshot({path:`${root}/.local/repo-loading-ui/failed.png`});console.log(JSON.stringify({errors,text:(await p.locator('body').innerText()).slice(0,2000)}));throw e;});
   await p.locator('.repo-image').waitFor();assert.equal(images,0,'offscreen image must not start a request');
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await p.screenshot({path:`${root}/.local/repo-loading-ui/${width}-${colorScheme}.png`});
   await p.locator('.repo-image').scrollIntoViewIfNeeded();await p.getByAltText('Deferred diagram',{exact:true}).waitFor({state:'attached'});assert.equal(images,1);
   releaseLog?.();assert.deepEqual(errors,[]);await c.close();
  }
 }finally{clearTimeout(timer);await browser?.close();vite.kill('SIGTERM');await rm(config,{force:true});}
});
