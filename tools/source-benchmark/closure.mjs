import { execFileSync } from 'node:child_process';
import { git } from './git.mjs';

/** Measure the actual new Git closure relative to a recipient already holding base. */
export function measureClosure(repository, commit, base) {
  const objects = git(repository, ['rev-list', '--objects', commit, `^${base}`])
    .split('\n')
    .map((line) => line.split(' ')[0]);
  const descriptions = git(
    repository,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${objects.join('\n')}\n` },
  ).split('\n');
  const counts = { blob: 0, tree: 0, commit: 0 };
  let blobBytes = 0,
    ancestorMetadataBytes = 0;
  for (const description of descriptions) {
    const [, kind, sizeText] = description.split(' ');
    const size = Number(sizeText);
    if (!(kind in counts) || !Number.isSafeInteger(size))
      throw new Error('Unexpected closure object');
    counts[kind]++;
    if (kind === 'blob') blobBytes += size;
    else ancestorMetadataBytes += size;
  }
  const pack = execFileSync('git', ['pack-objects', '--stdout', '--revs'], {
    cwd: repository,
    input: `${commit}\n^${base}\n`,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    counts,
    blob_bytes: blobBytes,
    ancestor_metadata_bytes: ancestorMetadataBytes,
    pack_bytes: pack.length,
    recipient_base_required: base,
  };
}
