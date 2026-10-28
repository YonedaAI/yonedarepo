import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
const request = (path: string, body?: unknown, cookie?: string) => bindings.SELF.fetch(`https://yoneda/api/${path}`, {method:body ? 'POST' : 'GET',headers:{...(body ? {'content-type':'application/json'} : {}),...(cookie ? {cookie} : {})},...(body ? {body:JSON.stringify(body)} : {})});
async function signup(username: string) {
 const result = await request('auth/signup',{username,password:'a long test password'});
 expect(result.status).toBe(200);
 return {cookie:(result.headers.get('set-cookie') ?? '').split(';')[0],account:await result.json<any>()};
}
it('reserves platform identities so a signup cannot become the administrator workspace',async()=>{
 expect((await request('auth/signup',{username:'_admin',password:'a long test password'})).status).toBe(400);
 expect((await request('auth/signup',{username:'_budget_claude',password:'a long test password'})).status).toBe(400);
});
it('signs up, authenticates after eviction and revokes the opaque session on logout', async () => {
 const {cookie,account} = await signup('alice');
 expect(account.recovery_code).toMatch(/^[a-f0-9]{64}$/);
 expect(cookie).toContain('yoneda_account=alice.');
 const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:alice'));
 await evictDurableObject(stub);
 expect(await (await request('auth/session',undefined,cookie)).json()).toMatchObject({authenticated:true,username:'alice'});
 expect((await request('auth/login',{username:'alice',password:'wrong'})).status).toBe(401);
 const login = await request('auth/login',{username:'alice',password:'a long test password'});
 expect(login.status).toBe(200);
 expect(login.headers.get('set-cookie')).toContain('HttpOnly');
 expect(login.headers.get('set-cookie')).toContain('Secure');
 await request('auth/logout',{},cookie);
 expect(await (await request('auth/session',undefined,cookie)).json()).toMatchObject({authenticated:false});
},30000);
it('uses a one-time recovery code and revokes old sessions', async () => {
 const {cookie,account} = await signup('recover_user');
 const result = await request('auth/recover',{username:'recover_user',password:'new long test password',recovery_code:account.recovery_code});
 expect(result.status).toBe(200);
 expect(await (await request('auth/session',undefined,cookie)).json()).toMatchObject({authenticated:false});
 expect((await request('auth/recover',{username:'recover_user',password:'another long password',recovery_code:account.recovery_code})).status).toBe(401);
 expect((await request('auth/login',{username:'recover_user',password:'new long test password'})).status).toBe(200);
},30000);
