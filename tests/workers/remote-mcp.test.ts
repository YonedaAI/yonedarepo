import { env } from 'cloudflare:workers';
import { reset, evictDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { ledger,sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { remoteMcp } from '../../cloudflare/worker/remote-mcp';
import { captureContribution } from '../../cloudflare/worker/contribution-capture';
import { platformSource } from '../../cloudflare/worker/source-objects';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env, Scope } from '../../cloudflare/worker/types';
import { platformProject } from './platform-fixture';
const bindings=env as unknown as Env;
afterEach(reset);
let project:Awaited<ReturnType<typeof platformProject>>;
async function setup(scope='contribute') {
 await workspace(bindings,'alice',{op:'signup',username:'alice',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:'a'.repeat(64)});
 project=await platformProject(bindings,'alice','remote-repo',{'index.html':'<!doctype html><title>Base</title>\n'},sitePolicy);
 const secret='b'.repeat(64);await workspace(bindings,'alice',{op:'grant_issue',id:'grant-1234567890123456',repo:'remote-repo',label:'Local agent',scope,expires:Date.now()+60000,token_hash:await sha(secret)});
 return `yoneda.alice.grant-1234567890123456.${secret}`;
}
function request(token:string,method:string,params:unknown={},repo='remote-repo'){return bindings.SELF.fetch(`https://yoneda/mcp/${repo}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
it('supports stateless MCP with durable repo scope and immediate subsequent-request revocation',async()=>{
 const token=await setup();
 const init=await request(token,'initialize',{protocolVersion:'2025-06-18'});expect(init.status).toBe(200);expect((await init.json<any>()).result.protocolVersion).toBe('2025-06-18');
 const tools=await (await request(token,'tools/list')).json<any>();expect(tools.result.tools.some((t:any)=>t.name==='attempt_submit')).toBe(true);
 const context=await (await request(token,'tools/call',{name:'repo_context',arguments:{}})).json<any>();const repository=JSON.parse(context.result.content[0].text);expect(repository.repository.published_commit).toBe(project.base.commit);expect(repository.git_url).toBeUndefined();
 expect((await request(token,'tools/list',{},'other-repo')).status).toBe(403);
 await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:alice')));
 await workspace(bindings,'alice',{op:'grant_revoke',id:'grant-1234567890123456'});expect((await request(token,'tools/list')).status).toBe(401);
});
it('read grants cannot become contributions, owner decisions or arbitrary HTTP authority',async()=>{
 const token=await setup('read');const denied=await (await request(token,'tools/call',{name:'attempt_begin',arguments:{request_id:crypto.randomUUID(),intent:'Build'}})).json<any>();expect(denied.result.isError).toBe(true);
 const decision=await (await request(token,'tools/call',{name:'accept',arguments:{}})).json<any>();expect(decision.result.isError).toBe(true);
 expect((await bindings.SELF.fetch('https://yoneda/api/repos/remote-repo/snapshot',{headers:{authorization:`Bearer ${token}`}})).status).toBe(403);
});

it('commits onto the attempt branch, binds the server-observed head and captures it fresh on the frozen base',async()=>{
 const token=await setup();const base=project.base;
 const call=async(name:string,args:any,ok=true)=>{const result=await remoteMcp(new Request('https://yoneda/mcp/remote-repo',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),bindings,'remote-repo');const body=await result.json<any>();expect(body.result.isError===true,JSON.stringify(body)).toBe(!ok);return ok?JSON.parse(body.result.content[0].text):body.result.content[0].text;};
 const attempt=await call('attempt_begin',{request_id:crypto.randomUUID(),intent:'Add accessible navigation'});
 expect(attempt.base).toMatchObject({repository:'platform/remote-repo',commit:base.commit});expect(attempt.git_url).toBeUndefined();
 expect((await call('attempt_read',{attempt_id:attempt.attempt_id})).entries.map((e:any)=>e.name)).toEqual(['index.html']);
 const html='<!doctype html><title>Contribution</title>\n';
 const first=await call('attempt_commit',{attempt_id:attempt.attempt_id,message:'Navigation',changes:[{path:'index.html',content_b64:btoa(html)}]});
 expect(first.branch).toBe(`contributions/${attempt.attempt_id}`);
 expect((await call('attempt_read',{attempt_id:attempt.attempt_id,path:'index.html'})).content).toBe(html);
 const second=await call('attempt_commit',{attempt_id:attempt.attempt_id,changes:[{path:'skip.css',content_b64:btoa('a{}\n')}]});
 expect(await call('attempt_commit',{attempt_id:attempt.attempt_id,changes:[{path:'../escape',content_b64:''}]},false)).toMatch(/safe relative/);
 const record=await call('context_publish',{attempt_id:attempt.attempt_id,kind:'alternative',statement:'Use a skip link',purpose:'Keyboard navigation',intent_id:attempt.intent_id,author:'owner',verified:true});expect(record.author).toBe(attempt.attempt_id);expect(record.data.verified).toBeUndefined();
 // A client-supplied commit is ignored: the branch head observed by the server is bound.
 const submitted=await call('attempt_submit',{attempt_id:attempt.attempt_id,commit:'f'.repeat(40)});expect(submitted.submitted_revision).toEqual({repository:'platform/remote-repo',commit:second.commit});
 expect(await call('attempt_commit',{attempt_id:attempt.attempt_id,changes:[{path:'late.txt',content_b64:btoa('late')}]},false)).toMatch(/expired|closed/);
 expect((await call('attempt_submit',{attempt_id:attempt.attempt_id})).status).toBe('capture_requested');
 const capture=await ledger(bindings,'remote-repo',{op:'claim',job_id:`capture:${attempt.attempt_id}`});
 expect(capture.payload).toMatchObject({capture_subtype:'platform_commit',contribution:submitted.submitted_revision,base:{commit:base.commit}});
 const scope:Scope={repo_id:'remote-repo',job:capture};
 const finished=await captureContribution(bindings,scope);
 // The contributor's two commits become one fresh commit on the frozen base with the same tree.
 const source=platformSource(project.platform);
 const fresh=await source.readCommit(finished.result.revision.commit);const head=await source.readCommit(second.commit);
 expect(fresh?.parents).toEqual([base.commit]);expect(fresh?.treeHash).toBe(head?.treeHash);expect(finished.result.revision.commit).not.toBe(second.commit);
 expect(finished.result.paths).toEqual(['index.html','skip.css']);
 expect((await captureContribution(bindings,scope)).result.revision).toEqual(finished.result.revision);
 await ledger(bindings,'remote-repo',finished);
 const snapshot=await ledger(bindings,'remote-repo',{op:'snapshot'});expect(snapshot.repository.published_commit).toBe(base.commit);
 expect(snapshot.candidates[0]).toMatchObject({revision:finished.result.revision,status:'evaluating'});
});
