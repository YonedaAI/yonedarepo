// Change requests: the adapter half. The authority owns changes, comments and the landing
// that marks a change landed (repo_store/changes.rs); this module routes the operations,
// adds the diff (object storage) to `show`, and sends the hook fan-out after events.
// Approval is `git_review` on the head commit and landing is `git_land` on main.
import { followForkChange, openForkChange } from './repo-forks';
import { notifyHooks } from './repo-hooks';
import { ApiError, diff, type Json, type RepoContext } from './repo-ops';

const changeNumber = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ApiError('NOT_FOUND', 'Unknown change');
  return n;
};

/** The change's diff from its merge base with main to its head; a landed change compares
 * against main just before it landed, where the head was not yet merged. */
function changeDiff(ctx: RepoContext, change: Json, patch: boolean) {
  if (!change.head) return null;
  const before = change.status === 'landed' ? { at: Number(change.landed_version) - 1 } : {};
  return diff(ctx, { base: change.base, head: change.head, merge_base: true, patch, ...before });
}

/** After an event the authority queued: deliver it (and anything else waiting). */
async function notified(ctx: RepoContext, done: Promise<Json>) {
  const value = await done;
  await notifyHooks(ctx.env, ctx.repo);
  return value;
}

/** Operations shared by REST and MCP. */
export const changeOperations = {
  // With `fork`: a branch of that fork, carried into this repository (repo-forks).
  git_change_create: (ctx: RepoContext, a: Json) =>
    notified(
      ctx,
      a.fork
        ? openForkChange(ctx, a)
        : ctx.call({ op: 'repo_change_create', branch: a.branch, title: a.title, body: a.body }),
    ),
  git_change_list: (ctx: RepoContext, a: Json) =>
    ctx.call({
      op: 'repo_changes',
      status: a.status || 'open',
      ...(a.limit === undefined ? {} : { limit: Number(a.limit) }),
    }),
  git_change_show: async (ctx: RepoContext, a: Json) => {
    const show = { op: 'repo_change_show', number: changeNumber(a.number) };
    let change = await ctx.call(show);
    // A change from a fork follows the fork branch's pushes (before anyone reviews or lands
    // its head); a failure to carry them is reported, not fatal to reading the change.
    let source_error: string | undefined;
    const moved = await followForkChange(ctx.env, ctx.repo, change).catch((e) => {
      source_error = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`.slice(0, 500);
      return false;
    });
    if (moved) change = await ctx.call(show);
    return { ...change, source_error, diff: await changeDiff(ctx, change, a.patch === true) };
  },
  git_change_comment: (ctx: RepoContext, a: Json) =>
    notified(
      ctx,
      ctx.call({
        op: 'repo_change_comment',
        number: changeNumber(a.number),
        body: a.body ?? null,
        commit: a.commit ?? null,
        path: a.path ?? null,
        line: a.line ?? null,
        side: a.side ?? null,
        resolve: a.resolve === true,
      }),
    ),
  git_change_close: (ctx: RepoContext, a: Json) =>
    notified(ctx, ctx.call({ op: 'repo_change_close', number: changeNumber(a.number) })),
  git_change_reopen: (ctx: RepoContext, a: Json) =>
    notified(ctx, ctx.call({ op: 'repo_change_reopen', number: changeNumber(a.number) })),
};

/** `GET|POST /changes`, `GET /changes/:n`, `POST /changes/:n/comments|close|reopen`. */
export async function changesRoute(
  ctx: RepoContext,
  req: Request,
  number: string | undefined,
  sub: string | undefined,
  body: () => Promise<Json>,
): Promise<Json> {
  const ops = changeOperations;
  const { method } = req;
  const query = Object.fromEntries(new URL(req.url).searchParams);
  if (!number && method === 'GET') return ops.git_change_list(ctx, query);
  if (!number && method === 'POST') return ops.git_change_create(ctx, await body());
  if (number && !sub && method === 'GET')
    return ops.git_change_show(ctx, {
      number,
      patch: query.patch === '1' || query.patch === 'true',
    });
  if (number && method === 'POST' && sub === 'comments')
    return ops.git_change_comment(ctx, { ...(await body()), number });
  if (number && method === 'POST' && sub === 'close') return ops.git_change_close(ctx, { number });
  if (number && method === 'POST' && sub === 'reopen')
    return ops.git_change_reopen(ctx, { number });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
