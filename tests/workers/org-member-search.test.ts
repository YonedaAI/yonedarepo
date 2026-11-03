// Real account/org authorities and D1 projections; no provider or directory mocks.
import { expect, it } from 'vitest';
import { recordAccount } from '../../cloudflare/worker/account-index';
import { claims, emailKey } from '../../cloudflare/worker/oauth-identity';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, scoped, signup, usePlatformFixture } from './repo-fixture';
import { applySchema } from './repo-fixture-schema';

usePlatformFixture();
const password = 'long platform test password';
async function legacy(account: string, handle?: string) {
  await workspace(scoped, account, { op: 'signup', username: account, password, salt: '01'.repeat(16), session_hash: 'a'.repeat(64), recovery_hash: 'b'.repeat(64) });
  if (handle) {
    await workspace(scoped, handle, { op: 'handle_reserve', handle, account });
    await workspace(scoped, account, { op: 'handle_set', handle });
    await bindings.INDEX.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind(account, handle).run();
  }
}
const search = (org: string, q: string, cookie: string, target = scoped) => api(`/orgs/${org}/member-candidates?${new URLSearchParams({q})}`, {cookie}, {}, target);

it('resolves new email accounts, legacy canonical identifiers and public aliases to personal members', async () => {
  const cookie = await signup('picker_owner');
  await api('/orgs', {cookie}, {body:{name:'picker_org'}});
  await signup('picker_new');
  await legacy('legacy.member@example.com', 'picker_alias');
  const found = await search('picker_org', 'picker_new@example.com', cookie);
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(found.body.candidates).toEqual([{identifier:'picker_new@example.com',handle:'picker_new',member:false}]);
  for (const identifier of ['picker_new@example.com', '@picker_new', 'legacy.member@example.com', '@picker_alias']) {
    const added = await api('/orgs/picker_org/members', {cookie}, {body:{account:identifier,role:'member'}});
    expect(added.status, JSON.stringify(added.body)).toBe(200);
  }
  const org = await api('/orgs/picker_org', {cookie});
  expect(org.body.members.map((m:any)=>m.account).sort()).toEqual(['legacy.member@example.com','picker_new','picker_owner']);
  expect((await search('picker_org', '@picker_alias', cookie)).body.candidates).toEqual([{identifier:'picker_alias',handle:'picker_alias',member:true}]);
  expect((await search('picker_org', 'picker_new@example.com', cookie)).body.candidates[0].member).toBe(true);
});

it('authorizes the actual owner before looking up any candidate, including POST member checks', async () => {
  const owner = await signup('search_owner');
  const member = await signup('search_member');
  const outsider = await signup('search_outsider');
  await api('/orgs', {cookie:owner}, {body:{name:'search_org'}});
  await api('/orgs/search_org/members', {cookie:owner}, {body:{account:'search_member',role:'member'}});
  const seen:string[]=[];
  const ns=scoped.WORKSPACES;
  const WORKSPACES={idFromName:(name:string)=>ns.idFromName(name),get:(id:DurableObjectId)=>({fetch:(url:string,init:RequestInit)=>{const c=JSON.parse(String(init.body));seen.push(c.op);return ns.get(id).fetch(url,init);}})} as unknown as DurableObjectNamespace;
  const env={...scoped,WORKSPACES};
  for(const cookie of [member,outsider]){
    for(const q of ['picker_new@example.com','@picker_alias']){
      seen.length=0;
      expect((await search('search_org',q,cookie,env)).status).toBe(403);
      expect(seen.some(op=>['account_exists','handle_lookup','identity_claim_get'].includes(op))).toBe(false);
    }
    seen.length=0;
    expect((await api('/orgs/search_org/members',{cookie},{body:{account:'unknown@example.com',role:'member'}},env)).status).toBe(403);
    expect(seen).not.toContain('account_exists');
  }
  expect((await search('search_org','picker', '',env)).status).toBe(401);
});

it('bounds literal public handle search and refuses stale, organization or stale email claims', async () => {
  const cookie=await signup('privacy_owner');
  await api('/orgs',{cookie},{body:{name:'privacy_org'}});
  for(let n=0;n<12;n++){
    const name=`picker_${n.toString().padStart(2,'0')}`;
    await legacy(name);
    await recordAccount(scoped,name,'email',Date.now());
  }
  await legacy('private.address@example.com','picker_private');
  await legacy('stale.address@example.com','picker_stale');
  await workspace(scoped,'stale.address@example.com',{op:'handle_set',handle:'different_handle'});
  await claims(scoped,await emailKey('old.address@example.com'),{op:'identity_claim',account:'picker_00'});
  await api('/orgs',{cookie},{body:{name:'picker_org'}});
  await bindings.INDEX.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind('picker_org','picker_org').run();
  const results=await search('privacy_org','@PICKER_',cookie);
  expect(results.status,JSON.stringify(results.body)).toBe(200);
  expect(results.body.candidates).toHaveLength(10);
  expect(JSON.stringify(results.body)).not.toContain('@example.com');
  expect(results.body.candidates.every((c:any)=>c.identifier===c.handle&&c.handle.startsWith('picker_'))).toBe(true);
  expect((await search('privacy_org','picker_private',cookie)).body.candidates).toEqual([{identifier:'picker_private',handle:'picker_private',member:false}]);
  for(const q of ['pi','picker%','private.address@','picker_stale','picker_org','old.address@example.com']) expect((await search('privacy_org',q,cookie)).body.candidates,q).toEqual([]);
  for(const account of ['picker_stale','picker_org','old.address@example.com']) expect((await api('/orgs/privacy_org/members',{cookie},{body:{account,role:'member'}})).status).toBe(404);
  expect((await search('privacy_org','x'.repeat(255),cookie)).status).toBe(400);
});

it('adds a new handle-named account by its exact email instead of creating an email member id', async () => {
  const cookie=await signup('email_inviter');
  await signup('email_invited');
  await api('/orgs',{cookie},{body:{name:'email_invite'}});
  const added=await api('/orgs/email_invite/members',{cookie},{body:{account:' Email_Invited@Example.com ',role:'member'}});
  expect(added.status,JSON.stringify(added.body)).toBe(200);
  expect((await api('/orgs/email_invite',{cookie})).body.members.map((m:any)=>m.account)).toContain('email_invited');
});

it('rejects deleted account aliases and verifies provider email claims against the live identity', async () => {
  const cookie=await signup('claim_owner');
  await api('/orgs',{cookie},{body:{name:'claim_org'}});
  await legacy('deleted.person@example.com','deleted_public');
  await workspace(scoped,'deleted.person@example.com',{op:'account_close'});
  expect((await search('claim_org','deleted_public',cookie)).body.candidates).toEqual([]);
  expect((await api('/orgs/claim_org/members',{cookie},{body:{account:'deleted_public',role:'member'}})).status).toBe(404);
  await legacy('provider_person');
  await workspace(scoped,'provider_person',{op:'identity_link',session_hash:'a'.repeat(64),provider:'github',subject:'test-provider-person',login:'provider_person',email:'provider@example.com'});
  await claims(scoped,await emailKey('provider@example.com'),{op:'identity_claim',account:'provider_person'});
  const found=await search('claim_org','provider@example.com',cookie);
  expect(found.body.candidates).toEqual([{identifier:'provider@example.com',handle:'provider_person',member:false}]);
  await workspace(scoped,'provider_person',{op:'identity_unlink',provider:'github'});
  expect((await search('claim_org','provider@example.com',cookie)).body.candidates).toEqual([]);
});

it('searches both regional projections even when the owner has no repositories in the other region', async () => {
  const cookie=await signup('regional_owner');
  await api('/orgs',{cookie},{body:{name:'regional_org'}});
  await recordAccount(scoped,'regional_owner','email',Date.now());
  const europe=(bindings as unknown as {INDEX_WEUR:D1Database}).INDEX_WEUR;
  await applySchema(europe);
  const remote={...scoped,INDEX:europe};
  await legacy('regional_only');
  await recordAccount(remote,'regional_only','email',Date.now());
  await legacy('regional_duplicate');
  await recordAccount(scoped,'regional_duplicate','email',Date.now());
  await recordAccount(remote,'regional_duplicate','email',Date.now());
  await legacy('private.regional@example.com','regional_private');
  await bindings.INDEX.prepare('DELETE FROM platform_handles WHERE workspace=?').bind('private.regional@example.com').run();
  await europe.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind('private.regional@example.com','regional_private').run();
  await legacy('stale.regional@example.com','regional_stale');
  await workspace(scoped,'stale.regional@example.com',{op:'handle_set',handle:'current_alias'});
  await europe.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind('stale.regional@example.com','regional_stale').run();
  await legacy('regional_gone');
  await recordAccount(remote,'regional_gone','email',Date.now());
  await workspace(scoped,'regional_gone',{op:'account_close'});
  await europe.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind('regional_org','regional_org').run();
  const CELL_WEUR={fetch:async()=>{throw new Error('member search should read bound indexes, not caller home routing');}} as unknown as Fetcher;
  const target={...scoped,CELLS:'on',CELL_WEUR,INDEX_WEUR:europe};
  const found=await search('regional_org','regional_',cookie,target);
  expect(found.status,JSON.stringify(found.body)).toBe(200);
  expect(found.body.candidates.map((c:any)=>c.identifier).sort()).toEqual(['regional_duplicate','regional_only','regional_owner','regional_private']);
  expect(JSON.stringify(found.body)).not.toContain('@example.com');
  expect((await bindings.INDEX.prepare('SELECT 1 FROM platform_accounts WHERE account=?').bind('regional_only').first())).toBeNull();
  const outsider=await signup('other_regional');
  let queries=0;
  const watched=new Proxy(europe,{get(db,key){if(key==='prepare')return (sql:string)=>{queries++;return db.prepare(sql);};const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  expect((await search('regional_org','regional_',outsider,{...target,INDEX_WEUR:watched})).status).toBe(403);
  expect(queries).toBe(0);
});
