// No provider key access. Authentication stays in memory and errors never include response bodies.
import {readFileSync,statSync} from 'node:fs';
import {ownerClient} from './booking-operator.mjs';
export async function operatorStudyClient(origin,ownerToken,credentials){
  const admin=ownerClient(origin,ownerToken),owner=await login(origin,credentials);
  return {simulated:false,health:admin.health,api:(path,body)=>
    path.startsWith('admin/campaign/')||path==='bootstrap'?admin.api(path,body):owner.api(path,body)};
}
export async function login(origin,credentials){
  const url=new URL(origin);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'
    ||url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('HTTPS API origin required');
  const metadata=statSync(credentials);
  if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new Error('Credentials must be a private mode-0600 regular file');
  const input=JSON.parse(readFileSync(credentials,'utf8'));
  const authenticated=await fetch(new URL('/api/auth/login',url),{method:'POST',redirect:'error',
    headers:{'content-type':'application/json'},body:JSON.stringify({username:input.username,password:input.password}),
    signal:AbortSignal.timeout(30000)});
  if(!authenticated.ok)throw new Error('Study login failed; credentials were not logged');
  const cookie=authenticated.headers.get('set-cookie')?.split(';')[0];
  if(!cookie)throw new Error('Study login returned no session');
  return {simulated:false,api:async(path,body)=>{
    if(!/^[a-zA-Z0-9_/?=&%.-]+$/.test(path)||path.includes('..')||path.startsWith('/'))throw new Error('Invalid study API path');
    const response=await fetch(new URL(`/api/${path}`,url),{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(100000)});
    const value=await response.json();
    if(!response.ok){
      const code=/^[A-Z_]{1,64}$/.test(value.error?.code)?value.error.code:'REQUEST_FAILED';
      throw Object.assign(new Error(`Study API failed (${response.status}): ${code}`),{code});
    }
    return value;
  }};
}
