// An import is a clone. `cloneRepository` runs `git clone` in an ImportContainer (the one kind
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
import { connectHint, type GitHubSource, importCredential } from './platform-github-import';
import { storePack } from './platform-pack-builder';
import {
  type Cloned,
  createRefs,
  MAIN,
  type RemoteRef,
  recordCommits,
  storeObjects,
  trunkOf,
} from './repo-clone-records';
import { githubRemote, remoteHead } from './repo-git-remote';
import { caller, type Json } from './repo-ops';
import { keepSeed, packKey, wholeClone } from './repo-pack-cache';
import { carriedHeaders } from './request-scope';
import type { Env } from './types';

/** Mints what a private remote takes, inside the step that sends it. */
type Credential = () => Promise<string | undefined>;

/** `branch`: the remote's branch to land as main; none: its default branch. */
export type CloneParams = {
  observation?: import('./operation-carrier').OperationCarrier;
  repo: string;
  url: string;
  branch?: string;
  /** When the request asked, for the import's own timing. */
  asked_at?: number;
  /** A private source: where its access is minted from, never the access itself. */
  github?: GitHubSource;
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
/** Commits one read of the instance lists. */
const COMMIT_PAGE = 1000;
/** Fresh instances an import may take. */
const ATTEMPTS = 2;
const STEP = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '30 minutes',
};
/** The clone itself: a container's cold start and Git. */
const CLONE_STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '75 minutes' };
const LOST = 'CLONE_LOST';

export type Stage =
  | { stage: 'clone' }
  | { stage: 'objects' | 'commits'; from: number }
  | { stage: 'refs'; cloned: Cloned }
  | { stage: 'pack'; key: string }
  | { stage: 'stop' };

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
    const main = trunkOf(refs, cloned, params.branch);
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
    // Every ref keeps its name. Only a branch asked for in place of the remote's own main moves
    // that main aside, as main can hold one commit.
    const others = refs
      .filter((r) => r !== main || r.ref !== MAIN)
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
async function asked(env: Env, remote: string, branch: string | undefined, credential?: string) {
  try {
    await remoteHead(remote, branch, AbortSignal.timeout(REMOTE_WAIT_MS), credential);
  } catch (e: any) {
    const said = String(e?.message);
    if (/answered 40[134]/.test(said))
      throw new NonRetryableError(`REMOTE_AUTH_REQUIRED: ${said}${connectHint(env, credential)}`);
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
  credential: Credential,
) {
  const send = (name: string, config: Json, stage: Stage) =>
    step.do(`${name} (${pass})`, config, () => runner.cloneStep(stage, params));
  // Only the instance's start needs it. Each start has one of its own, read inside the step so
  // that it is in no step's name or result.
  const cloned = await step.do(`clone (${pass})`, CLONE_STEP, async () =>
    runner.cloneStep({ stage: 'clone' }, params, await credential()),
  );
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
 * instance's environment alone and is kept nowhere: it is minted inside the step that uses it,
 * and a step that runs again mints another. */
export async function cloneRepository(
  env: Env,
  params: CloneParams,
  step: CloneStep,
  credential: Credential = () => importCredential(env, params.github),
) {
  const remote = githubRemote(params.url);
  if (!remote)
    throw new NonRetryableError('INVALID_URL: Only public GitHub repositories can be added');
  await step.do('ask the remote', STEP, async () =>
    asked(env, remote, params.branch, await credential()).then(() => true),
  );
  const runner = env.IMPORT_RUNNERS.get(
    env.IMPORT_RUNNERS.idFromName(`clone:${params.repo}`),
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
