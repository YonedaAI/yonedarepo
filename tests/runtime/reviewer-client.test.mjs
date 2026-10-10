import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCheckedRun, readRun } from '../../tools/reviewer-client.mjs';

test('reviewer finds a checked example through stable metadata pages', async () => {
  const paths = [];
  const pages = [
    { items: [{ id: 'failed', status: 'failed' }], next_cursor: 'opaque+cursor', watermark: 12 },
    { items: [{ id: 'checked', status: 'ready' }], next_cursor: null, watermark: 12 },
  ];
  const run = await findCheckedRun(async path => { paths.push(path); return pages.shift(); }, 'fixture');
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
    if (path.endsWith('/snapshot')) return { runs: [
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
    candidates: [{ run_id: 'run-1' }, { run_id: 'other' }],
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
  assert.deepEqual(detail.nodes, []);
  assert.deepEqual(detail.edges, []);
  assert.equal(detail.graph_paged, true);
});

test('unknown-resource and authorization errors do not trigger legacy fallback', async () => {
  for (const failure of [
    Object.assign(new Error('Not authorized'), { code: 'FORBIDDEN' }),
    Object.assign(new Error('Run not found'), { code: 'NOT_FOUND' }),
    Object.assign(new Error('Unknown repository operation'), { code: 'UNAUTHORIZED' }),
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
  const run = await findCheckedRun(async path => { paths.push(path); return pages.shift(); }, 'reviewer-fixture');
  assert.equal(run.id, 'checked');
  assert.equal(paths.length, 2);
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
