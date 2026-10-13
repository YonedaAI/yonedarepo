import {it} from 'node:test';
import assert from 'node:assert/strict';
import {settings,authority} from './booking-campaign.test.mjs';
import {makePlan,stageRequest,validateAuthority,corpus,checkedOutcome,studyConfig} from './booking-campaign-plan.mjs';
import {bookingPolicy} from './booking-policy.mjs';
function nextSettings(){
  const prior=makePlan(settings);
  return {...settings,id:'new-phase',campaign:{...settings.campaign,version:2},stage_scoped_context:true,corpus_version:2,
    repositories:settings.repositories.map(r=>({id:r.id+'-v2'})),
    retained_authority:{campaign_id:prior.campaign.id,version:1,charged_microusd:100000,
      repo_ids:prior.chains.map(c=>c.repo_id),chains:prior.chains.map((c,i)=>({id:c.id,charged_microusd:i===0?100000:0,
        models:{'codex/gpt-5.6-luna':{requests:i===0?4:0,charged_microusd:i===0?100000:0}}}))}};
}
it('v2 signed stages freeze only contemporary context and explicitly preserve initial full-event API behavior',()=>{
  const plan=makePlan(nextSettings()),chain=plan.chains[0];
  for(const stage of chain.stages){
    const request=stageRequest(plan,chain,stage,{id:chain.branch_id,working_commit:'a'.repeat(40),version:0});
    assert.deepEqual(request.current_context_ids,stage.relevant_context_ids);
    assert.equal(Object.hasOwn(request,'context_packet'),false);
  }
  assert.match(chain.stages[0].brief,/409/);
  assert.match(chain.stages[0].brief,/waitlist/);
  assert.ok(!chain.stages[0].relevant_context_ids.includes('context:booking:waitlist'));
  const capacity=(plan.corpus_records??corpus).find(r=>r.id==='context:booking:capacity');
  assert.doesNotMatch(capacity.statement,/wait|promot/i);
  assert.match(corpus.find(r=>r.id===capacity.id).statement,/waiter/);
});
it('v2 authority retains exact prior chain counters and refuses reset, missing history or widened authority',()=>{
  const plan=makePlan(nextSettings()),value=authority(plan);
  value.campaign.version=2;value.approval.version=2;
  value.campaign.charged_microusd=100000;value.chains=structuredClone(plan.retained_authority.chains);
  validateAuthority(plan,value);
  for(const mutate of [v=>v.campaign.charged_microusd=0,v=>v.chains=[],
    v=>v.chains[0].models['codex/gpt-5.6-luna'].requests=3,v=>v.approval.repo_ids.push('unauthorized'),
    v=>v.approval.repo_ids.push(plan.retained_authority.repo_ids[0]),
    v=>v.approval.limit_microusd=12500000]){
    const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateAuthority(plan,changed));
  }
});
it('v2 protected outcome rejects future requirements in initial frozen context',()=>{
  const plan=makePlan(nextSettings()),chain=plan.chains[0],stage=chain.stages[0];
  const request=stageRequest(plan,chain,stage,{id:chain.branch_id,working_commit:'a'.repeat(40),version:0});
  const revision={repository:'offline/v2',commit:'b'.repeat(40)};
  const selected=(plan.corpus_records??corpus).filter(c=>stage.relevant_context_ids.includes(c.id));
  const detail={run:{...request,status:'ready',campaign_approval_digest:'f'.repeat(64),context_records:[],
    context_study:{...studyConfig(plan,chain),corpus:stage.relevant_context_ids,records:selected},policy:bookingPolicy(stage.id)},
    executions:[{id:'e',run_id:stage.run_id,provider:plan.budget.provider,model:plan.budget.model,status:'completed'}],
    candidates:[{id:'c',run_id:stage.run_id,role:'final',status:'eligible',revision}],
    evaluations:[{candidate:'c',revision,policy:bookingPolicy(stage.id).version,suite:'commands-v1',
      environment:'linux-node24-rust1.94-v1',evidence:'c'.repeat(64),checks:[{name:'booking-acceptance',status:'pass'}]}]};
  assert.equal(checkedOutcome(plan,chain,stage,detail).pass,true);
  detail.run.context_study.corpus=corpus.map(c=>c.id);detail.run.context_study.records=corpus;
  assert.throws(()=>checkedOutcome(plan,chain,stage,detail));
});
