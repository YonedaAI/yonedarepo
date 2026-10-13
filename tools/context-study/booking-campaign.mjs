import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makePlan,starterFiles} from './booking-campaign-plan.mjs';
import {protectedBundle,bookingPolicy,stages} from './booking-policy.mjs';
import {runCampaign} from './booking-campaign-runner.mjs';
import {login} from './booking-client.mjs';
import {bootstrapPlan} from './booking-bootstrap.mjs';
import {campaignClient} from './booking-operator.mjs';
export function writeJSON(path,value){
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.pending';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temporary,path);
}
export function prepare(settings,output){
  const plan=makePlan(settings),directory=resolve(output);
  writeJSON(resolve(directory,'manifest.json'),plan);
  writeJSON(resolve(directory,'starter-workspace.json'),starterFiles());
  writeJSON(resolve(directory,'protected-test-bundle.json'),protectedBundle());
  if(settings.template)writeJSON(resolve(directory,'operator-bootstrap-plan.json'),bootstrapPlan(plan,settings.template));
  for(const stage of stages)writeJSON(resolve(directory,`policy-${stage}.json`),bookingPolicy(stage));
  // This request is inert output, not a server approval or a campaign enablement.
  writeJSON(resolve(directory,'operator-approval-request.json'),{username:plan.username,id:plan.campaign.id,expected_version:0,
    approval:{version:plan.campaign.version,profile:'controlled-event-booking-study-v1',audience:'owner',
      repo_ids:plan.chains.map(chain=>chain.repo_id),expires:settings.approval_expires??null,limit_microusd:12000000,chain_limit_microusd:2000000,
      buckets:{routine:12000000,opus:0,reserve:0},model_budgets:[plan.budget]}});
  return plan;
}
async function main(){
  const [mode,...argumentsList]=process.argv.slice(2),options={};
  for(let index=0;index<argumentsList.length;index+=2){
    if(!['--settings','--output','--origin','--credentials','--owner-token','--operator-token-file','--expected-revision','--authorization'].includes(argumentsList[index])||!argumentsList[index+1])
      throw new Error('Expected --settings FILE --output DIR; execution also needs explicit origin, private credentials and authorization');
    options[argumentsList[index]]=argumentsList[index+1];
  }
  if(!options['--settings']||!options['--output'])throw new Error('Explicit settings and output required');
  const settings=JSON.parse(readFileSync(options['--settings'],'utf8'));
  const plan=prepare(settings,options['--output']);
  if(mode==='plan'){console.log(`Offline plan only: ${plan.chains.length} chains, 18 stages, $2 per chain/$12 overall. No inference.`);return;}
  options['--owner-token']??=options['--operator-token-file'];
  if(mode!=='run'||options['--authorization']!=='owner-approved-paid-study'||!options['--origin']||!options['--credentials']&&!options['--owner-token'])
    throw new Error('Live execution requires a separately enabled exact server approval and explicit owner-approved-paid-study authorization');
  if(settings.synthetic_example===true)throw new Error('Replace synthetic example with actual owner-approved server identities');
  const client=options['--owner-token']?campaignClient(options['--origin'],options['--owner-token'],plan.username):await login(options['--origin'],options['--credentials']);
  if(options['--expected-revision']&&(!client.health||(await client.health()).revision!==options['--expected-revision']))throw new Error('Deployed platform revision changed');
  const results=await runCampaign(client,plan,{save:value=>writeJSON(resolve(options['--output'],'results.json'),value)});
  console.log(`Recorded ${results.chains.filter(chain=>chain.complete).length}/6 complete chains; no publication performed.`);
  if(!results.complete)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{console.error('Study stopped. Inspect saved evidence and server approval; sensitive responses were not logged.');process.exitCode=1;});
}
