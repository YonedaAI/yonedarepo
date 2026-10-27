// `git push` over HTTPS (receive-pack). The body streams into a Rust session that parses
// the commands and resolves the pack as it arrives. Then, in order: every object is
// verified (asking the repository for what the pack does not carry), the verified objects
// are written to R2, the new commits are recorded under their own ids, and only then do
// refs move: working branches by compare-and-swap (one batch for `--atomic`), protected
// branches by landing, with the server's merge when they moved meanwhile. A push that
// fails or dies before that leaves every ref and the log as they were.

import { landMode } from './repo-changesets';
import { dispatchRuns } from './repo-checks';
import { compute } from './repo-compute';
import { inBatches, rawObject, treeFor } from './repo-git-objects';
import { ReceiveSession } from './repo-git-sessions';
import { landWithMerge } from './repo-landing';
import { fromBase64, type RepoObjects } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { putRawBytes } from './repo-stores';

const RESULT = {
  'content-type': 'application/x-git-receive-pack-result',
  'cache-control': 'no-cache',
};
const VERIFY_ROUNDS = 64;
const WRITE_BUDGET = 4 * 1024 * 1024;
const RECORD_COMMITS = 100;
const READS = 16;
const WRITES = 64;

type Command = { ref: string; old: string | null; new: string | null; protected: boolean };
type Outcome = Map<string, string | null>;

const reason = (e: any) =>
  `${e instanceof ApiError ? e.code : (e?.code ?? 'ERROR')}: ${String(e?.message ?? e)}`.slice(
    0,
    300,
  );
const short = (ref: string) => ref.replace(/^refs\/heads\//, '');

export async function receivePack(
  ctx: RepoContext,
  objects: RepoObjects,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const session = ReceiveSession.open();
  try {
    let failure = await unpack(session, body);
    if (!failure) {
      // A body that ended early (a truncated pack) fails here.
      try {
        session.call({ op: 'finish' });
      } catch (e) {
        failure = reason(e);
      }
    }
    const { commands, capabilities } = session.call({ op: 'commands' });
    // An empty command list is Git's probe before a large push.
    if (!failure && commands.length === 0) return new Response(null, { headers: RESULT });
    const sideBand = capabilities.includes('side-band-64k') || capabilities.includes('side-band');
    const outcomes: Outcome = new Map(commands.map((c: Command) => [c.ref, null]));
    const messages: string[] = [];
    if (failure) return report(commands, refuseAll(outcomes, failure), failure, sideBand, messages);
    const atomic = capabilities.includes('atomic') && commands.length > 1;
    for (const command of commands as Command[])
      outcomes.set(command.ref, refusal(command, atomic));
    if (atomic && [...outcomes.values()].some(Boolean)) {
      for (const [ref, why] of outcomes) outcomes.set(ref, why ?? 'atomic push refused');
    }
    const going = (commands as Command[]).filter((c) => !outcomes.get(c.ref));
    const tips = going.flatMap((c) => (c.new ? [c.new] : []));
    let fresh = new Set<string>();
    try {
      if (tips.length > 0) fresh = await store(ctx, objects, session, tips);
    } catch (e) {
      // Nothing moved: report why for every ref still going.
      for (const c of going) outcomes.set(c.ref, reason(e));
      return report(commands, outcomes, reason(e), sideBand, messages);
    }
    if (atomic) await moveAll(ctx, going, outcomes);
    else for (const c of going) outcomes.set(c.ref, await moveOne(ctx, c, fresh, messages));
    return report(commands, outcomes, null, sideBand, messages);
  } finally {
    session.close();
  }
}

/** Feeds the whole body to the session; after a failure the rest is read and dropped, so
 * Git (which sends everything before it reads) gets the report. */
async function unpack(session: ReceiveSession, body: ReadableStream<Uint8Array>) {
  let failure: string | null = null;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (failure) continue;
    try {
      session.feed(value);
    } catch (e) {
      failure = reason(e);
    }
  }
  return failure;
}

/** Why a ref is refused before anything is stored (`null`: it goes ahead). */
function refusal(command: Command, atomic: boolean): string | null {
  if (command.ref.startsWith('refs/tags/')) return 'tags are not supported yet';
  if (!command.ref.startsWith('refs/heads/')) return 'only branches (refs/heads/*) can be pushed';
  if (command.protected && !command.new)
    return `${short(command.ref)} is protected and cannot be deleted`;
  if (command.protected && atomic)
    return `an atomic push cannot include ${short(command.ref)}: it moves only by landing`;
  return null;
}

function refuseAll(outcomes: Outcome, why: string) {
  for (const ref of outcomes.keys()) outcomes.set(ref, why);
  return outcomes;
}

/** Verifies the pack against the repository, writes its new objects to R2 and records
 * the new commits (parents first). Moves no ref. */
async function store(
  ctx: RepoContext,
  objects: RepoObjects,
  session: ReceiveSession,
  tips: string[],
) {
  let input: Json = { op: 'verify', tips };
  let verified: Json | null = null;
  for (let round = 0; round < VERIFY_ROUNDS && !verified; round++) {
    const step = session.call(input);
    if (step.need) input = { op: 'verify', tips, ...(await supply(ctx, objects, step.need)) };
    else verified = step;
  }
  if (!verified) throw new ApiError('INVALID_INPUT', 'Directories are nested too deeply');
  for (;;) {
    const frames = session.objects(WRITE_BUDGET);
    if (frames.length === 0) break;
    const parsed = framed(frames);
    for (let i = 0; i < parsed.length; i += WRITES)
      await putRawBytes(ctx.env, (id) => objects.rawKey(id), parsed.slice(i, i + WRITES));
  }
  const commits: Json[] = (verified.commits as Json[]).map((c) => ({
    ...c,
    check: tips.includes(c.commit),
  }));
  const runs: Json[] = [];
  for (let i = 0; i < commits.length; i += RECORD_COMMITS) {
    const recorded = await ctx.call({
      op: 'repo_record_pushed',
      commits: commits.slice(i, i + RECORD_COMMITS),
    });
    runs.push(...(recorded.check_runs ?? []));
  }
  // Undispatched runs stay queued in the authority and are sent again on request.
  await dispatchRuns(ctx.env, ctx.repo, runs).catch(() => {});
  return new Set(commits.map((c) => c.commit as string));
}

/** What verification asked for: recorded parents' trees, repository trees, and proof that
 * files the pack leaves out are held here. Anything missing refuses the push. */
async function supply(ctx: RepoContext, objects: RepoObjects, need: Json): Promise<Json> {
  const missing = (what: string) =>
    new ApiError('NOT_FOUND', `missing necessary objects: ${what} is not in this repository`);
  if (need.commits) {
    const commits: Json = {};
    await inBatches(need.commits as string[], READS, async (id) => {
      const found = await ctx.call({ op: 'repo_commit', commit: id, brief: true }).catch((e) => {
        if (e?.code === 'NOT_FOUND') throw missing(`commit ${id}`);
        throw e;
      });
      commits[id] = found.tree;
    });
    return { commits };
  }
  if (need.trees) {
    const trees = await inBatches(need.trees as string[], READS, (id) =>
      treeFor(objects, id).catch((e) => {
        if (e?.code === 'NOT_FOUND') throw missing(`tree ${id}`);
        throw e;
      }),
    );
    return { trees };
  }
  const present = await inBatches(need.objects as string[], READS, async (id) => {
    const head = await ctx.env.OBJECTS.head(objects.rawKey(id));
    if (head?.customMetadata?.kind === 'blob' || (await rawObject(objects, id, 'blob'))) return id;
    throw missing(`file ${id}`);
  });
  return { present };
}

const KINDS = ['', 'commit', 'tree', 'blob'];

/** Splits `ReceiveSession.objects` frames: kind, 20-byte id, 4-byte length, content. */
function framed(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { id: string; kind: string; data: Uint8Array }[] = [];
  for (let at = 0; at < bytes.length; ) {
    const kind = KINDS[bytes[at]];
    const id = [...bytes.subarray(at + 1, at + 21)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const length = view.getUint32(at + 21);
    if (!kind || at + 25 + length > bytes.length)
      throw new ApiError('GIT_FAILED', 'Malformed object frame');
    out.push({ id, kind, data: bytes.subarray(at + 25, at + 25 + length) });
    at += 25 + length;
  }
  return out;
}

/** `--atomic`: every working branch in one compare-and-swap, or none. */
async function moveAll(ctx: RepoContext, going: Command[], outcomes: Outcome) {
  if (going.length === 0) return;
  const updates = going.map((c) => ({ ref: c.ref, commit: c.new, expected: c.old }));
  try {
    const moved = await ctx.call({ op: 'repo_branch_batch', updates });
    const stale: string[] = moved.stale ?? [];
    for (const c of going)
      if (stale.length > 0)
        outcomes.set(c.ref, stale.includes(c.ref) ? 'fetch first' : 'atomic push refused');
  } catch (e) {
    for (const c of going) outcomes.set(c.ref, reason(e));
  }
}

/** One ref: a working branch by compare-and-swap, a protected one by landing. */
async function moveOne(
  ctx: RepoContext,
  c: Command,
  fresh: Set<string>,
  messages: string[],
): Promise<string | null> {
  try {
    if (c.protected && c.new) return await land(ctx, c, c.new, fresh, messages);
    const moved = await ctx.call({
      op: 'repo_branch_batch',
      updates: [{ ref: c.ref, commit: c.new, expected: c.old }],
    });
    return moved.stale ? 'fetch first' : null;
  } catch (e) {
    return reason(e);
  }
}

/** Lands `sha` on a protected branch, as `POST /land` does: a fast-forward keeps the
 * pushed commit; otherwise the server merges, or refuses an overlap as a conflict. A
 * commit the branch already holds (an older head pushed again) lands nothing. */
async function land(
  ctx: RepoContext,
  c: Command,
  sha: string,
  fresh: Set<string>,
  messages: string[],
) {
  const branch = short(c.ref);
  if (!fresh.has(sha)) {
    const head = await ctx.call({ op: 'repo_snapshot', ref: c.ref }).catch((e) => {
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    });
    if (head && head.commit !== sha) {
      const { merge_bases } = await ctx.call({
        op: 'repo_merge_base',
        left: sha,
        right: head.commit,
      });
      if (merge_bases.some((b: Json) => b.commit === sha)) return null;
    }
  }
  try {
    const landed: Json = await landWithMerge(ctx, c.ref, sha, false, landMode(ctx.env));
    // A merge commit, or a changeset whose Git commit the server builds: not `sha` itself.
    const head = landed.merge ?? ('git_commit' in landed ? landed.git_commit : sha);
    if (head !== sha) messages.push(`${branch}: landed with server merge, run git pull`);
    return null;
  } catch (e: any) {
    if (e?.code !== 'CONFLICT') return reason(e);
    const paths = conflictPaths(e);
    for (const path of paths) messages.push(`conflict in ${path}`);
    messages.push('next: git pull, resolve the conflicts, commit, git push');
    return `conflict${paths.length ? ` in ${paths.join(', ')}` : ''}: run git pull`.slice(0, 300);
  }
}

/** The conflicting paths a CONFLICT names, in details or (as the log check words it) its
 * message. */
function conflictPaths(e: any): string[] {
  const details = e?.details ?? {};
  const named = [...(details.conflicts ?? []), ...(details.paths ?? [])]
    .map((p: any) => (typeof p === 'string' ? p : p?.path))
    .filter((p: unknown): p is string => typeof p === 'string');
  if (named.length > 0) return [...new Set(named)].sort();
  const listed = /on (.+), which this commit read/.exec(String(e?.message ?? ''));
  return listed ? listed[1].split(', ') : [];
}

function report(
  commands: Command[],
  outcomes: Outcome,
  unpack: string | null,
  sideBand: boolean,
  messages: string[],
) {
  const refs = commands.map((c) => ({ ref: c.ref, refused: outcomes.get(c.ref) ?? null }));
  const { body_b64 } = compute({ op: 'git_report', unpack, refs, side_band: sideBand, messages });
  return new Response(fromBase64(body_b64), { headers: RESULT });
}
