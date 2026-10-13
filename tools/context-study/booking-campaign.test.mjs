import {it} from 'node:test';
import assert from 'node:assert/strict';
import {makePlan,validateAuthority,validateBinding,stageRequest,checkedOutcome,studyConfig,corpus} from './booking-campaign-plan.mjs';
import {bookingPolicy} from './booking-policy.mjs';

const budget={provider:'codex',model:'gpt-5.6-luna',max_requests:60,max_output_tokens:4096,max_execution_ms:600000,
  spend_limit_microusd:2000000,pricing:{input_microusd_per_million:250000,output_microusd_per_million:1200000,
    source:'owner-approved conservative rates'}};
export const settings={id:'offline-contract-test',username:'operator',connection:'frozen-connection',budget,
  campaign:{id:'server-owned-study-id',version:1},repositories:Array.from({length:6},(_,index)=>({
    id:`fresh-${index}`,seed_candidate_id:`seed-${index}`}))};
export function authority(plan){return {campaign:{id:plan.campaign.id,version:1,enabled:true,expires:Date.now()+60000,
  limit_microusd:12000000,charged_microusd:0},approval:{version:1,limit_microusd:12000000,
    chain_limit_microusd:2000000,buckets:{routine:12000000,opus:0,reserve:0},audience:'owner',
    repo_ids:plan.chains.map(chain=>chain.repo_id),model_budgets:[budget]}};}

it('plans six matched chains with one frozen model and no context packet',()=>{
  const plan=makePlan(settings);
  assert.equal(plan.chains.length,6);
  for(const chain of plan.chains){
    assert.equal(chain.stages.length,3);
    for(const stage of chain.stages){
      const request=stageRequest(plan,chain,stage,{id:chain.branch_id,working_commit:'a'.repeat(40),version:2});
      assert.deepEqual(request.model_budgets,[budget]);
      assert.equal(request.campaign.chain_id,chain.id);
      assert.equal(request.expected_working_version,2);
      assert.equal(Object.hasOwn(request,'context_packet'),false);
      assert.equal(Object.hasOwn(request,'autonomy_policy'),false);
      assert.deepEqual(request.delegation,{enabled:false,max_depth:0,max_executions:1});
    }
  }
  assert.deepEqual(plan.chains.map(chain=>[chain.arm,chain.repetition]),[
    ['source_only',1],['plain_notes',1],['graph',1],['graph',2],['plain_notes',2],['source_only',2]]);
  assert.equal(plan.agent_evidence,false);
});

it('fails closed on broader authority, different model, exhausted spend and duplicate repositories',()=>{
  const plan=makePlan(settings);
  validateAuthority(plan,authority(plan));
  const flat={...authority(plan).campaign,approval:authority(plan).approval,chains:[]};
  validateAuthority(plan,flat);
  for(const mutate of [value=>value.approval.chain_limit_microusd=5000000,
    value=>value.campaign.limit_microusd=50000000,value=>value.approval.model_budgets[0].max_requests=61,
    value=>value.campaign.charged_microusd=12000000,value=>value.campaign.enabled=false]){
    const value=structuredClone(authority(plan));mutate(value);assert.throws(()=>validateAuthority(plan,value));
  }
  const duplicate=structuredClone(settings);duplicate.repositories[1]=duplicate.repositories[0];
  assert.throws(()=>makePlan(duplicate));
  const opus=structuredClone(settings);opus.budget.model='claude-opus-5-5';assert.throws(()=>makePlan(opus));
});

it('eligible assertion cannot replace exact-revision protected behavioral evidence',()=>{
  const plan=makePlan(settings),chain=plan.chains[0],stage=chain.stages[0];
  const run=stageRequest(plan,chain,stage,{id:chain.branch_id,working_commit:'a'.repeat(40),version:0});
  const revision={repository:'offline/test',commit:'b'.repeat(40)};
  const candidate={id:'c',run_id:stage.run_id,status:'eligible',role:'final',revision};
  const evaluation={candidate:'c',revision,policy:`booking-${stage.id}-v1`,suite:'commands-v1',
    environment:'linux-node24-rust1.94-v1',checks:[{name:'booking-acceptance',status:'pass'}],evidence:'c'.repeat(64)};
  const detail={run:{...run,status:'ready',campaign_approval_digest:'f'.repeat(64),context_records:[],context_study:{...studyConfig(plan,chain),records:corpus},
    policy:bookingPolicy(stage.id)},
    executions:[{id:'e',run_id:stage.run_id,provider:budget.provider,model:budget.model,status:'completed'}],
    candidates:[candidate],evaluations:[evaluation]};
  assert.equal(checkedOutcome(plan,chain,stage,detail).pass,true);
  for(const mutate of [value=>value.evaluations=[],value=>value.evaluations[0].revision={...revision,commit:'d'.repeat(40)},
    value=>value.evaluations[0].checks[0].status='fail',value=>value.run.context_packet={},
    value=>value.executions.push({...value.executions[0],id:'unexpected-peer'}),
    value=>value.run.model_budgets[0].model='more-expensive',value=>value.run.context_study.arm='graph',
    value=>value.run.policy.build.checks[0].argv=['node','untrusted-self-test.mjs']]){
    const changed=structuredClone(detail);mutate(changed);assert.throws(()=>checkedOutcome(plan,chain,stage,changed));
  }
});
it('verifies the complete server-owned binding envelope and aggregate chain counters',()=>{
  const plan=makePlan(settings),chain=plan.chains[0],stage=chain.stages[0];
  const binding={...plan.campaign,repo_id:chain.repo_id,run_id:stage.run_id,chain_id:chain.id,
    bucket:'routine',purpose:'routine',model_budgets:[budget],repair_escalation:null,access:'owner'};
  validateBinding(plan,chain,stage,binding);
  for(const mutate of [value=>value.access='reviewer',value=>value.repair_escalation={},value=>value.extra='claim',
    value=>value.model_budgets[0].max_requests=48,value=>value.chain_id='another-chain']){
    const changed=structuredClone(binding);mutate(changed);assert.throws(()=>validateBinding(plan,chain,stage,changed));
  }
  const readback=authority(plan);readback.campaign.charged_microusd=1;
  assert.throws(()=>validateAuthority(plan,readback));
  readback.chains=[{id:chain.id,charged_microusd:1,models:{'codex/gpt-5.6-luna':{requests:61,charged_microusd:1}}}];
  assert.throws(()=>validateAuthority(plan,readback));
  readback.chains[0].models['codex/gpt-5.6-luna'].requests=1;
  validateAuthority(plan,readback);
});
