#!/usr/bin/env node
// Operator-only bootstrap. Never prints credentials or recovery data.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
const origin='https://yonedarepo-dev.mlong-f01.workers.dev';
const directory=new URL('../.local/reviewer/',import.meta.url);
const file=new URL('access.json',directory);
await mkdir(directory,{recursive:true,mode:0o700});
await chmod(directory,0o700);
let access;
try {access=JSON.parse(await readFile(file,'utf8'));}
catch(error) {if(error.code!=='ENOENT') throw error; access={username:'reviewer',password:randomBytes(32).toString('hex'),origin}; await writeFile(file,JSON.stringify(access,null,2),{mode:0o600,flag:'wx'});}
await chmod(file,0o600);
const token=(await readFile(new URL('../.local/owner-token',import.meta.url),'utf8')).trim();
async function request(path,body,admin=false) {
 const r=await fetch(`${origin}/api/${path}`,{method:'POST',headers:{'content-type':'application/json',...(admin?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:'error'});
 const v=await r.json(); if(!r.ok) throw Object.assign(new Error(v.error?.message ?? `HTTP ${r.status}`),{code:v.error?.code}); return v;
}
try {
 const signup=await request('auth/signup',{username:access.username,password:access.password});
 access.recovery_code=signup.recovery_code;
 await writeFile(file,JSON.stringify(access,null,2),{mode:0o600});
} catch(error) {if(error.code!=='ALREADY_EXISTS') throw error; await request('auth/login',{username:access.username,password:access.password});}
const provisioned=await request('admin/reviewer/provision',{username:access.username},true);
access={...access,...provisioned}; await writeFile(file,JSON.stringify(access,null,2),{mode:0o600});
console.log(`Reviewer account configured; sandbox ${provisioned.status}. Private access details saved in .local/reviewer/access.json (0600). No paid trial started.`);
