import { ledger } from './storage';
import type { Env, Json, Principal } from './types';

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** Only operator configuration activates the transport; source identity is independently read back. */
export async function freezeSourceApproval(
  env: Env,
  principal: Principal,
  repo: string,
  input: Json,
  repository: Json,
): Promise<void> {
  delete input._source_base;
  delete input._source_transport_approved;
  input.workspace_transport = 'git-native-v1';
  if (env.SOURCE_TRANSPORT !== 'api-source-v1') return;
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
      _workspace: principal.workspace,
    });
    if (
      branch.working_commit !== input.expected_working_commit ||
      branch.version !== input.expected_working_version
    )
      fail('WORKING_HEAD_MOVED', 'The working source changed; refresh your brief.');
    revision = branch.working_revision;
  }
  const [namespace, name, extra] = String(revision.repository).split('/');
  if (
    namespace !== env.ARTIFACTS_NAMESPACE ||
    extra ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name ?? '') ||
    !/^[a-f0-9]{40}$/.test(revision.commit ?? '')
  )
    fail('INVALID_CAPTURE', 'Approved source identity is unavailable.');
  using source = await env.ARTIFACTS.get(name);
  const commit = await source.readCommit(revision.commit);
  if (!commit || commit.hash !== revision.commit || !/^[a-f0-9]{40}$/.test(commit.treeHash)) {
    fail('INVALID_CAPTURE', 'Approved source revision is unavailable.');
    return;
  }
  input.workspace_transport = 'api-source-v1';
  input._source_transport_approved = true;
  input._source_base = { ...revision, tree: commit.treeHash };
}
