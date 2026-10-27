// Verified pushes to a repository's object store: a commit's pack goes to its hidden ref
// and the commit is read back from the store itself before it counts as pushed.
import { compute } from './repo-compute';
import type { RepoObjects } from './repo-objects';
import { fromBase64, toBase64 } from './repo-stores';
import { timed } from './repo-timing';

const PUSH_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const accepted = (refname: string) =>
  fromBase64(compute({ op: 'push_report', refname }).report_b64);
/** Git's report-status for one ref; anything else (an unpack failure, a server error line)
 * is a refusal carrying the report's printable text. */
function pushOutcome(report: Uint8Array, refname: string): { accepted: boolean; refused?: string } {
  try {
    const outcome = compute({ op: 'push_outcome', refname, report_b64: toBase64(report) });
    return { accepted: outcome.accepted === true, refused: outcome.refused ?? undefined };
  } catch {
    const text = new TextDecoder().decode(report).replace(/[^\x20-\x7e]+/g, ' ');
    return { accepted: false, refused: text.trim().slice(0, 300) || 'empty report' };
  }
}
/**
 * Pushes a commit's pack to its hidden ref and reads the commit back from the object store
 * itself, never the cache. Artifacts can refuse or lag pushes when several land on one
 * repository at once, so a refusal is retried with jittered backoff and a missing readback
 * is re-read before the push counts as failed. Pushes are idempotent: same objects, same
 * hidden ref. `ready` (the cache write running alongside) settles before the readback.
 */
export async function pushCommit(
  objects: RepoObjects,
  body: Uint8Array,
  commit: string,
  ready: Promise<unknown> = Promise.resolve(),
) {
  const refname = `refs/yoneda/c/${commit}`;
  ready.catch(() => {}); // observed below; a push failure must not leave it unhandled
  let reason = 'not readable';
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    if (attempt) await sleep(100 * 2 ** attempt + Math.random() * 100 * 2 ** attempt);
    const report = await timed('push.store', () => objects.store.push(body));
    const outcome = pushOutcome(report, refname);
    if (!outcome.accepted) {
      reason = `refused: ${outcome.refused}`;
      console.warn(`object store push attempt ${attempt + 1} ${reason}`);
    }
    await ready;
    for (let read = 0; read < 3; read++) {
      const readback = await timed('push.readback', () => objects.store.readCommit(commit));
      // A retried push may be refused because an earlier attempt already created the ref.
      if (readback) return { report: outcome.accepted ? report : accepted(refname), readback };
      if (!outcome.accepted) break;
      await sleep(50 * 2 ** read);
    }
  }
  throw Object.assign(new Error(`Pushed commit is not readable (${reason})`), {
    code: 'PUSH_FAILED',
  });
}
