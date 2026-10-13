import {env} from 'cloudflare:workers';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
const bindings=env as unknown as {BOOKINGS:DurableObjectNamespace; BOOKING_STAGE:string};
const feature=bindings.BOOKING_STAGE!=='initial_build';
const fixed=bindings.BOOKING_STAGE==='duplicate_registration_bugfix';
function fixture() { return bindings.BOOKINGS.get(bindings.BOOKINGS.idFromName(crypto.randomUUID())); }
async function register(stub:DurableObjectStub,email:string,key=email,event='workshop') {
  return stub.fetch(`https://fixture/api/events/${event}/registrations`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({name:'Fixture attendee',email,idempotency_key:key})});
}
async function rows(stub:DurableObjectStub) {
  return runInDurableObject(stub,(_instance,state)=>[...state.storage.sql.exec('SELECT id,event_id,email,idempotency_key,status FROM registrations ORDER BY id')]);
}
async function cancel(stub:DurableObjectStub,id:number) {
  return stub.fetch(`https://fixture/api/registrations/${id}/cancel`,{method:'POST'});
}
it('serves an accessible interactive UI and working API without exposing attendee identity',async()=>{
  const stub=fixture();
  const html=await (await stub.fetch('https://fixture/')).text();
  expect(html).toMatch(/<form[^>]+id="registration"/);expect(html).toContain('role="status"');
  const js=await (await stub.fetch('https://fixture/app.mjs')).text();
  expect(js).toContain("addEventListener('submit'");expect(js).toContain('/registrations');
  expect((await stub.fetch('https://fixture/health')).status).toBe(200);
  expect((await register(stub,'private-canary@example.invalid')).status).toBe(201);
  const events=await (await stub.fetch('https://fixture/api/events')).text();
  expect(events).not.toContain('private-canary');
  expect(JSON.parse(events).events.find((e:{id:string})=>e.id==='workshop')).toMatchObject({confirmed:1,capacity:2});
  expect((await rows(stub)).length).toBe(1);
});
it('persists exact SQL registration after Durable Object eviction',async()=>{
  const stub=fixture();const result=await (await register(stub,'persistent@example.invalid')).json() as any;
  await evictDurableObject(stub);
  const observed=await (await stub.fetch(`https://fixture/api/registrations/${result.registration.id}`)).json() as any;
  expect(observed.registration).toMatchObject({id:result.registration.id,status:'confirmed'});
  expect((await rows(stub))[0].email).toBe('persistent@example.invalid');
});
it('rejects malformed requests atomically without writing SQLite',async()=>{
  const stub=fixture();
  expect((await register(stub,'invalid')).status).toBe(400);
  expect((await register(stub,'valid@example.invalid','key','missing')).status).toBe(404);
  expect(await rows(stub)).toEqual([]);
});
it('never overbooks capacity under concurrent requests',async()=>{
  const stub=fixture();
  const results=await Promise.all(Array.from({length:5},(_,i)=>register(stub,`person${i}@example.invalid`)));
  const stored=await rows(stub);
  expect(stored.filter(row=>row.status==='confirmed')).toHaveLength(2);
  if(feature) { expect(results.filter(r=>r.status===201)).toHaveLength(5);expect(stored.filter(row=>row.status==='waitlisted')).toHaveLength(3); }
  else { expect(results.filter(r=>r.status===409)).toHaveLength(3);expect(stored).toHaveLength(2); }
});
it.runIf(feature)('waitlists FIFO and cancellation promotes exactly one oldest waiter',async()=>{
  const stub=fixture();
  const a=await (await register(stub,'a@example.invalid','a','talk')).json() as any;
  const b=await (await register(stub,'b@example.invalid','b','talk')).json() as any;
  const c=await (await register(stub,'c@example.invalid','c','talk')).json() as any;
  expect(b.registration).toMatchObject({status:'waitlisted',position:1});
  expect(c.registration).toMatchObject({status:'waitlisted',position:2});
  expect((await cancel(stub,a.registration.id)).status).toBe(200);
  expect((await rows(stub)).map(row=>row.status)).toEqual(['cancelled','confirmed','waitlisted']);
  await cancel(stub,a.registration.id);
  expect((await rows(stub)).map(row=>row.status)).toEqual(['cancelled','confirmed','waitlisted']);
});
it.runIf(fixed)('replays canonical attendee and request keys without duplicate rows or seats',async()=>{
  const stub=fixture();
  const first=await (await register(stub,'same@example.invalid','one')).json() as any;
  const replay=await register(stub,' SAME@EXAMPLE.INVALID ','two');
  expect(replay.status).toBe(200);expect(((await replay.json()) as any).registration.id).toBe(first.registration.id);
  const keyReplay=await register(stub,'same@example.invalid','one');expect(keyReplay.status).toBe(200);
  expect(await rows(stub)).toHaveLength(1);
  expect((await register(stub,'different@example.invalid','one')).status).toBe(409);
  expect(await rows(stub)).toHaveLength(1);
});
it.runIf(fixed)('deduplicates full-event waitlist retries and permits fresh registration after cancellation',async()=>{
  const stub=fixture();await register(stub,'confirmed@example.invalid','confirmed','talk');
  const waiter=await (await register(stub,'wait@example.invalid','wait','talk')).json() as any;
  const replay=await register(stub,'WAIT@example.invalid','new-key','talk');
  expect(replay.status).toBe(200);expect(((await replay.json()) as any).registration.id).toBe(waiter.registration.id);
  expect(await rows(stub)).toHaveLength(2);
  await cancel(stub,waiter.registration.id);
  expect((await register(stub,'wait@example.invalid','fresh','talk')).status).toBe(201);
  expect((await rows(stub)).filter(row=>row.status==='waitlisted')).toHaveLength(1);
});
