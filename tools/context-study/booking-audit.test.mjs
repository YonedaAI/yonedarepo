import {it} from 'node:test';
import assert from 'node:assert/strict';
import {lineage,auditCampaign} from './booking-campaign-audit.mjs';
it('separates initial assignment, successful delivery, body opening and capture-bound citations',()=>{
  const page={coverage:{status:'recorded'},assigned:[{execution_id:'e',targets:[{id:'context:booking:capacity'}]}],
    entries:[{execution_id:'e',call_id:'one',stage:'returned',targets:[{id:'context:booking:waitlist'},{id:'unrelated'}]},
      {execution_id:'e',call_id:'two',stage:'opened',targets:[{id:'context:booking:capacity'}]},
      {execution_id:'peer',call_id:'peer',stage:'opened',targets:[{id:'context:booking:duplicate'}]}],
    citations:[{execution_id:'e',seq:1,targets:[{id:'context:booking:capacity'}],candidates:[{revision:{commit:'captured'}}]},
      {execution_id:'e',seq:2,targets:[{id:'context:booking:waitlist'}],candidates:[{revision:{commit:'different'}}]}],
    has_more:false,citations_truncated:false};
  const result=lineage([page,page],['context:booking:capacity','context:booking:waitlist','context:booking:duplicate'],'e','captured');
  assert.deepEqual(result.assigned_ids,['context:booking:capacity']);
  assert.deepEqual(result.delivered_ids,['context:booking:capacity','context:booking:waitlist']);
  assert.deepEqual(result.opened_ids,['context:booking:capacity']);
  assert.deepEqual(result.cited_ids,['context:booking:capacity','context:booking:waitlist']);
  assert.deepEqual(result.citations_bound_to_capture_ids,['context:booking:capacity']);
  assert.equal(result.successful_receipt_calls,2);assert.equal(result.outcome_benefit,null);
});
it('missing coverage is unknown; truncated citations cannot establish complete lineage',()=>{
  const missing=lineage([],['context:booking:capacity'],'e','capture');
  assert.equal(missing.delivered_ids,null);assert.equal(missing.opened_ids,null);
  assert.equal(lineage([{has_more:false,citations_truncated:true}],['context:booking:capacity'],'e','capture').citations_complete,false);
});
it('rejects historical website artifacts and never turns protocol simulations into agent benefits',()=>{
  const plan={case:'event_booking_maintenance',campaign:{id:'new-authority'},plan_digest:'frozen',chains:[]};
  assert.throws(()=>auditCampaign(plan,{case:'website_update'}));
  const report=auditCampaign(plan,{case:plan.case,campaign_id:plan.campaign.id,plan_digest:plan.plan_digest,
    chains:[],synthetic:true,agent_evidence:false});
  assert.equal(report.agent_chains_measured,0);assert.equal(report.causal_effect,null);
  assert.equal(report.observed_outcome_contrasts,null);
});
