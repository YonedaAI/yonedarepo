// An import is a clone. `cloneRepository` runs `git clone` in a check container (its one kind
// of instance with the internet), and hands what that fetched to what a push stores and
// records with: bundles, `repo_record_pushed` and the repository's refs. Nothing goes over the
// public Git endpoint: the Worker reads the instance's own routes (clone_import.rs), so the
// result is an ordinary repository, every object in the store of record and every commit of
// every branch and tag recorded under its own id. docs/clone-import.md has the budget.
//
// A Workflow runs it in steps, each time-boxed, so that no Worker has to fit a repository into
// one call: the clone, then objects, commits, the pack a first `git clone` is sent and the refs.
// Refs come last, so an import is nothing or all of it. Every step repeats harmlessly: objects
// and commits are keyed by id, and a ref at its commit stays. An instance that goes takes the
// clone with it, and the steps start again from a new one (`ATTEMPTS`). Git's own hashing
// checked every object on its way in; `repo_record_pushed` checks each commit again.

import { NonRetryableError } from 'cloudflare:workflows';
import type { CheckInstance, Started } from './check-container';
import { log } from './log';
import { storePack } from './platform-pack-builder';
import { HEADER, storeBundle } from './repo-bundles';
import { githubRemote, remoteHead } from './repo-git-remote';
import { putLarge, SPILL_BYTES } from './repo-large-files';
import { caller, type Json } from './repo-ops';
import { keepSeed, packKey, wholeClone } from './repo-pack-cache';
import { framed, WRITE_BUDGET } from './repo-pack-copy';
import { concat } from './repo-pack-stream';
import { carriedHeaders } from './request-scope';
import type { Env } from './types';

/** `branch`: the remote's branch to land as main; none: its default branch. */
export type CloneParams = {
  repo: string;
  url: string;
  branch?: string;
  /** When the request asked, for the import's own timing. */
  asked_at?: number;
};
/** The subset of WorkflowStep a clone uses (tests pass a direct runner). */
export type CloneStep = {
  do<T>(name: string, config: Json, callback: () => Promise<T>): Promise<T>;
};

/** The largest pack a repository takes: its published 10 GB. */
export const MAX_PACK_BYTES = 10_000_000_000;
/** What Git may take, enforced where it runs. */
const CLONE_SECONDS = 60 * 60;
/** How long one step works before it hands on: well inside a Worker's 5 minutes of CPU. */
const STEP_MS = 120_000;
const REMOTE_WAIT_MS = 10_000;
/** Bundles written at once. */
const BUNDLES = 3;
/** Commits one read of the instance lists, and those one authority call records. */
const COMMIT_PAGE = 1000;
const RECORD_COMMITS = 100;
/** JSON one authority call carries (one larger commit goes alone). */
const RECORD_BYTES = 1024 * 1024;
const REF_BATCH = 100;
/** Fresh instances an import may take. */
const ATTEMPTS = 2;
const STEP = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '30 minutes',
};
/** The clone itself: a container's cold start and Git. */
const CLONE_STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '75 minutes' };
const LOST = 'CLONE_LOST';
const MAIN = 'refs/heads/main';

/** What `POST /clone` answers (clone_import.rs). */
type Cloned = {
  default_branch: string | null;
  pack_bytes: number;
  pack_objects: number;
  objects: number;
  commits: number;
  refs: number;
  refs_skipped: number;
};
/** A branch or tag as `/clone/refs` lists it. */
type RemoteRef = { ref: string; id: string; commit: string; tag_b64?: string };
const REFUSED_REF = ['INVALID_INPUT', 'GIT_OBJECT_INVALID'];
export type Stage =
  | { stage: 'clone' }
  | { stage: 'objects' | 'commits'; from: number }
  | { stage: 'refs'; cloned: Cloned }
  | { stage: 'pack'; key: string }
  | { stage: 'stop' };

/** Reads a stream by exact counts. */
class Exact {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #held: Uint8Array = new Uint8Array();

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async ended() {
    while (this.#held.length === 0) {
      const { done, value } = await this.#reader.read();
      if (done) return true;
      this.#held = value;
    }
    return false;
  }

  /** Up to `limit` bytes as they come; fails at an end that was not due. */
  async #piece(limit: number) {
    if (await this.ended()) throw new Error('The stream ended early');
    const piece = this.#held.subarray(0, limit);
    this.#held = this.#held.subarray(piece.length);
    return piece;
  }

  async take(count: number) {
    const pieces: Uint8Array[] = [];
    for (let left = count; left > 0; left -= pieces[pieces.length - 1].length)
      pieces.push(await this.#piece(left));
    return pieces.length === 1 ? pieces[0] : concat(pieces);
  }

  /** The next `count` bytes, not held. */
  stream(count: number) {
    let left = count;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const piece = await this.#piece(left);
        left -= piece.length;
        controller.enqueue(piece);
        if (left === 0) controller.close();
      },
    });
  }

  cancel() {
    return this.#reader.cancel();
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Stores the frames `body` streams as a push does: bundles, and a large file as its own raw
 * object. Stops at a frame's end once `until` has passed. Answers how many it took, and whether
 * that was all of them. */
async function storeObjects(
  env: Env,
  repo: string,
  body: ReadableStream<Uint8Array>,
  until: number,
) {
  const from = new Exact(body);
  let pieces: Uint8Array[] = [];
  let filled = 0;
  let objects = 0;
  let going: Promise<void>[] = [];
  const flush = async () => {
    if (filled === 0) return;
    const bytes = concat(pieces);
    pieces = [];
    filled = 0;
    going.push(storeBundle(env, repo, bytes, framed(bytes)));
    if (going.length < BUNDLES) return;
    await Promise.all(going);
    going = [];
  };
  let ended = false;
  for (;;) {
    ended = await from.ended();
    // At least one object a step, however late it started: every step moves the import on.
    if (ended || (objects > 0 && Date.now() >= until)) break;
    const header = await from.take(HEADER);
    const size = new DataView(header.buffer, header.byteOffset, HEADER).getUint32(21);
    objects++;
    if (size > SPILL_BYTES && header[0] === 3) {
      const key = `platform/v1/${repo}/git/${hex(header.subarray(1, 21))}`;
      await putLarge(env, key, size, from.stream(size));
      continue;
    }
    if (filled + HEADER + size > WRITE_BUDGET) await flush();
    pieces.push(header, await from.take(size));
    filled += HEADER + size;
  }
  await flush();
  await Promise.all(going);
  if (!ended) await from.cancel();
  return { objects, ended };
}

/** Records `lines` (commits parents first, a line each) in calls of RECORD_COMMITS commits or
 * RECORD_BYTES of JSON. Answers how many. */
async function recordCommits(env: Env, repo: string, lines: string[]) {
  const call = caller(env, repo, { _system: 'import' });
  let waiting: Json[] = [];
  let bytes = 0;
  const record = async () => {
    if (waiting.length > 0) await call({ op: 'repo_record_pushed', commits: waiting });
    waiting = [];
    bytes = 0;
  };
  for (const line of lines) {
    if (waiting.length >= RECORD_COMMITS || bytes + line.length > RECORD_BYTES) await record();
    waiting.push(JSON.parse(line));
    bytes += line.length;
  }
  await record();
}

/** What lands as main: the branch asked for, else the remote's default. */
function mainOf(refs: RemoteRef[], cloned: Cloned, branch?: string) {
  const named = branch ?? cloned.default_branch ?? undefined;
  const branches = refs.filter((r) => r.ref.startsWith('refs/heads/'));
  const found =
    branches.find((r) => r.ref === `refs/heads/${named}`) ??
    (branch === undefined ? branches[0] : undefined);
  if (!found)
    throw new NonRetryableError(
      branch
        ? `NOT_FOUND: Branch ${branch} was not found`
        : 'NOT_FOUND: The remote has no branches',
    );
  return found;
}

/** Creates `refs` in calls of REF_BATCH. One the platform cannot name is left out on its own,
 * and counted. */
async function createRefs(env: Env, repo: string, refs: RemoteRef[]) {
  const call = caller(env, repo, { _system: 'import' });
  const update = (r: RemoteRef) => ({
    ref: r.ref,
    commit: r.commit,
    ...(r.tag_b64 ? { tag: { data_b64: r.tag_b64 } } : {}),
  });
  let left_out = 0;
  for (let at = 0; at < refs.length; at += REF_BATCH) {
    const batch = refs.slice(at, at + REF_BATCH);
    await call({ op: 'repo_import_refs', updates: batch.map(update) }).catch(async (e) => {
      if (!REFUSED_REF.includes(e?.code)) throw e;
      for (const one of batch)
        await call({ op: 'repo_import_refs', updates: [update(one)] }).catch((why) => {
          left_out++;
          log.warn('import.ref_left_out', { repo, reason: `${one.ref}: ${why?.code}` });
        });
    });
  }
  return left_out;
}

/** One repository's clone in one instance: what the Workflow's steps call. The instance is
 * this object's until `stop`; the Worker holding it destroys it whatever happens. */
export class CloneSession {
  #started: Started | null = null;

  constructor(
    private readonly instance: CheckInstance,
    private readonly env: Env,
    private readonly start: (credential?: string) => Promise<Started>,
  ) {}

  #ask(path: string, body?: string) {
    if (!this.#started) throw Object.assign(new Error('The clone is gone'), { code: LOST });
    return this.instance.containerFetch(
      new Request(`http://check${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.#started.secret}`, ...carriedHeaders() },
        body,
      }),
    );
  }

  async #read(path: string) {
    const answer = await this.#ask(path);
    if (!answer.ok) throw new Error(`The container answered ${path} with ${answer.status}`);
    return answer;
  }

  /** A fresh instance's `git clone`. */
  async #clone(params: CloneParams, credential?: string) {
    await this.stop();
    this.#started = await this.start(credential);
    const began = Date.now();
    const answer = await this.#ask(
      '/clone',
      JSON.stringify({
        url: params.url,
        max_pack_bytes: MAX_PACK_BYTES,
        timeout_seconds: CLONE_SECONDS,
      }),
    );
    if (answer.ok) {
      const cloned = await answer.json<Cloned>();
      return { ...cloned, start_ms: this.#started.startMs, clone_ms: Date.now() - began };
    }
    const { error } = await answer.json<{ error?: Json }>().catch(() => ({ error: undefined }));
    await this.stop();
    if (error?.code === 'REPO_TOO_LARGE')
      return { refused: `REPO_TOO_LARGE: ${error.message}` } as const;
    throw new Error(`The clone failed: ${error?.message ?? answer.status}`);
  }

  async #objects(params: CloneParams, from: number) {
    const answer = await this.#read(`/clone/objects?from=${from}`);
    const body = answer.body as ReadableStream<Uint8Array>;
    const { objects, ended } = await storeObjects(
      this.env,
      params.repo,
      body,
      Date.now() + STEP_MS,
    );
    return ended ? null : from + objects;
  }

  async #commits(params: CloneParams, from: number) {
    const until = Date.now() + STEP_MS;
    let at = from;
    for (;;) {
      const page = await (
        await this.#read(`/clone/commits?from=${at}&count=${COMMIT_PAGE}`)
      ).text();
      const lines = page.split('\n').filter(Boolean);
      await recordCommits(this.env, params.repo, lines);
      at += lines.length;
      if (lines.length < COMMIT_PAGE) return null;
      if (Date.now() >= until) return at;
    }
  }

  /** Main, then every other branch and tag. Answers where the pack a `git clone` of all of
   * them is sent would go. */
  async #refs(params: CloneParams, cloned: Cloned) {
    const { repo } = params;
    const refs = await this.#refList();
    const main = mainOf(refs, cloned, params.branch);
    const call = caller(this.env, repo, { _system: 'import' });
    await call({
      op: 'repo_import',
      ref: 'main',
      commit: main.commit,
      pack_bytes: cloned.pack_bytes,
    }).catch(async (e) => {
      if (e?.code !== 'ALREADY_EXISTS') throw e;
      // A repeat of this step finds its own main; anything else came from someone else.
      const { refs: held } = await call({ op: 'repo_refs' });
      if (held[MAIN] !== main.commit)
        throw new Error('This repository changed while it was importing');
    });
    // A branch of the remote's own called main is kept, under another name.
    const others = refs
      .filter((r) => r !== main)
      .map((r) => (r.ref === MAIN ? { ...r, ref: 'refs/heads/imported/main' } : r));
    const left_out = await createRefs(this.env, repo, others);
    // With a ref left out, no clone asks for all of what the pack holds.
    const key = left_out === 0 ? await packKey(repo, wholeClone(refs.map((r) => r.id))) : null;
    const usable_ms = Date.now() - (params.asked_at ?? Date.now());
    return { commit: main.commit, refs: refs.length, left_out, key, usable_ms };
  }

  /** The pack a first `git clone` is sent, so that none is built from the objects, and what
   * later packs start from. It only saves that work: a failure here ends nothing. */
  async #pack(params: CloneParams, key: string) {
    const answer = await this.#read('/clone/pack');
    await storePack(this.env, params.repo, key, undefined, answer, async () => false);
    const tips = (await this.#refList()).map((r) => r.id);
    await keepSeed(this.env, params.repo, key, [...new Set(tips)]);
    return true;
  }

  async #refList() {
    const listed = await (await this.#read('/clone/refs')).text();
    return listed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RemoteRef);
  }

  /** The instance goes, however it was left. */
  async stop() {
    const going = this.#started;
    this.#started = null;
    if (going) await this.instance.destroy();
  }

  /** One step. An instance lost between steps answers `LOST`, for the Workflow to start over. */
  async step(stage: Stage, params: CloneParams, credential?: string) {
    switch (stage.stage) {
      case 'clone':
        return this.#clone(params, credential);
      case 'objects':
        return this.#objects(params, stage.from);
      case 'commits':
        return this.#commits(params, stage.from);
      case 'refs':
        return this.#refs(params, stage.cloned);
      case 'pack':
        return this.#pack(params, stage.key);
      case 'stop':
        return this.stop();
    }
  }
}

/** The container's side of a clone, as this Worker calls it. */
type CloneRunner = {
  cloneStep(stage: Stage, params: CloneParams, credential?: string): Promise<any>;
};

/** Why a remote cannot be cloned, as its import reads: a remote that is private or gone
 * answers for no container's start. */
async function asked(remote: string, branch: string | undefined) {
  try {
    await remoteHead(remote, branch, AbortSignal.timeout(REMOTE_WAIT_MS));
  } catch (e: any) {
    const said = String(e?.message);
    if (/answered 40[134]/.test(said)) throw new NonRetryableError(`REMOTE_AUTH_REQUIRED: ${said}`);
    if (/has no /.test(said)) throw new NonRetryableError(`NOT_FOUND: ${said}`);
    throw e;
  }
}

/** One pass, on one instance. */
async function clonePass(
  runner: CloneRunner,
  step: CloneStep,
  params: CloneParams,
  pass: number,
  credential?: string,
) {
  const send = (name: string, config: Json, stage: Stage) =>
    step.do(`${name} (${pass})`, config, () => runner.cloneStep(stage, params, credential));
  const cloned = await send('clone', CLONE_STEP, { stage: 'clone' });
  if ('refused' in cloned) throw new NonRetryableError(cloned.refused);
  for (const stage of ['objects', 'commits'] as const)
    for (let from: number | null = 0; from !== null; )
      from = await send(`${stage} from ${from}`, STEP, { stage, from });
  const landed = await send('refs', STEP, { stage: 'refs', cloned });
  if (landed.key)
    await send('pack', STEP, { stage: 'pack', key: landed.key }).catch((e) => {
      log.warn('import.pack_not_stored', { repo: params.repo, error: e });
    });
  const { commits, objects, pack_bytes } = cloned;
  return {
    commit: landed.commit,
    refs: landed.refs,
    left_out: landed.left_out,
    commits,
    objects,
    pack_bytes,
    timing: { start_ms: cloned.start_ms, clone_ms: cloned.clone_ms, usable_ms: landed.usable_ms },
  };
}

/** Clones `params.url` into `params.repo`. `credential`, for a private remote, travels by the
 * instance's environment alone and is kept nowhere: a caller reads it inside its own step. */
export async function cloneRepository(
  env: Env,
  params: CloneParams,
  step: CloneStep,
  credential?: string,
) {
  const remote = githubRemote(params.url);
  if (!remote)
    throw new NonRetryableError('INVALID_URL: Only public GitHub repositories can be added');
  await step.do('ask the remote', STEP, () => asked(remote, params.branch).then(() => true));
  const runner = env.CHECK_RUNNERS.get(
    env.CHECK_RUNNERS.idFromName(`clone:${params.repo}`),
  ) as unknown as CloneRunner;
  const clean = { ...params, url: remote };
  try {
    for (let pass = 1; ; pass++) {
      try {
        return await clonePass(runner, step, clean, pass, credential);
      } catch (e: any) {
        if (pass >= ATTEMPTS || !String(e?.message).includes('The clone is gone')) throw e;
      }
    }
  } finally {
    await step.do('stop the instance', STEP, () =>
      runner.cloneStep({ stage: 'stop' }, clean).then(() => true),
    );
  }
}
