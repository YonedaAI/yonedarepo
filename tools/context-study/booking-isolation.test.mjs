// Reproduce the container's immutable bundle without the repository's package.json.
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,chmodSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {protectedBundle} from './booking-policy.mjs';
import {starterFiles} from './booking-campaign-plan.mjs';
import {reference} from '../../fixtures/event-booking/controls/reference.mjs';
function files(directory,result={}){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isDirectory())files(path,result);
    else if(entry.isFile())result[path]=readFileSync(path,'utf8');
  }
  return result;
}
function permissions(directory,readonly){
  if(!readonly)chmodSync(directory,0o700);
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isDirectory())permissions(path,readonly);
    else if(entry.isFile())chmodSync(path,readonly?0o444:0o600);
  }
  if(readonly)chmodSync(directory,0o555);
}
function materialize(directory,workspace){
  for(const [path,file] of Object.entries(workspace)){
    const target=join(directory,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,file.content);
  }
}
it('protected workerd oracle loads from immutable ESM bundle with read-only packages and no ancestor package manifest',()=>{
  const root=mkdtempSync(join(tmpdir(),'yoneda-booking-isolation-')),bundle=join(root,'bundle'),subject=join(root,'candidate');
  try{
    materialize(bundle,protectedBundle().files);
    const source=starterFiles();
    source['api.mjs'].content=readFileSync('fixtures/event-booking/source/api.mjs','utf8');
    source['public/app.mjs'].content=readFileSync('fixtures/event-booking/source/public/app.mjs','utf8');
    source['booking.mjs'].content=reference(source['booking.mjs'].content,'duplicate_registration_bugfix');
    materialize(subject,source);
    assert.equal(spawnSync(process.execPath,['build.mjs'],{cwd:subject}).status,0);
    mkdirSync(join(bundle,'node_modules/@cloudflare'),{recursive:true});
    symlinkSync(resolve('node_modules/@cloudflare/vitest-plugin'),join(bundle,'node_modules/@cloudflare/vitest-plugin'),'dir');
    symlinkSync(resolve('node_modules/vitest'),join(bundle,'node_modules/vitest'),'dir');
    const before=files(bundle);permissions(bundle,true);
    const result=spawnSync(process.execPath,[join(bundle,'fixtures/event-booking/oracle/run.mjs'),
      'duplicate_registration_bugfix',resolve('node_modules/vitest/vitest.mjs')],{
      cwd:subject,encoding:'utf8',timeout:80000,maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    assert.match(result.stdout,/7 passed/);
    assert.deepEqual(files(bundle),before,'Immutable test bundle was modified');
  }finally{if(readdirSync(root).includes('bundle'))permissions(bundle,false);rmSync(root,{recursive:true,force:true});}
});
