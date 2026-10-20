import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { importSource,provisionProject,sitePolicy } from '../../cloudflare/worker/projects';
import { workspace } from '../../cloudflare/worker/workspace';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { bindNewPlatformRepo, interceptPlatform, platformJson, platformProject } from './platform-fixture';
const bindings = env as unknown as Env;
afterEach(async()=>{await reset();});
it('validates public Git imports without forwarding URL credentials or private hosts',()=>{
 expect(importSource('https://github.com/example/project.git')).toBe('https://github.com/example/project.git');
 for(const url of ['http://github.com/example/project','https://key@github.com/example/project','https://127.0.0.1/private','https://private.internal/repo','https://github.com/example/project?token=secret']) expect(()=>importSource(url)).toThrow();
});
it('resumes provisioning against real DOs after a transient platform failure',async()=>{
 await workspace(bindings,'alice',{op:'signup',username:'alice',password:'a long test password',salt:'01'.repeat(16),recovery_hash:'b'.repeat(64),session_hash:'a'.repeat(64)});
 const project = await workspace(bindings,'alice',{op:'project_reserve',id:'project-one',name:'Portfolio',policy:sitePolicy});
 const bound = await bindNewPlatformRepo(bindings,'alice',project.id);
 let lostRead = false;
 // The first head read fails like an unavailable platform; the retry reads the same repository.
 const env = interceptPlatform(bindings,(path)=>{if(path.endsWith('/refs') && !lostRead){lostRead=true;return platformJson({error:{code:'UPSTREAM_UNAVAILABLE',message:'Synthetic outage'}},503);}return undefined;});
 const failed = await provisionProject(env,'alice',project);expect(failed.status).toBe('failed');
 const retry = await workspace(bindings,'alice',{op:'project_retry',id:project.id});
 const ready = await provisionProject(env,'alice',retry);expect(ready.status).toBe('ready');
 expect(ready.platform).toEqual({repo:bound.repo});
 const snapshot = await ledger(bindings,'project-one',{op:'snapshot',_workspace:'alice'});expect(snapshot.repository.workspace).toBe('alice');expect(snapshot.repository.published_commit).toBe(bound.commit);
 await expect(ledger(bindings,'project-one',{op:'snapshot',_workspace:'bob'})).rejects.toThrow('another workspace');
});
it('preserves regular source files named like JavaScript prototype properties',async()=>{
 const {source}=await import('../../cloudflare/worker/artifacts');
 const {base}=await platformProject(bindings,'alice','proto-names',Object.fromEntries([['__proto__','proto bytes'],['constructor','constructor bytes']]));
 const workspace=await source(bindings,base);
 expect(Object.keys(workspace.files)).toEqual(['__proto__','constructor']);
 expect(JSON.parse(JSON.stringify(workspace)).files.__proto__.content).toBe('proto bytes');
});
