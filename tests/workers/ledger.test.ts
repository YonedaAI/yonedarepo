import {env} from 'cloudflare:workers';
import {evictDurableObject,reset,runInDurableObject} from 'cloudflare:test';
import {afterEach,expect,it} from 'vitest';
import {ledger,object,readObject} from '../../worker/storage';
import {authorized} from '../../worker/auth';
import type {Env} from '../../worker/types';
const bindings=env as unknown as Env;
afterEach(async()=>{await reset()});
async function initialize(){return ledger(bindings,'retry-test',{op:'init',id:'retry-test',name:'Retry client',remote:{namespace:'yoneda-test',name:'retry'},commit:'a'.repeat(40),policy:{version:'retry-v1',suite:'retry-contract-v1',environment:'rust-1.94-evaluator-v1',required_checks:['build','behavior']}})}
it('commits Rust commands, ordered events and outbox in real DO SQLite, and survives eviction',async()=>{
 await initialize();await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry',criteria:[]});
 const pending=await ledger(bindings,'retry-test',{op:'outbox'});expect(pending.jobs.some((j:{kind:string})=>j.kind==='agent')).toBe(true);
 const stub=bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName('retry-test'));await evictDurableObject(stub);
 const snapshot=await ledger(bindings,'retry-test',{op:'snapshot'});expect(snapshot.runs).toHaveLength(1);expect(snapshot.executions).toHaveLength(1);expect(snapshot.seq).toBe(2);expect(snapshot.capabilities?.artifact_reads).toBe(2);
 const events=await ledger(bindings,'retry-test',{op:'events',after:1});expect(events.events.map((e:{seq:number})=>e.seq)).toEqual([2]);
});
it('rolls back failed Rust storage transactions without changing the event sequence',async()=>{
 await initialize();await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry'});
 await expect(ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Duplicate'})).rejects.toThrow();
 const snapshot=await ledger(bindings,'retry-test',{op:'snapshot'});expect(snapshot.seq).toBe(2);expect(snapshot.runs).toHaveLength(1);
});
it('repairs existing execution graph data with the Rust migration in real DO SQLite',async()=>{
 await initialize();await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry'});
 const stub=bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName('retry-test'));
 await runInDurableObject(stub,(_instance,state)=>{
  state.storage.sql.exec("UPDATE nodes SET payload=json_set(payload,'$.data.status','capturing') WHERE json_extract(payload,'$.kind')='execution'");
  state.storage.sql.exec('DELETE FROM schema_migrations WHERE version=3');
 });
 await evictDurableObject(stub);
 const snapshot=await ledger(bindings,'retry-test',{op:'snapshot'});
 const execution=snapshot.executions[0];
 expect(snapshot.nodes.find((n:{id:string})=>n.id===execution.id).data).toEqual(execution);
 expect(snapshot.seq).toBe(2);
});
it('fences duplicate claims and does not trust caller time',async()=>{
 await initialize();await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry'});
 const claim=await ledger(bindings,'retry-test',{op:'claim',job_id:'job:run-test:research',now:1});expect(claim.lease_until).toBeGreaterThan(Date.now());
 await expect(ledger(bindings,'retry-test',{op:'claim',job_id:claim.id})).rejects.toThrow('already running');
});
it('stores content-addressed R2 evidence and repeats the same write safely',async()=>{
 const a=await object(bindings,'evidence');const b=await object(bindings,'evidence');expect(a).toEqual(b);expect(await readObject(bindings,a.digest)).toBe('evidence');
 await expect(readObject(bindings,'../secret')).rejects.toThrow('Invalid object digest');
});
it('fails closed without owner authorization and rejects spoofed Access assertions',async()=>{
 expect(await authorized(new Request('https://yoneda/api/repos'),bindings)).toBe(false);
 expect(await authorized(new Request('https://yoneda/api/repos',{headers:{'cf-access-jwt-assertion':'not-a-jwt'}}),bindings)).toBe(false);
 expect(await authorized(new Request('https://yoneda/api/repos',{headers:{authorization:'Bearer local-test-owner'}}),bindings)).toBe(true);
});
it('only exposes evidence recorded in the authorized repository',async()=>{
 await initialize(); await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry'});
 const claim=await ledger(bindings,'retry-test',{op:'claim',job_id:'job:run-test:research'});
 const evidence=await object(bindings,'Shared research text');
 await ledger(bindings,'retry-test',{op:'publish_artifact',job_id:claim.id,epoch:claim.epoch,id:'research-a',digest:evidence.digest,label:'Research',kind:'research',metadata:{assumptions:[{statement:'Upstream p99 stays within 100 ms',metric:'upstream_p99_ms',limit:100,path:'src/main.rs'}]}});
 const request=(digest:string)=>bindings.SELF.fetch(`https://yoneda/api/repos/retry-test/evidence?digest=${digest}`,{headers:{authorization:'Bearer local-test-owner'}});
 const allowed=await request(evidence.digest); expect(allowed.status).toBe(200); expect(await allowed.json()).toEqual({digest:evidence.digest,content:'Shared research text'});
 const other=await object(bindings,'Unrelated private object'); expect((await request(other.digest)).status).toBe(404);
});
it('detects changed content at an immutable R2 evidence address',async()=>{
 const value=await object(bindings,'Original evidence'); await bindings.OBJECTS.put(`sha256/${value.digest}`,'Changed evidence');
 await expect(readObject(bindings,value.digest)).rejects.toThrow('Evidence digest mismatch');
});
it('uses expiring HttpOnly owner sessions and rejects cross-origin mutation',async()=>{
 await initialize();
 const login=await bindings.SELF.fetch('https://yoneda/api/session',{method:'POST',headers:{authorization:'Bearer local-test-owner'}});
 expect(login.status).toBe(200); const setCookie=login.headers.get('set-cookie') ?? ''; expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).toContain('Secure');
 const cookie=setCookie.split(';')[0];
 const read=await bindings.SELF.fetch('https://yoneda/api/repos/retry-test/snapshot',{headers:{cookie}}); expect(read.status).toBe(200);
 const cross=await bindings.SELF.fetch('https://yoneda/api/repos/retry-test/start_run',{method:'POST',headers:{cookie,origin:'https://untrusted.example','content-type':'application/json'},body:JSON.stringify({id:'bad-run',intent:'cross-origin'})}); expect(cross.status).toBe(401);
 const forged=await bindings.SELF.fetch('https://yoneda/api/repos/retry-test/snapshot',{headers:{cookie:cookie+'0'}}); expect(forged.status).toBe(401);
});

it('reads cannot postpone an existing recovery alarm',async()=>{
 await initialize(); await ledger(bindings,'retry-test',{op:'start_run',id:'run-test',intent:'Safe retry'});
 const stub=bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName('retry-test'));
 const alarm=()=>runInDurableObject(stub,(_instance,state)=>state.storage.getAlarm());
 const before=await alarm(); expect(before).toBeLessThanOrEqual(Date.now()+16000); await ledger(bindings,'retry-test',{op:'snapshot'}); expect(await alarm()).toBe(before);
});
it('failed initialization does not leave a repeating alarm',async()=>{
 await expect(ledger(bindings,'missing-repo',{op:'snapshot'})).rejects.toThrow();
 const stub=bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName('missing-repo'));
 expect(await runInDurableObject(stub,(_instance,state)=>state.storage.getAlarm())).toBeNull();
});

it('refuses old container protocols and evaluator environments before executing a job', async () => {
 const { checkRuntime } = await import('../../worker/runtime');
 expect(() => checkRuntime('ready' as any,{kind:'agent'})).toThrow();
 expect(() => checkRuntime({protocol:2,environment:'old',suites:['retry-contract-v2']},{kind:'evaluate',payload:{policy:{environment:'new',suite:'retry-contract-v2'}}})).toThrow();
 expect(() => checkRuntime({protocol:2,environment:'new',suites:['retry-contract-v2']},{kind:'evaluate',payload:{policy:{environment:'new',suite:'retry-contract-v2'}}})).not.toThrow();
});

it('refuses old ledger read protocols before starting paid explorations', async () => {
 const { checkLedger } = await import('../../worker/runtime');
 expect(() => checkLedger({v:1})).toThrow();
 expect(() => checkLedger({capabilities:{artifact_reads:1}})).toThrow();
 expect(() => checkLedger({capabilities:{artifact_reads:2}})).not.toThrow();
});
