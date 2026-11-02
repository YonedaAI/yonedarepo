// The pages web-agents-flow.mjs --looks holds to the UI rules, wide and 375 px, light and dark, with
// no sideways scroll on the page: the commit form, its error and the keyboard, then a Landing's
// Instruments and Settings → Landing rules. Nothing here commits.
import assert from 'node:assert/strict';

const SIZES = [['wide', 1440], ['phone', 375]];
const SCHEMES = ['light', 'dark'];

async function eachSize(s, visit) {
  const { page } = s;
  const seen = [];
  for (const [label, width] of SIZES)
    for (const colorScheme of SCHEMES) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await visit(`${label}-${colorScheme}`);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sideways <= 0, `${label} ${colorScheme}: the page scrolls sideways by ${sideways}px`);
      seen.push(`${label} ${colorScheme}`);
    }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  return seen.join(', ');
}

export async function lookAtForm(s) {
  const { page } = s;
  const form = page.getByRole('form', { name: 'Add a file' });
  const seen = await eachSize(s, async (size) => {
    await page.goto(`${s.origin}${s.base}/files`);
    await page.getByRole('button', { name: 'Add file' }).click();
    await form.waitFor();
    await form.getByLabel('File').fill('src/a.js');
    await form.getByLabel('Branch').fill('main');
    await form.getByRole('button', { name: 'Save' }).click();
    await form.getByText(/Main moves only by landing/).waitFor();
    await s.shot(`form-${size}`);
  });
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add file' }).focus();
  await page.keyboard.press('Enter');
  await form.waitFor();
  const focused = await page.evaluate(() => document.activeElement?.closest('label')?.textContent?.trim());
  assert.equal(focused, 'File', 'the keyboard lands on the first field');
  await page.keyboard.press('Escape');
  return `${seen}; Escape closes, Enter opens on File`;
}

/** The Risk card on Landing `number`, and the help under the Landing rules switches. */
export async function lookAtPages(s, number) {
  const { page } = s;
  return eachSize(s, async (size) => {
    await page.goto(`${s.origin}${s.base}/changes/${number}`);
    await page.locator('.source-instruments').getByText(/Risk/).first().waitFor();
    await s.shot(`risk-card-${size}`);
    await page.goto(`${s.origin}${s.base}/settings`);
    await page.getByRole('checkbox', { name: 'Land when cleared' }).waitFor();
    await s.shot(`settings-help-${size}`);
  });
}
