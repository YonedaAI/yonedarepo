import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCheckedRun, readRun } from '../../tools/reviewer-client.mjs';

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
