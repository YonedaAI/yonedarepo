#!/usr/bin/env node
// Reviewer credentials remain in memory and never enter argv, URLs or disk.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const origin = 'https://yonedarepo-dev.mlong-f01.workers.dev';
function keyPrompt() {
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal to enter your reviewer key privately.');
  return new Promise((resolve, reject) => {
    process.stdout.write('Reviewer access key (hidden): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let key = '';
    function finish(error) {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(key);
    }
    function data(chunk) {
      for (const char of chunk.toString()) {
        if (char === '\u0003') return finish(new Error('Cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') key = key.slice(0,-1);
        else if (char >= ' ' && key.length < 128) key += char;
      }
    }
    process.stdin.on('data', data);
  });
}
async function main() {
  let key = await keyPrompt();
  let cookie = '';
  async function api(path, body) {
    const r = await fetch(`${origin}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type':'application/json',...(cookie ? {cookie} : {})},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect:'error',
    });
    const value = await r.json();
    if (!r.ok) throw Object.assign(new Error(value.error?.message ?? `Request failed (${r.status})`), {code:value.error?.code});
    if (path === 'auth/login') cookie=(r.headers.get('set-cookie') ?? '').split(';')[0];
    return value;
  }
  await api('auth/login',{username:'reviewer',password:key}); key='';
  const policy=await api('reviewer');
  console.log(`Signed in. Funded allowance remaining: $${((policy.budget.limit-policy.budget.charged)/1000000).toFixed(2)}.`);
  if (policy.project.status !== 'ready') throw new Error('Reviewer sandbox is still preparing. Open the hosted app and retry when setup is ready.');
  const request_id=policy.active_trial?.replace(/^reviewer-/, '') ?? randomUUID();
  console.log(policy.active_trial ? 'Resuming the recorded reviewer trial.' : 'Starting the prepared Build Together trial (up to $5).');
  let trial;
  // Recover a lost acknowledgement using the SAME request ID, never a new paid trial.
  for (let attempt=0;attempt<3;attempt++) {
    try { trial=await api('reviewer/trial',{request_id}); break; }
    catch (error) {
      if (error.code || attempt===2) throw error;
      await new Promise(r=>setTimeout(r,1000));
    }
  }
  if (!trial) throw new Error('Trial response unavailable. Check the hosted app before starting another trial.');
  const url=new URL(trial.url,origin).href;
  console.log(`Run: ${trial.run_id}\nReview: ${url}\nSign in as reviewer using the same access key in the browser.`);
  const opener=process.platform==='darwin' ? ['open',[url]] : process.platform==='win32' ? ['cmd',['/c','start','',url]] : ['xdg-open',[url]];
  const child=spawn(opener[0],opener[1],{stdio:'ignore'}); child.on('error',()=>{}); child.unref();
  let previous='';
  for (let n=0;n<240;n++) {
    const snapshot=await api(`repos/${trial.repo_id}/snapshot`);
    const run=snapshot.runs.find(r=>r.id===trial.run_id);
    const executions=snapshot.executions.filter(e=>e.run_id===trial.run_id);
    const status=`${run?.status ?? 'queued'} | ${executions.map(e=>`${e.strategy}: ${e.status}`).join(' | ')}`;
    if(status!==previous) { console.log(status); previous=status; }
    if (['ready','failed','cancelled','accepted'].includes(run?.status)) {
      console.log(run.status==='ready' ? 'Independent checks finished. Review the captured revision and decide in the browser.' : `Run ${run.status}. See recorded evidence in the browser.`);
      return;
    }
    await new Promise(r=>setTimeout(r,3000));
  }
  console.log('The run is continuing. Follow its activity in the browser.');
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
