// The platform's operation table, named after Git verbs. The HTTP API and MCP both
// dispatch here, so an MCP client and a REST client can never see different behavior.
import { dispatchRuns } from './repo-checks';
import {
  commit,
  diff,
  getObjects,
  type Json,
  listTree,
  type RepoContext,
  readFile,
  replay,
} from './repo-ops';
import { dispatchProjection } from './repo-projection';

type Operation = (ctx: RepoContext, args: Json) => Promise<Json>;
const version = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

export const operations: Record<string, Operation> = {
  git_status: (ctx) => ctx.call({ op: 'repo_status' }),
  git_refs: (ctx, a) => ctx.call({ op: 'repo_refs', ...version(a) }),
  git_log: (ctx, a) =>
    ctx.call({ op: 'repo_log', ref: a.ref ?? 'main', limit: Number(a.limit ?? 50), ...version(a) }),
  git_txlog: (ctx, a) =>
    ctx.call({ op: 'repo_txlog', after: Number(a.after ?? 0), limit: Number(a.limit ?? 100) }),
  git_show: (ctx, a) => ctx.call({ op: 'repo_commit', commit: a.commit }),
  git_merge_base: (ctx, a) => ctx.call({ op: 'repo_merge_base', left: a.left, right: a.right }),
  git_ls_tree: listTree,
  git_cat_file: readFile,
  git_get_objects: getObjects,
  git_diff: diff,
  git_commit: async (ctx, a) => commit(ctx, await ctx.objects(), a),
  git_check: (ctx, a) =>
    ctx.call({
      op: 'repo_check',
      commit: a.commit,
      name: a.name,
      status: a.status,
      evidence: a.evidence,
    }),
  git_check_run: async (ctx, a) => {
    const requested = await ctx.call({ op: 'repo_check_request', commit: a.commit, name: a.name });
    await dispatchRuns(ctx.env, ctx.repo, requested.runs);
    return requested;
  },
  git_review: (ctx, a) =>
    ctx.call({ op: 'repo_review', commit: a.commit, decision: a.decision, reason: a.reason }),
  git_revert: (ctx, a) => replay(ctx, a, 'revert'),
  git_cherry_pick: (ctx, a) => replay(ctx, a, 'pick'),
  git_land: async (ctx, a) => {
    const landed = await ctx.call({ op: 'repo_land', ref: a.ref, commit: a.commit });
    if (!landed.already) await dispatchProjection(ctx.env, ctx.repo);
    return landed;
  },
};
