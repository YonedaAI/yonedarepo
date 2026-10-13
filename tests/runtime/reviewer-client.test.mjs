import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignEntry, findCheckedRun, readRun, workspaceAllowance, workspaceEntry } from '../../tools/reviewer-client.mjs';

function checkedDetail(id, status = 'ready') {
  const revision = { repository: 'test/fork', commit: 'a'.repeat(40) };
  const policy = { version: 'current', suite: 'commands-v1', environment: 'test-evaluator', required_checks: ['build', 'behavior'] };
  const candidate = { id: `candidate:${id}`, run_id: id, status: 'eligible', revision, evaluation: `evaluation:${id}` };
  return { repository: { policy }, runs: [{ id, status }], executions: [], candidates: [candidate], evaluations: [{
    id: candidate.evaluation, candidate: candidate.id, revision, policy: policy.version,
    suite: policy.suite, environment: policy.environment, evidence: 'b'.repeat(64),
    checks: policy.required_checks.map(name => ({ name, status: 'pass' })),
  }] };
}

test('ready historical run with failed current-policy reevaluation is not a current checked result', async () => {
  const detail = checkedDetail('historical');
  detail.candidates[0].status = 'rejected';
  detail.evaluations[0].checks[1].status = 'fail';
  const paths = [];
  const found = await findCheckedRun(async path => {
    paths.push(path);
    if (path.includes('/runs_page?')) return { items: detail.runs, watermark: 1, next_cursor: null };
    return detail;
  }, 'fixture');
  assert.equal(found, null);
  assert.ok(paths.some(path => path.includes('/run_detail?')));
  assert.ok(paths.every(path => !/snapshot|trial|candidate_source/.test(path)));
});

test('discovery skips newer ready but stale-policy run and finds exact eligible current-policy result', async () => {
  const old = checkedDetail('newer');
  old.evaluations[0].policy = 'old-policy';
  const valid = checkedDetail('older', 'accepted');
  const found = await findCheckedRun(async path => {
    if (path.includes('/runs_page?')) return { items: [old.runs[0], valid.runs[0]], watermark: 2, next_cursor: null };
    return path.includes('newer') ? old : valid;
  }, 'fixture');
  assert.equal(found.id, 'older');
  assert.equal(found.current_checked_candidate.id, 'candidate:older');
  assert.equal(found.current_checked_candidate.policy, 'current');
});

test('historical acceptance does not exempt a run from current policy verification', async () => {
  const detail = checkedDetail('published', 'accepted');
  detail.repository.policy.version = 'stronger-policy';
  const found = await findCheckedRun(async path => path.includes('/runs_page?')
    ? { items: detail.runs, watermark: 2, next_cursor: null } : detail, 'fixture');
  assert.equal(found, null);
});

test('current checked discovery requires exact evidence bindings and every required check once', async () => {
  const changes = [
    detail => { detail.candidates[0].evaluation = 'other-evaluation'; },
    detail => { detail.evaluations[0].candidate = 'other-candidate'; },
    detail => { detail.evaluations[0].revision = { ...detail.evaluations[0].revision, commit: 'c'.repeat(40) }; },
    detail => { detail.evaluations[0].revision = { ...detail.evaluations[0].revision, repository: 'other/fork' }; },
    detail => { detail.evaluations[0].suite = 'other-suite'; },
    detail => { detail.evaluations[0].environment = 'other-environment'; },
    detail => { detail.evaluations[0].evidence = 'not-a-sha256'; },
    detail => { detail.evaluations[0].checks.pop(); },
    detail => { detail.evaluations[0].checks.push({ name: 'behavior', status: 'pass' }); },
    detail => { detail.evaluations[0].checks[1].status = 'fail'; },
    detail => { detail.repository.policy.required_checks.push('new-stronger-check'); },
    detail => { delete detail.repository.policy; },
  ];
  for (const change of changes) {
    const detail = checkedDetail('run');
    change(detail);
    assert.equal(await findCheckedRun(async path => path.includes('/runs_page?')
      ? { items: detail.runs, watermark: 1, next_cursor: null } : detail, 'fixture'), null);
  }
});

test('stale ready result on first page does not hide current checked result on subsequent page', async () => {
  const stale = checkedDetail('stale');
  stale.candidates[0].status = 'rejected';
  const valid = checkedDetail('checked');
  const paths = [];
  const pages = [
    { items: stale.runs, next_cursor: 'opaque+cursor', watermark: 12 },
    { items: valid.runs, next_cursor: null, watermark: 12 },
  ];
  const found = await findCheckedRun(async path => {
    paths.push(path);
    if (path.includes('/run_detail?')) return path.includes('stale') ? stale : valid;
    return pages.shift();
  }, 'fixture');
  assert.equal(found.id, 'checked');
  assert.match(paths[2], /cursor=opaque%2Bcursor&watermark=12/);
  assert.ok(paths.every(path => !/snapshot|trial|candidate_source/.test(path)));
});

test('checked detail read failures propagate without snapshot fallback or skipping to another run', async () => {
  for (const failure of [
    Object.assign(new Error('Not authorized'), { code: 'FORBIDDEN', status: 403 }),
    Object.assign(new Error('Run not found'), { code: 'NOT_FOUND', status: 404 }),
    new Error('Transport unavailable'),
  ]) {
    const paths = [];
    await assert.rejects(findCheckedRun(async path => {
      paths.push(path);
      if (path.includes('/runs_page?')) return { items: [{ id: 'run', status: 'ready' }], watermark: 1, next_cursor: null };
      throw failure;
    }, 'fixture'), error => error === failure);
    assert.equal(paths.length, 2);
    assert.ok(paths.every(path => !/snapshot/.test(path)));
  }
});

test('legacy snapshot compatibility also rejects status-only or stale-policy checked claims', async () => {
  const detail = checkedDetail('historical', 'accepted');
  detail.repository.policy.version = 'stronger';
  assert.equal(await findCheckedRun(async path => {
    if (path.includes('/runs_page?')) throw Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND', status: 404 });
    return detail;
  }, 'fixture'), null);
});

test('old DO missing operation mapped to HTTP409 uses only validated legacy snapshot fallback', async () => {
  const paths = [];
  const valid = checkedDetail('legacy');
  const api = async path => {
    paths.push(path);
    if (!path.endsWith('/snapshot'))
      throw Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND', status: 409 });
    return valid;
  };
  assert.equal((await findCheckedRun(api, 'fixture')).id, 'legacy');
  assert.equal((await readRun(api, 'fixture', 'legacy')).evaluations[0].id, 'evaluation:legacy');
  valid.repository.policy.version = 'stronger-current-policy';
  assert.equal(await findCheckedRun(api, 'fixture'), null);
  assert.ok(paths.every(path => /runs_page|run_detail|snapshot/.test(path)));
});

test('campaign entry reads checked output without starting or resuming running paid work', async () => {
  const paths=[];
  const checked={repo_id:'booking',run_id:'checked',url:'/?repo=booking&run=checked'};
  const result=await campaignEntry(async(path,body)=>{paths.push([path,body]);return checked;},
    {enabled:true,repo_id:'booking',active_trial:'still-running'},false,'unused');
  assert.equal(result,checked);
  assert.deepEqual(paths,[['reviewer/campaign/checked',undefined]]);
});

test('explicit trial reuses an active reservation and disabled campaigns never execute', async () => {
  const api=()=>{throw new Error('Unexpected paid action');};
  const active=await campaignEntry(api,{enabled:true,repo_id:'booking',active_trial:'active'},true,'new');
  assert.equal(active.run_id,'active');
  await assert.rejects(campaignEntry(api,{enabled:false},true,'new'),/not ready/);
});

test('reviewer finds a checked example through stable metadata pages', async () => {
  const paths = [];
  const pages = [
    { items: [{ id: 'failed', status: 'failed' }], next_cursor: 'opaque+cursor', watermark: 12 },
    { items: [{ id: 'checked', status: 'ready' }], next_cursor: null, watermark: 12 },
  ];
  const run = await findCheckedRun(async path => { paths.push(path); return path.includes('/run_detail?') ? checkedDetail('checked') : pages.shift(); }, 'fixture');
  assert.equal(run.id, 'checked');
  assert.match(paths[1], /cursor=opaque%2Bcursor/);
  assert.match(paths[1], /watermark=12/);
  assert.ok(paths.every(path => !/snapshot|trial|candidate_source/.test(path)));
});

test('legacy unknown repository operation falls back to the latest checked snapshot run', async () => {
  const paths = [];
  const api = async path => {
    paths.push(path);
    if (path.includes('/runs_page?'))
      throw Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND' });
    if (path.endsWith('/snapshot')) return { ...checkedDetail('newer', 'accepted'), runs: [
      { id: 'older', status: 'ready', created_at: 10 },
      { id: 'newer', status: 'accepted', created_at: 20 },
      { id: 'active', status: 'running', created_at: 30 },
    ] };
    throw new Error(`Unexpected request ${path}`);
  };
  assert.equal((await findCheckedRun(api, 'fixture')).id, 'newer');
  assert.deepEqual(paths.map(path => path.split('/').at(-1).split('?')[0]), ['runs_page', 'snapshot']);
});

test('legacy run detail returns only the selected run and run-scoped snapshot data', async () => {
  const paths = [];
  const snapshot = {
    repository: { id: 'fixture' }, runs: [{ id: 'run-1', status: 'ready' }, { id: 'other' }],
    executions: [{ run_id: 'run-1', strategy: 'a' }, { run_id: 'other', strategy: 'b' }],
    candidates: [{ id: 'selected', run_id: 'run-1' }, { id: 'other', run_id: 'other' }],
    evaluations: [{ id: 'evaluation-selected', candidate: 'selected' }, { id: 'evaluation-other', candidate: 'other' }],
    nodes: [{ id: 'graph-node' }], edges: [{ source: 'a', target: 'b' }],
  };
  const detail = await readRun(async path => {
    paths.push(path);
    if (path.includes('/run_detail?'))
      throw Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND' });
    return snapshot;
  }, 'fixture', 'run-1');
  assert.deepEqual(paths.map(path => path.split('/').at(-1).split('?')[0]), ['run_detail', 'snapshot']);
  assert.deepEqual(detail.runs.map(run => run.id), ['run-1']);
  assert.deepEqual(detail.executions.map(row => row.run_id), ['run-1']);
  assert.deepEqual(detail.candidates.map(row => row.run_id), ['run-1']);
  assert.deepEqual(detail.evaluations.map(row => row.id), ['evaluation-selected']);
  assert.deepEqual(detail.nodes, []);
  assert.deepEqual(detail.edges, []);
  assert.equal(detail.graph_paged, true);
});

test('unknown-resource and authorization errors do not trigger legacy fallback', async () => {
  for (const failure of [
    Object.assign(new Error('Not authorized'), { code: 'FORBIDDEN' }),
    Object.assign(new Error('Run not found'), { code: 'NOT_FOUND' }),
    Object.assign(new Error('Unknown repository operation'), { code: 'UNAUTHORIZED' }),
    Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND', status: 403 }),
    Object.assign(new Error('Unknown repository operation'), { code: 'NOT_FOUND', status: 401 }),
    Object.assign(new Error('Run not found'), { code: 'NOT_FOUND', status: 409 }),
  ]) {
    const paths = [];
    await assert.rejects(findCheckedRun(async path => {
      paths.push(path);
      throw failure;
    }, 'fixture'));
    assert.equal(paths.length, 1);
    assert.match(paths[0], /runs_page/);
  }
});

test('reviewer finds a checked example through metadata pages without reading source or starting work', async () => {
  const paths = [];
  const pages = [
    { items: [{ id: 'failed', status: 'failed', created_at: 4 }], next_cursor: 'opaque+cursor', watermark: 12 },
    { items: [{ id: 'checked', status: 'ready', created_at: 3 }], next_cursor: null, watermark: 12 },
  ];
  const run = await findCheckedRun(async path => { paths.push(path); return path.includes('/run_detail?') ? checkedDetail('checked') : pages.shift(); }, 'reviewer-fixture');
  assert.equal(run.id, 'checked');
  assert.equal(paths.length, 3);
  assert.match(paths[0], /runs_page/);
  assert.match(paths[1], /cursor=opaque%2Bcursor/);
  assert.match(paths[1], /watermark=12/);
  assert.ok(paths.every(path => !/snapshot|trial|candidate_source/.test(path)));
});

test('empty history is explicit and malformed or repeated page cursors fail closed', async () => {
  assert.equal(await findCheckedRun(async () => ({ items: [], next_cursor: null, watermark: 0 }), 'fixture'), null);
  await assert.rejects(findCheckedRun(async () => ({ items: null }), 'fixture'), /history response/);
  await assert.rejects(findCheckedRun(async () => ({ items: [], next_cursor: 'loop', watermark: 1 }), 'fixture'), /cursor/);
});

test('polling reads only the selected run and rejects a mismatched response', async () => {
  const paths = [];
  const detail = { runs: [{ id: 'run-1', status: 'ready' }], executions: [{ run_id: 'run-1' }] };
  assert.equal(await readRun(async path => { paths.push(path); return detail; }, 'fixture', 'run-1'), detail);
  assert.equal(paths[0], 'repos/fixture/run_detail?run_id=run-1');
  await assert.rejects(readRun(async () => ({ runs: [{ id: 'another' }], executions: [] }), 'fixture', 'run-1'), /selected run/);
});

test('ordinary checked discovery selects the newest owned result and ignores unavailable projects', async () => {
  const paths = [];
  const entry = await workspaceEntry(async path => {
    paths.push(path);
    if (path === 'repositories') return { repositories: [
      { id: 'first', status: 'ready' }, { id: 'latest', status: 'ready' },
      { id: 'preparing', status: 'provisioning' }, { id: 'deleted', status: 'deleted' },
    ] };
    const latest = path.includes('/latest/');
    if (path.includes('/run_detail?')) return checkedDetail(latest ? 'new' : 'old');
    return { items: [{ id: latest ? 'new' : 'old', status: 'ready', created_at: latest ? 20 : 10 }], watermark: 30, next_cursor: null };
  }, {});
  assert.equal(entry.run_id, 'new');
  assert.equal(entry.url, '/?repo=latest&run=new');
  assert.equal(paths.length, 5);
  assert.ok(paths.every(path => !/preparing|deleted|reviewer|candidate_source/.test(path)));
});

test('empty ordinary workspace offers browser approval but checked-only never starts work', async () => {
  const api = async path => {
    assert.equal(path, 'repositories');
    return { repositories: [] };
  };
  assert.equal((await workspaceEntry(api, {})).url, '/');
  assert.match((await workspaceEntry(api, { newTrial: true })).message, /No work was started/);
  await assert.rejects(workspaceEntry(api, { checkedOnly: true }), /never starts or resumes/);
});

test('allowance unavailable or malformed fails closed without guessing legacy authority', async () => {
  for (const failure of [
    new Error('Transport unavailable'),
    Object.assign(new Error('Unknown API route'), { code: 'NOT_FOUND', status: 403 }),
    Object.assign(new Error('Unknown workspace operation'), { code: 'NOT_FOUND', status: 500 }),
  ]) await assert.rejects(workspaceAllowance(async () => { throw failure; }));
  for (const response of [{}, { version: -1 }, { version: 1 }, { version: 1, remaining_microusd: -1 }])
    await assert.rejects(workspaceAllowance(async () => response), /Invalid shared workspace allowance/);
});

test('version-zero campaign explicit new and resume keep their original routes', async () => {
  const calls = [];
  const api = async (path, body) => { calls.push([path, body]); return { run_id: 'legacy' }; };
  await campaignEntry(api, { enabled: true }, true, 'same-request');
  await campaignEntry(api, { enabled: true, active_trial: 'active' }, false, 'unused', true);
  assert.deepEqual(calls, [['reviewer/campaign/trial', { request_id: 'same-request' }], ['reviewer/campaign/resume', {}]]);
});
