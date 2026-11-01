// Where writes really come from (global regions stage R1): agents often don't run where their
// people live, so a sign-up's region is only a default. One write in EVERY leaves one Analytics
// Engine point, in the site's dataset under its own event: the continent, the client kind and
// operation class, and a digest of who wrote. Off unless REGION_SIGNALS is `on`. Budget:
// docs/load-testing.md.
//
// - Who wrote comes from credentials the request already checked (`caller`, repo-ops.ts), with
//   no read of its own. A repository token names no account without a lookup that path must not
//   gain (global-scale-plan.md, safety rule 8), so its digest is the repository's; an operator
//   finds the owner in `platform_repos`.
// - A digest, because an older account's name can be an email address. It is a pseudonym, not
//   anonymity: operators can match it against the names they hold, which is how it is joined
//   with `platform_accounts.region`.
// - GET and HEAD never open a watch, and Git over SSH is left out: the gateway's requests carry
//   the gateway's location, not the client's.
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAnswer } from './background';
import { clientRequest } from './platform-client-events';
import { continentOf, regionSignals } from './region';
import type { Credentials } from './repo-ops';
import { isOwnTraffic } from './site-events';
import { sha } from './storage';
import type { Env } from './types';

const EVERY = 10;
const SUBJECT_LENGTH = 32;
/** A session token, as `sshBearer` reads it; that module imports what imports this one. */
const SSH_BRIDGE = 'Bearer ysh_';

type Writer = { kind: 'account' | 'repo'; id: string };
type Watch = { writer?: Writer };

const watching = new AsyncLocalStorage<Watch>();

function writerOf(auth: Credentials, repo: string): Writer | null {
  if ('_pat' in auth) return { kind: 'account', id: auth._pat.workspace };
  if ('_token' in auth) return { kind: 'repo', id: repo };
  if ('_session' in auth && auth._session.principal.startsWith('user:'))
    return { kind: 'account', id: auth._session.workspace };
  return null;
}

/** A command that may move refs is being signed for `auth`: the request being watched, if any,
 * has its writer. Jobs and internal callers name nobody. */
export function noteWriter(auth: Credentials, repo: string) {
  const watch = watching.getStore();
  if (watch && !watch.writer) watch.writer = writerOf(auth, repo) ?? undefined;
}

function sampled(req: Request, env: Env, random: () => number) {
  if (!regionSignals(env) || !env.SITE_EVENTS) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  if (random() * EVERY >= 1 || isOwnTraffic(req)) return false;
  return !req.headers.get('authorization')?.startsWith(SSH_BRIDGE);
}

async function writePoint(req: Request, env: Env, writer: Writer) {
  try {
    const seen = clientRequest(req, new URL(req.url));
    const subject = (await sha(writer.id)).slice(0, SUBJECT_LENGTH);
    const empty = Array(9).fill('');
    env.SITE_EVENTS?.writeDataPoint({
      indexes: [subject],
      blobs: [
        'write_origin',
        ...empty,
        seen?.client ?? 'browser',
        seen?.operation ?? 'write',
        continentOf(req),
        writer.kind,
      ],
      doubles: [0, 1, EVERY],
    });
  } catch {
    // A lost data point is acceptable; a failed write is not.
  }
}

/** Runs a platform request, and counts it when it is sampled and wrote something. A refused
 * write counts for nobody: a repository token is unchecked until its repository answers. */
export async function watchWrites(
  req: Request,
  env: Env,
  run: () => Promise<Response>,
  random = Math.random,
) {
  if (!sampled(req, env, random)) return run();
  const watch: Watch = {};
  const res = await watching.run(watch, run);
  const { writer } = watch;
  if (writer && res.status < 400) await afterAnswer(() => writePoint(req, env, writer));
  return res;
}
