// Saved-receipt audit, not a new fetch, inference, source capture or evaluator rerun.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkedOutcome,validateBinding,validateObservedRun,equal} from './booking-campaign-plan.mjs';
import {writeJSON} from './booking-campaign.mjs';
export function lineage(pages,relevantIds,execution,commit){
  const relevant=new Set(relevantIds),assigned=new Set(),delivered=new Set(),opened=new Set(),cited=new Set(),bound=new Set();
  const calls=new Map(),citations=new Map();
  for(const page of pages){
    for(const input of page.assigned??[]){
      if(input.execution_id!==execution)continue;
      for(const target of input.targets??[])if(relevant.has(target.id))assigned.add(target.id);
    }
    for(const entry of page.entries??[]){
      if(entry.execution_id===execution)calls.set(entry.call_id??entry.seq,entry);
    }
    for(const citation of page.citations??[]){
      if(citation.execution_id===execution)citations.set(citation.record_id??citation.seq,citation);
    }
  }
  for(const entry of calls.values())for(const target of entry.targets??[]){
    if(!relevant.has(target.id))continue;
    if(['returned','opened'].includes(entry.stage))delivered.add(target.id);
    if(entry.stage==='opened')opened.add(target.id);
  }
  for(const citation of citations.values())for(const target of citation.targets??[]){
    if(!relevant.has(target.id))continue;
    cited.add(target.id);
    if(commit&&citation.candidates?.some(candidate=>candidate.revision?.commit===commit))bound.add(target.id);
  }
  const observed=pages.length>0&&pages.every(page=>page.coverage?.status==='recorded');
  const values=set=>observed?[...set].sort():null;
  return {relevant_constraint_ids:relevantIds,execution_id:execution,captured_commit:commit,
    assigned_ids:pages.length?[...assigned].sort():null,delivered_ids:values(delivered),opened_ids:values(opened),
    cited_ids:pages.length?[...cited].sort():null,citations_bound_to_capture_ids:pages.length?[...bound].sort():null,
    successful_receipt_calls:calls.size,receipt_pages_complete:observed&&pages.at(-1)?.has_more===false,
    citations_complete:pages.length>0&&pages.every(page=>page.citations_truncated===false),
    assignment_limit:'Frozen initial input assignment does not establish model attention or successful tool delivery.',
    outcome_benefit:null};
}
export function auditCampaign(plan,results){
  if(plan.case!=='event_booking_maintenance'||results.case!==plan.case||results.campaign_id!==plan.campaign.id
    ||results.plan_digest!==plan.plan_digest||!Array.isArray(results.chains))throw new Error('Fresh booking campaign identity mismatch');
  const agentEvidence=results.agent_evidence===true&&results.synthetic===false;
  const seen=new Set();
  const chains=results.chains.map(chain=>{
    if(seen.has(chain.id))throw new Error('Duplicate campaign chain');seen.add(chain.id);
    const expected=plan.chains.find(expected=>expected.id===chain.id);
    if(!expected||expected.arm!==chain.arm||expected.repetition!==chain.repetition||expected.repo_id!==chain.repo_id)
      throw new Error('Chain does not belong to frozen matched campaign');
    const seenStages=new Set();
    const stages=chain.stages.map(stage=>{
      if(seenStages.has(stage.id))throw new Error('Duplicate campaign stage');seenStages.add(stage.id);
      const task=expected.stages.find(task=>task.id===stage.id);
      if(!task||task.run_id!==stage.run_id)throw new Error('Stage identity changed');
      let outcome=null,invalidVerdict=false,rejected=null;
      if(agentEvidence&&stage.detail){
        try{
          validateBinding(plan,expected,task,stage.server_binding);
          const {run}=validateObservedRun(plan,expected,task,stage.detail);
          const candidate=stage.detail.candidates?.find(c=>c.run_id===task.run_id&&c.role!=='specialist');
          const evaluation=stage.detail.evaluations?.find(e=>candidate&&e.candidate===candidate.id&&equal(e.revision,candidate.revision)
            &&e.policy===run.policy.version);
          if(candidate?.status==='rejected'&&evaluation?.suite==='commands-v1'
            &&evaluation.environment==='linux-node24-rust1.94-v1'&&/^[a-f0-9]{64}$/.test(evaluation.evidence)
            &&evaluation.checks?.some(c=>c.name==='booking-acceptance'&&c.status==='fail'))rejected=candidate;
          if(!rejected)outcome=checkedOutcome(plan,expected,task,stage.detail);
        }
        catch{invalidVerdict=true;}
      }
      const execution=outcome?.execution??stage.detail?.executions?.find(execution=>execution.run_id===stage.run_id);
      const commit=outcome?.revision?.commit??rejected?.revision?.commit??null;
      if(outcome&&(!equal(stage.captured_source?.revision,outcome.revision)))throw new Error('Captured outcome revision mismatch');
      return {id:task.id,run_id:stage.run_id,behavioral_pass:agentEvidence?(outcome?true:rejected?false:null):null,
        verification_invalid:invalidVerdict,checked_revision:outcome?.revision??rejected?.revision??null,
        working_head_advanced:agentEvidence&&outcome?stage.branch_readback?.latest_candidate_id===outcome.candidate.id
          &&stage.branch_readback?.working_commit===outcome.revision.commit
          &&stage.branch_readback?.version===stage.request?.expected_working_version+1:null,
        lineage:lineage(stage.usage_pages??[],task.relevant_context_ids,execution?.id??null,commit)};
    });
    return {id:chain.id,arm:chain.arm,repetition:chain.repetition,stages,
      complete:agentEvidence&&chain.complete===true&&chain.failure==null&&stages.length===3
        &&stages.every(stage=>stage.behavioral_pass===true&&stage.working_head_advanced===true),
      retained_failure:chain.failure??null};
  });
  const repetitions=[1,2];
  const completeTriplets=repetitions.filter(repetition=>['source_only','plain_notes','graph'].every(arm=>
    chains.some(chain=>chain.arm===arm&&chain.repetition===repetition&&chain.stages.length===3
      &&chain.stages.every(stage=>stage.behavioral_pass!==null))));
  const contrasts=agentEvidence&&completeTriplets.length===2?plan.chains[0].stages.map(task=>{
    const count=arm=>chains.filter(chain=>chain.arm===arm).filter(chain=>chain.stages.find(stage=>stage.id===task.id)?.behavioral_pass).length;
    return {stage:task.id,repetitions:2,source_passes:count('source_only'),notes_passes:count('plain_notes'),graph_passes:count('graph'),
      graph_minus_source_pass_rate:(count('graph')-count('source_only'))/2,
      graph_minus_notes_pass_rate:(count('graph')-count('plain_notes'))/2};
  }):null;
  return {version:1,case:plan.case,campaign_id:results.campaign_id,agent_chains_measured:agentEvidence?chains.length:0,
    saved_evidence_only:true,source_refetched:false,oracle_rerun:false,chains,complete_matched_triplets:completeTriplets.length,
    observed_outcome_contrasts:contrasts,causal_effect:null,
    causal_limit:'Receipts and assertions do not prove outcome benefit. Two matched repetitions with reversed order describe outcomes; model nondeterminism, time/order and incomplete stages limit causal inference. Graph versus notes measures retrieval format; graph versus source also changes historical information availability.',
    live_requirements:['A separate owner-authorized exact $12/$2 server campaign, compatible runtime and six newly seeded isolated repositories',
      'Eighteen actual stage executions with the same frozen model, bounded requests/output/time and no escalation',
      'Retain failed and cancelled chains, protected exact-capture checks, full context pages, citation coverage and server chain spend',
      'Inspect actual UI and persisted-data maintenance outcomes; publication requires an independent owner decision']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [manifest,input,output]=process.argv.slice(2);
  if(!manifest||!input||!output)throw new Error('Use booking-campaign-audit.mjs MANIFEST RESULTS OUTPUT');
  const report=auditCampaign(JSON.parse(readFileSync(manifest,'utf8')),JSON.parse(readFileSync(input,'utf8')));
  writeJSON(output,report);console.log(`Audited ${report.agent_chains_measured} fresh agent chains; causal effect remains unmeasured.`);
}
