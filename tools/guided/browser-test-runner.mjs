// Child process for the agents' browser test. The parent starts it under the Node permission
// model with read access to the test directory and playwright-core only, no write, child
// process, worker or addon permission, and an empty environment. It connects to a browser the
// parent launched, so the test receives a Playwright page but never the operator's files or
// credentials. Output is bounded and captured by the parent.
import { pathToFileURL } from 'node:url';
// playwright-core arrives as an absolute file URL: package resolution would need wider reads.
const [endpoint, url, testFile, playwright] = process.argv.slice(2);
const { chromium } = await import(playwright);
const browser = await chromium.connect(endpoint);
let failure = null;
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const module = await import(pathToFileURL(testFile).href);
  const test = typeof module.default === 'function' ? module.default : module.run;
  if (typeof test !== 'function')
    throw new Error('tests/app.browser.mjs must export default async function (page, url) or run(page, url)');
  await test(page, url);
} catch (error) {
  failure = error;
} finally {
  await browser.close().catch(() => {});
}
if (failure) {
  console.error(`agent browser test failed: ${String(failure?.stack ?? failure).slice(0, 4000)}`);
  process.exitCode = 1;
} else console.log('agent browser test passed');
