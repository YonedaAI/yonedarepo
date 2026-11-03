// Functional local workerd evidence. Two actual private SQLite copy objects, R2 and the
// source authority are real; workerd has one location, so this does not prove geography.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { purgeObjects } from '../../cloudflare/worker/repo-admin';
import { fenceReadCopies, keepNearby } from '../../cloudflare/worker/repo-locality';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on={...scoped,AUTOMATIC_LOCALITY:'on'} as Env;
const CONTENT='A local file copy\n';
async function setup(name:string){
 const cookie=await signup(name);
 const made=await api('/repos',{cookie},{body:{name,files:[file('a.txt',CONTENT)],author,policy:{approvals:0,required_checks:[]}}});
 expect(made.status,JSON.stringify(made.body)).toBe(200);await drainObjects();
 const tree=await api(`/repos/${made.body.id}/tree`,{cookie});
 return {cookie,id:made.body.id as string,blob:tree.body.entries.find((e:any)=>e.name==='a.txt').id as string};
}
async function read(repo:string,cookie:string,continent='EU',target=on){
 const res=await platformFetch(new Request(`https://yoneda/api/v1/repos/${repo}/blob?path=a.txt`,{headers:{cookie},cf:{continent}}),target);
 return {status:res.status,body:await res.json<any>()};
}
async function copy(repo:string,region:string,body:object){
 const ns=bindings.READ_COPIES!;
 const result=await ns.get(ns.idFromName(`${repo}:read:${region}`)).fetch('https://read-copy/',{method:'POST',body:JSON.stringify({...body,repo,...(region!=='registry'&&{region}),_system:'local-copy'})});
 return result.json<any>();
}

it('an existing repository acquires separate US and European copies and reads a warm copy without R2',async()=>{
 const r=await setup('local_copy_existing');
 expect((await read(r.id,r.cookie)).body.content).toBe(CONTENT);
 expect((await copy(r.id,'weur',{op:'copy_get',epoch:1,id:r.blob,kind:'blob'})).object.data_b64).toBe(btoa(CONTENT));
 expect((await read(r.id,r.cookie,'NA')).status).toBe(200);
 expect((await copy(r.id,'enam',{op:'copy_get',epoch:1,id:r.blob,kind:'blob'})).object.data_b64).toBe(btoa(CONTENT));
 const original=bindings.OBJECTS;
 const objects=new Proxy(original,{get(t,k){if(k==='get')return()=>Promise.reject(new Error('simulated unavailable origin'));const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 await caches.default.delete(new Request(`https://objects.yoneda.internal/${r.id}/${r.blob}`));
 expect((await read(r.id,r.cookie,'EU',{...on,OBJECTS:objects})).body.content).toBe(CONTENT);
 expect((await api(`/repos/${r.id}/refs`,{cookie:r.cookie})).status).toBe(200);
});

it('a private warm copy still requires source-authority membership on every request',async()=>{
 const r=await setup('local_copy_auth');expect((await read(r.id,r.cookie)).status).toBe(200);
 const stranger=await signup('local_copy_stranger');
 expect((await read(r.id,stranger)).status).toBe(404);
 expect((await read(r.id,'')).status).toBe(404);
 expect((await copy(r.id,'weur',{op:'copy_get',epoch:1,id:r.blob,kind:'blob'})).object).not.toBeNull();
});

it('quarantine purge fences enrolled copies and rejects a fill captured before the purge',async()=>{
 const r=await setup('local_copy_quarantine');expect((await read(r.id,r.cookie)).status).toBe(200);
 const held=await api(`/repos/${r.id}/quarantine`,{cookie:r.cookie},{body:{kind:'blob',path:'a.txt',reason:'simulated sensitive fixture',retain_days:30}},on);
 expect(held.status,JSON.stringify(held.body)).toBe(200);
 expect((await read(r.id,r.cookie)).status).toBe(451);
 const purged=await api(`/repos/${r.id}/quarantine/${held.body.record.id}/purge`,{cookie:r.cookie},{body:{confirm:r.blob}},on);
 expect(purged.status,JSON.stringify(purged.body)).toBe(200);
 const late=await copy(r.id,'weur',{op:'copy_put',epoch:1,object:{id:r.blob,kind:'blob',data_b64:btoa(CONTENT)}});
 expect(late.error.code).toBe('COPY_FENCED');
 const now=await copy(r.id,'registry',{op:'registry_permit',region:'weur'});
 expect(now.blocked).toContain(r.blob);
 expect((await copy(r.id,'weur',{op:'copy_get',epoch:now.epoch,id:r.blob,kind:'blob'})).object).toBeNull();
});

it('repository purge seals every enrolled copy even with the read switch off',async()=>{
 const r=await setup('local_copy_delete');await read(r.id,r.cookie);await read(r.id,r.cookie,'NA');
 expect((await api(`/repos/${r.id}?confirm=local_copy_delete`,{cookie:r.cookie},{method:'DELETE'},on)).status).toBe(200);
 await purgeObjects({...on,AUTOMATIC_LOCALITY:'off'},r.id,true);
 for(const region of ['enam','weur']){
  const late=await copy(r.id,region,{op:'copy_put',epoch:1,object:{id:r.blob,kind:'blob',data_b64:btoa(CONTENT)}});
  expect(late.error.code).toBe('COPY_FENCED');
 }
 expect((await copy(r.id,'registry',{op:'registry_permit',region:'weur'})).error.code).toBe('COPY_FENCED');
});

it('a failed regional fence fails cleanup, rather than acknowledging an incomplete purge',async()=>{
 const r=await setup('local_copy_retry');await read(r.id,r.cookie);
 const ns=bindings.READ_COPIES!;
 const down={idFromName:(n:string)=>ns.idFromName(n),get:()=>({fetch:async()=>{throw new Error('simulated unavailable copy');}})} as unknown as DurableObjectNamespace;
 await expect(fenceReadCopies({...on,READ_COPIES:down},r.id,[r.blob])).rejects.toThrow('simulated unavailable copy');
 await fenceReadCopies(on,r.id,[r.blob]);
 const permit=await copy(r.id,'registry',{op:'registry_permit',region:'weur'});
 expect((await copy(r.id,'weur',{op:'copy_get',epoch:permit.epoch,id:r.blob,kind:'blob'})).object).toBeNull();
});

it('off or without a trusted geographic signal, ordinary reads touch no copy store',async()=>{
 const r=await setup('local_copy_off');let calls=0;const ns=bindings.READ_COPIES!;
 const watched={idFromName:(n:string)=>ns.idFromName(n),get:(id:DurableObjectId,options?:DurableObjectNamespaceGetDurableObjectOptions)=>{calls++;return ns.get(id,options);}} as DurableObjectNamespace;
 expect((await read(r.id,r.cookie,'EU',{...on,AUTOMATIC_LOCALITY:'off',READ_COPIES:watched})).status).toBe(200);
 expect((await read(r.id,r.cookie,'T1',{...on,READ_COPIES:watched})).status).toBe(200);
 expect(calls).toBe(0);
});

it('an unavailable copy falls back to the authoritative file read',async()=>{
 const r=await setup('local_copy_fallback');const ns=bindings.READ_COPIES!;
 const down={idFromName:(n:string)=>ns.idFromName(n),get:()=>({fetch:async()=>{throw new Error('simulated unavailable copy');}})} as unknown as DurableObjectNamespace;
 expect((await read(r.id,r.cookie,'EU',{...on,READ_COPIES:down})).body.content).toBe(CONTENT);
});

it('a fill paused after enrollment cannot publish into a region first created by its purge',async()=>{
 const r=await setup('local_copy_late');const ns=bindings.READ_COPIES!;
 let reached!:()=>void;let release!:()=>void;
 const arrived=new Promise<void>(r=>{reached=r;});const gate=new Promise<void>(r=>{release=r;});
 const delayed={idFromName:(n:string)=>ns.idFromName(n),get:(id:DurableObjectId,options?:DurableObjectNamespaceGetDurableObjectOptions)=>{
   const stub=ns.get(id,options);return {fetch:async(url:string,init:RequestInit)=>{
    if(JSON.parse(String(init.body)).op==='copy_put'){reached();await gate;}
    return stub.fetch(url,init);
   }};
 }} as unknown as DurableObjectNamespace;
 const env={...on,READ_COPIES:delayed};
 const filling=inScope({env,req:new Request('https://yoneda/api/v1/',{cf:{continent:'EU'}})},()=>keepNearby(env,r.id,{id:r.blob,kind:'blob',data_b64:btoa(CONTENT)}));
 await arrived;
 try{await fenceReadCopies(on,r.id,[r.blob]);}finally{release();}
 await filling;
 const permit=await copy(r.id,'registry',{op:'registry_permit',region:'weur'});
 expect((await copy(r.id,'weur',{op:'copy_get',epoch:permit.epoch,id:r.blob,kind:'blob'})).object).toBeNull();
});

it('revoking an agent token refuses its warm-copy read',async()=>{
 const r=await setup('local_copy_revoke');
 const made=await api(`/repos/${r.id}/tokens`,{cookie:r.cookie},{body:{name:'reader',scopes:['read']}},on);
 expect(made.status).toBe(200);
 const ask=()=>platformFetch(new Request(`https://yoneda/api/v1/repos/${r.id}/blob?path=a.txt`,{headers:{authorization:`Bearer ${made.body.token}`},cf:{continent:'EU'}}),on);
 expect((await ask()).status).toBe(200);
 expect((await api(`/repos/${r.id}/tokens/reader`,{cookie:r.cookie},{method:'DELETE'},on)).status).toBe(200);
 expect((await ask()).status).toBe(401);
});
