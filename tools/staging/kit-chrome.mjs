// A headless Chrome for a feature item of the kit, already signed in with the session the run
// holds. No login form: every sign-in is one more session on an account that keeps ten, and the
// form has its own gate (`browser`). Screenshots go to .local/staging/<name>-<ts>/; a failure adds
// the page's text and what the console and network said there, scrubbed of the cookie.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { scrub } from './browser-flow.mjs';
import { OWN_TRAFFIC } from './client.mjs';

/** A Cookie header's one pair as Playwright's cookie for `origin`. */
function sessionCookie(cookie, origin) {
  const at = cookie.indexOf('=');
  return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: origin, httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'Lax' };
}

/**
 * Runs `body({ page, context, shot, problems })` in a Chrome holding `cookie`. `name` names the
 * evidence directory, `viewport` the window, and `clipboard` lets the page use the clipboard.
 */
export async function withChrome({ origin, root, cookie, headed = false, name, viewport = { width: 1440, height: 1000 }, clipboard = false }, m, body) {
  const dir = join(root, `.local/staging/${name}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  m[`${name}_evidence`] = relative(root, dir);
  const secrets = [cookie.slice(cookie.indexOf('=') + 1)];
  const problems = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  try {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: OWN_TRAFFIC });
    await context.addCookies([sessionCookie(cookie, origin)]);
    if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('response', (response) => response.status() >= 400 && problems.push(`http ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`));
    let shots = 0;
    const shot = (label) => page.screenshot({ path: join(dir, `${String(++shots).padStart(2, '0')}-${label}.png`), fullPage: true });
    try {
      return await body({ page, context, shot, problems });
    } catch (error) {
      await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true }).catch(() => {});
      const text = await page.locator('body').innerText().catch((e) => `page text unavailable: ${e.message}`);
      await writeFile(join(dir, 'failure.txt'), scrub(`${error.message}\n\nURL: ${page.url()}\n\n${text.slice(0, 20_000)}\n\n${problems.join('\n')}\n`, secrets));
      throw error;
    }
  } finally {
    await browser.close();
    if (problems.length) await writeFile(join(dir, 'console.txt'), scrub(`${problems.join('\n')}\n`, secrets));
    m[`${name}_console_errors`] = problems.length;
  }
}

/** A row of a table or list: the one holding `text`. */
export const rowWith = (scope, role, text) => scope.getByRole(role).filter({ hasText: text });
