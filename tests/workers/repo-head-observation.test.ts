import {expect,it}from'vitest';
import{refreshHead}from'../../cloudflare/worker/repo-head';
import{observeRequest}from'../../cloudflare/worker/operation-observation';
import{inScope}from'../../cloudflare/worker/request-scope';
import type{Env}from'../../cloudflare/worker/types';
it('carries the initiating request into head-cache refresh RPC',async()=>{
 const seen:unknown[][]=[];const stub={head:()=>{},refresh:async(...args:unknown[])=>{seen.push(args);}};
 const env={OPERATION_METRICS:'on',OPERATION_DETAIL_EVERY:'1',REQUEST_IDS:'on',LAND_COMBINERS:{idFromName:(s:string)=>s,get:()=>stub}}as unknown as Env;
 const req=new Request('https://site.test/api/v1/repos/r0123456789abcdef0123/land');
 await inScope({env,req},()=>observeRequest(env,req,async()=>{await refreshHead(env,'r0123456789abcdef0123');return new Response();}));
 expect(seen[0][2]).toMatchObject({origin:'GET /api/v1/repos/:repo/land',source:'rest',selected:true});
});
