// Operator capabilities are read once into RAM. Never return headers or raw error bodies.
import {readFileSync,lstatSync} from 'node:fs';
export function ownerClient(origin,path,request=fetch){
  const url=new URL(origin);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'
    ||url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('HTTPS API origin required');
  const metadata=lstatSync(path);
  if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new Error('Owner token requires a private regular file');
  const token=readFileSync(path,'utf8').trim();
  if(!token||/[\r\n]/.test(token))throw new Error('Invalid private operator credential');
  const send=async(path,body,health=false)=>{
    if(!/^[a-zA-Z0-9_/?=&%.-]+$/.test(path)||path.includes('..')||path.startsWith('/'))throw new Error('Invalid operator API path');
    let response,value;
    try{
      response=await request(new URL(health?'/health':`/api/${path}`,url),{
        method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(100000)});
      value=await response.json();
    }catch{throw Object.assign(new Error('Operator transport failed; sensitive responses withheld'),{code:'TRANSPORT_FAILED'});}
    if(!response.ok){
      const code=/^[A-Z_]{1,64}$/.test(value?.error?.code)?value.error.code:'REQUEST_FAILED';
      throw Object.assign(new Error(`Operator API failed (${response.status}): ${code}`),{code});
    }
    return value;
  };
  return {simulated:false,api:send,health:()=>send('health',undefined,true)};
}
export function gitEnvironment(capability,base=process.env){
  // Drop all inherited Git config/tracing/credential helper knobs before installing this RAM-only header.
  const environment=Object.fromEntries(Object.entries(base).filter(([key])=>!key.startsWith('GIT_')));
  return {...environment,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',
    GIT_CONFIG_VALUE_0:`Authorization: Bearer ${capability}`,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
}
export function campaignClient(origin,path,username,request=fetch){
  const admin=ownerClient(origin,path,request);
  const actions=new Set(['snapshot','published_source','context_get','run_detail','context_usage','working_branch',
    'create_working_branch','approve_test_bundle','candidate_source','cancel_run']);
  return {simulated:false,health:admin.health,api:async(path,body)=>{
    if(path==='bootstrap'||path.startsWith('admin/campaign/'))return admin.api(path,body);
    const match=/^repos\/([a-zA-Z0-9_-]{1,80})\/([a-z_]+)(?:\?(.*))?$/.exec(path);
    if(!match||!actions.has(match[2]))throw new Error('Unsupported protected operator action');
    const input={...body};
    for(const [key,value] of new URLSearchParams(match[3]??'')){
      if(!['id','run_id','limit','cursor'].includes(key)||Object.hasOwn(input,key))throw new Error('Invalid operator read parameters');
      input[key]=key==='limit'?Number(value):value;
      if(key==='limit'&&(!Number.isSafeInteger(input[key])||input[key]<1||input[key]>100))throw new Error('Invalid receipt limit');
    }
    return admin.api('admin/campaign/repository',{username,repo_id:match[1],action:match[2],input});
  }};
}
