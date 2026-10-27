// `git push` over HTTPS (receive-pack). The body streams into a Rust session that parses
// the commands and resolves the pack as it arrives. Then, in order: every object is
// verified (asking the repository for what the pack does not carry), the verified objects
// are written to R2, the new commits are recorded under their own ids, and only then do
// refs move: working branches by compare-and-swap (one batch for `--atomic`), protected
// branches by landing, with the server's merge when they moved meanwhile, and new
// lightweight tags by creation (tags never move or disappear). A push that fails or dies
// before that leaves every ref and the log as they were.

import { dispatchRuns } from './repo-checks';
import { compute } from './repo-compute';
import { type Command, moveAll, moveOne, type Outcome, reason, refusal } from './repo-git-moves';
import { inBatches, rawObject, treeFor } from './repo-git-objects';
import { ReceiveSession } from './repo-git-sessions';
import { fromBase64, type RepoObjects } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { dispatchProjection } from './repo-projection';
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

export async function receivePack(
  ctx: RepoContext,
  objects: RepoObjects,
  body: ReadableStream<Uint8Array>,
  secretAllow: Json[],
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
      if (tips.length > 0) fresh = await store(ctx, objects, session, tips, secretAllow);
    } catch (e) {
      // Nothing moved: report why for every ref still going.
      // A credential refuses the whole push by path and line (never its text); the pack
      // itself unpacked fine.
      const secret = (e as any)?.code === 'SECRET_DETECTED';
      const why = secret ? String((e as any).message) : reason(e);
      for (const c of going) outcomes.set(c.ref, why);
      return report(commands, outcomes, secret ? null : why, sideBand, messages);
    }
    if (atomic) await moveAll(ctx, going, outcomes);
    else for (const c of going) outcomes.set(c.ref, await moveOne(ctx, c, fresh, messages));
    // New tags are mirrored to the object store like protected branches (a lost message
    // only delays that).
    if (going.some((c) => c.ref.startsWith('refs/tags/') && !outcomes.get(c.ref)))
      await dispatchProjection(ctx.env, ctx.repo).catch(() => {});
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
  secretAllow: Json[],
) {
  let input: Json = { op: 'verify', tips, secret_allow: secretAllow };
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
