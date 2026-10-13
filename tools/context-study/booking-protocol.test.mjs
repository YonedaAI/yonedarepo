// Protocol simulations test fencing only; they are never campaign evidence.
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {makePlan,starterFiles,planCorpus,studyConfig} from './booking-campaign-plan.mjs';
import {runCampaign} from './booking-campaign-runner.mjs';
import {bookingPolicy} from './booking-policy.mjs';
const budget={provider:'codex',model:'gpt-5.6-luna',max_requests:60,max_output_tokens:4096,max_execution_ms:600000,
  spend_limit_microusd:2000000,pricing:{input_microusd_per_million:250000,output_microusd_per_million:1200000,
    source:'owner-approved conservative rates'}};
const settings={id:'protocol-test',username:'operator',connection:'frozen',budget,campaign:{id:'server-contract',version:1},
  repositories:Array.from({length:6},(_,i)=>({id:`repo-${i}`,seed_candidate_id:`seed-${i}`}))};
function fake(plan,{lostAck=false,failedStage=false,wrongSeed=false,oldRuntime=false}={}){
  const corpus=planCorpus(plan);
  const calls=[],branches=new Map(),runs=new Map(),policies=new Map(),studies=new Map(
    plan.chains.map(chain=>[chain.repo_id,{...studyConfig(plan,chain),records:corpus}]));
  const revision=commit=>({repository:'synthetic/test',commit});
  const base='a'.repeat(40);
  const state={campaign:{id:plan.campaign.id,version:plan.campaign.version,enabled:true,expires:Date.now()+3600000,
    limit_microusd:12000000,charged_microusd:plan.retained_authority?.charged_microusd??0},
    approval:{version:plan.campaign.version,limit_microusd:12000000,chain_limit_microusd:2000000,audience:'owner',
      buckets:{routine:12000000,opus:0,reserve:0},repo_ids:plan.chains.map(c=>c.repo_id),model_budgets:[budget]},
    chains:structuredClone(plan.retained_authority?.chains??[])};
  const client={simulated:true,calls,api:async(path,body)=>{
    calls.push({path,body:structuredClone(body)});
    if(path==='admin/campaign/status')return structuredClone(state);
    if(path==='admin/campaign/run_status'){
      const run=runs.get(body.run_id).run;
      return {...run.campaign,repo_id:body.repo_id,run_id:run.id,model_budgets:[budget],repair_escalation:null,access:'owner'};
    }
    const [,pathRepo,actionQuery]=path.split('/'),[pathAction,query]=actionQuery.split('?'),params=new URLSearchParams(query);
    const action=path==='admin/campaign/start_run'?'start_run':pathAction;
    const repo=path==='admin/campaign/start_run'?body.repo_id:pathRepo;
    if(path==='admin/campaign/start_run')body=body.approval;
    if(action==='snapshot')return {capabilities:oldRuntime?{}:{campaign_budget:1,working_branches:1,context_usage:1},repository:{status:'ready',published_commit:base,head_commit:base,version:0,
      policy:policies.get(repo)??{version:'seed'},pending:null,context_study:{...studies.get(repo),records:[]}},runs:[],jobs:[]};
    if(action==='context_get'){const record=corpus.find(r=>r.id===params.get('id'));return {id:record.id,kind:record.kind,data:record};}
    if(action==='published_source')return {revision:revision(base),files:wrongSeed?{}:starterFiles()};
    if(action==='candidate_source'){
      const id=params.get('id');
      const run=[...runs.values()].find(r=>r.candidates[0].id===id);return {revision:run.candidates[0].revision,files:{}};
    }
    if(action==='configure_context_study'){studies.set(repo,{...body.context_study,records:corpus});return body.context_study;}
    if(action==='create_working_branch'){
      const branch={id:body.id,status:'active',working_commit:base,working_revision:revision(base),version:0};
      branches.set(repo,branch);return structuredClone(branch);
    }
    if(action==='working_branch')return structuredClone(branches.get(repo));
    if(action==='approve_test_bundle'){policies.set(repo,body.policy);return {digest:plan.test_bundle_digest};}
    if(action==='start_run'){
      const branch=branches.get(repo),number=branch.version+1,commit=String(number).repeat(40);
      const candidate={id:`candidate-${body.id}`,run_id:body.id,role:'final',status:'eligible',revision:revision(commit)};
      const evaluation={candidate:candidate.id,revision:candidate.revision,policy:policies.get(repo).version,suite:'commands-v1',
        environment:'linux-node24-rust1.94-v1',evidence:'e'.repeat(64),checks:[{name:'booking-acceptance',status:failedStage?'fail':'pass'}]};
      const context=body.current_context_ids?{...studies.get(repo),corpus:body.current_context_ids,
        records:body.current_context_ids.map(id=>corpus.find(r=>r.id===id))}:studies.get(repo);
      runs.set(body.id,{run:{...body,campaign_approval_digest:'f'.repeat(64),context_records:[],context_study:context,policy:policies.get(repo),status:'ready'},
        candidates:[candidate],evaluations:[evaluation],executions:[{id:'e',run_id:body.id,provider:budget.provider,model:budget.model,status:'completed'}]});
      if(!failedStage)Object.assign(branch,{working_commit:commit,working_revision:revision(commit),version:number,latest_candidate_id:candidate.id});
      if(lostAck)throw new Error('Simulated lost acknowledgment');return {};
    }
    if(action==='run_detail')return structuredClone(runs.get(params.get('run_id')));
    if(action==='context_usage')return {entries:[],citations:[],has_more:false,citations_truncated:false};
    if(action==='cancel_run')return {};
    throw new Error(`Unexpected test protocol path ${action}`);
  }};
  return client;
}
it('simulates stable run discovery after lost ACK without duplicate execution or publication',async()=>{
  const plan=makePlan(settings),client=fake(plan,{lostAck:true}),saved=[];
  const result=await runCampaign(client,plan,{save:value=>saved.push(structuredClone(value))});
  assert.equal(result.complete,true);assert.equal(result.agent_evidence,false);assert.equal(result.synthetic,true);
  const starts=client.calls.filter(call=>call.path.endsWith('/start_run'));
  assert.equal(starts.length,18);assert.equal(new Set(starts.map(call=>call.body.approval.id)).size,18);
  assert.equal(client.calls.some(call=>/\/accept$|\/enable$|\/configure$/.test(call.path)),false);
  assert.equal(saved.at(-1).complete,true);
  for(const chain of plan.chains){
    assert.equal(starts.filter(call=>call.body.approval.campaign.chain_id===chain.id).length,3);
    assert.equal(new Set(starts.filter(call=>call.body.approval.campaign.chain_id===chain.id).map(call=>JSON.stringify(call.body.approval.model_budgets))).size,1);
  }
});
it('retains protected failures, cancels that run and skips subsequent stages without escalation',async()=>{
  const plan=makePlan(settings),client=fake(plan,{failedStage:true});
  const result=await runCampaign(client,plan);
  assert.equal(result.complete,false);
  assert.equal(client.calls.filter(call=>call.path.endsWith('/start_run')).length,6);
  assert.equal(client.calls.filter(call=>call.path.endsWith('/cancel_run')).length,6);
  for(const chain of result.chains){assert.equal(chain.stages.length,1);assert.equal(chain.stages[0].detail.evaluations[0].checks[0].status,'fail');}
});
it('preflights every identical seed before beginning any potentially paid work',async()=>{
  const plan=makePlan(settings),client=fake(plan,{wrongSeed:true});
  await assert.rejects(runCampaign(client,plan),/Seed capture differs/);
  assert.equal(client.calls.some(call=>call.path.endsWith('/start_run')),false);
});
it('rejects a ledger without aggregate campaign capabilities before starting models',async()=>{
  const plan=makePlan(settings),client=fake(plan,{oldRuntime:true});
  await assert.rejects(runCampaign(client,plan),/campaign/);
  assert.equal(client.calls.some(call=>call.path.endsWith('/start_run')),false);
});
it('starts only through the server-signed campaign endpoint, never client-minted bindings',async()=>{
  const plan=makePlan(settings),client=fake(plan);
  await runCampaign(client,plan);
  assert.equal(client.calls.filter(call=>call.path==='admin/campaign/start_run').length,18);
  assert.equal(client.calls.some(call=>call.path==='admin/campaign/bind_run'||/^repos\/[^/]+\/start_run$/.test(call.path)),false);
});
it('uses the owner-seeded controlled arm and never generic admin reconfiguration',async()=>{
  const plan=makePlan(settings),client=fake(plan);
  const result=await runCampaign(client,plan);
  assert.equal(result.complete,true);
  assert.equal(client.calls.some(call=>call.path.endsWith('/configure_context_study')),false);
});
it('v2 protocol preserves old spend and accepts only exact stage-scoped frozen context',async()=>{
  const prior=makePlan(settings);
  const plan=makePlan({...settings,id:'protocol-v2',stage_scoped_context:true,corpus_version:2,
    campaign:{...settings.campaign,version:2},repositories:settings.repositories.map(r=>({id:r.id+'-v2'})),
    retained_authority:{campaign_id:prior.campaign.id,version:1,charged_microusd:100000,
      repo_ids:prior.chains.map(c=>c.repo_id),chains:[{id:prior.chains[0].id,charged_microusd:100000,
        models:{'codex/gpt-5.6-luna':{charged_microusd:100000,requests:4}}}]}});
  const client=fake(plan),result=await runCampaign(client,plan);
  assert.equal(result.complete,true);assert.equal(result.agent_evidence,false);
  assert.equal(result.authority_final.campaign.charged_microusd,100000);
  for(const chain of result.chains)for(const stage of chain.stages){
    assert.deepEqual(stage.detail.run.context_study.corpus,stage.request.current_context_ids);
    assert.deepEqual(stage.detail.run.context_study.records.map(r=>r.id),stage.request.current_context_ids);
  }
});
