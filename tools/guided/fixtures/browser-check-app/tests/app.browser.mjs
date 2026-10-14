// Fixture stand-in for the agents' own browser test.
export default async function (page, url) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Add one' }).click();
  await page.getByRole('button', { name: 'Add one' }).click();
  const total = await page.locator('#total').textContent();
  if (total !== '2') throw new Error(`expected total 2, saw ${total}`);
  console.log('counter increments');
}
