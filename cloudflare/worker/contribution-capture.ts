// Capture of an external contribution: the submitted commit's tree is rebuilt as a fresh
// platform commit on the frozen base, from the platform's own diff of the two trees, and set
// on the attempt's candidate branch. The contributor's history never becomes a candidate.
// Like refresh, this runs in the Worker: no container and no model.
import { platformRevision, repositoryPlatform } from './agents-platform';
import { CANDIDATE_DIFF_LIMIT } from './evidence';
import { captureFileProvenance } from './provenance';
import { platformSource } from './source-objects';
import { object, sha } from './storage';
import type { Env, Json, Scope } from './types';

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'INVALID_CAPTURE' });
};

/** Platform changes that turn `base` into the submitted tree, naming only recorded blobs. */
function rebuild(changes: Json[]): Json[] {
  const out: Json[] = [];
  for (const change of changes) {
    if (change.op === 'delete' || change.op === 'rename')
      out.push({ path: change.op === 'rename' ? change.old_path : change.path, delete: true });
    if (change.op === 'delete') continue;
    if (!['blob', 'exec'].includes(change.new?.type))
      fail('Contributions contain only regular files');
    out.push({ path: change.path, blob: change.new.id, type: change.new.type });
  }
  return out;
}

export async function captureContribution(env: Env, scope: Scope): Promise<Json> {
  const job = scope.job;
  const { base, contribution } = job.payload;
  const repository = platformRevision(scope.repo_id);
  if (base?.repository !== repository || contribution?.repository !== repository)
    fail('Contribution is outside this repository');
  const platform = await repositoryPlatform(env, scope.repo_id);
  const source = platformSource(platform);
  const submitted = await source.readCommit(contribution.commit);
  if (!submitted) return fail('Submitted contribution commit is unavailable');
  const branch = `agents/capture-${(await sha(`${scope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
  const rebuilt = async (commit: string | null) => {
    const actual = commit ? await source.readCommit(commit) : null;
    return actual &&
      actual.treeHash === submitted.treeHash &&
      JSON.stringify(actual.parents) === JSON.stringify([base.commit])
      ? actual
      : null;
  };
  let captured = await rebuilt(await source.head(branch));
  if (!captured) {
    const diff = await platform.call(
      'GET',
      `/diff?base=${base.commit}&head=${contribution.commit}`,
    );
    if (!diff.changes.length) fail('The contribution changes nothing');
    const made = await platform.call('POST', '/commits', {
      parent: base.commit,
      changes: rebuild(diff.changes),
      message: `External contribution ${job.payload.execution.id}`,
      author: { name: 'YonedaRepo capture', email: 'capture@yonedarepo.invalid' },
    });
    captured = await rebuilt(made.commit);
    if (!captured) return fail('The rebuilt contribution differs from the submitted tree');
    await platform.call('POST', '/branches', { ref: branch, commit: made.commit, expected: null });
  }
  const commit = captured.hash;
  const fileProvenance = await captureFileProvenance(source, base.commit, commit);
  const paths = [
    ...new Set(fileProvenance.flatMap((f: Json) => [f.path, f.old_path]).filter(Boolean)),
  ].sort();
  const patch = await platform.call('GET', `/diff?base=${base.commit}&head=${commit}&patch=1`);
  const text = patch.changes
    .map((c: Json) => c.patch ?? `Binary or large file ${c.path} changed\n`)
    .join('');
  return {
    op: 'finish',
    job_id: job.id,
    epoch: job.epoch,
    result: {
      id: `contribution-${(await sha(`${scope.repo_id}:${commit}`)).slice(0, 32)}`,
      revision: { repository, commit },
      parents: captured.parents,
      tree: captured.treeHash,
      paths,
      file_provenance: fileProvenance,
      summary: 'External contribution',
      diff_digest: (await object(env, text, CANDIDATE_DIFF_LIMIT)).digest,
    },
  };
}
