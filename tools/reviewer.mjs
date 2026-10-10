#!/usr/bin/env node
// Reviewer credentials remain in memory and never enter argv, URLs or disk.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { findCheckedRun, readRun } from './reviewer-client.mjs';

const origin = 'https://yonedarepo.com';
function keyPrompt() {
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal to enter your reviewer key privately.');
  return new Promise((resolve, reject) => {
    process.stdin.setRawMode(true);
    process.stdout.write('Reviewer access key (hidden): ');
    process.stdin.resume();
    let key = '';
    function finish(error) {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.destroy();
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
function usage() {
  return `Usage: node tools/reviewer.mjs [--help] [--new] [--checked] [--no-open] [--key-file <path>]

Options:
  --help             Show this help without signing in.
  --key-file <path>  Read a reviewer key from a private file (raw key or access.json).
  --checked          Open the latest recorded checked run; never start/resume a trial.
  --no-open          Print the review URL without launching a browser.
  --new              Explicitly approve a new funded trial (up to $5).`;
}
function parseArgs(args) {
  const options = { help: false, newTrial: false, checkedOnly: false, openBrowser: true, keyFile: '' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--new') options.newTrial = true;
    else if (argument === '--checked') options.checkedOnly = true;
    else if (argument === '--no-open') options.openBrowser = false;
    else if (argument === '--key-file') {
      const path = args[++index];
      if (!path || path.startsWith('--')) throw new Error('--key-file requires a path.');
      options.keyFile = path;
    } else throw new Error(usage());
  }
  if (options.help && args.length !== 1) throw new Error('--help cannot be combined with other options.');
  if (options.checkedOnly && options.newTrial)
    throw new Error('--checked and --new are mutually exclusive.');
  return options;
}
async function keyFromFile(path) {
  const file = resolve(path);
  const metadata = await stat(file);
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
    throw new Error('Reviewer key file must be private (owner read/write only).');
  const content = await readFile(file, 'utf8');
  let record;
  try { record = JSON.parse(content); } catch { record = null; }
  const key = typeof record?.password === 'string' ? record.password : content.trim();
  if (!key || key.length > 128) throw new Error('Reviewer key file is empty or invalid.');
  return { key, username: typeof record?.username === 'string' ? record.username : 'reviewer' };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const credentials = options.keyFile ? await keyFromFile(options.keyFile) : { key: await keyPrompt(), username: 'reviewer' };
  let key = credentials.key;
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
  try {
    await api('auth/login',{username:credentials.username,password:key});
  } finally {
    key='';
    credentials.key='';
  }
  const policy=await api('reviewer');
  console.log(`Signed in. Funded allowance remaining: $${((policy.budget.limit-policy.budget.charged)/1000000).toFixed(2)}.`);
  if (policy.project.status !== 'ready') throw new Error('Reviewer sandbox is still preparing. Open the hosted app and retry when setup is ready.');
  let trial;
  if (options.checkedOnly || (!policy.active_trial && !options.newTrial)) {
    const recorded=await findCheckedRun(api,policy.repo_id);
    if(recorded) {
      trial={repo_id:policy.repo_id,run_id:recorded.id,
        url:`/?repo=${encodeURIComponent(policy.repo_id)}&run=${encodeURIComponent(recorded.id)}`};
      console.log(options.checkedOnly
        ? 'Read-only mode: using a recorded checked run; no trial will be started.'
        : 'Opening the recorded checked example. Use --new only to approve another funded trial.');
    } else if (options.checkedOnly) {
      throw new Error('No recorded checked run is available. --checked never starts or resumes a trial.');
    }
    else throw new Error('No checked example is available yet. Use --new to approve a funded trial (up to $5).');
  }
  const request_id=policy.active_trial?.replace(/^reviewer-/, '') ?? randomUUID();
  if (!trial) console.log(policy.active_trial ? 'Resuming the recorded reviewer trial.' : 'Starting the prepared Build Together trial (up to $5).');
  // Recover a lost acknowledgement using the SAME request ID, never a new paid trial.
  for (let attempt=0;!trial && attempt<3;attempt++) {
    try { trial=await api('reviewer/trial',{request_id}); break; }
    catch (error) {
      if (error.code || attempt===2) throw error;
      await new Promise(r=>setTimeout(r,1000));
    }
  }
  if (!trial) throw new Error('Trial response unavailable. Check the hosted app before starting another trial.');
  const url=new URL(trial.url,origin).href;
  console.log(`Run: ${trial.run_id}\nReview: ${url}`);
  const opener=process.platform==='darwin' ? ['open',[url]] : process.platform==='win32' ? ['cmd',['/c','start','',url]] : ['xdg-open',[url]];
  if (options.openBrowser) {
    const child=spawn(opener[0],opener[1],{stdio:'ignore'}); child.on('error',()=>{}); child.unref();
    console.log('Review browser opened. Sign in as reviewer using the same access key.');
  } else console.log('Browser not opened (--no-open). Open the review URL and sign in separately.');
  let previous='';
  for (let n=0;n<240;n++) {
    const snapshot=await readRun(api,trial.repo_id,trial.run_id);
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
