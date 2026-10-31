// A repository's Artifacts store: the projected mirror of a repository in production. Its
// create may be left to a queue job (`ASYNC_STORE`; repo-store-create), so a store can be
// missing for a while after its repository exists: reads find it empty, and what needs it
// says so (`STORE_PENDING`) or waits for it (`ready`).
import { bounded, rpcValue } from './durable';
import { largeReceivePack } from './repo-large-files';
import { gone } from './repo-mirror-git';
import type { ObjectStore } from './repo-stores';
import { record, timed } from './repo-timing';
import type { Env } from './types';

/** Per-isolate: a repository's remote never changes. */
const remotes = new Map<string, string>();
/** Per-isolate write tokens, reused until shortly before they expire (never logged). */
const tokens = new Map<string, { plaintext: string; expires: number }>();
const TOKEN_SECONDS = 60;
const TOKEN_REUSE_MS = 40_000;
const CLONE_TOKEN_SECONDS = 600;
/** Busy answers a large file's push waits out (Artifacts takes one receive-pack at once). */
const PUSH_FILE_RETRIES = 6;
/** The queue job that creates a repository's store (`asyncStore`; repo-store-create). */
export const STORE_JOB = 'platform_store';
/** What a request needing the store itself waits for a job to make it: delivery (a second
 * or two) and a create (3.3 s at worst on dev). A seeded create's dialog allows for it. */
export const STORE_WAIT_MS = 20_000;
const STORE_POLL_MS = 250;
/** Why a store can't be used yet, with `ASYNC_STORE` on. */
export const STORE_PENDING = 'STORE_PENDING';

/** Whether a new repository's store is left to a queue job (`ASYNC_STORE=on`). R2 has nothing
 * to wait for. */
export const asyncStore = (env: Env) =>
  env.ASYNC_STORE === 'on' && env.PLATFORM_OBJECT_STORE !== 'r2';

/** Asks for the repository's own store. Sent only with `asyncStore`: see docs/runbook.md
 * for the order a new job kind reaches the Workers in. */
export async function dispatchStore(env: Env, repo: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: STORE_JOB, repo_id: repo, job_id: 'store' });
}

/** Whether `e` says Artifacts has no such repository (yet). */
export const absent = (e: any) => e?.code === 'CREATE_IN_PROGRESS' || gone(e);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ArtifactsStore implements ObjectStore {
  constructor(
    private readonly env: Env,
    private readonly name: string,
  ) {}
  get spec() {
    return `artifacts:${this.env.ARTIFACTS_NAMESPACE}/${this.name}`;
  }
  async create() {
    await rpcValue(this.env.ARTIFACTS.create(this.name, { setDefaultBranch: 'main' }));
  }
  /**
   * Pushes through the repository's queue: Artifacts takes one receive-pack at a time. The
   * remote and a short-lived write token are reused within this isolate; minting and
   * revoking a token per push cost more than the push itself. A rejected token is replaced.
   */
  async push(body: Uint8Array) {
    const queue = this.env.OBJECT_PUSHES.get(this.env.OBJECT_PUSHES.idFromName(this.spec));
    for (let attempt = 0; ; attempt++) {
      const { remote, token } = await timed('push.token', () => this.credentials(attempt > 0));
      try {
        const pushed = await rpcValue(queue.push(remote, token, body));
        record('push.wait', pushed.waited_ms);
        record('push.send', pushed.sent_ms);
        record('push.batch', pushed.batch);
        return pushed.report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /returned 40[13]/.test(message)) continue;
        throw Object.assign(new Error(message), { code: 'PUSH_FAILED' });
      }
    }
  }
  /**
   * Streams a large file's receive-pack straight to Artifacts (never through the push
   * queue: its body cannot be held or combined), retrying while Artifacts is busy with
   * another receive-pack and once with a fresh token.
   */
  async pushFile(id: string, size: number, open: () => Promise<ReadableStream<Uint8Array>>) {
    for (let attempt = 0; ; attempt++) {
      const { remote, token } = await this.credentials(attempt > 0);
      const { body, carrier } = largeReceivePack(id, size, await open());
      const result = await fetch(`${remote}/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-git-receive-pack-request',
          accept: 'application/x-git-receive-pack-result',
        },
        body,
        redirect: 'manual',
      });
      const report = new Uint8Array(await result.arrayBuffer());
      if ([401, 403].includes(result.status) && attempt === 0) continue;
      const busy = new TextDecoder().decode(report.subarray(0, 200)).includes('busy');
      if (busy && attempt < PUSH_FILE_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100),
        );
        continue;
      }
      if (result.status !== 200)
        throw Object.assign(new Error(`Object store push returned ${result.status}`), {
          code: 'PUSH_FAILED',
        });
      return carrier;
    }
  }
  private async credentials(fresh: boolean) {
    const cached = tokens.get(this.spec);
    const remote = remotes.get(this.spec);
    if (!fresh && remote && cached && cached.expires > Date.now())
      return { remote, token: cached.plaintext };
    using repo = await this.opened();
    const url = remote ?? (await rpcValue(repo.info())).remote;
    remotes.set(this.spec, url);
    const token = await rpcValue(repo.createToken('write', TOKEN_SECONDS));
    tokens.set(this.spec, { plaintext: token.plaintext, expires: Date.now() + TOKEN_REUSE_MS });
    return { remote: url, token: token.plaintext };
  }
  /** The repository; a store still to come fails with `STORE_PENDING`, at once. */
  private async opened() {
    try {
      return await this.env.ARTIFACTS.get(this.name);
    } catch (e: any) {
      if (!asyncStore(this.env) || !absent(e)) throw e;
      throw Object.assign(new Error(`Store ${this.name} does not exist yet`), {
        code: STORE_PENDING,
      });
    }
  }
  /** The repository, waiting up to STORE_WAIT_MS for the job making it; 503 after that. */
  private async waited() {
    const until = Date.now() + STORE_WAIT_MS;
    const poll = async () => {
      for (;;) {
        try {
          return await this.opened();
        } catch (e: any) {
          if (e?.code !== STORE_PENDING || Date.now() > until) throw e;
        }
        await sleep(STORE_POLL_MS);
      }
    };
    return bounded(STORE_WAIT_MS, poll()).catch((e) => {
      if (e?.code && e.code !== STORE_PENDING) throw e;
      throw Object.assign(new Error("The repository's object store is not ready yet"), {
        code: 'OVERLOADED',
      });
    });
  }
  async ready() {
    await rpcValue(this.waited());
  }
  async cloneAccess() {
    using repo = await this.waited();
    const info = await rpcValue(repo.info());
    const token = await rpcValue(repo.createToken('read', CLONE_TOKEN_SECONDS));
    return { remote: info.remote, token: token.plaintext, expires_in_seconds: CLONE_TOKEN_SECONDS };
  }
  async readCommit(id: string) {
    using repo = await this.held();
    const commit = repo && (await rpcValue(repo.readCommit(id)));
    return commit ? { tree: commit.treeHash, parents: commit.parents } : null;
  }
  async readTree(id: string) {
    using repo = await this.held();
    const entries = repo && (await rpcValue(repo.readTree(id)));
    return entries ? entries.map((e) => ({ name: e.name, type: e.type, id: e.hash })) : null;
  }
  async readBlob(id: string) {
    using repo = await this.held();
    if (!repo) return null;
    return rpcValue(repo.readBlob(id), async (blob) =>
      blob ? new Uint8Array(await blob.arrayBuffer()) : null,
    );
  }
  /** The repository to read, or null when it does not exist: once deleted (a mirror retired
   * after a purge, still named by a fork's record of its parent or a head copy older than
   * the switch), or not yet (`STORE_JOB`). The store of record holds all of it either way. */
  private async held() {
    try {
      return await this.env.ARTIFACTS.get(this.name);
    } catch (e: any) {
      if (absent(e)) return null;
      throw e;
    }
  }
}
