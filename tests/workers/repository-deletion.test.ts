import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { platformRequest, projectPlatform } from '../../cloudflare/worker/agents-platform';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { deliverOutbox } from '../../cloudflare/worker/outbox-delivery';
import { deliverDeletion } from '../../cloudflare/worker/repository-deletion';
import { provisionProject } from '../../cloudflare/worker/projects';
import { authorizePreview, previewLink } from '../../cloudflare/worker/sites';
import { ledger, sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import type { Env, Json } from '../../cloudflare/worker/types';
import { bindNewPlatformRepo } from './platform-fixture';

const bindings = env as unknown as Env;
const policy = {version:'retry-v1',suite:'retry-contract-v1',environment:'rust-1.94-evaluator-v1',required_checks:['build','behavior']};
afterEach(reset);
async function setup(id='delete-me', name='Delete me', ready=true) {
  await workspace(bindings,'alice',{op:'signup',username:'alice',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:await sha('a'.repeat(64))});
  const project=await workspace(bindings,'alice',{op:'project_reserve',id,name,policy});
  if(ready) {
    await ledger(bindings,id,{op:'init',id,name,workspace:'alice',remote:{namespace:'platform',name:id},commit:'a'.repeat(40),policy});
    await workspace(bindings,'alice',{op:'project_update',id,status:'ready'});
  }
  return project;
}
function request(id='delete-me',confirm_name:unknown='Delete me',cookie='yoneda_account=alice.'+'a'.repeat(64)) {
  return new Request(`https://yoneda/api/repos/${id}/delete_repository`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({confirm_name})});
}
async function remove(id='delete-me', name='Delete me') {
  const response=await fetchRequest(request(id,name),bindings);
  expect(response.status).toBe(200);
  expect((await response.json<Json>()).status).toBe('deleted');
}

it('reports deployment propagation when an older repository ledger has no deletion command',async()=>{
  const previous={...bindings,REPOSITORIES:{idFromName:(name:string)=>name,get:()=>({fetch:async()=>Response.json({error:{code:'NOT_FOUND',message:'Unknown repository operation'}},{status:404})})}} as unknown as Env;
  const response=await fetchRequest(new Request('https://yoneda/api/repos/old-ledger/delete_repository',{method:'POST',headers:{authorization:`Bearer ${bindings.OWNER_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({confirm_name:'Old ledger'})}),previous);
  expect(response.status).toBe(409);
  expect((await response.json<Json>()).error).toMatchObject({code:'LEDGER_UPDATING',message:'Repository code is still updating. Try deletion again shortly.'});
});

it('deletes through the authenticated API, fences retries and preserves other repositories and provider connections',async()=>{
  await setup();
  await workspace(bindings,'alice',{op:'project_reserve',id:'keep-me',name:'Keep me',policy});
  await workspace(bindings,'alice',{op:'provider_put',provider:'mimo',model:'mimo-v2.6-flash',sealed:{iv:'fixture',ciphertext:'fixture'}});
  await ledger(bindings,'delete-me',{op:'start_run',id:'delete-run',intent:'Disposable deletion fixture'});
  const active=await ledger(bindings,'delete-me',{op:'claim',job_id:'job:delete-run:research'});
  await workspace(bindings,'alice',{op:'grant_issue',id:'grant-deletion-fixture',repo:'delete-me',scope:'contribute',label:'Disposable grant',expires:Date.now()+60000,token_hash:'b'.repeat(64)});
  await remove();
  expect((await workspace(bindings,'alice',{op:'projects'})).projects.map((p:Json)=>p.id)).toEqual(['keep-me']);
  expect((await workspace(bindings,'alice',{op:'settings'})).providers).toHaveLength(1);
  expect((await workspace(bindings,'alice',{op:'grants',repo:'delete-me'})).grants[0].revoked).toBe(true);
  await expect(ledger(bindings,'delete-me',{op:'finish',job_id:active.id,epoch:active.epoch,result:{}})).rejects.toThrow('deleted');
  expect((await ledger(bindings,'delete-me',{op:'claim',job_id:active.id})).already_done).toBe(true);
  const pending=await ledger(bindings,'delete-me',{op:'outbox'});
  expect(pending.jobs.some((entry:Json)=>entry.kind==='stop'&&entry.payload.epoch===active.epoch)).toBe(true);
  expect(pending.jobs.some((entry:Json)=>entry.kind==='agent')).toBe(false);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName('delete-me')));
  await remove();
  const gone=await fetchRequest(new Request('https://yoneda/api/repos/delete-me/snapshot',{headers:{cookie:'yoneda_account=alice.'+'a'.repeat(64)}}),bindings);
  expect(gone.status).toBe(410);
});

it('rejects missing confirmation, cross-workspace ownership, unauthenticated and cross-origin deletion',async()=>{
  await setup();
  expect((await fetchRequest(request('delete-me','wrong'),bindings)).status).toBe(409);
  expect((await fetchRequest(new Request(request(),{body:'{}'}),bindings)).status).toBe(409);
  expect((await fetchRequest(request('delete-me','Delete me',''),bindings)).status).toBe(401);
  const cross=request();cross.headers.set('origin','https://untrusted.example');
  expect((await fetchRequest(cross,bindings)).status).toBe(401);
  await expect(ledger(bindings,'delete-me',{op:'delete_repository',_workspace:'bob',confirm_name:'Delete me'})).rejects.toThrow('another workspace');
  expect((await ledger(bindings,'delete-me',{op:'snapshot'})).repository.status).toBe('ready');
});

it('permanently deletes failed and provisioning projects before their repository ledger exists',async()=>{
  const project=await setup('pending-repo','Pending',false);
  await workspace(bindings,'alice',{op:'project_update',id:project.id,status:'failed',error:'Fixture import failure'});
  await remove(project.id,'Pending');
  await expect(workspace(bindings,'alice',{op:'project_update',id:project.id,status:'ready'})).rejects.toThrow('deleted');
  await expect(workspace(bindings,'alice',{op:'project_reserve',id:project.id,name:'Pending',policy})).rejects.toThrow('deleted');
  await expect(ledger(bindings,project.id,{op:'init'})).rejects.toThrow('deleted');
  await expect(provisionProject(bindings,'alice',project)).rejects.toThrow('deleted');
  expect((await workspace(bindings,'alice',{op:'projects'})).projects).toHaveLength(0);
});

it('revokes already issued preview capabilities and blocks all repository context reads',async()=>{
  await setup();
  const local={...bindings,SITE_ORIGIN:'https://sites.example'};
  const link=await previewLink(local,'delete-me',{deployment:{digest:'c'.repeat(64)}});
  const token=new URL(link.url).pathname.split('/')[3];
  expect(await authorizePreview(local,'c'.repeat(64),token)).toBe(true);
  await remove();
  expect(await authorizePreview(local,'c'.repeat(64),token)).toBe(false);
  for(const op of ['snapshot','graph','context_search','events','why','execution_logs'])
    await expect(ledger(bindings,'delete-me',{op})).rejects.toThrow('deleted');
});

it('revokes the agent token with the owner\'s own credential and leaves the platform repository to its owner',async()=>{
  await setup();
  const { repo } = await bindNewPlatformRepo(bindings,'alice','delete-me');
  const agent = await projectPlatform(bindings,'alice','delete-me');
  expect((await agent.call('GET','/refs')).refs['refs/heads/main']).toMatch(/^[0-9a-f]{40}$/);
  await remove();
  // The sealed credential is gone with the project, and the platform refuses the token itself.
  await expect(workspace(bindings,'alice',{op:'project_platform_credential',id:'delete-me'})).rejects.toThrow();
  await expect(agent.call('GET','/refs')).rejects.toMatchObject({ status: 401 });
  const owner = new Request('https://yoneda/',{headers:{cookie:'yoneda_account=alice.'+'a'.repeat(64)}});
  const kept = await platformRequest(bindings,{forward:owner},'GET',`/repos/${repo}/refs`);
  expect(kept.refs['refs/heads/main']).toMatch(/^[0-9a-f]{40}$/);
  // Deletion records no source cleanup: nothing in the agent layer owns repository storage.
  await ledger(bindings,'delete-me',{op:'recover'});
  expect((await ledger(bindings,'delete-me',{op:'outbox'})).jobs.map((entry:Json)=>entry.kind)).not.toContain('delete_artifact');
});

it('drains Artifacts cleanup recorded before projects moved to the platform',async()=>{
  const deleted:string[]=[];
  const sdk={...bindings,ARTIFACTS:{delete:async(name:string)=>{deleted.push(name);return true;}}} as unknown as Env;
  await deliverDeletion(sdk,'legacy',{kind:'delete_artifact',payload:{name:'legacy-fork'}});
  expect(deleted).toEqual(['legacy-fork']);
});

it('continues independent deletion cleanup after a container stop fails and only acknowledges successes',async()=>{
  await setup();
  await ledger(bindings,'delete-me',{op:'start_run',id:'active-run',intent:'Disposable stop failure fixture'});
  await ledger(bindings,'delete-me',{op:'claim',job_id:'job:active-run:research'});
  await remove();
  await bindings.INDEX.exec('CREATE TABLE repositories(id TEXT PRIMARY KEY,payload TEXT NOT NULL,seq INTEGER NOT NULL)');
  const sdk={...bindings,EXECUTIONS:{idFromName:(name:string)=>name,get:()=>({stop:async()=>{throw new Error('Stop unavailable fixture');}})}} as unknown as Env;
  const pending=(await ledger(bindings,'delete-me',{op:'outbox'})).jobs.map((entry:Json)=>({...entry,repository_deleted:true}));
  const delivered=await deliverOutbox(sdk,'delete-me',pending);
  expect(delivered).toContain('delete:workspace');
  expect(delivered).not.toContain('stop:job:active-run:research:1');
  for(const id of delivered) await ledger(bindings,'delete-me',{op:'outbox_sent',id});
  expect((await ledger(bindings,'delete-me',{op:'outbox'})).jobs.map((entry:Json)=>entry.kind)).toEqual(['stop']);
});
