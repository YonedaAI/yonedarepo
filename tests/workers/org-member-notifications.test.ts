import {expect,it,vi}from'vitest';
import {runDurableObjectAlarm}from'cloudflare:test';
import {accountRoute}from'../../cloudflare/worker/accounts';
import {notificationsRoute}from'../../cloudflare/worker/account-notifications';
import {memberNotificationJob}from'../../cloudflare/worker/platform-org-notifications';
import {workspace}from'../../cloudflare/worker/workspace';
import type{Env,Envelope}from'../../cloudflare/worker/types';
import{api,bindings,scoped,signup,usePlatformFixture}from'./repo-fixture';
usePlatformFixture();
async function seed(verified=true){
 const owner={cookie:await signup('notice_owner')};const member={cookie:await signup('notice_member')};const stranger={cookie:await signup('notice_stranger')};
 await api('/orgs',owner,{body:{name:'notice_org'}});
 if(verified){await workspace(scoped,'notice_member',{op:'email_token',purpose:'resend',token_hash:'a'.repeat(64)});await workspace(scoped,'notice_member',{op:'email_verify',token_hash:'a'.repeat(64)});}
 const result=await api('/orgs/notice_org/members',owner,{body:{account:'notice_member',role:'member'}});expect(result.status).toBe(200);
 const pending=await workspace(scoped,'notice_org',{op:'member_notices_pending'});const id=pending.notices[0].id;
 const env={...scoped,EMAIL_FROM:'YonedaRepo <sender@example.com>',EMAIL_CONTACT:'help@example.com',WEB_ORIGIN:'https://yoneda.test',RESEND_API_KEY:{get:async()=> 'synthetic-key'}}as unknown as Env;
 const job={v:1,kind:'org_member_notification',repo_id:'',job_id:'notice',workspace:'notice_org',number:id}as Envelope;
 return {owner,member,stranger,env,job};
}
const inbox=async(cookie:string)=>{
 const r=await accountRoute(new Request('https://yoneda.test/api/auth/notifications',{headers:{cookie}}),scoped);return{status:r?.status,body:await r?.json<any>()};
};
it('delivers to the recipient once with captured verified email and durable unread state',async()=>{
 const s=await seed();const send=vi.fn<typeof fetch>(async()=>Response.json({id:'captured'}));
 await memberNotificationJob(s.env,s.job,send);await memberNotificationJob(s.env,s.job,send);
 expect(send).toHaveBeenCalledTimes(1);const mail=JSON.parse(String(send.mock.calls[0]?.[1]?.body));expect(mail.to).toEqual(['notice_member@example.com']);expect(mail.subject).toContain('notice_org');
 const shown=await inbox(s.member.cookie);expect(shown.status).toBe(200);expect(shown.body.unread).toBe(1);expect(shown.body.items[0].org).toBe('notice_org');expect(JSON.stringify(shown.body)).not.toContain('@');
 expect((await inbox(s.owner.cookie)).body.unread).toBe(0);expect((await inbox(s.stranger.cookie)).body.unread).toBe(0);
 const ack=await accountRoute(new Request('https://yoneda.test/api/auth/notifications',{method:'POST',headers:{cookie:s.member.cookie,'content-type':'application/json'},body:JSON.stringify({through:Date.now(),account:'notice_owner'})}),scoped);expect((await ack?.json<any>()).unread).toBe(0);
 expect((await inbox(s.owner.cookie)).body.items).toEqual([]);
});
it('keeps unverified recipients in-app without sending any email',async()=>{
 const s=await seed(false);const send=vi.fn<typeof fetch>();await memberNotificationJob(s.env,s.job,send);expect(send).not.toHaveBeenCalled();expect((await inbox(s.member.cookie)).body.unread).toBe(1);
});
it('does not notify an existing member again for retries or a role-only change',async()=>{
 const s=await seed();const send=vi.fn<typeof fetch>(async()=>Response.json({id:'captured'}));await memberNotificationJob(s.env,s.job,send);
 for(const role of ['member','owner'])expect((await api('/orgs/notice_org/members',s.owner,{body:{account:'notice_member',role}})).status).toBe(200);
 expect((await workspace(scoped,'notice_org',{op:'member_notices_pending'})).notices).toEqual([]);expect(send).toHaveBeenCalledTimes(1);
});
it('saved membership and in-app delivery survive a mail failure, with pending recovery',async()=>{
 const s=await seed();const send=vi.fn<typeof fetch>(async()=>new Response('',{status:503}));expect(await memberNotificationJob(s.env,s.job,send)).toEqual({retry:60});
 expect((await api('/orgs/notice_org',s.member)).status).toBe(200);expect((await inbox(s.member.cookie)).body.unread).toBe(1);expect((await workspace(scoped,'notice_org',{op:'member_notices_pending'})).notices).toHaveLength(1);
});
it('removed membership cancels an undelivered notice and rejects anonymous inbox access',async()=>{
 const s=await seed();await api('/orgs/notice_org/members/notice_member',s.owner,{method:'DELETE'});const send=vi.fn<typeof fetch>();await memberNotificationJob(s.env,s.job,send);expect(send).not.toHaveBeenCalled();expect((await inbox(s.member.cookie)).body.unread).toBe(0);expect((await inbox('')).status).toBe(401);
});
it('the real account alarm dispatches committed notices and leaves recovery pending',async()=>{
 await seed(false);const stub=bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:notice_org'));expect(await runDurableObjectAlarm(stub)).toBe(true);expect((await workspace(scoped,'notice_org',{op:'member_notices_pending'})).notices).toHaveLength(1);
});

it('an uncertain completion retries the same provider key without duplicating the recipient inbox',async()=>{
 const s=await seed();let fail=true;
 const wrapped={...s.env,WORKSPACES:{idFromName:(name:string)=>bindings.WORKSPACES.idFromName(name),get:(id:DurableObjectId)=>{
  const stub=bindings.WORKSPACES.get(id);return{fetch:async(input:RequestInfo,init?:RequestInit)=>{
   const command=typeof init?.body==='string'?JSON.parse(init.body):{};
   if(command.op==='member_notice_finish'&&fail){fail=false;throw new Error('Synthetic acknowledgement loss');}
   return stub.fetch(input,init);
  }};
 }}}as unknown as Env;
 const keys:string[]=[];const delivered=new Set<string>();const send=vi.fn<typeof fetch>(async(_url,init)=>{
  const key=new Headers(init?.headers).get('idempotency-key')??'';keys.push(key);delivered.add(key);return Response.json({id:'captured'});
 });
 await expect(memberNotificationJob(wrapped,s.job,send)).rejects.toThrow('Synthetic acknowledgement loss');
 const stub=bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:notice_org'));
 const {runInDurableObject}=await import('cloudflare:test');
 await runInDurableObject(stub,async(_instance,state)=>{state.storage.sql.exec('UPDATE org_member_notices SET lease_until=0');});
 await memberNotificationJob(s.env,s.job,send);
 expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(1);expect(delivered.size).toBe(1);expect((await inbox(s.member.cookie)).body.items).toHaveLength(1);
});

it('inbox failures do not expose internal account or storage details',async()=>{
 const result=await notificationsRoute(new Request('https://yoneda.test/api/auth/notifications'),scoped,async()=>{throw new Error('Synthetic private storage detail');});
 expect(result.status).toBe(503);const body=await result.json<any>();expect(body.error.message).toBe('Notifications are unavailable. Try again.');expect(JSON.stringify(body)).not.toContain('private storage');
});

it('repeated member puts and role edits never postpone an earlier recovery alarm',async()=>{
 const s=await seed(false);
 const stub=bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:notice_org'));
 const {runInDurableObject}=await import('cloudflare:test');
 const deadline=Date.now()+200;
 await runInDurableObject(stub,async(_instance,state)=>{await state.storage.setAlarm(deadline);});
 for(const role of ['member','owner','member']){
  expect((await api('/orgs/notice_org/members',s.owner,{body:{account:'notice_member',role}})).status).toBe(200);
  expect(await runInDurableObject(stub,async(_instance,state)=>state.storage.getAlarm())).toBe(deadline);
 }
});

it('held old delivery cannot disclose an organization to a recreated account name',async()=>{
 const s=await seed();let replace=true;
 const wrapped={...s.env,WORKSPACES:{idFromName:(name:string)=>bindings.WORKSPACES.idFromName(name),get:(id:DurableObjectId)=>{
  const stub=bindings.WORKSPACES.get(id);return{fetch:async(input:RequestInfo,init?:RequestInit)=>{
   const command=typeof init?.body==='string'?JSON.parse(init.body):{};
   if(command.op==='notification_put'&&replace){
    replace=false;
    await api('/orgs/notice_org/members/notice_member',s.owner,{method:'DELETE'});
    await workspace(scoped,'notice_member',{op:'account_close'});
    await workspace(scoped,'notice_member',{op:'signup',username:'notice_member',password:'replacement password',salt:'02'.repeat(16),recovery_hash:'c'.repeat(64),session_hash:'d'.repeat(64),email:'replacement@example.com'});
   }
   return stub.fetch(input,init);
  }};
 }}}as unknown as Env;
 const send=vi.fn<typeof fetch>();await memberNotificationJob(wrapped,s.job,send);
 expect((await workspace(scoped,'notice_member',{op:'notifications_list'})).items).toEqual([]);
 expect((await workspace(scoped,'notice_member',{op:'account_summary'})).orgs).toEqual([]);
 expect(send).not.toHaveBeenCalled();
 expect((await api('/orgs/notice_org/members',s.owner,{body:{account:'notice_member',role:'member'}})).status).toBe(200);
 const fresh=(await workspace(scoped,'notice_org',{op:'member_notices_pending'})).notices[0];
 await memberNotificationJob(s.env,{...s.job,number:fresh.id},send);
 expect((await workspace(scoped,'notice_member',{op:'notifications_list'})).items).toHaveLength(1);
 expect(send).not.toHaveBeenCalled();
});


it('a held synchronous membership hint cannot leak to a recreated account name',async()=>{
 const s=await seed(false);await api('/orgs/notice_org/members/notice_member',s.owner,{method:'DELETE'});let replace=true;
 const wrapped={...scoped,WORKSPACES:{idFromName:(name:string)=>bindings.WORKSPACES.idFromName(name),get:(id:DurableObjectId)=>{
  const stub=bindings.WORKSPACES.get(id);return{fetch:async(input:RequestInfo,init?:RequestInit)=>{
   const command=typeof init?.body==='string'?JSON.parse(init.body):{};
   if(command.op==='notification_hint'&&replace){
    replace=false;await api('/orgs/notice_org/members/notice_member',s.owner,{method:'DELETE'});
    await workspace(scoped,'notice_member',{op:'account_close'});
    await workspace(scoped,'notice_member',{op:'signup',username:'notice_member',password:'replacement password',salt:'02'.repeat(16),recovery_hash:'c'.repeat(64),session_hash:'d'.repeat(64)});
   }
   return stub.fetch(input,init);
  }};
 }}}as unknown as Env;
 expect((await api('/orgs/notice_org/members',s.owner,{body:{account:'notice_member',role:'member'}},wrapped)).status).toBe(200);
 expect(replace).toBe(false);
 expect((await workspace(scoped,'notice_member',{op:'account_summary'})).orgs).toEqual([]);
});
