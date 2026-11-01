// Repositories kept between runs (docs/load-testing.md: prepare them ahead and reuse them).
// The saved file holds ids and names only, under .local/ with the evidence. Nothing here
// deletes a repository: test repositories stay for the next run.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const poolPath = (name) => resolve(root, `.local/platform-live/pool-${name}.json`);

export async function readPool(file, target) {
  const text = await readFile(file, 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (text === null) return [];
  const pool = JSON.parse(text);
  if (pool.target !== target) throw new Error(`${file} belongs to ${pool.target}, not ${target}`);
  return pool.repos;
}

async function savePool(file, target, repos) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ target, saved_at: new Date().toISOString(), repos }, null, 2)}\n`);
}

/** Runs `work` over `items`, `width` at a time. */
export async function waves(items, width, work) {
  const out = [];
  for (let i = 0; i < items.length; i += width) out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return out;
}

/** `size` repository ids from `file`: saved ones that still answer, then new ones. Saved
 * repositories past `size` stay in the file for a larger run. The file is saved after each wave
 * of creations, so a failed setup keeps what it made. */
export async function ensurePool(session, { file, size, prefix, width = 20 }) {
  const saved = await readPool(file, session.url);
  const asked = saved.slice(0, size);
  const rest = saved.slice(size);
  const alive = await waves(asked, width, async (repo) => ((await session.call('GET', `/repos/${repo.id}/refs`)).status === 200 ? repo : null));
  const repos = alive.filter(Boolean);
  if (repos.length < asked.length) console.error(`${asked.length - repos.length} saved repositories no longer answer; replacing them`);
  const stamp = Date.now();
  for (let i = 0, missing = size - repos.length; i < missing; i += width) {
    const wave = Array.from({ length: Math.min(width, missing - i) }, (_, k) => `${prefix}-${stamp}-${i + k}`);
    repos.push(...(await Promise.all(wave.map((name) => session.createKept(name)))));
    await savePool(file, session.url, [...repos, ...rest]);
  }
  return repos.map((r) => r.id);
}
