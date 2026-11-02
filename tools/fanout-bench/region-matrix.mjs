// One arm of the same-region test: a client in one region, a fresh repository, and the operations
// a person or agent would notice, each from the client, by today's path or the region's. Failures
// are recorded, never hidden: an arm that can't create says so and the test goes on.
import { commitPack, cloneSteps, pushSteps } from './git-forms.mjs';
import { clean } from './region-accounts.mjs';
import { armRequests, repoName, seedBlobs, seedFiles } from './region-plan.mjs';

const AUTHOR = { name: 'Region matrix', email: 'bench@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');

/** A step's result without what must not be kept: a create's answer holds a token. */
export const sample = clean;

const fileAt = (o, i) => `f${String(i % o.files).padStart(2, '0')}.txt`;
const phase = (timing, name) => Number(new RegExp(`${name};dur=([\\d.]+)`).exec(timing ?? '')?.[1] ?? 0);

/** A create's own time: a hinted create starts its 64 shards and combiners before it answers,
 * where today's starts them after, so that wait is left out to compare like with like. */
export function netCreate(row) {
  if (row.server === null || row.server === undefined) return row;
  const waited = phase(row.timing, 'create\\.shards') + phase(row.timing, 'create\\.place');
  return { ...row, ms_raw: row.ms, server_raw: row.server, ms: Math.round(row.ms - waited), server: Number((row.server - waited).toFixed(1)) };
}

/** Sums the requests one Git operation took; failed if any of them did. */
export function joined(rows) {
  return {
    ms: rows.reduce((n, r) => n + r.ms, 0),
    server: rows.every((r) => r.server !== null) ? Number(rows.reduce((n, r) => n + r.server, 0).toFixed(1)) : null,
    status: rows.find((r) => !r.ok)?.status ?? 200,
    ok: rows.every((r) => r.ok),
    error: rows.find((r) => !r.ok)?.error,
    message: rows.find((r) => !r.ok)?.message,
    timing: rows.map((r) => `${r.label}: ${r.timing}`).join(' | '),
  };
}

/** The sequence for one arm. `call(client, body)` is regions.mjs's, `front` the same on the front
 * Worker's host, `account` the arm's own (region-accounts.mjs), `options` region-plan's. */
export async function runArm({ call, front, account, pat, ledger, assets }, { stamp, run, client, arm: { arm, data, serve }, options: o }) {
  const name = repoName(stamp, run, client, arm);
  const files = seedFiles(name, o.files);
  const send = async (steps) => {
    const answer = await call(client, { steps, ...(serve && { serve }) });
    return answer.failed ? steps.map((s) => ({ label: s.label, status: 0, ok: false, ms: 0, server: null, error: 'BENCH_CLIENT', message: answer.failed })) : answer.results;
  };
  const out = { run, client, arm, data, name, requests: armRequests(o, arm), ops: {} };
  const note = (op, row) => (out.ops[op] ??= []).push(sample(row));
  for (let i = 0; i < o.signIns; i++) note('sign_in', (await account.signIn()).row);
  if (arm === 'today')
    for (let i = 0; i < o.pages; i++) {
      const pages = await front(client, { steps: [{ label: 'page', path: '/' }, ...assets.slice(0, 1).map((path) => ({ label: 'asset', path }))] });
      if (pages.failed) note('page', { label: 'page', status: 0, ok: false, ms: 0, server: null, error: 'BENCH_CLIENT', message: pages.failed });
      for (const row of pages.results ?? []) note(row.label, row);
    }
  const [made] = await send([
    {
      label: 'create',
      path: '/api/v1/repos',
      token: pat,
      keep: true,
      json: {
        name,
        region_hint: data,
        policy: { required_checks: [], approvals: 0 },
        files: Object.entries(files).map(([path, text]) => ({ path, content_b64: b64(text) })),
        message: 'Seed',
        author: AUTHOR,
        tokens: [{ name: 'matrix', scopes: ['read', 'write', 'land'] }],
      },
    },
  ]);
  note('create', netCreate(made));
  if (!made.ok) return { ...out, failed: `create: ${made.status} ${made.error} ${made.message ?? ''}` };
  const { id, commit, tokens, region_hint: applied } = made.value;
  await ledger.add({ id, name });
  out.id = id;
  if (applied !== data) return { ...out, stop: 'The platform did not apply the hint: REGION_HINT_TEST is off on this deployment' };
  const token = tokens[0].token;
  const repo = `/api/v1/repos/${id}`;

  const [where] = await send([{ label: 'where', path: `${repo}/where`, token: pat, keep: true }]);
  out.where = where.ok ? where.value : { failed: `${where.status} ${where.error}` };

  for (let i = 0; i < o.reads; i++) {
    const [own, personal, list] = await send([
      { label: 'read_token', path: `${repo}/blob?path=${fileAt(o, i)}`, token, contains: 'file' },
      { label: 'read_pat', path: `${repo}/blob?path=${fileAt(o, i + o.reads)}`, token: pat, contains: 'file' },
      { label: 'list', path: `${repo}/tree?ref=main`, token },
    ]);
    note('read_token', own);
    note('read_pat', personal);
    note('list', list);
  }
  for (let i = 0; i < o.clones; i++) note('clone', joined(await send(cloneSteps(id, token, commit))));
  for (let i = 0; i < o.lands; i++) {
    const path = `land-${run}-${i}.txt`;
    const [committed] = await send([{ label: 'commit', path: `${repo}/commits`, token, keep: true, json: { ref: 'main', changes: [{ path, content_b64: b64(`${path}\n`) }], message: path, author: AUTHOR } }]);
    note('commit', committed);
    if (!committed.ok) continue;
    const [landed] = await send([{ label: 'land', path: `${repo}/land`, token, json: { ref: 'main', commit: committed.value.commit } }]);
    note('land', landed);
  }
  const blobs = seedBlobs(name, o.files);
  for (let i = 0; i < o.pushes; i++) {
    const pushed = commitPack({ parent: commit, files: blobs, name: `push-${i}.txt`, text: `push ${i} of ${name}\n`, at: 1_800_000_000 + i });
    note('push', joined(await send(pushSteps(id, token, { ref: `refs/heads/bench/${i}`, ...pushed }))));
  }
  for (let i = 0; i < o.searches; i++) {
    const [found] = await send([{ label: 'search', path: '/api/v1/search?q=file', token: pat }]);
    note('search', found);
  }
  return out;
}
