import { env } from 'cloudflare:workers';
import { reset, evictDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { ledger,sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { remoteMcp } from '../../cloudflare/worker/remote-mcp';
import { externalGit } from '../../cloudflare/worker/external-git';
import { readObject } from '../../cloudflare/worker/storage';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env } from '../../cloudflare/worker/types';
const bindings=env as unknown as Env;
afterEach(reset);
async function setup(scope='contribute') {
 await workspace(bindings,'alice',{op:'signup',username:'alice',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:'a'.repeat(64)});
 await workspace(bindings,'alice',{op:'project_reserve',id:'remote-repo',name:'Remote',policy:sitePolicy});await workspace(bindings,'alice',{op:'project_update',id:'remote-repo',status:'ready'});
 await ledger(bindings,'remote-repo',{op:'init',id:'remote-repo',name:'Remote',workspace:'alice',remote:{namespace:'yoneda-test',name:'remote-repo'},commit:'a'.repeat(40),policy:sitePolicy});
 const secret='b'.repeat(64);await workspace(bindings,'alice',{op:'grant_issue',id:'grant-1234567890123456',repo:'remote-repo',label:'Local agent',scope,expires:Date.now()+60000,token_hash:await sha(secret)});
 return `yoneda.alice.grant-1234567890123456.${secret}`;
}
function request(token:string,method:string,params:unknown={},repo='remote-repo'){return bindings.SELF.fetch(`https://yoneda/mcp/${repo}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
it('supports stateless MCP with durable repo scope and immediate subsequent-request revocation',async()=>{
 const token=await setup();
 const init=await request(token,'initialize',{protocolVersion:'2025-06-18'});expect(init.status).toBe(200);expect((await init.json<any>()).result.protocolVersion).toBe('2025-06-18');
 const tools=await (await request(token,'tools/list')).json<any>();expect(tools.result.tools.some((t:any)=>t.name==='attempt_submit')).toBe(true);
 const context=await (await request(token,'tools/call',{name:'repo_context',arguments:{}})).json<any>();expect(JSON.parse(context.result.content[0].text).repository.published_commit).toBe('a'.repeat(40));
 expect((await request(token,'tools/list',{},'other-repo')).status).toBe(403);
 const git=await bindings.SELF.fetch('https://yoneda/git/remote-repo/source/info/refs?service=git-receive-pack',{headers:{authorization:`Bearer ${token}`}});expect(git.status).toBe(403);
 await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:alice')));
 await workspace(bindings,'alice',{op:'grant_revoke',id:'grant-1234567890123456'});expect((await request(token,'tools/list')).status).toBe(401);
});
it('read grants cannot become contributions, owner decisions or arbitrary HTTP authority',async()=>{
 const token=await setup('read');const denied=await (await request(token,'tools/call',{name:'attempt_begin',arguments:{request_id:crypto.randomUUID(),intent:'Build'}})).json<any>();expect(denied.result.isError).toBe(true);
 const decision=await (await request(token,'tools/call',{name:'accept',arguments:{}})).json<any>();expect(decision.result.isError).toBe(true);
 expect((await bindings.SELF.fetch('https://yoneda/api/repos/remote-repo/snapshot',{headers:{authorization:`Bearer ${token}`}})).status).toBe(403);
});

it('binds server-observed source, derives context identity and fences Git before independent capture',async()=>{
 const token=await setup();let head='b'.repeat(40);const reads:string[]=[];let revoked=0;
 const remote={ [Symbol.dispose](){},fork:async()=>({token:'initial-capability'}),info:async()=>({defaultBranch:'main'}),log:async()=>[{hash:head}],listTokens:async()=>({tokens:[]}),revokeToken:async()=>{revoked++;return true;},readCommit:async(commit:string)=>{reads.push(commit);return {treeHash:'c'.repeat(40)};},readTree:async()=>[{name:'index.html',type:'blob',hash:'d'.repeat(40)}],readBlob:async()=>new Blob(['<!doctype html><title>Contribution</title>'])};
 const scoped={...bindings,ARTIFACTS:{get:async()=>remote}} as unknown as Env;
 const call=async(name:string,args:any)=>{const result=await remoteMcp(new Request('https://yoneda/mcp/remote-repo',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),scoped,'remote-repo');const body=await result.json<any>();expect(body.result.isError,JSON.stringify(body)).not.toBe(true);return JSON.parse(body.result.content[0].text);};
 const args={request_id:crypto.randomUUID(),intent:'Add accessible navigation'};
 const attempt=await call('attempt_begin',args);expect(attempt.git_url).toContain('/external-');expect(revoked).toBe(1);expect(JSON.stringify(attempt)).not.toContain('initial-capability');
 const record=await call('context_publish',{attempt_id:attempt.attempt_id,kind:'alternative',statement:'Use a skip link',purpose:'Keyboard navigation',intent_id:attempt.intent_id,author:'owner',verified:true});expect(record.author).toBe(attempt.attempt_id);expect(record.data.verified).toBeUndefined();
 const submitted=await call('attempt_submit',{attempt_id:attempt.attempt_id,commit:'f'.repeat(40)});expect(submitted.submitted_revision.commit).toBe(head);expect(reads).toEqual([head]);
 head='e'.repeat(40);expect((await call('attempt_submit',{attempt_id:attempt.attempt_id})).status).toBe('capture_requested');expect(reads).toHaveLength(1);
 const git=await externalGit(new Request(`${attempt.git_url}/info/refs?service=git-receive-pack`,{headers:{authorization:`Bearer ${token}`}}),scoped,['git','remote-repo',attempt.attempt_id,'info','refs']);expect(git.status).toBe(403);
 const capture=await ledger(bindings,'remote-repo',{op:'claim',job_id:`capture:${attempt.attempt_id}`});expect(capture.kind).toBe('capture');expect(capture.payload.base.commit).toBe('a'.repeat(40));expect(JSON.parse(await readObject(bindings,capture.payload.workspace)).files['index.html'].content).toContain('Contribution');
 const snapshot=await ledger(bindings,'remote-repo',{op:'snapshot'});expect(snapshot.repository.published_commit).toBe('a'.repeat(40));expect(snapshot.candidates).toHaveLength(0);
});
