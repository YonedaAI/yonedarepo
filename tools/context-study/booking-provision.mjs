// Private operator setup only. No provider requests, run starts or funding changes.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {gitEnvironment,campaignClient} from './booking-operator.mjs';
import {operatorStudyClient} from './booking-client.mjs';
import {bootstrapPlan} from './booking-bootstrap.mjs';
import {starterFiles,hash,equal,studyConfig,corpus} from './booking-campaign-plan.mjs';
import {prepare,writeJSON} from './booking-campaign.mjs';
const reject=message=>{throw new Error(message);};
export function git(args,cwd,capability){
  return new Promise((accept,reject)=>{
    const child=spawn('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnvironment(capability??''),stdio:['ignore','pipe','pipe']});
    let stdout='';child.stdout.on('data',data=>{if(stdout.length<8192)stdout+=data.toString();});
    // Drain privately: stderr may contain a remote capability or SDK URL.
    child.stderr.resume();
    const timeout=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.on('error',()=>{clearTimeout(timeout);reject(new Error('Private Git subprocess unavailable'));});
    child.on('close',code=>{clearTimeout(timeout);code===0?accept(stdout.trim()):reject(new Error('Private Git operation failed; stderr withheld'));});
  });
}
export async function seedTemplate(client,template,output,{runGit=git}={}){
  const receiptPath=resolve(output,'template-receipt.json');
  const bootstrap=await client.api('bootstrap',{name:template});
  if(bootstrap.commit){
    const previous=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):null;
    if(previous?.commit!==bootstrap.commit||previous?.source_digest!==hash(starterFiles()))reject('Existing template lacks matching private verified receipt');
    return previous;
  }
  const remote=new URL(bootstrap.remote);
  if(remote.protocol!=='https:'||remote.username||remote.password||remote.search||remote.hash
    ||!bootstrap.token||!bootstrap.token_id)reject('Invalid private Git bootstrap envelope');
  const directory=mkdtempSync(resolve(tmpdir(),'booking-starter-'));
  let commit,tree,pushed=false;
  try{
    for(const [path,file] of Object.entries(starterFiles())){
      const target=resolve(directory,path);
      if(!target.startsWith(directory+'/'))reject('Invalid starter path');
      mkdirSync(dirname(target),{recursive:true});writeFileSync(target,file.content,{mode:file.executable?0o755:0o644});
    }
    await runGit(['init','--initial-branch=main'],directory);
    await runGit(['add','--all'],directory);
    await runGit(['-c','user.name=Yoneda Fixture Operator','-c','user.email=fixture@yoneda.invalid','-c','commit.gpgsign=false',
      'commit','-m','Initialize explicit incomplete event booking campaign starter'],directory);
    commit=await runGit(['rev-parse','HEAD'],directory);tree=await runGit(['rev-parse','HEAD^{tree}'],directory);
    if(!/^[a-f0-9]{40}$/.test(commit)||!/^[a-f0-9]{40}$/.test(tree))reject('Invalid local seed capture');
    try{await runGit(['push',bootstrap.remote,'HEAD:refs/heads/main'],directory,bootstrap.token);}catch{/* Read back same commit after uncertain acknowledgment. */}
    const observed=await runGit(['ls-remote',bootstrap.remote,'refs/heads/main'],directory,bootstrap.token);
    if(observed.split(/\s+/)[0]!==commit)reject('Private Git HEAD readback differs from seed capture');
    pushed=true;
  }finally{
    try{
      const revoked=await client.api('bootstrap',{name:template,revoke_token_id:bootstrap.token_id});
      if(revoked.revoked!==true)reject('Bootstrap write capability revocation not confirmed');
    }
    finally{rmSync(directory,{recursive:true,force:true});}
  }
  const observed=await client.api('bootstrap',{name:template});
  if(!pushed||observed.commit!==commit)reject('Server template readback differs from Git capture');
  const receipt={template,commit,tree,source_digest:hash(starterFiles()),write_capability_revoked:true,agent_evidence:false};
  writeJSON(receiptPath,receipt);return receipt;
}
export async function provisionAll(client,plan,template,output,{reviewerRepo,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const setup=bootstrapPlan(plan,template),requests=setup.provisions.map(value=>value.body);
  if(reviewerRepo)requests.push({username:plan.username,repo_id:reviewerRepo,template,policy:setup.provisions[0].body.policy});
  const receipts=[];
  for(const body of requests){
    let receipt;
    for(let attempt=0;attempt<60;attempt++){
      receipt=await client.api('admin/campaign/provision',body);
      if(receipt.status==='ready')break;
      if(receipt.status!=='provisioning')reject('Unexpected provisioning state');
      await sleep(2000);
    }
    if(receipt?.status!=='ready'||receipt.username!==plan.username||receipt.repo_id!==body.repo_id)reject('Private provisioning did not become ready');
    const snapshot=await client.api(`repos/${body.repo_id}/snapshot`),repo=snapshot.repository;
    const source=await client.api(`repos/${body.repo_id}/published_source`);
    const files=Object.fromEntries(Object.entries(source.files??{}).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
    if(repo.status!=='ready'||repo.head_commit!==receipt.commit||repo.published_commit!==receipt.commit
      ||source.revision?.commit!==receipt.commit||hash(files)!==plan.source_digest
      ||snapshot.runs?.length||snapshot.jobs?.some(job=>['running','queued'].includes(job.status)))reject('Provisioned source is not the frozen fresh starter');
    const chain=plan.chains.find(value=>value.repo_id===body.repo_id);
    if(chain){
      const {records,...config}=repo.context_study??{};
      if(!equal(config,studyConfig(plan,chain)))reject('Provisioned study arm changed');
      for(const record of corpus){
        const actual=await client.api(`repos/${body.repo_id}/context_get?id=${encodeURIComponent(record.id)}`);
        if(actual.kind!==record.kind||actual.data?.statement!==record.statement||actual.data?.purpose!==record.purpose)reject('Provisioned constraint differs from frozen corpus');
      }
    }
    receipts.push({...receipt,source_digest:plan.source_digest,verified_no_runs:true,
      ...(chain?{arm:chain.arm,repetition:chain.repetition}:{reviewer_campaign:true})});
    writeJSON(resolve(output,'provision-receipts.json'),{version:1,agent_evidence:false,model_calls:0,receipts});
  }
  return receipts;
}
async function main(){
  const options={};
  for(let i=2;i<process.argv.length;i+=2){
    if(!['--settings','--output','--origin','--owner-token','--operator-token-file','--credentials','--expected-revision','--reviewer-repo'].includes(process.argv[i])||!process.argv[i+1])reject('Invalid private setup arguments');
    options[process.argv[i]]=process.argv[i+1];
  }
  options['--owner-token']??=options['--operator-token-file'];
  for(const key of ['--settings','--output','--origin','--owner-token','--expected-revision'])if(!options[key])reject('Explicit private setup settings and deployed revision required');
  const settings=JSON.parse(readFileSync(options['--settings'],'utf8'));
  if(settings.synthetic_example!==false)reject('Actual operator settings required');
  const plan=prepare(settings,options['--output']);
  const client=options['--credentials']?await operatorStudyClient(options['--origin'],options['--owner-token'],options['--credentials']):campaignClient(options['--origin'],options['--owner-token'],plan.username);
  const health=await client.health();
  if(health.revision!==options['--expected-revision'])reject('Deployed platform revision changed');
  writeJSON(resolve(options['--output'],'platform-readback.json'),health);
  const template=await seedTemplate(client,settings.template,options['--output']);
  const receipts=await provisionAll(client,plan,settings.template,options['--output'],{reviewerRepo:options['--reviewer-repo']});
  console.log(JSON.stringify({template:template.template,commit:template.commit,ready_repositories:receipts.map(value=>value.repo_id),model_calls:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(`Private setup stopped: ${/^[A-Z_]{1,64}$/.test(error.code)?error.code:'SETUP_FAILED'}; no sensitive response logged.`);process.exitCode=1;});
