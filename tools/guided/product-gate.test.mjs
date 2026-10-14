import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { productGateStep } from './post-review.mjs';
import { agentTests, gateSummary, redactor, resolvePreview, runProductGate } from './product-gate.mjs';

const repo = `repo-${'a'.repeat(32)}`;
const revision = 'c'.repeat(40);
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJkaWdlc3QiOiJ4In0.c2lnbmF0dXJl';
const previewUrl = `https://sites.example/v/${'d'.repeat(64)}/${token}/`;

function api({ files = { 'tests/app.browser.mjs': { content: 'export default async () => {}' } } } = {}) {
  const calls = [];
  const handler = async (path) => {
    calls.push(path);
    if (path.endsWith('/snapshot'))
      return { runs: [], executions: [], evaluations: [{ id: 'evaluation:1', candidate: 'candidate:1', revision: { commit: revision } }] };
    if (path.includes('/site_preview?')) return { url: previewUrl, expires_in: 3600 };
    if (path.includes('/candidate_source?')) return { files };
    if (path.includes('/events?')) return { events: [] };
    throw new Error(`unexpected ${path}`);
  };
  return { handler, calls };
}

test('preview resolution binds the exact evaluation, candidate and revision', async () => {
  const { handler } = api();
  const found = await resolvePreview(handler, repo, { evaluation: 'evaluation:1', candidate: 'candidate:1', revision });
  assert.equal(found.revision, revision);
  await assert.rejects(resolvePreview(handler, repo, { evaluation: 'evaluation:1', candidate: 'candidate:2' }), /different candidate/);
  await assert.rejects(resolvePreview(handler, repo, { evaluation: 'evaluation:1', revision: 'e'.repeat(40) }), /revision differs/);
  await assert.rejects(resolvePreview(handler, repo, { evaluation: 'evaluation:9' }), /not found/);
});

test('signed preview token is redacted from persisted text', () => {
  assert.equal(redactor(previewUrl)(`${previewUrl}app.mjs 404`), `https://sites.example/v/${'d'.repeat(64)}/[token]/app.mjs 404`);
});

test('agent tests come from the candidate revision tests/ directory only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tests-'));
  try {
    const files = {
      'tests/app.browser.mjs': { content: "import './helper.mjs';" },
      'tests/helper.mjs': { content: 'export {}' },
      'public/app.mjs': { content: 'ignored' },
      'tests/../escape.mjs': { content: 'refused' },
    };
    const path = await agentTests(api({ files }).handler, repo, 'candidate:1', dir);
    assert.equal(path, join(dir, 'tests/app.browser.mjs'));
    assert.equal(await readFile(join(dir, 'tests/helper.mjs'), 'utf8'), 'export {}');
    await assert.rejects(readFile(join(dir, 'public/app.mjs')));
    await assert.rejects(readFile(join(dir, 'escape.mjs')));
    assert.equal(await agentTests(api({ files: {} }).handler, repo, 'candidate:1', dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('driver post-step gates the checked final result and records timing and readiness', async () => {
  const { handler } = api();
  const seen = [];
  const browserCheck = async (input) => {
    seen.push(input);
    return { revision: input.revision, ...input.meta, outcome: 'fail', failed: ['agent_browser_tests'], agent_tests: { status: 'fail' }, steps: [{ name: 'agent_browser_tests', status: 'fail', duration_ms: 3 }], duration_ms: 9, finished_at: 'now' };
  };
  const state = {
    repo_id: repo,
    steps: { concurrent: { run_ids: [], checked: { candidate_id: 'candidate:1', evaluation_id: 'evaluation:1', revision: { commit: revision } } } },
  };
  const saved = [];
  const outcome = await productGateStep({ api: handler }, state, {
    outRoot: '/tmp/gate-root',
    save: async (value) => saved.push(structuredClone(value)),
    gate: (client, id, options) => runProductGate(client, id, { ...options, check: browserCheck }),
  });
  assert.equal(seen[0].url, previewUrl);
  assert.equal(seen[0].outDir, `/tmp/gate-root/${revision}`);
  assert.match(seen[0].testFile, /tests\/app\.browser\.mjs$/);
  assert.equal(outcome.demo_ready, false);
  assert.equal(saved.at(-1).product_gate.outcome, 'fail');
  assert.equal(saved.at(-1).product_gate.kind, 'driver_side_browser_check');
  assert.equal(saved.at(-1).timing.schema, 'guided-timing-v1');
  assert.ok(!JSON.stringify(saved).includes(token), 'token never stored in driver state');
  await assert.rejects(productGateStep({ api: handler }, { repo_id: repo, steps: {} }), /No checked final result/);
  assert.equal(gateSummary({ ...outcome.product_gate, steps: [] }, '/x').result_path, '/x/result.json');
});
