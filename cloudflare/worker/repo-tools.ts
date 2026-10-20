// The platform's operation table, named after Git verbs. The HTTP API and MCP both
// dispatch here, so an MCP client and a REST client can never see different behavior.
import { dispatchRuns } from './repo-checks';
import { codemod, editSymbol, getSymbol, listSymbols } from './repo-code';
import { commit, replay } from './repo-commit';
import { recordContract, symbolContract } from './repo-contracts';
import { blame, pathHistory, search } from './repo-derived';
import { explicitMerge, landWithMerge } from './repo-merge';
import { diff, getObjects, type Json, listTree, type RepoContext, readFile } from './repo-ops';
import { plan } from './repo-plan';
import { agentView } from './repo-views';

type Operation = (ctx: RepoContext, args: Json) => Promise<Json>;
const version = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

export const operations: Record<string, Operation> = {
  git_status: (ctx) => ctx.call({ op: 'repo_status' }),
  git_refs: (ctx, a) => ctx.call({ op: 'repo_refs', ...version(a) }),
  git_log: (ctx, a) =>
    a.path
      ? pathHistory(ctx, a)
      : ctx.call({
          op: 'repo_log',
          ref: a.ref ?? 'main',
          limit: Number(a.limit ?? 50),
          ...version(a),
        }),
  git_txlog: (ctx, a) =>
    ctx.call({ op: 'repo_txlog', after: Number(a.after ?? 0), limit: Number(a.limit ?? 100) }),
  git_show: (ctx, a) => ctx.call({ op: 'repo_commit', commit: a.commit }),
  git_merge_base: (ctx, a) => ctx.call({ op: 'repo_merge_base', left: a.left, right: a.right }),
  git_ls_tree: listTree,
  git_cat_file: readFile,
  git_grep: search,
  symbol_list: listSymbols,
  symbol_get: getSymbol,
  symbol_edit: editSymbol,
  symbol_contract: symbolContract,
  symbol_contract_record: recordContract,
  symbol_view: agentView,
  git_codemod: codemod,
  git_plan: plan,
  git_blame: blame,
  git_get_objects: getObjects,
  git_diff: diff,
  git_commit: (ctx, a) => commit(ctx, null, a),
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
  git_bisect: async (ctx, a) => {
    const step = a.id
      ? await ctx.call({ op: 'repo_bisect_step', id: a.id })
      : await ctx.call({
          op: 'repo_bisect_start',
          ref: a.ref ?? 'main',
          check: a.check,
          good: a.good,
          bad: a.bad,
        });
    await dispatchRuns(ctx.env, ctx.repo, step.runs);
    return step;
  },
  git_pin: (ctx, a) =>
    ctx.call({ op: 'repo_pin', commit: a.commit, reason: a.reason, unpin: a.unpin === true }),
  git_review: (ctx, a) =>
    ctx.call({ op: 'repo_review', commit: a.commit, decision: a.decision, reason: a.reason }),
  git_merge: explicitMerge,
  git_revert: (ctx, a) => replay(ctx, a, 'revert'),
  git_cherry_pick: (ctx, a) => replay(ctx, a, 'pick'),
  git_branch: (ctx, a) =>
    ctx.call({ op: 'repo_branch_set', ref: a.ref, commit: a.commit, expected: a.expected ?? null }),
  git_land: (ctx, a) => landWithMerge(ctx, a.ref, a.commit, a.fast_forward_only === true),
};
