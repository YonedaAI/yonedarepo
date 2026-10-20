// Refresh a checked candidate onto the current target with the platform's server-side merge.
// The ledger reserved the refresh (frozen base, head, candidate and declared paths); this
// Worker step runs no container and no model, and the ledger validates every readback.
import { platformRevision, repositoryPlatform } from './agents-platform';
import { CANDIDATE_DIFF_LIMIT } from './evidence';
import { captureFileProvenance } from './provenance';
import { platformSource } from './source-objects';
import { ledger, object, sha } from './storage';
import type { Env, Json, Scope } from './types';

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'INVALID_CAPTURE' });
};

async function declaredPaths(env: Env, scope: Scope, header: Json): Promise<string[]> {
  const paths: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await ledger(env, scope.repo_id, {
      op: 'source_refresh_paths',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      limit: 200,
      expected_digest: header.declared_paths_ref.digest,
      ...(after === null ? {} : { after }),
    });
    paths.push(...page.items);
    if (!page.has_more) return paths;
    after = page.next_cursor;
  }
}

/** Unified patch text of `head` against `base`, as the candidate diff view stores it. */
async function patchText(
  platform: Awaited<ReturnType<typeof repositoryPlatform>>,
  base: string,
  head: string,
) {
  const diff = await platform.call('GET', `/diff?base=${base}&head=${head}&patch=1`);
  return {
    paths: diff.changes.map((c: Json) => String(c.path)).sort(),
    text: diff.changes
      .map((c: Json) => c.patch ?? `Binary or large file ${c.path} changed\n`)
      .join(''),
  };
}

export async function refreshCandidate(env: Env, scope: Scope): Promise<Json> {
  const job = scope.job;
  const identity = { job_id: job.id, epoch: job.epoch };
  const header = await ledger(env, scope.repo_id, { op: 'source_refresh_context', ...identity });
  const repository = platformRevision(scope.repo_id);
  if (
    header.head?.repository !== repository ||
    header.candidate?.repository !== repository ||
    header.base?.repository !== repository
  )
    fail('Refresh inputs are outside this repository');
  const declared = await declaredPaths(env, scope, header);
  const platform = await repositoryPlatform(env, scope.repo_id);
  const source = platformSource(platform);
  const base = header.base.commit;
  const head = header.head.commit;
  const candidate = header.candidate.commit;
  const changed = async (from: string, to: string) =>
    (await platform.call('GET', `/diff?base=${from}&head=${to}`)).changes
      .map((c: Json) => String(c.path))
      .sort();
  const candidatePaths = await changed(base, candidate);
  const interveningPaths = await changed(base, head);
  const overlapping = candidatePaths.filter((path: string) => interveningPaths.includes(path));
  const merged = await platform.call('POST', '/merges', {
    into: head,
    source: candidate,
    on_conflict: 'workspace',
    message: `Refresh candidate onto ${head}`,
  });
  if (merged.up_to_date || merged.fast_forward) fail('The candidate already contains its target');
  const conflicts: string[] = (merged.conflicts ?? []).map((c: Json) => String(c.path)).sort();
  const commit: string = conflicts.length ? merged.workspace : merged.commit;
  const result = await source.readCommit(commit);
  if (!result || JSON.stringify(result.parents) !== JSON.stringify([head, candidate]))
    fail('Platform merge parents differ from the reserved refresh inputs');
  // The refreshed revision is addressable by name like every other candidate.
  const branch = `agents/refresh-${(await sha(`${scope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
  if ((await source.head(branch)) !== commit)
    await platform.call('POST', '/branches', { ref: branch, commit, expected: null });
  const expectedHead = await source.readCommit(head);
  if (!expectedHead) fail('Frozen refresh head is unavailable');
  const fileProvenance = await captureFileProvenance(source, head, commit);
  const paths = [
    ...new Set(fileProvenance.flatMap((f: Json) => [f.path, f.old_path]).filter(Boolean)),
  ].sort();
  const target = header.working_branch_id
    ? await ledger(env, scope.repo_id, { op: 'working_branch', id: header.working_branch_id })
    : null;
  const readback: Json = {
    observed_head: target ? target.working_commit : await source.head('main'),
    version: target ? target.version : header.expected_version,
    parents: result?.parents,
    expected_head_tree: expectedHead?.treeHash,
    merged_paths: paths,
    candidate_paths: candidatePaths,
    intervening_paths: interveningPaths,
  };
  const evidence = {
    base_commit: base,
    observed_head: head,
    candidate_commit: candidate,
    declared_paths: declared,
    captured_paths: candidatePaths,
    intervening_paths: interveningPaths,
    overlapping_paths: overlapping,
  };
  const common = { evidence, paths, file_provenance: fileProvenance, tree: result?.treeHash };
  if (conflicts.length)
    return {
      op: 'conflict_refresh_complete',
      ...identity,
      result: {
        ...common,
        status: 'unresolved',
        merge_tree: result?.treeHash,
        merge_workspace_commit: commit,
        workspace_revision: { repository, commit },
        conflict_paths: conflicts,
        readback: { ...readback, workspace_commit: commit, conflict_paths: conflicts },
      },
    };
  const diff = await patchText(platform, head, commit);
  return {
    op: 'conflict_refresh_complete',
    ...identity,
    result: {
      ...common,
      status: 'clean',
      candidate_id: `candidate:refresh:${commit}`,
      revision: { repository, commit },
      merge_commit: commit,
      diff_digest: (await object(env, diff.text, CANDIDATE_DIFF_LIMIT)).digest,
      readback: { ...readback, merge_commit: commit },
    },
  };
}
