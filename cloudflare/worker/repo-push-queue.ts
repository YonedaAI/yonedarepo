// One push queue per Artifacts repository. Artifacts accepts a single receive-pack per
// repository at a time (it answers `ERR artifacts_git_receive_pack_busy`), so concurrent
// commits would fail or wait out one push each. Pushes that arrive while one is in flight
// leave together as one combined receive-pack, and each caller gets its own ref's report.
// A push that already carries several refs (a projection's backlog or its carriers'
// deletes) leaves alone, with its whole report: combining is for single-ref pushes.
// The queue holds no state worth keeping: callers retry if it is evicted mid-push.
import { DurableObject } from 'cloudflare:workers';
import { compute } from './repo-compute';
import { fromBase64, toBase64 } from './repo-objects';
import type { Env } from './types';

const MAX_BATCH = 64;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const BUSY_RETRIES = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Git's report for one ref, with how long it waited for and spent in its receive-pack. */
export type Pushed = { report: Uint8Array; waited_ms: number; sent_ms: number; batch: number };
type Waiting = {
  body: Uint8Array;
  refs: string[];
  queued: number;
  resolve(pushed: Pushed): void;
  reject(error: unknown): void;
};

/** The refs a receive-pack body this platform built updates (its commands, to the flush). */
function refsOf(body: Uint8Array) {
  const refs: string[] = [];
  for (let at = 0; at + 4 <= body.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (!length) break;
    const command = new TextDecoder().decode(body.subarray(at + 4, at + length)).split('\0')[0];
    refs.push(command.trim().split(' ')[2] ?? '');
    at += length;
  }
  return refs;
}

/** Takes the oldest waiting pushes, at most one per ref (Git refuses duplicates); a push of
 * several refs only alone. */
function take(waiting: Waiting[]) {
  const batch: Waiting[] = [];
  const refs = new Set<string>();
  let bytes = 0;
  for (let i = 0; i < waiting.length && batch.length < MAX_BATCH; ) {
    const next = waiting[i];
    const several = next.refs.length > 1;
    if (several && batch.length === 0) return waiting.splice(i, 1);
    if (
      several ||
      next.refs.some((ref) => refs.has(ref)) ||
      (batch.length > 0 && bytes + next.body.length > MAX_BATCH_BYTES)
    ) {
      i++;
      continue;
    }
    for (const ref of next.refs) refs.add(ref);
    bytes += next.body.length;
    batch.push(...waiting.splice(i, 1));
  }
  return batch;
}

/** Git's error packet (`ERR <message>`) when the server refuses the whole request. */
function errorPacket(report: Uint8Array) {
  const text = new TextDecoder().decode(report.subarray(4, 4 + 200));
  return text.startsWith('ERR ') ? text.slice(4).trim() : null;
}

/** The queue's logic, separate from the Durable Object so tests can drive it in-process. */
export class PushBatcher {
  #waiting: Waiting[] = [];
  #draining = false;
  #remote = { url: '', token: '' };

  /**
   * Pushes `body` to `remote` and resolves with Git's report for its ref. `token` is the
   * caller's short-lived write token; a batch uses the newest one, whose caller is still
   * waiting and so has not revoked it.
   */
  push(remote: string, token: string, body: Uint8Array): Promise<Pushed> {
    this.#remote = { url: remote, token };
    return new Promise((resolve, reject) => {
      this.#waiting.push({ body, refs: refsOf(body), queued: Date.now(), resolve, reject });
      if (!this.#draining) void this.#drain();
    });
  }

  async #drain() {
    this.#draining = true;
    try {
      while (this.#waiting.length > 0) {
        const batch = take(this.#waiting);
        const sending = Date.now();
        try {
          const body =
            batch.length === 1
              ? batch[0].body
              : fromBase64(
                  compute({ op: 'push_combine', bodies_b64: batch.map((w) => toBase64(w.body)) })
                    .push_b64,
                );
          const report = await this.#send(body);
          const sent_ms = Date.now() - sending;
          for (const w of batch)
            w.resolve({
              report:
                batch.length === 1
                  ? report
                  : fromBase64(
                      compute({
                        op: 'push_split',
                        report_b64: toBase64(report),
                        refname: w.refs[0],
                      }).report_b64,
                    ),
              waited_ms: sending - w.queued,
              sent_ms,
              batch: batch.length,
            });
        } catch (error) {
          for (const w of batch) w.reject(error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #send(body: Uint8Array) {
    for (let attempt = 0; ; attempt++) {
      const result = await fetch(`${this.#remote.url}/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#remote.token}`,
          'content-type': 'application/x-git-receive-pack-request',
          accept: 'application/x-git-receive-pack-result',
        },
        body,
        redirect: 'manual',
      });
      if (result.status !== 200) throw new Error(`Object store push returned ${result.status}`);
      const report = new Uint8Array(await result.arrayBuffer());
      // Someone outside this queue (a human `git push`) holds the repository.
      if (errorPacket(report)?.includes('busy') && attempt < BUSY_RETRIES) {
        await sleep(100 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      return report;
    }
  }
}

export class ObjectPushQueue extends DurableObject<Env> {
  #batcher = new PushBatcher();

  push(remote: string, token: string, body: Uint8Array): Promise<Pushed> {
    return this.#batcher.push(remote, token, body);
  }
}
