// `git push` over HTTPS (receive-pack). The body streams into a Rust session that parses
// the commands and resolves the pack as it arrives. Then, in order: every object is
// verified (asking the repository for what the pack does not carry), the verified objects
// are written to R2, the new commits are recorded under their own ids, and only then do
// refs move: working branches by compare-and-swap (one batch for `--atomic`), protected
// branches by landing, with the server's merge when they moved meanwhile, and new
// tags by creation (tags never move or disappear; an annotated tag's object is verified
// against the commit it tags and kept by the authority). A push that fails or dies
// before that leaves every ref and the log as they were. `-o yoneda.reads=…` declares the
// files the pushed work relied on: they are recorded with each pushed tip, and landing
// refuses the push as a read conflict when one of them changed after its base.

import { deferred } from './background';
import { transient } from './durable';
import { bundlesOn, storeBundle } from './repo-bundles';
import { dispatchRuns } from './repo-checks';
import { compute } from './repo-compute';
import {
  type Command,
  moveAll,
  moveOne,
  type Outcome,
  reason,
  refusal,
  target,
} from './repo-git-moves';
import { supply } from './repo-git-objects';
import { ReceiveSession } from './repo-git-sessions';
import { notifyHooks } from './repo-hooks';
import { largeWarnings, SpilledFiles } from './repo-large-files';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { framed } from './repo-pack-copy';
import { dispatchObjects, dispatchProjection } from './repo-projection';
import { putRawBytes } from './repo-stores';
import { record, timed } from './repo-timing';

const RESULT = {
  'content-type': 'application/x-git-receive-pack-result',
  'cache-control': 'no-cache',
};
const VERIFY_ROUNDS = 64;
// As much as the authority stages for one commit (staging.rs STAGE_OBJECTS, STAGE_LIMIT).
const STAGE_OBJECTS = 256;
const STAGE_BYTES = 1024 * 1024;
const WRITE_BUDGET = 4 * 1024 * 1024;
/** Body bytes fed to the session at once: what it holds of a spilled file's pack bytes. */
const FEED_BYTES = 1024 * 1024;
const RECORD_COMMITS = 100;
/** Verified commits the session lists at once (each with its touches and objects). */
const VERIFIED_PAGE = 25;
const WRITES = 64;

export async function receivePack(
  ctx: RepoContext,
  objects: RepoObjects,
  body: ReadableStream<Uint8Array>,
  secretAllow: Json[],
): Promise<Response> {
  const session = ReceiveSession.open();
  const files = new SpilledFiles(ctx.env, ctx.repo, (id) => objects.rawKey(id));
  try {
    let failure = await timed('git.unpack', () => unpack(session, body, files));
    if (!failure) {
      // A body that ended early (a truncated pack) fails here.
      try {
        session.call({ op: 'finish' });
      } catch (e) {
        failure = reason(e);
      }
    }
    const { commands, capabilities, reads } = session.call({ op: 'commands' });
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
    // An annotated tag's tip is the commit it tags (its object is kept by the authority).
    const tips = going.flatMap((c) => (c.new ? [target(c) as string] : []));
    let fresh = new Set<string>();
    try {
      if (tips.length > 0)
        fresh = await timed('git.store', () =>
          store(ctx, objects, session, tips, secretAllow, reads ?? [], files, messages),
        );
    } catch (e) {
      // Nothing moved: an overloaded authority is an HTTP 503 Git can retry; otherwise
      // report why for every ref still going.
      if (transient(e)) throw e;
      // A credential refuses the whole push by path and line (never its text); the pack
      // itself unpacked fine.
      const secret = (e as any)?.code === 'SECRET_DETECTED';
      const why = secret ? String((e as any).message) : reason(e);
      for (const c of going) outcomes.set(c.ref, why);
      return report(commands, outcomes, secret ? null : why, sideBand, messages);
    }
    await timed('git.move', async () => {
      if (atomic) await moveAll(ctx, going, outcomes, messages);
      else for (const c of going) outcomes.set(c.ref, await moveOne(ctx, c, fresh, messages));
    });
    // Every ref refused only because the authority was overloaded: nothing moved, so the
    // push as a whole is retryable.
    if (going.length > 0 && going.every((c) => outcomes.get(c.ref)?.startsWith('OVERLOADED:')))
      throw Object.assign(new Error('The repository is overloaded; nothing moved'), {
        overloaded: true,
      });
    // New tags are mirrored to the object store like protected branches (a lost message
    // only delays that).
    if (going.some((c) => c.ref.startsWith('refs/tags/') && !outcomes.get(c.ref)))
      await timed('git.projection', () => dispatchProjection(ctx.env, ctx.repo).catch(() => {}));
    // Webhooks for every ref the push moved (branch moves never reach the derive job).
    if (going.some((c) => !outcomes.get(c.ref))) await notifyHooks(ctx.env, ctx.repo);
    return report(commands, outcomes, null, sideBand, messages);
  } finally {
    session.close();
    await files.abort();
  }
}

/** Feeds the whole body to the session, storing the files it spills as they come (the
 * pack waits while one's content is pending); after a failure the rest is read and
 * dropped, so Git (which sends everything before it reads) gets the report. */
async function unpack(
  session: ReceiveSession,
  body: ReadableStream<Uint8Array>,
  files: SpilledFiles,
) {
  let failure: string | null = null;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (failure) continue;
    try {
      for (let at = 0; at < value.length; at += FEED_BYTES) {
        session.feed(value.subarray(at, at + FEED_BYTES));
        await takeSpilled(session, files);
      }
    } catch (e) {
      failure = reason(e);
      await files.abort();
    }
  }
  return failure;
}

/** Spilled files' content after a feed, the pack resuming while it waited for it. */
async function takeSpilled(session: ReceiveSession, files: SpilledFiles) {
  for (let paused = true; paused; ) {
    const frames = session.spilled();
    paused = frames[0] === 1;
    await files.take(frames.subarray(1));
    if (paused) session.feed(new Uint8Array());
  }
}

function refuseAll(outcomes: Outcome, why: string) {
  for (const ref of outcomes.keys()) outcomes.set(ref, why);
  return outcomes;
}

/** Verifies the pack against the repository, stores its new objects and records the new
 * commits (parents first), each tip with the push's declared `reads`. Moves no ref. A
 * small push sends its objects with the record,
 * so the authority stages them in the same transaction (R2 writes are a subrequest each,
 * a few at a time, and take most of a push's time); the projector writes them to R2 after
 * the answer, as for commits built here. A larger one is written to R2 first: a bundle per
 * batch with `PUSH_BUNDLES=on` (repo-bundles), else one R2 object per Git object. */
async function store(
  ctx: RepoContext,
  objects: RepoObjects,
  session: ReceiveSession,
  tips: string[],
  secretAllow: Json[],
  reads: string[],
  files: SpilledFiles,
  messages: string[],
) {
  let input: Json = { op: 'verify', tips, secret_allow: secretAllow };
  let verified: Json | null = null;
  for (let round = 0; round < VERIFY_ROUNDS && !verified; round++) {
    const step = session.call(input);
    if (step.need) {
      const kind = Object.keys(step.need)[0] ?? 'none';
      const asked = (step.need[kind] as unknown[] | undefined)?.length ?? 0;
      const started = performance.now();
      input = { op: 'verify', tips, ...(await supply(ctx, objects, step.need)) };
      record(`git.verify.${kind}`, performance.now() - started, asked);
    } else verified = step;
  }
  if (!verified) throw new ApiError('INVALID_INPUT', 'Directories are nested too deeply');
  let frames = session.objects(WRITE_BUDGET);
  let batch = framed(frames);
  const bytes = batch.reduce((n, o) => n + o.data.length, 0);
  const staged =
    batch.length === verified.objects && batch.length <= STAGE_OBJECTS && bytes <= STAGE_BYTES;
  const data = new Map(staged ? batch.map((o) => [o.id, toBase64(o.data)]) : []);
  // A bundle per batch (one R2 write, then its index), or one R2 object per Git object.
  const bundled = bundlesOn(ctx.env);
  while (!staged && batch.length > 0) {
    const started = performance.now();
    if (bundled) await storeBundle(ctx.env, ctx.repo, frames, batch);
    else
      for (let i = 0; i < batch.length; i += WRITES)
        await putRawBytes(ctx.env, (id) => objects.rawKey(id), batch.slice(i, i + WRITES));
    record(bundled ? 'git.bundle' : 'git.write', performance.now() - started, batch.length);
    frames = session.objects(WRITE_BUDGET);
    batch = framed(frames);
  }
  const runs: Json[] = [];
  const fresh = new Set<string>();
  let drain = false;
  // The verified commits come a page at a time (the session holds them), recorded in
  // batches of RECORD_COMMITS.
  for (let i = 0; i < verified.verified; i += RECORD_COMMITS) {
    const listed: Json[] = [];
    for (let at = i; at < Math.min(i + RECORD_COMMITS, verified.verified); at += VERIFIED_PAGE)
      listed.push(...session.call({ op: 'verified', from: at, count: VERIFIED_PAGE }).commits);
    messages.push(...largeWarnings(files.stored, listed));
    const commits: Json[] = listed.map((c) => ({
      ...c,
      ...(staged
        ? { objects: (c.objects as Json[]).map((o) => ({ ...o, data_b64: data.get(o.id) })) }
        : {}),
      check: tips.includes(c.commit),
      ...(tips.includes(c.commit) && reads.length > 0 ? { read_set: reads } : {}),
    }));
    for (const c of commits) fresh.add(c.commit);
    const recorded = await timed('git.record', () =>
      ctx.call({
        op: 'repo_record_pushed',
        commits,
        ...(staged ? { staged: true } : {}),
      }),
    );
    runs.push(...(recorded.check_runs ?? []));
    drain ||= recorded.dispatch_objects === true;
  }
  if (staged) record('git.staged', 0, batch.length);
  // The objects are durable in the authority: the drain request can leave after the
  // answer (a lost one is resent with the next accepted commit).
  const send = () => dispatchObjects(ctx.env, ctx.repo).catch(() => {});
  if (drain && !deferred(send)) await timed('git.drain', send);
  // Undispatched runs stay queued in the authority and are sent again on request.
  await timed('git.runs', () => dispatchRuns(ctx.env, ctx.repo, runs).catch(() => {}));
  return fresh;
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
