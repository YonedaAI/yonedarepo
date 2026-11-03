import{expect,it,vi}from'vitest';import{runInDurableObject}from'cloudflare:test';
import{accountRoute}from'../../cloudflare/worker/accounts';import{memberNotificationJob}from'../../cloudflare/worker/platform-org-notifications';import{workspace}from'../../cloudflare/worker/workspace';import type{Env,Envelope}from'../../cloudflare/worker/types';import{api,bindings,scoped,signup,usePlatformFixture}from'./repo-fixture';
usePlatformFixture();
const inbox=(cookie:string,method='GET',id='',headers:Record<string,string>={})=>accountRoute(new Request('https://yoneda.test/api/auth/notifications'+(id?'/'+encodeURIComponent(id):''),{method,headers:{cookie,...headers}}),scoped);
async function seed(verified=false){const owner={cookie:await signup('dismiss_owner')};const member={cookie:await signup('dismiss_member')};const other={cookie:await signup('dismiss_other')};await api('/orgs',owner,{body:{name:'dismiss_org'}});if(verified){await workspace(scoped,'dismiss_member',{op:'email_token',purpose:'resend',token_hash:'a'.repeat(64)});await workspace(scoped,'dismiss_member',{op:'email_verify',token_hash:'a'.repeat(64)});}await api('/orgs/dismiss_org/members',owner,{body:{account:'dismiss_member',role:'member'}});const id=(await workspace(scoped,'dismiss_org',{op:'member_notices_pending'})).notices[0].id;const job={v:1,kind:'org_member_notification',repo_id:'',job_id:'dismiss',workspace:'dismiss_org',number:id}as Envelope;return{owner,member,other,job};}
const body=async(response:Promise<Response|null>)=>(await response)?.json<any>();
it('dismisses only the current cookie account and refuses anonymous, PAT and cross-origin requests',async()=>{
 const s=await seed();await memberNotificationJob(scoped,s.job);const shown=await body(inbox(s.member.cookie));const id=shown.items[0].id;
 expect((await inbox(s.other.cookie,'DELETE',id))?.status).toBe(200);expect((await body(inbox(s.member.cookie))).unread).toBe(1);
 expect((await inbox('','DELETE',id))?.status).toBe(401);
 const token=await api('/tokens',s.member,{body:{name:'dismiss-pat',scopes:['repo:read'],expires_days:1}});expect(token.status).toBe(200);
 expect((await inbox('','DELETE',id,{authorization:`Bearer ${token.body.token}`}))?.status).toBe(401);
 expect((await inbox(s.member.cookie,'DELETE',id,{origin:'https://elsewhere.invalid'}))?.status).toBe(401);
 expect((await inbox(s.member.cookie,'DELETE','bad/id'))?.status).toBe(400);
 expect((await inbox(s.member.cookie,'DELETE','acme:9999999999999999999'))?.status).toBe(400);
 expect((await inbox(s.member.cookie,'DELETE',id))?.status).toBe(200);expect((await body(inbox(s.member.cookie))).items).toEqual([]);
 expect((await inbox(s.member.cookie,'DELETE',id))?.status).toBe(200);expect((await inbox(s.member.cookie,'DELETE','unknown:999'))?.status).toBe(200);
 expect((await api('/orgs/dismiss_org',s.member)).status).toBe(200);
});
it('clear and queue acknowledgement loss never resurrect the notice or change mail deduplication',async()=>{
 const s=await seed(true);let fail=true;const env={...scoped,EMAIL_FROM:'YonedaRepo <sender@example.com>',EMAIL_CONTACT:'help@example.com',WEB_ORIGIN:'https://yoneda.test',RESEND_API_KEY:{get:async()=> 'synthetic-key'}}as unknown as Env;
 const wrapped={...env,WORKSPACES:{idFromName:(n:string)=>bindings.WORKSPACES.idFromName(n),get:(id:DurableObjectId)=>{const stub=bindings.WORKSPACES.get(id);return{fetch:async(input:RequestInfo,init?:RequestInit)=>{const c=typeof init?.body==='string'?JSON.parse(init.body):{};if(c.op==='member_notice_finish'&&fail){fail=false;throw new Error('Synthetic acknowledgement loss');}return stub.fetch(input,init);}};}}}as unknown as Env;
 const keys:string[]=[];const deliveries=new Set<string>();const send=vi.fn<typeof fetch>(async(_url,init)=>{const key=new Headers(init?.headers).get('idempotency-key')??'';keys.push(key);deliveries.add(key);return Response.json({id:'captured'});});
 await expect(memberNotificationJob(wrapped,s.job,send)).rejects.toThrow('Synthetic acknowledgement loss');
 expect((await inbox(s.member.cookie,'DELETE'))?.status).toBe(200);expect((await body(inbox(s.member.cookie))).unread).toBe(0);
 const stub=bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:dismiss_org'));await runInDurableObject(stub,async(_instance,state)=>{state.storage.sql.exec('UPDATE org_member_notices SET lease_until=0');});
 await memberNotificationJob(env,s.job,send);expect(keys).toHaveLength(2);expect(deliveries.size).toBe(1);expect((await body(inbox(s.member.cookie))).items).toEqual([]);
 expect((await api('/orgs/dismiss_org',s.member)).status).toBe(200);expect((await workspace(scoped,'dismiss_member',{op:'account_summary'})).orgs).toContain('dismiss_org');
 expect((await workspace(scoped,'dismiss_org',{op:'member_notices_pending'})).notices).toEqual([]);
});
it('a new delivery after clear remains visible, including an already-read notification',async()=>{
 const s=await seed();await memberNotificationJob(scoped,s.job);await inbox(s.member.cookie,'DELETE');
 await api('/orgs',s.owner,{body:{name:'later_org'}});await api('/orgs/later_org/members',s.owner,{body:{account:'dismiss_member',role:'member'}});const id=(await workspace(scoped,'later_org',{op:'member_notices_pending'})).notices[0].id;await memberNotificationJob(scoped,{...s.job,workspace:'later_org',number:id});
 const shown=await body(inbox(s.member.cookie));expect(shown.items).toHaveLength(1);expect(shown.items[0].org).toBe('later_org');
 const ack=new Request('https://yoneda.test/api/auth/notifications',{method:'POST',headers:{cookie:s.member.cookie,'content-type':'application/json'},body:JSON.stringify({through:Date.now()})});expect((await accountRoute(ack,scoped))?.status).toBe(200);expect((await body(inbox(s.member.cookie))).unread).toBe(0);
 await inbox(s.member.cookie,'DELETE',shown.items[0].id);expect((await body(inbox(s.member.cookie))).items).toEqual([]);
});

it.each(['GET','POST','DELETE'])('an old cookie request cannot %s a recreated account inbox',async(method)=>{
 const s=await seed();await memberNotificationJob(scoped,s.job);let replace=true;
 const wrapped={...scoped,WORKSPACES:{idFromName:(n:string)=>bindings.WORKSPACES.idFromName(n),get:(id:DurableObjectId)=>{const stub=bindings.WORKSPACES.get(id);return{fetch:async(input:RequestInfo,init?:RequestInit)=>{
  const c=typeof init?.body==='string'?JSON.parse(init.body):{};
  if(['notifications_list','notifications_read','notifications_clear'].includes(c.op)&&replace){replace=false;
   await workspace(scoped,'dismiss_member',{op:'account_close'});
   await workspace(scoped,'dismiss_member',{op:'signup',username:'dismiss_member',password:'replacement password',salt:'02'.repeat(16),recovery_hash:'c'.repeat(64),session_hash:'d'.repeat(64)});
   const identity=await workspace(scoped,'dismiss_member',{op:'notification_identity'});
   await workspace(scoped,'dismiss_member',{op:'notification_put',org:'private_new',id:1,role:'member',at:Date.now(),incarnation:identity.incarnation});
  }
  return stub.fetch(input,init);
 }};}}}as unknown as Env;
 const req=new Request('https://yoneda.test/api/auth/notifications',{method,headers:{cookie:s.member.cookie,'content-type':'application/json'},body:method==='POST'?JSON.stringify({through:Date.now()+1000}):undefined});
 const response=await accountRoute(req,wrapped);expect(response?.status).toBe(401);
 const fresh=await workspace(scoped,'dismiss_member',{op:'notifications_list'});expect(fresh.items).toHaveLength(1);expect(fresh.items[0].org).toBe('private_new');expect(fresh.unread).toBe(1);
});
