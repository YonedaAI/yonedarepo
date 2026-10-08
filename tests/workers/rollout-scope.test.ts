import { expect, it } from 'vitest';
import { ledger } from '../../worker/storage';
import type { Env } from '../../worker/types';
it('fails closed before private reads or mutations against an older unscoped Repo DO',async()=>{
 const commands:any[]=[];
 const env={REPOSITORIES:{idFromName:(id:string)=>id,get:()=>({fetch:async(_url:string,options:any)=>{const c=JSON.parse(options.body);commands.push(c);return Response.json({capabilities:{artifact_reads:2},repository:{id:'legacy',workspace:'alice'},nodes:[{label:'private context'}]});}})}} as unknown as Env;
 for(const op of ['snapshot','start_run','context_publish']) {
  await expect(ledger(env,'legacy',{op,_workspace:'alice',intent:'build'})).rejects.toThrow('updating');
 }
 expect(commands.every(c=>c.op==='snapshot')).toBe(true);
});
it('checks returned workspace ownership even when a Repo DO advertises scope capability',async()=>{
 const commands:any[]=[];
 const env={REPOSITORIES:{idFromName:(id:string)=>id,get:()=>({fetch:async(_url:string,options:any)=>{const c=JSON.parse(options.body);commands.push(c);return Response.json({capabilities:{workspace_authority:1},repository:{workspace:'bob'}});}})}} as unknown as Env;
 await expect(ledger(env,'private',{op:'start_run',_workspace:'alice'})).rejects.toThrow('another workspace');
 expect(commands.map(c=>c.op)).toEqual(['snapshot']);
});
it('blocks public HTTP reads and mutations before an older DO sees untrusted commands',async()=>{
 const {env}=await import('cloudflare:workers');const {workspace}=await import('../../worker/workspace');const {sha}=await import('../../worker/storage');const {fetchRequest}=await import('../../worker/routes');
 const bindings=env as unknown as Env;const token='a'.repeat(64);await workspace(bindings,'rollout_user',{op:'signup',username:'rollout_user',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:await sha(token)});
 const commands:any[]=[];const old={...bindings,REPOSITORIES:{idFromName:(id:string)=>id,get:()=>({fetch:async(_url:string,options:any)=>{const c=JSON.parse(options.body);commands.push(c);return Response.json({capabilities:{artifact_reads:2},repository:{id:'legacy'},nodes:[{label:'private context'}]});}})}} as unknown as Env;
 for(const method of ['GET','POST']) {
  const req=new Request(`https://yoneda/api/repos/legacy/${method==='GET'?'snapshot':'cancel_run'}`,{method,headers:{cookie:`yoneda_account=rollout_user.${token}`,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify({run_id:'private-run'})}:{})});
  const res=await fetchRequest(req,old);expect(res.status).toBe(409);expect(await res.text()).not.toContain('private context');
 }
 expect(commands.every(c=>c.op==='snapshot')).toBe(true);
});
