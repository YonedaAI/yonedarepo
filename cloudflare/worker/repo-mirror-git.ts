// A Git client of a repository's Artifacts mirror, for copying its history out
// (repo-mirror-retire): the refs it advertises and a fetch's pack, streamed. Protocol
// version 0 over smart HTTP with a short-lived read token; the fetch asks for side-band-64k
// (the pack arrives on band 1) and no thin pack, so every delta's base is in the pack.
import { rpcValue } from './durable';
import { concat } from './repo-pack-stream';
import type { Env } from './types';

/** A mirror's smart HTTP remote and a read token for it (never logged). */
export type Mirror = { remote: string; token: string };
/** An advertised ref: its value, and for an annotated tag the commit it peels to. */
export type MirrorRef = { name: string; id: string; peeled?: string };

/** Read tokens outlive a run's lease (repo_store/quarantine/mirror.rs LEASE_MS). */
const TOKEN_SECONDS = 30 * 60;
const ZERO = '0'.repeat(40);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** Whether `e` says the Artifacts repository does not exist. */
export const gone = (e: any) =>
  e?.code === 'NOT_FOUND' || /not.?found/i.test(String(e?.message ?? e));

/** The remote of Artifacts repository `name`, with a read token. */
export async function mirrorAccess(env: Env, name: string): Promise<Mirror> {
  using repo = await env.ARTIFACTS.get(name);
  const info = await rpcValue(repo.info());
  const token = await rpcValue(repo.createToken('read', TOKEN_SECONDS));
  return { remote: info.remote, token: token.plaintext };
}

const authorized = (mirror: Mirror) => ({ authorization: `Bearer ${mirror.token}` });

/** The refs the mirror advertises (hidden ones too). */
export async function advertised(mirror: Mirror): Promise<MirrorRef[]> {
  const answer = await fetch(`${mirror.remote}/info/refs?service=git-upload-pack`, {
    headers: authorized(mirror),
    redirect: 'manual',
  });
  if (!answer.ok) throw new Error(`The mirror's refs answered ${answer.status}`);
  const bytes = new Uint8Array(await answer.arrayBuffer());
  const refs = new Map<string, MirrorRef>();
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = Number.parseInt(text(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(length) || (length > 0 && length < 4))
      throw new Error("The mirror's ref advertisement is malformed");
    if (length === 0) {
      at += 4;
      continue;
    }
    const line = text(bytes.subarray(at + 4, at + length))
      .split('\0')[0]
      .trim();
    at += length;
    const [id, name] = line.split(' ');
    if (!/^[0-9a-f]{40}$/.test(id ?? '') || !name || id === ZERO) continue;
    if (name.endsWith('^{}')) {
      const tag = refs.get(name.slice(0, -3));
      if (tag) tag.peeled = id;
    } else refs.set(name, { name, id });
  }
  return [...refs.values()];
}

/** Fetches what `wants` reach beyond `haves` (whose history the caller holds): the pack's
 * bytes as they arrive. */
export async function* fetchPack(
  mirror: Mirror,
  wants: string[],
  haves: string[],
): AsyncGenerator<Uint8Array> {
  const body =
    wants
      .map((w, i) => pkt(`want ${w}${i === 0 ? ' side-band-64k ofs-delta no-progress' : ''}\n`))
      .join('') +
    '0000' +
    haves.map((h) => pkt(`have ${h}\n`)).join('') +
    pkt('done\n');
  const answer = await fetch(`${mirror.remote}/git-upload-pack`, {
    method: 'POST',
    headers: {
      ...authorized(mirror),
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
    },
    body,
    redirect: 'manual',
  });
  if (!answer.ok || !answer.body) throw new Error(`The mirror's fetch answered ${answer.status}`);
  yield* bandOne(answer.body);
}

/** Side-band packets' band 1 (the pack), after the acknowledgments; band 3 is an error. */
async function* bandOne(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let held: Uint8Array = new Uint8Array();
  const need = async (n: number) => {
    while (held.length < n) {
      const { done, value } = await reader.read();
      if (done) throw new Error("The mirror's fetch ended early");
      held = held.length ? concat([held, value]) : value;
    }
  };
  try {
    for (;;) {
      await need(4);
      const length = Number.parseInt(text(held.subarray(0, 4)), 16);
      if (Number.isNaN(length) || (length > 0 && length < 5))
        throw new Error("The mirror's fetch answer is malformed");
      if (length === 0) return;
      await need(length);
      const payload = held.subarray(4, length);
      held = held.subarray(length);
      const head = text(payload.subarray(0, 4));
      if (head.startsWith('NAK') || head.startsWith('ACK')) continue;
      if (head.startsWith('ERR')) throw new Error(`The mirror refused the fetch: ${text(payload)}`);
      if (payload[0] === 1) yield payload.slice(1);
      else if (payload[0] === 3)
        throw new Error(`The mirror's fetch failed: ${text(payload.subarray(1)).slice(0, 300)}`);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The first-parent chain from `tip` (newest first) down to the first commit `held` names
 * (excluded), from the mirror's log, at most `limit` commits. */
export async function firstParents(
  env: Env,
  name: string,
  tip: string,
  held: ReadonlySet<string>,
  limit: number,
): Promise<string[]> {
  using repo = await env.ARTIFACTS.get(name);
  const chain: string[] = [];
  while (chain.length < limit) {
    const page = await rpcValue(repo.log({ ref: tip, limit: 1000, offset: chain.length }));
    for (const commit of page) {
      if (held.has(commit.hash)) return chain;
      chain.push(commit.hash);
    }
    if (page.length < 1000) return chain;
  }
  return chain;
}
