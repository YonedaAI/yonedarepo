// "Resolve conflict" where sandboxes are deployed: instead of a harness resolver inside the old
// run, the owner's start path starts an ordinary one-agent sandbox run on the conflict's target
// head, with the candidate's own model, whose brief is the conflict: the conflicting paths and
// each one's base, head and candidate versions. Its candidate is checked and published like any
// other. Deployments without sandboxes keep the ledger's harness resolver.
import { repositoryPlatform } from './agents-platform';
import { historyDetail } from './history-archive';
import { approveOwnerRun } from './owner-run-approval';
import { SANDBOX_TRANSPORT } from './sandbox-attempt';
import { platformSource, type SourceRepo } from './source-objects';
import { ledger, sha } from './storage';
import type { Env, Json, Principal } from './types';

/** One side of a conflicting path: absent, binary, or its text (cut to `EXCERPT` bytes). */
export type Side = { size: number; text: string | null } | null;
export type ConflictFile = { path: string; base: Side; head: Side; candidate: Side };

const EXCERPT = 6_000;
const EXCERPT_FILES = 12;
const PATH_LIMIT = 200;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** The file at `path` in `commit`, or null when it is absent there. */
export async function fileAt(source: SourceRepo, commit: string, path: string): Promise<Side> {
  let tree = (await source.readCommit(commit))?.treeHash;
  const parts = path.split('/');
  for (const [index, name] of parts.entries()) {
    const entries = tree ? await source.readTree(tree) : null;
    const entry = entries?.find((e) => e.name === name);
    if (!entry) return null;
    if (index < parts.length - 1) {
      if (entry.type !== 'tree') return null;
      tree = entry.hash;
      continue;
    }
    if (entry.type !== 'blob' && entry.type !== 'exec') return null;
    const blob = await source.readBlob(entry.hash);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.slice(0, EXCERPT + 1).arrayBuffer());
    try {
      // Streaming: a character cut at the excerpt's end is not an error.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.slice(0, EXCERPT),
        {
          stream: true,
        },
      );
      return { size: blob.size, text: text.includes('\0') ? null : text };
    } catch {
      return { size: blob.size, text: null };
    }
  }
  return null;
}

const describe = (side: Side) =>
  side === null ? 'absent' : `${side.size} bytes${side.text === null ? ', binary' : ''}`;

const excerpt = (label: string, side: Side) =>
  side?.text == null
    ? []
    : [
        `${label}${side.size > EXCERPT ? ` (first ${EXCERPT} bytes)` : ''}:`,
        '```',
        side.text,
        '```',
      ];

/** The resolver run's brief: what conflicts, where each side stands, and what to do. */
export function conflictBrief(
  record: Json,
  files: ConflictFile[],
  total: number,
  guidance = '',
): string {
  const candidate = record.candidate ?? {};
  const base = String(candidate.base?.commit ?? record.candidate_base ?? '');
  const head = String(record.head_commit ?? '');
  const theirs = String(candidate.revision?.commit ?? record.candidate_revision ?? '');
  const lines = [
    `Resolve a merge conflict. Candidate ${candidate.id ?? record.candidate_id} (commit ${theirs}, from run ${candidate.run_id ?? 'unknown'}) was made on base ${base}; the head has since moved to ${head}, and both changed the same paths. This repository is checked out at that head.`,
    `Carry the candidate's whole change over onto this head: integrate both sides in every conflicting path (do not keep one side wholesale), and keep the candidate's changes to paths that do not conflict. Its full change is \`git diff ${base} ${theirs}\` and \`git cherry-pick --no-commit ${theirs}\` applies it with conflict markers, if the commits are in this clone; otherwise use the versions below.`,
    `Candidate summary: ${String(candidate.summary ?? 'none recorded').slice(0, 500)}`,
    ...(guidance.trim() ? [`Owner guidance: ${guidance.trim().slice(0, 4096)}`] : []),
    `Conflicting paths (${total}${total > files.length ? `, the first ${files.length} listed` : ''}):`,
    ...files.map(
      (f) =>
        `- ${f.path}: base ${describe(f.base)}, head ${describe(f.head)}, candidate ${describe(f.candidate)}`,
    ),
  ];
  for (const file of files.slice(0, EXCERPT_FILES)) {
    const sides = [
      ...excerpt(`base (${base.slice(0, 12)})`, file.base),
      ...excerpt(`head (${head.slice(0, 12)})`, file.head),
      ...excerpt(`candidate (${theirs.slice(0, 12)})`, file.candidate),
    ];
    if (sides.length) lines.push('', `## ${file.path}`, ...sides);
  }
  return lines.join('\n');
}

/** The conflicting paths, from the record or its stored path list. */
async function conflictPaths(env: Env, repo: string, owner: string, record: Json) {
  if (Array.isArray(record.conflict_paths))
    return {
      paths: record.conflict_paths.slice(0, PATH_LIMIT),
      total: record.conflict_paths.length,
    };
  const page = await ledger(env, repo, {
    op: 'conflict_paths',
    conflict_id: record.id,
    section: 'conflict_paths',
    limit: PATH_LIMIT,
    _workspace: owner,
  });
  return { paths: page.items as string[], total: Number(page.total) };
}

/**
 * Starts the sandbox resolver run for an owner's resolve request. Conflicts resolve only in a
 * sandbox: a deployment without one refuses. A retried request finds the same run.
 */
export async function resolveInSandbox(
  env: Env,
  principal: Principal,
  repo: string,
  input: Json,
): Promise<Json> {
  const owner = principal.workspace;
  const repository = await ledger(env, repo, { op: 'repository_status', _workspace: owner });
  if (!env.AGENT_SANDBOX || !((repository.capabilities?.sandbox_cli ?? 0) >= 1))
    fail(
      'SANDBOX_REQUIRED',
      'Conflicts are resolved in a sandbox, which this deployment does not run',
    );
  const id = typeof input.conflict_id === 'string' ? input.conflict_id : '';
  const request = typeof input.request_id === 'string' ? input.request_id : '';
  if (!id || !request || request.length > 128)
    fail('INVALID_INPUT', 'A conflict and request id are required');
  const record = await ledger(env, repo, {
    op: 'conflict_status',
    conflict_id: id,
    _workspace: owner,
  });
  const runId = `resolve-${(await sha(`${id}:${request}`)).slice(0, 24)}`;
  if (record.sandbox_resolver?.request_id === request)
    return { conflict_id: id, status: 'resolving', run_id: record.sandbox_resolver.run_id };
  if (record.status !== 'unresolved')
    fail('INVALID_STATE', 'Only unresolved conflicts can be resolved');
  if (record.expected_version !== input.expected_version)
    fail('HEAD_MOVED', 'Repository changed since conflict review');
  const detail = await historyDetail(env, repo, String(record.candidate?.run_id));
  const execution = (detail.executions ?? []).find(
    (e: Json) => e.id === record.candidate?.execution,
  );
  if (!execution?.provider || !execution.model)
    fail(
      'MISSING_MODEL_APPROVAL',
      'This candidate has no hosted model to resolve with. Resolve it with your local agent and submit a new contribution.',
    );
  const { paths, total } = await conflictPaths(env, repo, owner, record);
  const source = platformSource(await repositoryPlatform(env, repo));
  const base = String(record.candidate.base?.commit);
  const head = String(record.head_commit);
  const theirs = String(record.candidate.revision?.commit);
  const files: ConflictFile[] = [];
  for (const path of paths)
    files.push({
      path,
      base: await fileAt(source, base, path),
      head: await fileAt(source, head, path),
      candidate: await fileAt(source, theirs, path),
    });
  const run: Json = {
    id: runId,
    intent: conflictBrief(
      record,
      files,
      total,
      typeof input.owner_brief === 'string' ? input.owner_brief : '',
    ),
    criteria: [
      'Every conflicting path integrates both sides',
      "The candidate's changes to other paths are kept",
    ],
    mode: 'compare',
    runtime: SANDBOX_TRANSPORT,
    agents: [
      {
        provider: execution.provider,
        model: execution.model,
        connection: execution.connection ?? execution.provider,
        strategy: 'Conflict resolver',
        ...(execution.cli ? { cli: execution.cli } : {}),
        ...(execution.reasoning_effort ? { reasoning_effort: execution.reasoning_effort } : {}),
      },
    ],
  };
  if (record.working_branch_id != null) {
    const branch = await ledger(env, repo, {
      op: 'working_branch',
      id: record.working_branch_id,
      _workspace: owner,
    });
    if (branch.working_commit !== head)
      fail('HEAD_MOVED', 'The working branch moved since conflict review');
    Object.assign(run, {
      working_branch_id: record.working_branch_id,
      expected_working_commit: head,
      expected_working_version: branch.version,
    });
  } else if (repository.published_commit !== head) {
    fail('HEAD_MOVED', 'Repository changed since conflict review');
  }
  const approved = await approveOwnerRun(env, principal, repo, run);
  await ledger(env, repo, { ...approved, op: 'start_run', _workspace: owner }).catch((failure) => {
    // A retry after a lost acknowledgment finds the run it already started.
    if ((failure as { code?: string }).code !== 'ALREADY_EXISTS') throw failure;
  });
  await ledger(env, repo, {
    op: 'conflict_resolver_run',
    conflict_id: id,
    run_id: runId,
    request_id: request,
    _workspace: owner,
  });
  return { conflict_id: id, status: 'resolving', run_id: runId };
}
