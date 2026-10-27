// Reads under a burst (C3): `burst` concurrent reads from one read source at a time, sent by
// the bench client. Main's published head serves unpinned (and min_version) blob reads; a
// commit, a branch version, a tree, refs, log and txlog are served by the repository's
// authority. One refused (or wrong) read fails the run.
import { b64 } from './driver.mjs';
import { errors, percentiles, phases } from './stats.mjs';

const FILES = 100;
const file = (i) => ({ path: `seed%2F${i % FILES}.txt`, content: `seed ${i % FILES}\n` });

/** Each source's request for reader `i`, given main's head commit and version. */
export const SOURCES = {
  'published-blob': (i) => ({ get: `/blob?path=${file(i).path}`, content: file(i).content }),
  'pinned-blob': (i, at) => ({ get: `/blob?path=${file(i).path}&min_version=${at.version}`, content: file(i).content }),
  'commit-blob': (i, at) => ({ get: `/blob?path=${file(i).path}&commit=${at.commit}`, content: file(i).content }),
  'version-blob': (i, at) => ({ get: `/blob?path=${file(i).path}&ref=main&at=${at.version}`, content: file(i).content }),
  tree: () => ({ get: '/tree?path=seed' }),
  refs: () => ({ get: '/refs' }),
  log: () => ({ get: '/log?limit=20' }),
  txlog: () => ({ get: '/txlog?limit=100' }),
};

export async function reads(session, { burst, principals, sources }) {
  const seed = Array.from({ length: FILES }, (_, i) => ({ path: `seed/${i}.txt`, content_b64: b64(`seed ${i}\n`) }));
  const repo = await session.createRepo(`reads${burst}`, seed);
  const tokens = principals === 'tokens' ? await session.mintTokens(repo, Math.min(burst, 50)) : [];
  const who = (i) => (tokens.length ? { token: tokens[i % tokens.length] } : { cookie: session.cookie });
  const { body: refs } = await session.call('GET', `/repos/${repo}/refs`);
  const at = { commit: refs.refs?.['refs/heads/main'], version: refs.version };
  if (!at.commit || !Number.isInteger(at.version)) throw new Error(`refs answered without main: ${JSON.stringify(refs).slice(0, 200)}`);

  const results = {};
  for (const source of sources) {
    const began = performance.now();
    const replies = await session.fanout(repo, Array.from({ length: burst }, (_, i) => ({ ...who(i), ...SOURCES[source](i, at) })));
    const rows = replies.map((r) => r.read);
    results[source] = {
      elapsed_ms: Math.round(performance.now() - began),
      ok: rows.filter((r) => r.ok).length,
      refused: rows.filter((r) => !r.ok).length,
      // A wrong answer with status 200 still counts (as "200 WRONG_CONTENT").
      errors: errors(rows.filter((r) => !r.ok).map((r) => ({ ...r, status: r.status === 200 ? '200' : r.status }))),
      client: percentiles(rows.filter((r) => r.ok).map((r) => r.ms)),
      server: percentiles(rows.filter((r) => r.ok && r.server !== null).map((r) => r.server)),
      phases: phases(rows, true),
    };
    console.error(`${source}: ${results[source].ok}/${burst} ok, p95 ${results[source].client.p95_ms} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { repo, burst, principals, at, passed: Object.values(results).every((r) => r.refused === 0), sources: results };
}
