#!/usr/bin/env node
// Generic driver-side browser check for a static site revision. It does not know the product:
// it checks that the site loads cleanly (assets, stylesheet, console), lays out at 1100px and
// 390px, takes light/dark screenshots, and runs the agents' own tests/app.browser.mjs.
// Off-origin requests are blocked and reported; the result is JSON. It is not an
// in-container evaluator check.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

export const testPath = 'tests/app.browser.mjs';
export const widths = [1100, 390];
const SERIF_DEFAULT = /^\s*("?Times New Roman"?|Times|serif)\s*$/i;
const OUTPUT_LIMIT = 16 * 1024;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Loopback static server confined to `dir` (symlinks resolved and re-checked). */
export async function serveDirectory(dir) {
  const root = await realpath(dir);
  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://local').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = await realpath(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

const bounded = (text) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]` : text);

/** Runs the agents' test in a permission-restricted child with an empty environment. */
async function agentTest({ endpoint, url, testFile: given, timeoutMs, redact }) {
  // Permission paths must be real paths (e.g. macOS /var -> /private/var).
  const testFile = await realpath(given);
  const runner = fileURLToPath(new URL('./browser-test-runner.mjs', import.meta.url));
  const entry = pathToFileURL(await realpath(fileURLToPath(import.meta.resolve('playwright-core')))).href;
  const playwright = await realpath(dirname(fileURLToPath(import.meta.resolve('playwright-core/package.json'))));
  const testDir = dirname(testFile);
  const child = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${testDir}`, `--allow-fs-read=${runner}`, `--allow-fs-read=${playwright}`, runner, endpoint, url, testFile, entry],
    { cwd: testDir, env: {}, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const collect = (chunk) => {
    if (output.length <= OUTPUT_LIMIT) output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const code = await new Promise((done) => {
    child.on('error', () => done(-1));
    child.on('close', (value) => done(value));
  });
  clearTimeout(timer);
  return { exit_code: code, timed_out: timedOut, output: redact(bounded(output.trim())) };
}

/**
 * Checks one site revision. Give `siteDir` (served locally) or `url`; `testFile` is the
 * revision's tests/app.browser.mjs, or null when the agents provided none (a failure).
 */
export async function runBrowserCheck({ url, siteDir, testFile = null, revision = null, outDir = null, timeoutMs = 60000, launch = {}, redact = (text) => String(text), meta = {} }) {
  check(Boolean(url) !== Boolean(siteDir), 'Give exactly one of url or siteDir');
  const served = siteDir ? await serveDirectory(siteDir) : null;
  const target = served?.url ?? url;
  const origin = new URL(target).origin;
  if (outDir) await mkdir(outDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const steps = [];
  const step = async (name, run) => {
    const begin = performance.now();
    const record = { name, status: 'pass' };
    try {
      const detail = await run();
      if (detail !== undefined) record.detail = JSON.parse(redact(JSON.stringify(detail)));
    } catch (error) {
      record.status = 'fail';
      record.detail = redact(error?.message ?? error).split('\n')[0].slice(0, 400);
    }
    record.duration_ms = Math.round(performance.now() - begin);
    steps.push(record);
    return record;
  };
  const server = await chromium.launchServer({ channel: 'chrome', headless: true, ...launch });
  const screenshots = [];
  const present = Boolean(testFile) && (await access(testFile).then(() => true, () => false));
  let agent = { present, status: 'fail', output: 'agents provided no browser tests' };
  let browserVersion = null;
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' });
    context.setDefaultTimeout(10000);
    const requests = [];
    const problems = [];
    const errors = [];
    // The site must be self-contained: anything off-origin is blocked and reported.
    await context.route('**/*', (route) => {
      const requested = new URL(route.request().url());
      if (requested.origin === origin || ['data:', 'blob:'].includes(requested.protocol)) return route.continue();
      problems.push({ url: redact(requested.href).slice(0, 200), blocked: 'off-origin request' });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('response', (response) => {
      const at = new URL(response.url());
      if (at.origin !== origin || at.pathname === '/favicon.ico') return;
      const item = { url: redact(at.pathname), type: response.request().resourceType(), status: response.status() };
      requests.push(item);
      if (item.status !== 200 && item.status !== 304) problems.push(item);
    });
    page.on('requestfailed', (request) => {
      const at = new URL(request.url());
      if (at.origin === origin && at.pathname !== '/favicon.ico')
        problems.push({ url: redact(at.pathname), type: request.resourceType(), failure: request.failure()?.errorText });
    });
    page.on('console', (message) => {
      // Chrome's automatic favicon probe is not a site request.
      if (message.type() === 'error' && !/\/favicon\.ico$/.test(message.location()?.url ?? ''))
        errors.push(redact(message.text()).slice(0, 300));
    });
    page.on('pageerror', (error) => errors.push(redact(`pageerror: ${error.message}`).slice(0, 300)));
    await step('assets_and_styles', async () => {
      const response = await page.goto(target, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      check(response?.ok(), `Document returned ${response?.status()}`);
      const style = await page.evaluate(() => ({
        stylesheets: [...document.querySelectorAll('link[rel~=stylesheet]')].map((link) => Boolean(link.sheet)),
        sheets: document.styleSheets.length,
        font_family: getComputedStyle(document.body).fontFamily,
      }));
      check(!problems.length, `Requests failed: ${JSON.stringify(problems.slice(0, 5))}`);
      check(style.sheets > 0 && style.stylesheets.every(Boolean), 'No stylesheet applied');
      check(!SERIF_DEFAULT.test(style.font_family), `Body font is the browser default (${style.font_family})`);
      return { requests: requests.length, ...style };
    });
    await step('no_console_errors', async () => {
      check(!errors.length, errors.slice(0, 5).join(' | '));
    });
    for (const width of widths)
      await step(`no_horizontal_overflow_${width}`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        check(size.scroll <= size.client + 1, `Page is ${size.scroll}px wide in a ${size.client}px viewport`);
        return size;
      });
    if (outDir)
      await step('screenshots', async () => {
        for (const width of widths)
          for (const scheme of ['light', 'dark']) {
            await page.setViewportSize({ width, height: 900 });
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(150);
            const file = `${width}-${scheme}.png`;
            await page.screenshot({ path: join(outDir, file), fullPage: true });
            screenshots.push(file);
          }
        return { files: screenshots };
      });
    await context.close();
    await browser.close();
    await step('agent_browser_tests', async () => {
      check(present, 'agents provided no browser tests');
      agent = { present: true, ...(await agentTest({ endpoint: server.wsEndpoint(), url: target, testFile, timeoutMs, redact })) };
      agent.status = agent.exit_code === 0 && !agent.timed_out ? 'pass' : 'fail';
      check(!agent.timed_out, `Agent browser test exceeded ${timeoutMs} ms`);
      check(agent.exit_code === 0, agent.output.split('\n').find((line) => /failed|error/i.test(line)) ?? `exit ${agent.exit_code}`);
      return { exit_code: agent.exit_code };
    });
  } finally {
    await server.close().catch(() => {});
    await served?.close();
  }
  const failed = steps.filter((item) => item.status !== 'pass').map((item) => item.name);
  const finished = Date.now();
  const result = {
    schema: 'browser-check-v1',
    ...meta,
    revision,
    url: siteDir ? 'local-static-server' : redact(target),
    outcome: failed.length ? 'fail' : 'pass',
    failed,
    steps,
    agent_tests: { path: testPath, ...agent },
    screenshots,
    browser: { channel: 'chrome', version: browserVersion },
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
    duration_ms: finished - started,
  };
  if (outDir) await writeFile(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

export const usage = `node tools/guided/browser-check.mjs (--site DIR | --url http://127.0.0.1:PORT/) [--root DIR | --tests FILE] [--revision SHA] [--out DIR] [--timeout-ms N]
--root is the revision checkout (tests at <root>/${testPath}); with --site alone it defaults to the site's parent.
Prints the result JSON on stdout; exits 1 when any check fails or the agents provided no browser tests.`;

export function parseCheckArgs(args) {
  const names = { '--site': 'site', '--url': 'url', '--root': 'root', '--tests': 'tests', '--revision': 'revision', '--out': 'out', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return { help: true };
    const key = names[args[index]];
    check(key && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid browser-check arguments; use --help');
    options[key] = args[++index];
  }
  check(Boolean(options.site) !== Boolean(options.url), 'Give exactly one of --site or --url');
  if (options.url) {
    const local = new URL(options.url);
    check(['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname), 'Only a loopback --url is allowed');
  }
  check(!options.revision || /^[a-f0-9]{7,64}$/.test(options.revision), 'Revision must be a commit id');
  options.timeoutMs = Number(options.timeoutMs ?? 60000);
  check(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 600000, 'Timeout must be 1..600000 ms');
  const root = options.root ?? (options.site ? dirname(resolve(options.site)) : null);
  options.testFile = options.tests ? resolve(options.tests) : root ? resolve(root, testPath) : null;
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseCheckArgs(args);
  if (options.help) return console.log(usage);
  const result = await runBrowserCheck({
    url: options.url,
    siteDir: options.site,
    testFile: options.testFile,
    revision: options.revision ?? null,
    outDir: options.out ? resolve(options.out) : null,
    timeoutMs: options.timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.log(JSON.stringify({ schema: 'browser-check-v1', outcome: 'error', error: String(error?.message ?? error).split('\n')[0].slice(0, 300) }));
    process.exitCode = 1;
  });
