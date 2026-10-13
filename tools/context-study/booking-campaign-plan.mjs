// A plan is an offline contract. Only server-returned approval can authorize a run.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {bookingPolicy,protectedBundle} from './booking-policy.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const specification=JSON.parse(readFileSync(resolve(root,'fixtures/event-booking/campaign.json'),'utf8'));
export const corpus=JSON.parse(readFileSync(resolve(root,'fixtures/event-booking/corpus.json'),'utf8'));
const currentCorpus=JSON.parse(readFileSync(resolve(root,'fixtures/event-booking/corpus-v2.json'),'utf8'));
export const planCorpus=plan=>plan.corpus_records??corpus;
export const equal=isDeepStrictEqual;
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw new Error(message);};
export function safeID(value){if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(value))fail('Invalid study identifier');return value;}
export function starterFiles(){
  const files={};
  function walk(directory,prefix=''){
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(['dist','data','worker.js','static.mjs'].includes(entry.name))continue;
      const path=prefix+entry.name;
      if(entry.isDirectory())walk(resolve(directory,entry.name),path+'/');
      else if(entry.isFile())files[path]={content:readFileSync(resolve(directory,entry.name),'utf8'),executable:false};
      else fail('Fixture must contain regular files');
    }
  }
  walk(resolve(root,'fixtures/event-booking/source'));
  // Explicit incomplete bootstrap. Reference controls remain outside the agent source.
  const inventory="return Response.json({events:booking.events()});";
  if(!files['api.mjs'].content.includes(inventory))fail('Starter anchor changed');
  files['api.mjs'].content=files['api.mjs'].content.replace(inventory,"return Response.json({error:'INITIAL_INVENTORY_NOT_IMPLEMENTED'},{status:501});");
  files['public/app.mjs'].content="// Synthetic bootstrap: implement API-driven registration and cancellation.\n";
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
}
export function makePlan(settings){
  if(settings.corpus_version!==undefined&&![1,2].includes(settings.corpus_version))fail('Unsupported frozen corpus version');
  const records=settings.corpus_version===2?currentCorpus:corpus;
  safeID(settings.id);safeID(settings.campaign?.id);
  if(!Number.isSafeInteger(settings.campaign.version)||settings.campaign.version<1)fail('Explicit campaign version required');
  if(!settings.username||!settings.connection)fail('Operator and saved connection required');
  const budget=settings.budget;
  const allowed={codex:'gpt-5.6-luna',zai:'glm-5.3-flash',claude:'claude-sonnet-5-5'};
  if(!budget||allowed[budget.provider]!==budget.model||budget.max_requests!==60||budget.max_output_tokens!==4096
    ||budget.max_execution_ms!==600000||budget.spend_limit_microusd!==2000000
    ||budget.pricing?.source!=='owner-approved conservative rates'
    ||['input_microusd_per_million','output_microusd_per_million'].some(key=>!Number.isSafeInteger(budget.pricing[key])||budget.pricing[key]<=0)
    ||(budget.requests??0)!==0||(budget.charged_microusd??0)!==0)fail('Frozen bounded routine model required; escalation forbidden');
  const repos=settings.repositories;
  if(!Array.isArray(repos)||repos.length!==6||new Set(repos.map(repo=>repo.id)).size!==6)fail('Six distinct fresh repositories required');
  for(const repo of repos)safeID(repo.id);
  const retained=settings.retained_authority;
  if(retained){
    if(retained.campaign_id!==settings.campaign.id||retained.version!==settings.campaign.version-1
      ||!Array.isArray(retained.chains)||!Array.isArray(retained.repo_ids)
      ||retained.repo_ids.some(id=>repos.some(repo=>repo.id===id))
      ||new Set(retained.chains.map(chain=>chain.id)).size!==retained.chains.length
      ||!Number.isSafeInteger(retained.charged_microusd)||retained.charged_microusd<0||retained.charged_microusd>=12000000
      ||retained.chains.reduce((sum,chain)=>sum+chain.charged_microusd,0)!==retained.charged_microusd)
      fail('Invalid retained study authority');
    retained.repo_ids.forEach(safeID);retained.chains.forEach(chain=>safeID(chain.id));
  }
  const order=[['source_only',1],['plain_notes',1],['graph',1],['graph',2],['plain_notes',2],['source_only',2]];
  const chains=order.map(([arm,repetition],index)=>{
    const id=`${settings.id}-${arm}-${repetition}`;safeID(id);
    return {id,arm,repetition,repo_id:repos[index].id,
      branch_id:`${id}-work`,stages:specification.stages.map((stage,number)=>({...stage,
        ...(settings.stage_scoped_context===true&&number===0?{brief:stage.brief+' Initial stage only: preserve full-event HTTP 409 rejection and two-seat capacity; do not implement waitlist or promotion until the next feature stage.'}:{}),
        run_id:`${id}-s${number+1}`}))};
  });
  const plan={version:1,case:specification.case,id:settings.id,campaign:settings.campaign,username:settings.username,
    connection:settings.connection,budget:structuredClone(budget),chains,source_digest:hash(starterFiles()),
    corpus_digest:hash(records),test_bundle_digest:protectedBundle().digest,
    campaign_limit_microusd:12000000,chain_limit_microusd:2000000,agent_evidence:false,
    experiment:'matched maintenance chains; reversed arm order in repetition two; initial source identical',
    time_limit_basis:'600000ms per stage execution; 1800000ms per chain, queue wait separately bounded',
    causal_effect:null,
    ...(settings.stage_scoped_context===true?{stage_scoped_context:true}:{}),
    ...(settings.corpus_version===2?{corpus_records:structuredClone(records)}:{}),
    ...(retained?{retained_authority:structuredClone(retained)}:{})};
  return {...plan,plan_digest:hash(plan)};
}
export function validateAuthority(plan,value,now=Date.now(),allowExhausted=false){
  const {approval,chains,...flat}=value??{};
  const campaign=value?.campaign??flat;
  if(!campaign||campaign.id!==plan.campaign.id||campaign.version!==plan.campaign.version||campaign.enabled!==true
    ||campaign.expires<=now||campaign.limit_microusd!==12000000
    ||!Number.isSafeInteger(campaign.charged_microusd)||campaign.charged_microusd<0
    ||campaign.charged_microusd>12000000||!allowExhausted&&campaign.charged_microusd===12000000
    ||!approval||approval.version!==plan.campaign.version||approval.limit_microusd!==12000000
    ||approval.chain_limit_microusd!==2000000||approval.audience!=='owner'
    ||!equal(approval.buckets,{routine:12000000,opus:0,reserve:0})
    ||!equal(approval.repo_ids?.slice().sort(),plan.chains.map(chain=>chain.repo_id).sort())
    ||!equal(approval.model_budgets,[plan.budget]))fail('Server approval differs from frozen six-chain study');
  const observedChains=chains??[];
  if(!Array.isArray(observedChains)||new Set(observedChains.map(chain=>chain.id)).size!==observedChains.length)
    fail('Invalid server campaign chain readback');
  let total=0;
  const retained=plan.retained_authority?.chains??[];
  if(retained.some(previous=>!observedChains.some(current=>equal(current,previous))))fail('Retained study chain counters changed or disappeared');
  for(const chain of observedChains){
    if(![...plan.chains,...retained].some(expected=>expected.id===chain.id)||!Number.isSafeInteger(chain.charged_microusd)
      ||chain.charged_microusd<0||chain.charged_microusd>2000000)fail('Unexpected or over-budget campaign chain');
    total+=chain.charged_microusd;
    for(const [model,usage] of Object.entries(chain.models??{})){
      if(model!==`${plan.budget.provider}/${plan.budget.model}`||!Number.isSafeInteger(usage.requests)
        ||usage.requests<0||usage.requests>60||!Number.isSafeInteger(usage.charged_microusd)
        ||usage.charged_microusd<0||usage.charged_microusd>2000000)fail('Campaign model chain limit changed');
    }
  }
  if(total!==campaign.charged_microusd)fail('Aggregate spend differs from server chain readback');
  return {campaign,approval,chains:observedChains};
}
export function studyConfig(plan,chain){return {id:plan.id,case:plan.case,arm:chain.arm,corpus:planCorpus(plan).map(record=>record.id)};}
export function stageRequest(plan,chain,stage,branch){
  if(branch.id!==chain.branch_id||branch.status==='closed'||! /^[a-f0-9]{40,64}$/.test(branch.working_commit)
    ||!Number.isSafeInteger(branch.version)||branch.version<0)fail('Invalid checked working head');
  return {id:stage.run_id,workspace_transport:'git-native-v1',intent:stage.brief,
    criteria:['Protected event-booking behavioral checks pass at the exact captured revision'],
    agents:[{provider:plan.budget.provider,model:plan.budget.model,connection:plan.connection,
      strategy:'Implement the requested maintenance stage; preserve prior behavior and persisted data.'}],
    model_budgets:[plan.budget],delegation:{enabled:false,max_depth:0,max_executions:1},context:[],
    ...(plan.stage_scoped_context?{current_context_ids:stage.relevant_context_ids}:{}),
    working_branch_id:branch.id,expected_working_commit:branch.working_commit,expected_working_version:branch.version,
    campaign:{...plan.campaign,chain_id:chain.id,bucket:'routine',purpose:'routine'}};
}
export function validateBinding(plan,chain,stage,binding){
  const expected={...plan.campaign,repo_id:chain.repo_id,run_id:stage.run_id,chain_id:chain.id,
    bucket:'routine',purpose:'routine',model_budgets:[plan.budget],repair_escalation:null,access:'owner'};
  if(!equal(binding,expected))fail('Server run binding differs from frozen campaign envelope');
  return binding;
}
export function validateObservedRun(plan,chain,stage,detail){
  const run=detail.run??detail.runs?.find(run=>run.id===stage.run_id);
  const executions=detail.executions?.filter(execution=>execution.run_id===stage.run_id)??[];
  const cleanBudget=budget=>{const {requests,charged_microusd,...config}=budget;return config;};
  const expected=cleanBudget(plan.budget);
  const records=planCorpus(plan);
  const expectedIds=plan.stage_scoped_context?stage.relevant_context_ids:records.map(record=>record.id);
  const expectedRecords=expectedIds.map(id=>records.find(record=>record.id===id));
  if(!run||run.id!==stage.run_id||Object.hasOwn(run,'context_packet')||run.working_branch_id!==chain.branch_id
    ||! /^[a-f0-9]{64}$/.test(run.campaign_approval_digest)
    ||!equal(run.campaign,{...plan.campaign,chain_id:chain.id,bucket:'routine',purpose:'routine'})
    ||!equal(run.model_budgets?.map(cleanBudget),[expected])
    ||run.context_study?.arm!==chain.arm||run.context_study?.id!==plan.id||run.context_study?.case!==plan.case
    ||!equal(run.context_study?.corpus,expectedIds)
    ||!equal(run.context_study?.records?.map(record=>({id:record.id,kind:record.kind,statement:record.data?.statement??record.statement,
      purpose:record.data?.purpose??record.purpose})),expectedRecords)
    ||!equal(run.delegation,{enabled:false,max_depth:0,max_executions:1})
    ||!equal(run.context,[])||!equal(run.context_records,[])
    ||!equal(run.policy,bookingPolicy(stage.id))
    ||executions.length!==1||executions[0].provider!==plan.budget.provider||executions[0].model!==plan.budget.model)
    fail('Observed run violates frozen study isolation');
  return {run,executions};
}
export function checkedOutcome(plan,chain,stage,detail){
  const {run,executions}=validateObservedRun(plan,chain,stage,detail);
  const candidate=detail.candidates?.find(candidate=>candidate.run_id===stage.run_id&&candidate.role!=='specialist');
  if(!candidate||candidate.status!=='eligible'||executions[0].status!=='completed')fail('Stage has no completed checked candidate');
  const evaluation=detail.evaluations?.find(evaluation=>evaluation.candidate===candidate.id
    &&equal(evaluation.revision,candidate.revision)&&evaluation.policy===run.policy.version
    &&evaluation.suite==='commands-v1'&&evaluation.environment==='linux-node24-rust1.94-v1'
    &&/^[a-f0-9]{64}$/.test(evaluation.evidence)
    &&equal(evaluation.checks?.map(check=>[check.name,check.status]),[['booking-acceptance','pass']]));
  if(!evaluation)fail('Missing protected exact-revision behavioral verdict');
  return {pass:true,candidate,revision:candidate.revision,evaluation,execution:executions[0]};
}
