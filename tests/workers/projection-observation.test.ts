import{env}from'cloudflare:workers';
import{runInDurableObject}from'cloudflare:test';
import{expect,it}from'vitest';
import{rememberProjection}from'../../cloudflare/worker/repo-land-combiner';
import type{Env}from'../../cloudflare/worker/types';
it('keeps old projector records readable and carries optional metadata through actual storage',async()=>{
 const bindings=env as unknown as Env;const ns=bindings.LAND_COMBINERS as DurableObjectNamespace;
 const stub=ns.get(ns.idFromName('observation-storage-contract'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const trace={requestId:'request-1234',span:'parent-1234',origin:'POST /api/v1/repos/:repo/land',source:'rest',traffic:'ordinary',selected:true};
  await rememberProjection(state.storage,{OPERATION_METRICS:'on'}as Env,'r0123456789abcdef0123',trace);
  expect(await state.storage.get('projector')).toBe('r0123456789abcdef0123');
  const saved=await state.storage.get(['projector','projection_observation']);expect(saved.get('projection_observation')).toEqual(trace);
  await rememberProjection(state.storage,{}as Env,'r0123456789abcdef0124');expect(await state.storage.get('projector')).toBe('r0123456789abcdef0124');
 });
});
