import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCheckArgs, runBrowserCheck } from './browser-check.mjs';

const fixture = new URL('./fixtures/browser-check-app/', import.meta.url);
const revision = 'f'.repeat(40);

/** Copies the fixture app, applies `change(root)`, and runs the check with screenshots. */
async function check(change = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-check-'));
  try {
    await cp(fixture, root, { recursive: true });
    await change(root);
    const outDir = join(root, 'out');
    const result = await runBrowserCheck({
      siteDir: join(root, 'public'),
      testFile: join(root, 'tests/app.browser.mjs'),
      revision,
      outDir,
      timeoutMs: 30000,
    });
    return { result, files: await readdir(outDir), saved: JSON.parse(await readFile(join(outDir, 'result.json'), 'utf8')) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const statuses = (result) => Object.fromEntries(result.steps.map((step) => [step.name, step.status]));

test('clean site with passing agent browser test passes', { timeout: 90000 }, async () => {
  const { result, files, saved } = await check();
  assert.equal(result.outcome, 'pass', JSON.stringify(result.steps));
  assert.equal(result.agent_tests.status, 'pass');
  assert.match(result.agent_tests.output, /counter increments/);
  assert.deepEqual(saved.failed, []);
  assert.equal(saved.revision, revision);
  for (const name of ['1100-light.png', '1100-dark.png', '390-light.png', '390-dark.png', 'result.json'])
    assert.ok(files.includes(name), name);
});

test('failing agent browser test fails the check with its output', { timeout: 90000 }, async () => {
  const { result } = await check((root) =>
    writeFile(join(root, 'tests/app.browser.mjs'), "export async function run(page, url) { await page.goto(url); throw new Error('agent assertion: total stayed 0'); }\n"),
  );
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(result.failed, ['agent_browser_tests']);
  assert.match(result.agent_tests.output, /agent assertion: total stayed 0/);
});

test('agent test cannot read operator files or environment', { timeout: 90000 }, async () => {
  const { result } = await check((root) =>
    writeFile(
      join(root, 'tests/app.browser.mjs'),
      "import { readFileSync } from 'node:fs';\nexport default async function () { console.log('inherited', ['HOME', 'PATH', 'USER'].some((key) => key in process.env)); readFileSync(new URL('../public/index.html', import.meta.url)); }\n",
    ),
  );
  assert.equal(result.agent_tests.status, 'fail');
  assert.match(result.agent_tests.output, /inherited false/);
  assert.match(result.agent_tests.output, /ERR_ACCESS_DENIED|restricted/);
});

test('missing stylesheet fails asset checks and still runs the agent test', { timeout: 90000 }, async () => {
  const { result } = await check((root) => rm(join(root, 'public/style.css')));
  assert.equal(result.outcome, 'fail');
  const steps = statuses(result);
  assert.equal(steps.assets_and_styles, 'fail');
  assert.equal(steps.no_console_errors, 'fail');
  assert.equal(steps.agent_browser_tests, 'pass');
  assert.match(result.steps[0].detail, /style\.css/);
});

test('missing agent tests is reported without failing the generic check', { timeout: 90000 }, async () => {
  const { result } = await check((root) => rm(join(root, 'tests'), { recursive: true }));
  assert.equal(result.outcome, 'pass');
  assert.equal(result.agent_tests.status, 'absent');
  assert.equal(result.agent_tests.output, 'agents provided no browser tests');
  assert.equal(result.agent_tests.present, false);
});

test('arguments: loopback URLs only, tests default to the site parent', () => {
  assert.throws(() => parseCheckArgs(['--url', 'https://example.com/']), /loopback/);
  assert.throws(() => parseCheckArgs(['--site', 'a', '--url', 'http://127.0.0.1:1/']), /exactly one/);
  assert.throws(() => parseCheckArgs(['--site', 'a', '--revision', 'not-a-sha']), /commit id/);
  assert.match(parseCheckArgs(['--site', '/x/public']).testFile, /^\/x\/tests\/app\.browser\.mjs$/);
});
