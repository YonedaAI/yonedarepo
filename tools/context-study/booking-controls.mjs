// Executes actual local workerd/DO SQLite controls. No provider/model calls.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {reference} from '../../fixtures/event-booking/controls/reference.mjs';
import {starterFiles} from './booking-campaign-plan.mjs';
const root=resolve('.local/semantic-context-investigation/booking-controls');
mkdirSync(root,{recursive:true});
const original=readFileSync('fixtures/event-booking/source/booking.mjs','utf8');
const trials=[
  {name:'campaign-bootstrap-red',variant:'campaign_starter',stage:'initial_build',pass:3,fail:1,skip:3},
  {name:'initial-build-control',variant:'initial_build',stage:'initial_build',pass:4,fail:0,skip:3},
  {name:'missing-feature-red',variant:'initial_build',stage:'waitlist_feature',pass:3,fail:2,skip:2},
  {name:'seeded-duplicate-red',variant:'waitlist_feature',stage:'duplicate_registration_bugfix',pass:5,fail:2,skip:0},
  {name:'waitlist-control',variant:'waitlist_feature',stage:'waitlist_feature',pass:5,fail:0,skip:2},
  {name:'duplicate-fix-control',variant:'duplicate_registration_bugfix',stage:'duplicate_registration_bugfix',pass:7,fail:0,skip:0},
];
const results=[];
for(const trial of trials){
  const directory=join(root,trial.name);mkdirSync(directory,{recursive:true});
  cpSync('fixtures/event-booking/source',directory,{recursive:true,filter:path=>!path.includes('/dist')&&!path.includes('/data')&&!path.endsWith('/worker.js')&&!path.endsWith('/static.mjs')});
  if(trial.variant==='campaign_starter'){
    for(const [path,file] of Object.entries(starterFiles())){
      mkdirSync(resolve(directory,path,'..'),{recursive:true});writeFileSync(join(directory,path),file.content);
    }
  }else writeFileSync(join(directory,'booking.mjs'),reference(original,trial.variant));
  const built=spawnSync(process.execPath,[join(directory,'build.mjs')],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  const checked=spawnSync('pnpm',['exec','vitest','run','--configLoader','runner','--config','fixtures/event-booking/oracle/vitest.config.mts','--reporter=json',`--outputFile=${join(directory,'oracle.json')}`],
    {encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,YONEDA_BOOKING_SUBJECT:directory,YONEDA_BOOKING_STAGE:trial.stage}});
  writeFileSync(join(directory,'oracle.log'),`${checked.stdout}\n${checked.stderr}`);
  const report=JSON.parse(readFileSync(join(directory,'oracle.json')));
  assert.equal(report.numPassedTests,trial.pass,trial.name);assert.equal(report.numFailedTests,trial.fail,trial.name);
  assert.equal(checked.status,trial.fail?1:0,trial.name);
  const result={...trial,source_sha256:createHash('sha256').update(readFileSync(join(directory,'booking.mjs'))).digest('hex'),
    runtime:'actual workerd Durable Object SQLite',model_calls:0,agent_evidence:false,checks:report.testResults.flatMap(file=>file.assertionResults.map(test=>({name:test.title,status:test.status}))) };
  results.push(result);console.log(`${trial.name}: ${trial.pass} passed, ${trial.fail} expected failures (${trial.stage})`);
}
writeFileSync(join(root,'results.json'),JSON.stringify({version:1,synthetic:true,agent_evidence:false,causal_benefit:null,results},null,2)+'\n');
