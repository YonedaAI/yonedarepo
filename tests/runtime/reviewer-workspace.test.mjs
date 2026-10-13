import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function cli(args = [], allowance = { version: 1, remaining_microusd: 47000000 }, candidateStatus = 'eligible') {
  const dir = await mkdtemp(join(tmpdir(), 'reviewer-cli-'));
  try {
    const key = join(dir, 'key');
    const calls = join(dir, 'calls.json');
    const mock = join(dir, 'fetch.mjs');
    await writeFile(key, 'synthetic-key', { mode: 0o600 });
    await writeFile(mock, `
      import { writeFileSync } from 'node:fs';
      const calls=[];
      const allowance=${JSON.stringify(allowance)};
      const candidateStatus=${JSON.stringify(candidateStatus)};
      globalThis.fetch=async(url, options)=>{
        const path=new URL(url).pathname.slice(5);
        calls.push([path,options.method]);
        writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls),{mode:0o600});
        let value; let status=200;
        if(path==='auth/login') value={ok:true};
        else if(path==='workspace/allowance') {
          value=allowance;
          if(allowance.error) status=allowance.status;
        }
        else if(path==='repositories') value={repositories:[{id:'owned',status:'ready'}]};
        else if(path==='repos/owned/runs_page') value={items:[{id:'normal-checked',status:'ready',created_at:3}],watermark:3,next_cursor:null};
        else if(path==='reviewer') value={campaign:{enabled:true,budget:{limit_microusd:5000000,charged_microusd:0}}};
        else if(path==='reviewer/campaign/checked') value={repo_id:'legacy',run_id:'legacy-checked',url:'/?repo=legacy&run=legacy-checked'};
        else if(path==='repos/owned/run_detail') {
          const revision={repository:'test/fork',commit:'a'.repeat(40)};
          value={repository:{policy:{version:'current',suite:'commands-v1',environment:'test-evaluator',required_checks:['behavior']}},
            runs:[{id:'normal-checked',status:'ready'}],executions:[],
            candidates:[{id:'captured',run_id:'normal-checked',status:candidateStatus,revision,evaluation:'evaluation'}],
            evaluations:[{id:'evaluation',candidate:'captured',revision,policy:'current',suite:'commands-v1',environment:'test-evaluator',evidence:'b'.repeat(64),checks:[{name:'behavior',status:'pass'}]}]};
        }
        else if(path==='repos/legacy/run_detail') value={runs:[{id:'legacy-checked',status:'ready'}],executions:[]};
        else {status=409;value={error:{code:'UNEXPECTED',message:'Unexpected legacy mutation or request'}};}
        return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','set-cookie':'synthetic=session'}});
      };
    `);
    const child = spawn(process.execPath, ['--import', mock, 'tools/reviewer.mjs', '--key-file', key, '--no-open', ...args]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    return { code, stdout, stderr, calls: JSON.parse(await readFile(calls, 'utf8')) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('checked CLI rejects ready historical run after stronger-policy reevaluation fails', async () => {
  const result = await cli(['--checked'], undefined, 'rejected');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No current-policy checked run/);
  assert.doesNotMatch(result.stdout, /Independent checks finished|Run: normal-checked/);
  assert.ok(result.calls.every(([path, method]) => !path.startsWith('reviewer') && (method === 'GET' || path === 'auth/login')));
});

for (const args of [[], ['--checked'], ['--new'], ['--resume']]) {
  test(`shared allowance CLI ${args[0] ?? 'default'} uses ordinary read-only workspace, never legacy trial`, async () => {
    const result = await cli(args);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Shared workspace allowance remaining: \$47\.00/);
    assert.ok(result.calls.some(([path]) => path === 'repositories'));
    assert.ok(result.calls.every(([path, method]) => !path.startsWith('reviewer') && (method === 'GET' || path === 'auth/login')));
    assert.match(result.stdout, args.includes('--new') || args.includes('--resume') ? /Start a Run/ : /normal-checked/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-key|synthetic=session/);
  });
}

test('version zero allowance keeps the legacy checked command read-only', async () => {
  const result = await cli([], { version: 0 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /legacy-checked/);
  assert.ok(result.calls.some(([path]) => path === 'reviewer/campaign/checked'));
  assert.ok(result.calls.every(([path, method]) => method === 'GET' || path === 'auth/login'));
});

test('known missing allowance route alone permits old deployment compatibility', async () => {
  const result = await cli([], { status: 404, error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /legacy-checked/);
});

for (const failure of [
  { status: 403, error: { code: 'FORBIDDEN', message: 'Not authorized' } },
  { status: 404, error: { code: 'NOT_FOUND', message: 'Workspace not found' } },
]) test('allowance authorization/resource failure cannot downgrade to legacy workflow', async () => {
  const result = await cli([], failure);
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls.map(([path]) => path), ['auth/login', 'workspace/allowance']);
});
