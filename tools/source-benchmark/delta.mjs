import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { measureClosure } from './closure.mjs';
import { sha256 } from './content.mjs';
import { git } from './git.mjs';

/** Local authority fixture: seed metadata from the parent tree and submit one new blob.
 * This case is not a SourceWorkspace, remote transport or Linux mount measurement.
 */
export async function captureDeltaCase(fixturePath) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const change = fixture.changed_files?.[0];
  if (
    fixture.version !== 1 ||
    !isAbsolute(fixture.repository) ||
    fixture.changed_files.length !== 1 ||
    !/^[a-f0-9]{40}$/.test(fixture.base?.commit ?? '') ||
    !/^data\/\d{3}\/\d{5}\.bin$/.test(change?.path ?? '')
  )
    throw new Error('Expected the generated one-file local delta fixture');
  const content = await readFile(change.content_file);
  if (content.length !== change.bytes || sha256(content) !== change.sha256)
    throw new Error('Changed fixture bytes differ from their recorded identity');
  const temp = await mkdtemp(join(tmpdir(), 'source-delta-index-'));
  try {
    const env = {
      GIT_INDEX_FILE: join(temp, 'index'),
      GIT_AUTHOR_DATE: '2000-01-01T00:01:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:01:00Z',
    };
    const start = performance.now();
    git(fixture.repository, ['read-tree', fixture.base.commit], { env });
    const blob = git(fixture.repository, ['hash-object', '-w', '--stdin'], { env, input: content });
    git(
      fixture.repository,
      ['update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`],
      { env },
    );
    const tree = git(fixture.repository, ['write-tree'], { env });
    const commit = git(
      fixture.repository,
      [
        'commit-tree',
        tree,
        '-p',
        fixture.base.commit,
        '-m',
        'Deterministic one-file source API capture fixture',
      ],
      { env },
    );
    return {
      version: 1,
      kind: 'local-git-delta-case',
      parent: fixture.base.commit,
      parent_tree: fixture.base.tree,
      commit,
      tree,
      changed_paths: [change.path],
      changed_bytes: content.length,
      capture_ms: performance.now() - start,
      object_closure: measureClosure(fixture.repository, commit, fixture.base.commit),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--fixture')
      throw new Error('Usage: delta.mjs --fixture FIXTURE_JSON');
    console.log(JSON.stringify(await captureDeltaCase(args[1])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
