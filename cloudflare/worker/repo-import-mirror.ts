// A mirror whose tip is not what a direct import landed: the remote moved between the fetch
// and Artifacts' own, so it holds a later commit than main. Main stays what was fetched, and
// the mirror is moved back to it with the pack that fetch stored, which lands the commit
// whatever became of it on the remote. Rare, and left to a receive-pack: it is the one thing
// Git lets a client say to a mirror, and without it every later projection would be refused.

import { compute } from './repo-compute';
import { wholeClone } from './repo-import-direct';
import type { ImportParams } from './repo-import-head';
import { bandOne } from './repo-mirror-git';
import { parseStore, toBase64 } from './repo-objects';
import { packKey, storedPack } from './repo-pack-cache';
import type { Env } from './types';

const REF = 'refs/heads/main';
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** `old` to `head` on the mirror's main, with the pack stored for `head`. Fails loudly when
 * the pack is gone or the mirror refuses: nothing here is safe to guess. */
export async function moveMirror(env: Env, params: ImportParams, old: string, head: string) {
  const store = parseStore(env, `artifacts:${env.ARTIFACTS_NAMESPACE}/yr-${params.repo}`);
  const key = await packKey(params.repo, wholeClone([head]));
  const open = async () => {
    const stored = await storedPack(env, key);
    if (!stored) throw new Error(`The pack of ${head} is not stored`);
    const none = { shallow: [], unshallow: [] };
    const pack = bandOne(stored.body, none, false, true);
    const command = new TextEncoder().encode(
      `${pkt(`${old} ${head} ${REF}\0report-status\n`)}0000`,
    );
    let opened = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!opened) {
          opened = true;
          controller.enqueue(command);
          return;
        }
        const next = await pack.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await pack.return(undefined);
      },
    });
  };
  if (!store.pushStream) throw new Error('This store cannot be pushed to');
  const report = await store.pushStream(open);
  const { accepted, refused } = compute({
    op: 'push_outcome',
    refname: REF,
    report_b64: toBase64(report),
  });
  if (!accepted) throw new Error(`The mirror refused main at ${head}: ${refused}`);
}
