// Forks, the adapter half (the authority's steps and the access decision are documented in
// repo_store/forks.rs; inherited reads in repo-inherit). Forking copies the commit graph the
// parent's refs reach and the refs, never objects. A change from a fork carries the fork
// branch's new commits into the parent (objects into its store of record first, then
// recorded as pushed) and opens an ordinary change on the parent's mirror branch.
import { dispatchRuns } from './repo-checks';
import { listRepository, newRepoId, owning } from './repo-create';
import { rawObjects } from './repo-git-objects';
import { UploadSession } from './repo-git-sessions';
import { enumerate } from './repo-git-upload';
import { refreshHead } from './repo-head';
import { isLarge, putLarge } from './repo-large-files';
import { parseStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, type RepoContext } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import { visibilityOf } from './repo-public';
import { shardOutboxes } from './repo-shards';
import { FORK_DEPTH, forkDepth, forkSpec, forkStore, newStore, putRawBytes } from './repo-stores';
import type { Env } from './types';

const REPO = /^r[0-9a-f]{20}$/;
/** The caller's own credentials, as `ctx` signs them. */
const credentialsOf = (ctx: RepoContext) => ctx.call.sign({}) as Credentials;

/**
 * `git_fork {name?, owner?, policy?}` on the parent: a new repository owned by the caller's
 * account or by organization `owner` (an owner of it asks; needs only read here), its refs the parent's at the current version. The fork is listed
 * only once its history and refs are in place, so a failed attempt leaves nothing visible.
 */
export async function forkRepository(ctx: RepoContext, args: Json) {
  const { env } = ctx;
  // Forking into an organization (`owner`) needs an owner of it, as creating there does.
  const auth = await owning(env, credentialsOf(ctx), { owner: args.owner });
  // A fork is private unless asked otherwise, whatever its parent is.
  const visibility = visibilityOf(args.visibility);
  const source = await ctx.call({ op: 'repo_fork_source' });
  if (forkDepth(source.object_store) >= FORK_DEPTH)
    throw new ApiError('NOT_SUPPORTED', `Forks of forks nest at most ${FORK_DEPTH} deep`);
  const id = newRepoId();
  const name = typeof args.name === 'string' && args.name ? args.name : source.name;
  await caller(
    env,
    id,
    auth,
  )({
    op: 'repo_init',
    name,
    object_store: forkSpec(ctx.repo, source.object_store, newStore(env, `yr-${id}`).spec),
    parent: { repo: ctx.repo, version: source.version },
    policy: args.policy ?? { required_checks: [], approvals: 1 },
    visibility,
  });
  const platform = caller(env, id, { _system: 'import' });
  let after: Json | null = null;
  let commits = 0;
  do {
    const page: Json = await ctx.call({ op: 'repo_fork_export', version: source.version, after });
    await platform({ op: 'repo_fork_record', commits: page.commits });
    commits += page.commits.length;
    after = page.next;
  } while (after);
  // After the export: every commit it named as held by the parent's Artifacts store is in
  // an Artifacts fork of that store, whose branches lease the fork's first projections.
  const store = await forkStore(env, source.object_store, `yr-${id}`);
  const held = store.inherited ? source.projections : [];
  await platform({
    op: 'repo_fork_refs',
    refs: source.refs,
    projections: Object.fromEntries(held.map((p: Json) => [p.refname, p.projected_commit])),
  });
  await caller(env, ctx.repo, { _system: 'fork' })({ op: 'repo_fork_register', fork: id });
  await shardOutboxes(env, id);
  await listRepository(env, id, auth._session.workspace, name, visibility);
  await Promise.all([dispatchProjection(env, id), refreshHead(env, id)]);
  return {
    id,
    name,
    parent: ctx.repo,
    parent_version: source.version,
    refs: Object.keys(source.refs).length,
    commits,
  };
}

/**
 * `git_change_create {fork, branch, title, body?}` on the parent: a reader of the parent
 * who writes to fork `fork` proposes its `branch`. The branch is carried into the parent
 * and the change opened on its mirror.
 */
export async function openForkChange(ctx: RepoContext, a: Json) {
  const fork = String(a.fork ?? '');
  if (!REPO.test(fork)) throw new ApiError('INVALID_INPUT', 'fork must be a repository id');
  // Read on the parent before the platform writes anything there for this caller.
  await ctx.call({ op: 'repo_git_access', service: 'git-upload-pack' });
  const offered = await caller(
    ctx.env,
    fork,
    credentialsOf(ctx),
  )({
    op: 'repo_fork_offer',
    branch: a.branch,
  });
  if (offered.parent !== ctx.repo)
    throw new ApiError('INVALID_INPUT', `Repository ${fork} is not a fork of this one`);
  const mirror = await carryForkBranch(ctx.env, ctx.repo, fork, offered.branch);
  return ctx.call({
    op: 'repo_change_create',
    branch: mirror,
    base: a.base ?? null,
    title: a.title,
    body: a.body,
    source_repo: fork,
    source_branch: offered.branch,
  });
}

/** An open change from a fork follows the fork branch: carried again when its head moved
 * (deleted fork branches and forks leave the change as it is). Whether it moved. */
export async function followForkChange(env: Env, parent: string, change: Json) {
  if (change.status !== 'open' || !change.source_repo) return false;
  const fork = caller(env, change.source_repo, { _system: 'fork' });
  const refs = await fork({ op: 'repo_refs' }).catch(() => null);
  const head = refs?.refs?.[`refs/heads/${change.source_branch}`];
  if (!head || head === change.head) return false;
  await carryForkBranch(env, parent, change.source_repo, change.source_branch);
  return true;
}

/**
 * Brings fork branch `branch` into `parent`: the commits the parent lacks, oldest first,
 * each with the objects it introduced copied into the parent's store of record before the
 * commit is recorded there; then the parent's mirror `forks/<fork>/<branch>` moves to the
 * head (its short name is returned). The head's checks start as for a push.
 */
export async function carryForkBranch(env: Env, parent: string, fork: string, branch: string) {
  const onParent = caller(env, parent, { _system: 'fork' });
  const onFork = caller(env, fork, { _system: 'fork' });
  const tips = Object.values((await onParent({ op: 'repo_refs' })).refs);
  const carried = await onFork({ op: 'repo_fork_branch', branch, haves: tips });
  const listed: Json[] = carried.commits;
  const known = listed.length
    ? await onParent({
        op: 'repo_git_walk',
        wants: [],
        haves: listed.map((c) => c.commit),
        common_only: true,
      })
    : { common: [] };
  const fresh = listed.filter((c) => !known.common.includes(c.commit));
  if (fresh.length) {
    const [from, into] = await Promise.all(
      [onFork, onParent].map(async (call, i) => {
        const { object_store } = await call({ op: 'repo_status' });
        return new RepoObjects(env, i ? parent : fork, parseStore(env, object_store));
      }),
    );
    const pushed: Json[] = [];
    for (const commit of fresh) pushed.push(await copyCommit(from, into, commit));
    pushed[pushed.length - 1].check = true;
    const recorded = await onParent({ op: 'repo_record_pushed', commits: pushed });
    await dispatchRuns(env, parent, recorded.check_runs);
  }
  const mirror = await onParent({ op: 'repo_fork_mirror', fork, branch, commit: carried.head });
  return String(mirror.ref).slice('refs/heads/'.length);
}

/** Copies the objects `commit` introduced (its diff against its first parent, as a fetch
 * lists them) from `from` into `into`'s store of record; answers its pushed record. */
async function copyCommit(from: RepoObjects, into: RepoObjects, commit: Json) {
  const session = UploadSession.open({ commits: [commit] });
  let listed: Json;
  try {
    listed = await enumerate(session, from);
  } finally {
    session.close();
  }
  const objects: { id: string; kind: string }[] = [
    ...listed.trees.map((id: string) => ({ id, kind: 'tree' })),
    ...listed.fetch,
  ];
  let data_b64 = '';
  for await (const group of rawObjects(from, objects)) {
    const lost = group.find((o) => !o.data);
    if (lost) throw new ApiError('NOT_FOUND', `${lost.kind} ${lost.id} of the fork is missing`);
    // Large files stream across, one at a time.
    for (const o of group)
      if (isLarge(o.data)) await putLarge(into.env, into.rawKey(o.id), o.data.size, o.data.body);
    await putRawBytes(
      into.env,
      (id) => into.rawKey(id),
      group.flatMap((o) =>
        o.data instanceof Uint8Array ? [{ id: o.id, kind: o.kind, data: o.data }] : [],
      ),
    );
    const own = group.find((o) => o.id === commit.commit);
    if (own) data_b64 = toBase64(own.data as Uint8Array);
  }
  return { commit: commit.commit, data_b64, touches: commit.touches, objects, check: false };
}

/** After a fork's deletion: its parent stops counting it. */
export function forgetFork(env: Env, parent: string, fork: string) {
  return caller(env, parent, { _system: 'fork' })({ op: 'repo_fork_forget', fork });
}
