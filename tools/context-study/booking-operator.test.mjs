import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownerClient,gitEnvironment,campaignClient} from './booking-operator.mjs';
import {seedTemplate} from './booking-provision.mjs';
test('operator credential stays in header memory; unsafe paths and response secrets never reach errors',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'booking-auth-'));
  try{
    const path=join(directory,'token');writeFileSync(path,'test-owner-secret',{mode:0o600});
    let observed;
    const client=ownerClient('https://example.com',path,async(url,options)=>{
      observed={url,options};
      return new Response(JSON.stringify({error:{code:'DENIED',message:'test-owner-secret'}}),{status:403});
    });
    await assert.rejects(client.api('bootstrap',{name:'safe'}),error=>error.code==='DENIED'&&!error.message.includes('secret'));
    assert.equal(observed.options.headers.authorization,'Bearer test-owner-secret');
    assert.equal(observed.options.redirect,'error');
    await assert.rejects(client.api('../escape'));
    writeFileSync(path,'test-owner-secret',{mode:0o600});
    assert.throws(()=>ownerClient('http://external.example',path));
    const environment=gitEnvironment('private-git-capability',{PATH:'/bin',GIT_TRACE:'1',GIT_CONFIG_COUNT:'7',GIT_CONFIG_VALUE_0:'unsafe'});
    assert.equal(environment.GIT_TRACE,undefined);
    assert.equal(environment.GIT_CONFIG_COUNT,'1');
    assert.equal(environment.GIT_CONFIG_VALUE_0,'Authorization: Bearer private-git-capability');
    assert.equal(environment.GIT_TERMINAL_PROMPT,'0');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('owned repository calls use narrow admin wrapper; direct paid start is refused',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'booking-wrapper-'));
  try{
    const path=join(directory,'token');writeFileSync(path,'test-owner-secret',{mode:0o600});
    const calls=[];
    const client=campaignClient('https://example.com',path,'reviewer',async(url,options)=>{
      calls.push({path:new URL(url).pathname,body:JSON.parse(options.body)});
      return Response.json({marker:'server-value'});
    });
    assert.deepEqual(await client.api('repos/booking-one/context_usage?run_id=run-1&limit=100&cursor=12'),{marker:'server-value'});
    assert.deepEqual(calls[0],{path:'/api/admin/campaign/repository',body:{username:'reviewer',repo_id:'booking-one',action:'context_usage',input:{run_id:'run-1',limit:100,cursor:'12'}}});
    await client.api('repos/booking-one/create_working_branch',{id:'branch',expected_version:0,expected_commit:'a'.repeat(40)});
    assert.equal(calls[1].body.action,'create_working_branch');
    await assert.rejects(client.api('repos/booking-one/start_run',{id:'paid'}));
    await assert.rejects(client.api('repos/booking-one/snapshot?op=start_run'));
    assert.equal(calls.length,2);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('bootstrap revokes RAM-only capability after uncertain push and checks immutable HEAD',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'booking-bootstrap-'));
  const commit='a'.repeat(40),tree='b'.repeat(40),calls=[],gitCalls=[];
  let bootstraps=0;
  const client={api:async(path,body)=>{
    calls.push({path,body});
    if(body.revoke_token_id)return {revoked:true};
    if(bootstraps++===0)return {remote:'https://artifacts.example/seed.git',token:'private-git-capability',token_id:'private-id'};
    return {commit};
  }};
  const runGit=async(args,cwd,capability)=>{
    gitCalls.push({args,capability});
    assert.ok(args.every(value=>!value.includes('private-git-capability')));
    if(args[0]==='push')throw new Error('uncertain acknowledgment');
    if(args[0]==='ls-remote')return `${commit}\trefs/heads/main`;
    if(args[0]==='rev-parse')return args[1]==='HEAD'?commit:tree;
    return '';
  };
  try{
    const receipt=await seedTemplate(client,'safe-template',directory,{runGit});
    assert.equal(receipt.commit,commit);assert.equal(receipt.write_capability_revoked,true);
    assert.equal(calls.filter(call=>call.body.revoke_token_id).length,1);
    assert.ok(!JSON.stringify(receipt).includes('private-git'));
    assert.equal(gitCalls.filter(call=>call.capability).length,2);
    const failed={api:async(path,body)=>body.revoke_token_id?{revoked:true}:{remote:'https://artifacts.example/seed.git',token:'private',token_id:'other'}};
    await assert.rejects(seedTemplate(failed,'other-template',directory,{runGit:async args=>args[0]==='rev-parse'?commit:args[0]==='ls-remote'?'wrong': ''}));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
