// Clone packs built in a container: PackBuilder (cloudflare/pack-builder/Dockerfile, its own
// image) runs `yoneda-pack-builder`, which builds them with stock Git (real deltas: svelte's
// full pack is 121.5 MiB against GitHub's 118.9 and the Worker's 136.6) in up to 1 GiB, where
// a Worker isolate has 128 MB. One instance per repository (`packs:<repo>`), started fresh
// for each build and destroyed after it (its PID 1 ignores SIGTERM: a stop would leave it
// holding a slot).
//
// The container has no internet and no credentials. Its two Git remotes are answered here:
// - http://mirror.internal/<repo>.git: the repository's Artifacts mirror (kept current by
//   projection), proxied with a short-lived read token this Worker mints per request;
// - http://platform.internal/<repo>.git: the platform's own smart HTTP (protocol v2,
//   served in-process as the `derive` system principal), for what the mirror lacks: with the
//   mirror's refs as haves, only the lag travels.
// Each answers only for the instance's own repository (the id of `packs:<repo>` must be
// the calling container's) and only upload-pack's two requests.
//
// The packs stream back to this Worker, which frames them as side-band packets (what a
// clone is served), checks each one's SHA-1 trailer and stores it (PackWriter) unless a
// blob was withheld meanwhile.
import { Container } from '@cloudflare/containers';
import { requestBody } from './repo-git-http';
import { advertiseV2, uploadPackV2 } from './repo-git-v2';
import { caller, type Json, RepoContext } from './repo-ops';
import { type Fresh, PART, PackWriter, packKey } from './repo-pack-cache';
import { CHUNK, concat, sideBand } from './repo-pack-stream';
import { parseStore } from './repo-stores';
import type { Env } from './types';

export const PACK_PORT = 8080;
const MIRROR_HOST = 'mirror.internal';
const PLATFORM_HOST = 'platform.internal';
const SOURCE_PATH = /^\/(r[0-9a-f]{20})\.git\/(info\/refs|git-upload-pack)$/;

/** One pack a build stores: what it is for (`tip`: main's commit, after a push). */
export type PackOrder = { label: string; fresh: Fresh; tip?: string };
/** A build: its packs, built only when their wants reach `minObjects` objects. */
export type BuildPlan = { repo: string; packs: PackOrder[]; minObjects: number };
export type PackOutcome = {
  label: string;
  outcome: 'stored' | 'held' | 'small' | 'withheld' | 'not kept';
  objects?: number;
  bytes?: number;
} & Json;
export type BuildReport = { start_ms: number; fetch?: Json; packs: PackOutcome[] };

/** The container operations a build needs (the Durable Object, or a test double). */
export type BuilderInstance = {
  startAndWaitForPorts(options: unknown): Promise<unknown>;
  containerFetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};

const builderName = (repo: string) => `packs:${repo}`;

/** The repository's builder, where the platform has containers for it. */
export const packBuilder = (env: Env, repo: string) =>
  env.PACK_BUILDERS?.get(env.PACK_BUILDERS.idFromName(builderName(repo)));

/** Builds `plan` in a fresh instance, destroyed whatever happens. `withheld`: whether the
 * repository withholds a blob now (asked again before each pack is kept). */
export async function buildPacks(
  instance: BuilderInstance,
  env: Env,
  plan: BuildPlan,
  withheld: () => Promise<boolean>,
): Promise<BuildReport> {
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const starting = Date.now();
  try {
    await instance.startAndWaitForPorts({
      ports: [PACK_PORT],
      startOptions: {
        envVars: {
          PACK_TOKEN: secret,
          MIRROR_URL: `http://${MIRROR_HOST}/${plan.repo}.git`,
          PLATFORM_URL: `http://${PLATFORM_HOST}/${plan.repo}.git`,
        },
      },
      cancellationOptions: { portReadyTimeoutMS: 90_000 },
    });
    const report: BuildReport = { start_ms: Date.now() - starting, packs: [] };
    const call = async (path: string, body?: string) => {
      const answer = await instance.containerFetch(
        new Request(`http://packs${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${secret}` },
          body,
        }),
      );
      if (!answer.ok) {
        const error = await answer.json<Json>().catch((): Json => ({}));
        throw new Error(`pack builder ${path}: ${answer.status} ${error.error ?? ''}`.trim());
      }
      return answer;
    };
    const wants = [...new Set(plan.packs.flatMap((p) => p.fresh.wants))];
    report.fetch = await (await call('/fetch', wants.join('\n'))).json<Json>();
    for (const order of plan.packs) {
      const key = await packKey(plan.repo, order.fresh);
      const label = order.label;
      if (Number(report.fetch.objects) < plan.minObjects)
        report.packs.push({ label, outcome: 'small', objects: report.fetch.objects });
      else if (await env.OBJECTS.head(key)) report.packs.push({ label, outcome: 'held' });
      else {
        const answer = await call(`/pack?${shape(order.fresh)}`, order.fresh.wants.join('\n'));
        const stored = await storePack(env, plan.repo, key, order.tip, answer, withheld);
        const { ms, cpu_ms, peak_mib } = await (await call('/stats')).json<Json>();
        report.packs.push({ label, ...stored, ms, cpu_ms, peak_mib });
      }
    }
    return report;
  } finally {
    await instance.destroy().catch(() => {});
  }
}

/** The pack options of `fresh` (the container builds depth 1 at most: `canBuild`). */
const shape = (fresh: Fresh) =>
  [fresh.omit_blobs ? 'filter=blob:none' : '', fresh.depth === 1 ? 'depth=1' : '']
    .filter(Boolean)
    .join('&');

/** Whether a container builds the pack of `fresh` (a full or partial clone, or depth 1). */
export const canBuild = (fresh: Fresh) =>
  (fresh.depth === null || fresh.depth === 1) && !fresh.deepen_relative;

/** Stores the pack `answer` streams, as side-band packets of CHUNK, once its trailer
 * checks out and no blob is withheld. */
async function storePack(
  env: Env,
  repo: string,
  key: string,
  tip: string | undefined,
  answer: Response,
  withheld: () => Promise<boolean>,
): Promise<{ outcome: PackOutcome['outcome']; objects: number; bytes: number }> {
  const writer = new PackWriter(env, repo, key, PART, tip);
  const digest = new crypto.DigestStream('SHA-1');
  const hashing = digest.getWriter();
  let pending: Uint8Array[] = [];
  let size = 0;
  let tail = new Uint8Array();
  let head = new Uint8Array();
  let bytes = 0;
  const flush = async (all: boolean) => {
    while (size >= CHUNK || (all && size > 0)) {
      const joined = concat(pending);
      const piece = joined.subarray(0, Math.min(CHUNK, joined.length));
      pending = [joined.subarray(piece.length)];
      size -= piece.length;
      await writer.add(sideBand(1, piece, CHUNK));
    }
  };
  try {
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (head.length < 12) head = concat([head, chunk]).subarray(0, 12);
      // Everything but the last 20 bytes (the trailer) is hashed.
      const joined = concat([tail, chunk]);
      const cut = Math.max(joined.length - 20, 0);
      await hashing.write(joined.subarray(0, cut));
      tail = joined.slice(cut);
      pending.push(chunk);
      size += chunk.length;
      await flush(false);
    }
    await hashing.close();
    const sum = new Uint8Array(await digest.digest);
    const magic = new TextDecoder().decode(head.subarray(0, 4));
    if (magic !== 'PACK' || tail.length !== 20 || sum.some((b, i) => b !== tail[i]))
      throw new Error('the pack builder sent an incomplete pack');
    await flush(true);
    const objects = new DataView(head.buffer, head.byteOffset + 8, 4).getUint32(0);
    if (await withheld()) {
      await writer.abort();
      return { outcome: 'withheld', objects, bytes };
    }
    return { outcome: (await writer.finish(0)) ? 'stored' : 'not kept', objects, bytes };
  } catch (e) {
    await writer.abort().catch(() => {});
    throw e;
  }
}

/** The repository a container's request names, when it is that container's own. */
function ownRepo(req: Request, env: Env, containerId: string) {
  const url = new URL(req.url);
  const match = SOURCE_PATH.exec(url.pathname);
  if (!match || !env.PACK_BUILDERS) return null;
  const own = env.PACK_BUILDERS.idFromName(builderName(match[1])).toString() === containerId;
  const upload =
    (match[2] === 'info/refs' &&
      req.method === 'GET' &&
      url.searchParams.get('service') === 'git-upload-pack') ||
    (match[2] === 'git-upload-pack' && req.method === 'POST');
  return own && upload ? { repo: match[1], path: match[2], search: url.search } : null;
}

const refused = () => new Response('Not reachable from the pack builder\n', { status: 403 });
const system = (env: Env, repo: string) =>
  new RepoContext(env, repo, caller(env, repo, { _system: 'derive' }));

/** http://mirror.internal: the repository's Artifacts remote, with a read token added. */
export async function mirrorSource(req: Request, env: Env, ctx: { containerId: string }) {
  const own = ownRepo(req, env, ctx.containerId);
  if (!own) return refused();
  const { object_store } = await system(env, own.repo).status();
  const store = parseStore(env, String(object_store ?? ''));
  if (!store.cloneAccess) return new Response('This repository has no mirror\n', { status: 404 });
  const { remote, token } = await store.cloneAccess();
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of ['content-type', 'accept', 'git-protocol'])
    if (req.headers.has(name)) headers.set(name, req.headers.get(name) ?? '');
  return fetch(`${remote}/${own.path}${own.search}`, {
    method: req.method,
    headers,
    body: req.method === 'POST' ? req.body : undefined,
    redirect: 'manual',
  });
}

/** http://platform.internal: the platform's smart HTTP (version 2) for the repository. The
 * fetch is served as built (never from or into the pack store: that is what is building). */
export async function platformSource(req: Request, env: Env, ctx: { containerId: string }) {
  const own = ownRepo(req, env, ctx.containerId);
  if (!own) return refused();
  if (!(req.headers.get('git-protocol') ?? '').includes('version=2'))
    return new Response('Git protocol version 2 is required\n', { status: 400 });
  if (own.path === 'info/refs') return advertiseV2();
  const built = system({ ...env, PACK_CACHE: 'off' }, own.repo);
  return uploadPackV2(built, await built.objects(), requestBody(req));
}

export class PackBuilder extends Container<Env> {
  defaultPort = PACK_PORT;
  enableInternet = false;
  sleepAfter = '20m';

  /** Builds `plan`'s packs (pack-build jobs call this; repo-pack-jobs). */
  build(plan: BuildPlan) {
    const withheld = async () => (await system(this.env, plan.repo).objects()).withholdsAny();
    return buildPacks(this, this.env, plan, withheld);
  }

  /** An instance left running (its build's caller vanished) is killed, not asked to stop. */
  override async onActivityExpired() {
    if (this.ctx.container?.running) await this.destroy();
  }
}

// Assigned, not declared as `static` fields (see SshGateway: a class field would hide
// @cloudflare/containers' setter and leave its registry empty).
PackBuilder.outboundByHost = { [MIRROR_HOST]: mirrorSource, [PLATFORM_HOST]: platformSource };
