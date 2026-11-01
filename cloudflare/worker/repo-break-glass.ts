// Human-only break-glass recovery (`POST /api/v1/repos/:id/break-glass`). The
// SourceRepository authority decides, refuses every non-human caller and records each
// action; this adapter only builds a revert commit in the object store. Nothing here
// needs the check runners, the platform queue or an agent service: queue sends after the
// authority committed are best effort, and the durable state they would nudge (queued
// check runs, pending ref projections) is picked up again by the next dispatch.

import { warned } from './log';
import { audited } from './repo-audit';
import { replay } from './repo-commit';
import { dispatchDerive } from './repo-derived';
import { refreshHead } from './repo-head';
import { notifyHooks } from './repo-hooks';
import { ApiError, type Json, type RepoContext } from './repo-ops';

const ACTIONS = ['land', 'revert', 'release_land_lease', 'pause_automation', 'resume_automation'];
const AUTHOR = { name: 'YonedaRepo break-glass', email: 'break-glass@yonedarepo.invalid' };

async function nudge(ctx: RepoContext, ref: string, result: Json) {
  // Every action changes what main's published head carries (its head, or the pause).
  await refreshHead(ctx.env, ctx.repo, true);
  // A resume is told to hooks; a lost nudge waits for the repository's next event.
  if (result.paused === false && !result.already)
    await notifyHooks(ctx.env, ctx.repo).catch(warned('break_glass.hooks_not_nudged'));
  if (!result.landed || result.already) return result;
  const sent = [
    await dispatchDerive(ctx.env, ctx.repo, ref).then(
      () => true,
      () => false,
    ),
  ];
  return sent.every(Boolean) ? result : { ...result, projection: 'deferred' };
}

async function act(ctx: RepoContext, body: Json) {
  const action = String(body.action ?? '');
  if (!ACTIONS.includes(action))
    throw new ApiError('INVALID_INPUT', `action must be one of ${ACTIONS.join(', ')}`);
  const ref = typeof body.ref === 'string' && body.ref ? body.ref : 'main';
  const command: Json = {
    op: 'repo_break_glass',
    action,
    ref,
    reason: body.reason,
    ...(body.commit !== undefined ? { commit: body.commit } : {}),
    ...('expected_old' in body ? { expected_old: body.expected_old } : {}),
    ...('expected_epoch' in body ? { expected_epoch: body.expected_epoch } : {}),
    ...(body.cancel_pending === true ? { cancel_pending: true } : {}),
  };
  if (action !== 'revert') return nudge(ctx, ref, await ctx.call(command));
  // The authority checks the caller, reason, head and target before anything is written.
  const checked = await ctx.call(command);
  if (checked.already) return checked;
  const target = await ctx.call({ op: 'repo_commit', commit: body.commit });
  const subject = String(target.message).split('\n')[0];
  const made = await replay(
    ctx,
    {
      commit: body.commit,
      ref,
      parent: checked.head,
      base_version: checked.version,
      author: AUTHOR,
      message: `Revert "${subject}"\n\nThis reverts commit ${target.commit}.\n\nBreak-glass: ${String(body.reason).trim()}`,
    },
    'revert',
    'best_effort',
  );
  const landed = await ctx.call({ ...command, revert_commit: made.commit });
  return nudge(ctx, ref, {
    ...landed,
    ...(made.check_runs_undispatched ? { check_runs_undispatched: true } : {}),
  });
}

export const breakGlass = (ctx: RepoContext, body: Json) =>
  audited(ctx.env, ctx.repo, act(ctx, body));
