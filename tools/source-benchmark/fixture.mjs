import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureBytes, fixturePaths, requestedPaths, sha256 } from './content.mjs';
import { commit, git } from './git.mjs';

export async function createFixture(
  output,
  { files = 10000, bytes = 4096, seed = 'yoneda-source-api-v1' } = {},
) {
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 65536)
    throw new Error('Per-file bytes must be 1024–65536');
  const paths = fixturePaths(files);
  const requested = requestedPaths(paths);
  const unread = paths.find((path) => !requested.includes(path));
  const root = resolve(output);
  await mkdir(dirname(root), { recursive: true });
  try {
    await mkdir(root);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Fixture destination already exists');
    throw error;
  }
  const repository = join(root, 'repo');
  await mkdir(repository);
  for (const path of paths) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), fixtureBytes(seed, path, bytes));
  }
  git(repository, ['init', '-b', 'main']);
  commit(repository, 'Deterministic pseudorandom source', 0);
  await writeFile(join(repository, unread), fixtureBytes(seed, unread, bytes, 'historical'));
  commit(repository, 'Historical unread content must not reach lazy agent', 1);
  await writeFile(join(repository, unread), fixtureBytes(seed, unread, bytes));
  commit(repository, 'Exact current source authority', 2);
  const delta = join(root, 'delta');
  await mkdir(delta);
  const changed = fixtureBytes(seed, requested[0], bytes, 'changed');
  const contentFile = join(delta, 'changed.bin');
  await writeFile(contentFile, changed);
  const fixture = {
    version: 1,
    seed,
    repository,
    file_count: files,
    bytes_per_file: bytes,
    base_bytes: files * bytes,
    requested_paths: requested,
    requested_bytes: requested.length * bytes,
    base: {
      commit: git(repository, ['rev-parse', 'HEAD']),
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
    },
    history_commits: 3,
    changed_files: [
      { path: requested[0], content_file: contentFile, bytes, sha256: sha256(changed) },
    ],
    sealed_unread: { path: unread, bytes, sha256: sha256(fixtureBytes(seed, unread, bytes)) },
  };
  await writeFile(join(root, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

function argumentsFor(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (
      !['--out', '--files', '--bytes', '--seed'].includes(key) ||
      argv[index + 1] === undefined ||
      key in args
    )
      throw new Error(
        'Usage: fixture.mjs --out NEW_DIRECTORY [--files 10000] [--bytes 4096] [--seed SEED]',
      );
    args[key] = argv[index + 1];
  }
  if (!args['--out']) throw new Error('--out NEW_DIRECTORY is required');
  return {
    output: args['--out'],
    options: {
      files: args['--files'] === undefined ? 10000 : Number(args['--files']),
      bytes: args['--bytes'] === undefined ? 4096 : Number(args['--bytes']),
      seed: args['--seed'] ?? 'yoneda-source-api-v1',
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, options } = argumentsFor(process.argv.slice(2));
    console.log(JSON.stringify(await createFixture(output, options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
