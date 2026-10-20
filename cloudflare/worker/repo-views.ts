// Dual views over one source (paper §7.2), both bound to a revision and built only from
// platform data, so they work with every agent service switched off. The agent view is
// a symbol with its contract and graph neighbors; the human view is a template-generated
// subsystem narrative with a dependency map. Rust compute builds both.
import { fileAt, handleOf } from './repo-code';
import { compute } from './repo-compute';
import { revisionFiles } from './repo-contracts';
import { decide, outside } from './repo-grants';
import { type Json, type RepoContext, target } from './repo-ops';

/** Agent view: the symbol's source, contract, callers, callees and members, with handles. */
export async function agentView(ctx: RepoContext, args: Json) {
  const { where, path, id, objects } = await fileAt(ctx, args);
  const { files, records, truncated } = await revisionFiles(
    ctx,
    where.tree,
    args.commit ? undefined : args.at,
  );
  const view = compute({
    op: 'agent_view',
    path,
    symbol: String(args.symbol ?? ''),
    files,
    records,
  });
  const withHandle = (n: Json) => ({ ...n, handle: handleOf(where.commit, n.path, n) });
  const bytes = await objects.blob(id);
  return {
    commit: where.commit,
    ...view,
    symbol: {
      ...view.symbol,
      source: new TextDecoder().decode(bytes.subarray(view.symbol.start, view.symbol.end)),
      handle: handleOf(where.commit, path, view.symbol),
    },
    neighbors: {
      ...view.neighbors,
      callers: view.neighbors.callers.map(withHandle),
      callees: view.neighbors.callees.map(withHandle),
      members: view.neighbors.members.map(withHandle),
    },
    files_truncated: truncated,
  };
}

/** Human view of the subsystems under directory `path` (default: the repository root). */
export async function humanView(ctx: RepoContext, args: Json) {
  const path = String(args.path ?? '').replace(/^\/+|\/+$/g, '');
  const view = await decide(ctx, [path], [path]);
  if (path && !view.paths[0] && !view.dirs[0]) throw outside();
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const { files, records, truncated, limit } = await revisionFiles(
    ctx,
    where.tree,
    args.commit ? undefined : args.at,
  );
  return {
    commit: where.commit,
    version: where.version ?? null,
    ...compute({ op: 'human_view', path, files, records }),
    files_truncated: truncated,
    files_limit: limit,
  };
}
