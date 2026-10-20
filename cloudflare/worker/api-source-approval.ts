import { openSource, type SourceCommit } from './source-objects';
import { ledger } from './storage';
import type { Env, Json } from './types';

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/**
 * Every run works in a lazy source workspace; its base is read back from the platform.
 * `checkpoint` is the revision the ledger restores the working branch to before the run
 * starts (a guided concurrent retry); the branch head is still checked against the lease.
 */
export async function freezeSourceApproval(
  env: Env,
  owner: string,
  repo: string,
  input: Json,
  repository: Json,
  checkpoint?: { repository: string; commit: string },
): Promise<void> {
  delete input._source_base;
  delete input._source_transport_approved;
  delete input.workspace_transport;
  if (!env.SOURCES || repository.capabilities?.source_api !== 1)
    fail('LEDGER_UPDATING', 'Source access is updating; refresh before starting.');
  let revision = {
    repository: `${repository.remote.namespace}/${repository.remote.name}`,
    commit: repository.published_commit,
  };
  if (input.working_branch_id != null) {
    const branch = await ledger(env, repo, {
      op: 'working_branch',
      id: input.working_branch_id,
      _workspace: owner,
    });
    if (
      branch.working_commit !== input.expected_working_commit ||
      branch.version !== input.expected_working_version
    )
      fail('WORKING_HEAD_MOVED', 'The working source changed; refresh your brief.');
    revision = checkpoint ?? branch.working_revision;
  }
  if (!/^[a-f0-9]{40}$/.test(revision.commit ?? ''))
    fail('INVALID_CAPTURE', 'Approved source identity is unavailable.');
  let commit: SourceCommit | null = null;
  try {
    commit = await (await openSource(env, String(revision.repository))).readCommit(revision.commit);
  } catch (failure: any) {
    if (failure.code !== 'SOURCE_SCOPE') throw failure;
  }
  if (!commit || commit.hash !== revision.commit || !/^[a-f0-9]{40}$/.test(commit.treeHash)) {
    fail('INVALID_CAPTURE', 'Approved source revision is unavailable.');
    return;
  }
  input.workspace_transport = 'api-source-v1';
  input._source_transport_approved = true;
  input._source_base = { ...revision, tree: commit.treeHash };
}
