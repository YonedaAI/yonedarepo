// Execution adapter is injectable for offline protocol tests. No fixture repairs here.
import {bookingPolicy,protectedBundle} from './booking-policy.mjs';
import {validateAuthority,stageRequest,checkedOutcome,studyConfig,validateBinding,validateObservedRun,planCorpus,equal,hash} from './booking-campaign-plan.mjs';
const stop=message=>{throw new Error(message);};
const terminal=new Set(['ready','accepted','failed','cancelled']);
export async function runCampaign(client,plan,{save=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  now=Date.now,waitMs=960000}={}){
  const result={version:1,case:plan.case,campaign_id:plan.campaign.id,plan_digest:plan.plan_digest,
    synthetic:client.simulated===true,agent_evidence:client.simulated!==true,chains:[],complete:false,causal_effect:null};
  const corpus=planCorpus(plan);
  const campaignStatus=()=>client.api('admin/campaign/status',{username:plan.username,id:plan.campaign.id});
  const detail=(chain,stage)=>client.api(`repos/${chain.repo_id}/run_detail?run_id=${stage.run_id}`);
  const authority=validateAuthority(plan,await campaignStatus(),now());
  if(authority.campaign.charged_microusd!==(plan.retained_authority?.charged_microusd??0))stop('Fresh phase must begin with exact retained campaign spend');
  // Complete all read-only isolation checks before any model run starts.
  for(const chain of plan.chains){
    const snapshot=await client.api(`repos/${chain.repo_id}/snapshot`);
    if(snapshot.capabilities?.campaign_budget!==1||snapshot.capabilities?.working_branches!==1
      ||snapshot.capabilities?.context_usage!==1)stop('Server lacks protected campaign/branch/context capabilities');
    const repo=snapshot.repository;
    const {records,...preparedStudy}=repo.context_study??{};
    if(!equal(preparedStudy,studyConfig(plan,chain)))stop('Owner-seeded controlled study differs from frozen arm');
    if(repo.status!=='ready'||repo.pending!=null||repo.head_commit!==repo.published_commit
      ||snapshot.runs?.some(run=>run.context_study)||snapshot.jobs?.some(job=>['running','queued'].includes(job.status)))
      stop('Fresh ready repository required; study runs or active jobs found');
    const source=await client.api(`repos/${chain.repo_id}/published_source`);
    const files=Object.fromEntries(Object.entries(source.files??{}).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
    if(source.revision?.commit!==repo.published_commit||hash(files)!==plan.source_digest)stop('Seed capture differs from identical fresh incomplete starter');
    for(const record of corpus){
      const actual=await client.api(`repos/${chain.repo_id}/context_get?id=${encodeURIComponent(record.id)}`);
      if(actual.kind!==record.kind||actual.data?.statement!==record.statement||actual.data?.purpose!==record.purpose)
        stop('Maintenance corpus differs across arms');
    }
  }
  for(const chain of plan.chains){
    const evidence={id:chain.id,arm:chain.arm,repetition:chain.repetition,repo_id:chain.repo_id,stages:[],complete:false};
    result.chains.push(evidence);save(result);
    let active=null;
    try{
      const snapshot=await client.api(`repos/${chain.repo_id}/snapshot`),repo=snapshot.repository;
      const branch=await client.api(`repos/${chain.repo_id}/create_working_branch`,{id:chain.branch_id,
        expected_commit:repo.published_commit,expected_version:repo.version});
      let expectedBranch=branch;
      for(const stage of chain.stages){
        validateAuthority(plan,await campaignStatus(),now());
        const latest=await client.api(`repos/${chain.repo_id}/snapshot`);
        if(latest.repository.published_commit!==repo.published_commit)stop('Canonical publication changed during controlled chain');
        const protectedFiles=protectedBundle();
        const approved=await client.api(`repos/${chain.repo_id}/approve_test_bundle`,{
          expected_commit:latest.repository.head_commit,expected_version:latest.repository.version,
          expected_policy:latest.repository.policy.version,policy:bookingPolicy(stage.id),
          files:protectedFiles.files,protected_paths:['schema.json','build.mjs']});
        if(approved.digest!==plan.test_bundle_digest)stop('Protected test bundle readback changed');
        const current=await client.api(`repos/${chain.repo_id}/working_branch?id=${chain.branch_id}`);
        if(current.working_commit!==expectedBranch.working_commit||current.version!==expectedBranch.version)
          stop('Unapproved peer advanced working branch');
        const request=stageRequest(plan,chain,stage,current);
        active=stage;
        const saved={id:stage.id,run_id:stage.run_id,request,usage_pages:[],outcome:null};
        evidence.stages.push(saved);save(result);
        const observe=async()=>{
          const observed=await detail(chain,stage);
          saved.detail=observed;save(result);
          try{validateObservedRun(plan,chain,stage,observed);}
          catch{throw Object.assign(new Error('Frozen run readback violates deployment fidelity'),{code:'DEPLOYMENT_FIDELITY_FAILED'});}
          return observed;
        };
        try{await client.api('admin/campaign/start_run',{username:plan.username,repo_id:chain.repo_id,approval:request});}
        catch(failure){
          // Acknowledgment loss: discover the same stable run ID, never resubmit under a new ID.
          try{await observe();}catch(discovery){
            if(discovery.code==='DEPLOYMENT_FIDELITY_FAILED')throw discovery;
            throw failure;
          }
        }
        const binding=await client.api('admin/campaign/run_status',{username:plan.username,repo_id:chain.repo_id,run_id:stage.run_id});
        saved.server_binding=validateBinding(plan,chain,stage,binding);save(result);
        const deadline=now()+waitMs;
        let observed;
        while(true){
          observed=await observe();
          const run=observed.run??observed.runs?.find(run=>run.id===stage.run_id);
          if(terminal.has(run?.status))break;
          if(now()>=deadline)stop('Stage queue/execution wait exceeded bound');
          await sleep(2000);
        }
        saved.detail=observed;
        let cursor=null;
        for(let count=0;count<100;count++){
          const page=await client.api(`repos/${chain.repo_id}/context_usage?run_id=${stage.run_id}&limit=100${cursor===null?'':`&cursor=${encodeURIComponent(cursor)}`}`);
          saved.usage_pages.push(page);
          if(page.has_more===false)break;
          if(page.has_more!==true||page.next_cursor==null||page.next_cursor===cursor)stop('Incomplete or looping context receipt pages');
          cursor=page.next_cursor;
          if(count===99)stop('Receipt page bound exceeded');
        }
        saved.outcome=checkedOutcome(plan,chain,stage,observed);
        saved.captured_source=await client.api(`repos/${chain.repo_id}/candidate_source?id=${saved.outcome.candidate.id}`);
        if(!equal(saved.captured_source.revision,saved.outcome.revision))stop('Captured source revision mismatch');
        const advanced=await client.api(`repos/${chain.repo_id}/working_branch?id=${chain.branch_id}`);
        if(advanced.latest_candidate_id!==saved.outcome.candidate.id||advanced.working_commit!==saved.outcome.revision.commit
          ||advanced.version!==current.version+1)stop('Protected checked candidate did not advance working branch exactly once');
        saved.branch_readback=advanced;
        expectedBranch=advanced;active=null;save(result);
      }
      evidence.complete=true;
    }catch(failure){
      evidence.failure={code:/^[A-Z_]{1,64}$/.test(failure?.code)?failure.code:'STUDY_CHAIN_STOPPED',
        message:'Chain stopped; inspect retained stage evidence and server ledger'};
      if(active){
        await client.api(`repos/${chain.repo_id}/cancel_run`,{run_id:active.run_id}).catch(()=>{});
        evidence.cancel_requested=true;
      }
      save(result);
      if(evidence.failure.code==='DEPLOYMENT_FIDELITY_FAILED'){
        result.failure={...evidence.failure};save(result);break;
      }
      // An arm never gets a more expensive retry or a rewritten positive outcome.
    }
  }
  result.authority_final=validateAuthority(plan,await campaignStatus(),now(),true);
  result.complete=result.chains.every(chain=>chain.complete);save(result);return result;
}
