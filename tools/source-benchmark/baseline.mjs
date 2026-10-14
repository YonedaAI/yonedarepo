import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { git } from './git.mjs';

async function sizes(root, { skipGit = false, suffix } = {}) {
  let bytes = 0,
    files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (skipGit && entry.name === '.git') continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Benchmark fixtures must contain regular files');
    if (entry.isDirectory()) {
      const nested = await sizes(path, { skipGit, suffix });
      bytes += nested.bytes;
      files += nested.files;
    } else if (!suffix || entry.name.endsWith(suffix)) {
      bytes += (await lstat(path)).size;
      files++;
    }
  }
  return { bytes, files };
}

/** file:// plus --no-local forces Git to transfer a pack, rather than hard-link objects. */
export async function fullCloneBaseline(fixturePath, output) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (
    fixture.version !== 1 ||
    !isAbsolute(fixture.repository) ||
    !/^[a-f0-9]{40}$/.test(fixture.base?.commit ?? '')
  )
    throw new Error('Expected a generated local fixture');
  if (!(await lstat(join(fixture.repository, '.git'))).isDirectory())
    throw new Error('Baseline requires an actual local Git repository');
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await lstat(destination);
    throw new Error('Clone destination already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const start = performance.now();
  git(
    dirname(destination),
    ['clone', '--no-local', '--', pathToFileURL(fixture.repository).href, destination],
    {
      env: { GIT_ALLOW_PROTOCOL: 'file' },
    },
  );
  const cloneMs = performance.now() - start;
  const checkout = await sizes(destination, { skipGit: true });
  const objects = await sizes(join(destination, '.git', 'objects'), { suffix: '.pack' });
  const metadata = await sizes(join(destination, '.git'));
  const commit = git(destination, ['rev-parse', 'HEAD']);
  const tree = git(destination, ['rev-parse', 'HEAD^{tree}']);
  if (
    commit !== fixture.base.commit ||
    tree !== fixture.base.tree ||
    checkout.files !== fixture.file_count ||
    checkout.bytes !== fixture.base_bytes
  )
    throw new Error('Clone differs from the fixture authority');
  return {
    version: 1,
    kind: 'local-full-git-clone',
    commit,
    tree,
    clone_ms: cloneMs,
    checkout_files: checkout.files,
    checkout_bytes: checkout.bytes,
    packed_git_object_bytes: objects.bytes,
    git_metadata_bytes: metadata.bytes,
    history_commits: Number(git(destination, ['rev-list', '--count', 'HEAD'])),
    requested_paths: fixture.requested_paths,
    requested_blob_bytes: fixture.requested_bytes,
    fixture_files: fixture.file_count,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--fixture' || args[2] !== '--out')
      throw new Error('Usage: baseline.mjs --fixture FIXTURE_JSON --out NEW_CLONE_DIRECTORY');
    console.log(JSON.stringify(await fullCloneBaseline(args[1], args[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
