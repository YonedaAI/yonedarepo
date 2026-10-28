// The platform's operation table, named after Git verbs. The HTTP API and MCP both
// dispatch here, so an MCP client and a REST client can never see different behavior.

import { changeOperations } from './repo-changes';
import { landMode } from './repo-changesets';
import { dispatchRuns } from './repo-checks';
import { codemod, editSymbol, getSymbol, listSymbols } from './repo-code';
import { commit, replay } from './repo-commit';
import { recordContract, symbolContract } from './repo-contracts';
import { blame, pathHistory, search } from './repo-derived';
import { listTree, readFile } from './repo-files';
import { hookOperations, notifyHooks } from './repo-hooks';
import { landWithMerge } from './repo-landing';
import { memberOperations } from './repo-members';
import { explicitMerge } from './repo-merge';
import { ApiError, diff, getObjects, type Json, type RepoContext } from './repo-ops';
import { plan } from './repo-plan';
import { dispatchProjection } from './repo-projection';
import { mergeOutboxes, shardOutboxes } from './repo-shards';
import { readRefs } from './repo-snapshots';
import { agentView } from './repo-views';

type Operation = (ctx: RepoContext, args: Json) => Promise<Json>;
const version = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

export const operations: Record<string, Operation> = {
  git_status: async (ctx) => {
    const [status, shards] = await Promise.all([
      ctx.call({ op: 'repo_status' }),
      shardOutboxes(ctx.env, ctx.repo),
    ]);
    return { ...status, objects: mergeOutboxes([status.objects, ...shards]) };
  },
  git_refs: readRefs,
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
  // A client's commit on main begins from the published head (no authority call).
  git_commit: (ctx, a) => commit(ctx, null, { ...a, begin_from_head: true }),
  git_check: async (ctx, a) => {
    const posted = await ctx.call({
      op: 'repo_check',
      commit: a.commit,
      name: a.name,
      status: a.status,
      evidence: a.evidence,
    });
    if (posted.hooks) await notifyHooks(ctx.env, ctx.repo);
    return posted;
  },
  git_check_run: async (ctx, a) => {
    const requested = await ctx.call({ op: 'repo_check_request', commit: a.commit, name: a.name });
    await dispatchRuns(ctx.env, ctx.repo, requested.runs);
    return requested;
  },
  git_session_record: (ctx, a) =>
    ctx.call({
      op: 'repo_session_record',
      commit: a.commit,
      cli: a.cli,
      summary: a.summary,
      model: a.model ?? null,
      prompt_digest: a.prompt_digest ?? null,
      transcript_ref: a.transcript_ref ?? null,
      read_set_digest: a.read_set_digest ?? null,
    }),
  git_sessions: (ctx, a) => ctx.call({ op: 'repo_sessions', commit: a.commit }),
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
  git_branch: async (ctx, a) => {
    const moved = await ctx.call({
      op: 'repo_branch_set',
      ref: a.ref,
      commit: a.commit,
      expected: a.expected ?? null,
    });
    await notifyHooks(ctx.env, ctx.repo);
    return moved;
  },
  // A new tag is mirrored to the object store like a protected branch.
  git_tag: async (ctx, a) => {
    const created = await ctx.call({ op: 'repo_tag_create', name: a.name, commit: a.commit });
    if (!created.already)
      await Promise.all([dispatchProjection(ctx.env, ctx.repo), notifyHooks(ctx.env, ctx.repo)]);
    return created;
  },
  ...hookOperations,
  ...changeOperations,
  ...memberOperations,
  git_land: (ctx, a) => {
    if (!/^[0-9a-f]{40}$/.test(String(a.commit ?? '')))
      throw new ApiError('INVALID_INPUT', 'commit must be a 40-character commit id');
    return landWithMerge(
      ctx,
      a.ref,
      a.commit,
      a.fast_forward_only === true,
      landMode(ctx.env, a.land_mode),
    );
  },
};
