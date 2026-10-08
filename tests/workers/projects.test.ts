import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { importSource,provisionProject,sitePolicy } from '../../worker/projects';
import { workspace } from '../../worker/workspace';
import { ledger } from '../../worker/storage';
import type { Env } from '../../worker/types';
const bindings = env as unknown as Env;
afterEach(async()=>{await reset();});
it('validates public Git imports without forwarding URL credentials or private hosts',()=>{
 expect(importSource('https://github.com/example/project.git')).toBe('https://github.com/example/project.git');
 for(const url of ['http://github.com/example/project','https://key@github.com/example/project','https://127.0.0.1/private','https://private.internal/repo','https://github.com/example/project?token=secret']) expect(()=>importSource(url)).toThrow();
});
it('resumes provisioning against real DOs after a lost Artifacts fork acknowledgment',async()=>{
 await workspace(bindings,'alice',{op:'signup',username:'alice',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:'a'.repeat(64)});
 const project = await workspace(bindings,'alice',{op:'project_reserve',id:'project-one',name:'Portfolio',policy:sitePolicy});
 let forked = false; let lostRead = false; const revoked:string[] = [];
 // This fake isolates SDK failure handling. Artifacts compatibility is verified separately live.
 const remote = { [Symbol.dispose](){},info:async()=>({defaultBranch:'main'}),log:async()=>[{hash:'c'.repeat(40)}],readCommit:async()=>({treeHash:'d'.repeat(40)}),readTree:async()=>[{name:'README.md',type:'blob',hash:'e'.repeat(40)}],readBlob:async()=>new Blob(['Source']),listTokens:async()=>({tokens:[{id:'lost-initial-token',state:'active'}]}),revokeToken:async(id:string)=>{revoked.push(id);return true;},fork:async()=>{if(!forked){forked=true;throw new Error('Lost acknowledgment');}throw new Error('ArtifactsError: repo already exists: project-one');}};
 const env = {...bindings,ARTIFACTS:{get:async(name:string)=>{if(name==='project-one' && !lostRead){lostRead=true;throw new Error('Target read temporarily unavailable');}return remote;}}} as unknown as Env;
 const failed = await provisionProject(env,'alice',project);expect(failed.status).toBe('failed');
 const ready = await provisionProject(env,'alice',failed);expect(ready.status).toBe('ready');expect(revoked).toContain('lost-initial-token');
 const snapshot = await ledger(bindings,'project-one',{op:'snapshot',_workspace:'alice'});expect(snapshot.repository.workspace).toBe('alice');expect(snapshot.repository.published_commit).toBe('c'.repeat(40));
 await expect(ledger(bindings,'project-one',{op:'snapshot',_workspace:'bob'})).rejects.toThrow('another workspace');
});
it('preserves regular source files named like JavaScript prototype properties',async()=>{
 const {source}=await import('../../worker/artifacts');
 const remote={ [Symbol.dispose](){},readCommit:async()=>({treeHash:'b'.repeat(40)}),readTree:async()=>[{name:'__proto__',type:'blob',hash:'c'.repeat(40)},{name:'constructor',type:'blob',hash:'d'.repeat(40)}],readBlob:async(hash:string)=>new Blob([hash])};
 const env={...bindings,ARTIFACTS:{get:async()=>remote}} as unknown as Env;
 const workspace=await source(env,{repository:'yoneda-test/private',commit:'a'.repeat(40)});
 expect(Object.keys(workspace.files)).toEqual(['__proto__','constructor']);
 expect(JSON.parse(JSON.stringify(workspace)).files.__proto__.content).toBe('c'.repeat(40));
});
