// Repository pages live at `/<handle>/<name>`; `/source/<id>` still opens them, by redirect. The
// flows know a repository by id, so this asks the API for its readable path (`/source/<id>`
// while its owner has no handle) and waits for that address.
const known = new Map();

/** The repository's page address, from the API once per id. */
export async function repoPath(account, id) {
  if (!known.has(id)) {
    const { path } = await account.get(`/api/v1/repos/${id}`);
    known.set(id, path ?? `/source/${id}`);
  }
  return known.get(id);
}

/** Waits for the page at `rest` (like `/changes`) of repository `id`. */
export async function atRepo(page, account, id, rest = '') {
  await page.waitForURL(`**${await repoPath(account, id)}${rest}`);
}

/** Opens a repository from the sidebar's picker, there on every page but the settings ones. An
 * option's name is `name` or `owner/name`, with `, public` and the like after it. */
export async function openRepo(page, name) {
  if (new URL(page.url()).pathname.startsWith('/settings'))
    await page.getByRole('navigation', { name: 'Browse' }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /^(Choose a repository|Switch repository)/ }).click();
  await page.getByRole('combobox', { name: 'Find repositories' }).fill(name);
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('option', { name: new RegExp(`^([^/]+/)?${literal}(,|$)`) }).click();
}
