// Search across an account's repositories (`GET /api/v1/search`, behind ACCOUNT_SEARCH): a
// filter over each repository's own search. The summary in `search:<owner>` only chooses which
// repositories to ask, so who sees what stays each repository's decision.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { runAll } from '../../cloudflare/worker/repo-account-search';
import { purgeJob } from '../../cloudflare/worker/repo-admin';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, ACCOUNT_SEARCH: 'on', ADMIN_ACCOUNTS: 'operator_search' } as unknown as Env;
const solo = { required_checks: [], approvals: 0 };

const search = (who: { cookie?: string; token?: string }, query: string, rest = '', target = on) =>
  api(`/search?query=${encodeURIComponent(query)}${rest}`, who, {}, target);

async function repoWith(who: { cookie: string }, name: string, text: string, extra: object = {}, target = on) {
  const body = { name, policy: solo, files: [file('src/main.txt', text)], author, ...extra };
  const created = await api('/repos', who, { body }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

const derive = (id: string, ref = 'main', target = on) =>
  deriveAfterLanding(target, { v: 1, kind: 'platform_derive', repo_id: id, job_id: ref } as any);

/** The account that owns `repo`, as the listing has it. */
const ownerOf = async (repo: string) =>
  (await bindings.INDEX.prepare('SELECT workspace FROM platform_repos WHERE id=?').bind(repo).first<{ workspace: string }>())?.workspace ?? '';

/** The directory's row for `repo`, or null. */
const row = (owner: string, repo: string) =>
  runInDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`search:${owner}`)), async (_instance, state) => {
    const tables = state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='workspace_records'").toArray();
    if (tables.length === 0) return null;
    const rows = state.storage.sql.exec('SELECT payload FROM workspace_records WHERE id=?', `search:${repo}`).toArray();
    return rows.length ? JSON.parse(String(rows[0].payload)) : null;
  });

const names = (body: any) => body.results.map((r: any) => r.name).sort();

it('stays off: no route, no row, and the repository search is unchanged', async () => {
  const owner = { cookie: await signup('search_off') };
  const id = await repoWith(owner, 'quiet', 'needle_off\n');
  await derive(id, 'main', scoped);
  expect((await search(owner, 'needle_off', '', scoped)).status).toBe(404);
  expect(await row(await ownerOf(id), id)).toBeNull();
  expect((await api(`/repos/${id}/search?query=needle_off`, owner)).body.results).toHaveLength(1);
});

it('finds a repository beyond the newest 25, searching only those that can match', async () => {
  const owner = { cookie: await signup('search_deep') };
  const oldest = await repoWith(owner, 'oldest', 'zebra_quantum_flux\n');
  await derive(oldest);
  for (let i = 0; i < 26; i++) await derive(await repoWith(owner, `plain-${i}`, `nothing to see ${i}\n`));
  const answer = await search(owner, 'zebra_quantum');
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.results.map((r: any) => r.repo)).toEqual([oldest]);
  expect(answer.body.results[0].answer.results[0].path).toBe('src/main.txt');
  expect(answer.body.next).toBeNull();
  // The filter is what kept it to one: code asks only what can match.
  const aimed = await search(owner, 'zebra_quantum', '&groups=code');
  expect(aimed.body).toMatchObject({ searched: 1, scanned: 27, next: null });
  // The summary and the candidate list are never part of an answer.
  expect(JSON.stringify(answer.body)).not.toMatch(/bits|saturated|maybe/);
});

it('matches paths as well as contents, and folds case', async () => {
  const owner = { cookie: await signup('search_path') };
  const id = await repoWith(owner, 'paths', 'plain\n', { files: [file('deep/Directory/Widget_Maker.rs', 'x\n')] });
  await derive(id);
  await derive(await repoWith(owner, 'other', 'plain\n'));
  expect((await search(owner, 'widget_maker')).body.results.map((r: any) => r.repo)).toEqual([id]);
  expect((await search(owner, 'directory/WIDGET')).body.results.map((r: any) => r.repo)).toEqual([id]);
});

it('pages 25 repositories at a time, none twice, when nothing is summarized', async () => {
  const owner = { cookie: await signup('search_pages') };
  for (let i = 0; i < 27; i++) await repoWith(owner, `same-${i}`, 'shared_needle\n');
  const first = await search(owner, 'shared_needle');
  expect(first.body.results).toHaveLength(25);
  expect(first.body.next).toEqual(expect.any(String));
  const second = await search(owner, 'shared_needle', `&after=${encodeURIComponent(first.body.next)}`);
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  expect(second.body.results).toHaveLength(2);
  expect(second.body.next).toBeNull();
  expect(new Set([...names(first.body), ...names(second.body)]).size).toBe(27);
});

it('treats a short query, newer activity and a missing summary as maybe', async () => {
  const owner = { cookie: await signup('search_maybe') };
  const summarized = await repoWith(owner, 'summarized', 'alpha\n');
  await derive(summarized);
  // Two characters ask no directory: the repository's own search answers.
  expect(names((await search(owner, 'al')).body)).toEqual(['summarized']);
  // A landing the summary hasn't seen.
  const landed = await api(`/repos/${summarized}/commits`, owner, { body: { ref: 'main', changes: [file('new.txt', 'freshly_landed\n')], message: 'New', author } }, on);
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  expect((await api(`/repos/${summarized}/land`, owner, { body: { ref: 'main', commit: landed.body.commit } }, on)).body.landed).toBe(true);
  await bindings.INDEX.prepare('INSERT INTO platform_activity(repo,touched_at) VALUES(?1,?2) ON CONFLICT(repo) DO UPDATE SET touched_at=?2')
    .bind(summarized, Date.now() + 1000)
    .run();
  expect(names((await search(owner, 'freshly_landed')).body)).toEqual(['summarized']);
  // Imports, created files and forks have no row.
  const unsummarized = await repoWith(owner, 'unsummarized', 'bravo_charlie\n');
  expect(await row(await ownerOf(unsummarized), unsummarized)).toBeNull();
  expect(names((await search(owner, 'bravo_charlie')).body)).toEqual(['unsummarized']);
});

it('summarizes main only: a branch keeps main’s summary current and adds nothing to it', async () => {
  const owner = { cookie: await signup('search_main') };
  const id = await repoWith(owner, 'branches', 'on_main_only\n');
  await derive(id);
  const account = await ownerOf(id);
  const before = await row(account, id);
  const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'on_branch_only\n')], message: 'Side', author } }, on);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await api(`/repos/${id}/refs/batch`, owner, { body: { updates: [{ ref: 'scratch', commit: made.body.commit, expected: null }] } }, on);
  await derive(id, 'scratch');
  const after = await row(account, id);
  expect(after.bits).toBe(before.bits);
  expect(after.commit).toBe(before.commit);
  expect(after.at).toBeGreaterThanOrEqual(before.at);
  expect((await search(owner, 'on_branch_only')).body.results).toEqual([]);
});

it('keeps records on the newest 25', async () => {
  const owner = { cookie: await signup('search_records') };
  const id = await repoWith(owner, 'records', 'plain_text\n', { message: 'Recordable subject line' });
  await derive(id);
  const found = await search(owner, 'Recordable subject');
  expect(found.body.results.map((r: any) => r.repo)).toEqual([id]);
  expect(found.body.results[0].answer.commits.count).toBe(1);
  // The second page is code only: the records were asked for on the first.
  const later = await search(owner, 'Recordable subject', `&after=${encodeURIComponent(`${Date.now() + 60_000}.${id}`)}`);
  expect(later.body.results).toEqual([]);
});

it('lets a token see no more than GET /repos does', async () => {
  const cookie = await signup('search_tokens');
  const owner = { cookie };
  const [a, b] = [await repoWith(owner, 'a', 'token_needle\n'), await repoWith(owner, 'b', 'token_needle\n')];
  await Promise.all([derive(a), derive(b)]);
  expect(names((await search(owner, 'token_needle')).body)).toEqual(['a', 'b']);

  const narrow = await api('/tokens', { cookie }, { body: { name: 'one', scopes: ['repo:read'], repos: [a] } });
  expect((await search({ token: narrow.body.token }, 'token_needle')).body.results.map((r: any) => r.repo)).toEqual([a]);

  const full = await api('/tokens', { cookie }, { body: { name: 'all', scopes: ['repo:read'] } });
  expect((await search({ token: full.body.token }, 'token_needle')).body.results).toHaveLength(2);
  expect((await api(`/tokens/${full.body.id}`, { cookie }, { method: 'DELETE' })).status).toBe(200);
  const revoked = await search({ token: full.body.token }, 'token_needle');
  expect(revoked.status).toBe(401);
  expect(JSON.stringify(revoked.body)).not.toContain('token_needle');

  // A path-restricted token belongs to one repository, so this route isn't for it.
  const minted = await api(`/repos/${a}/tokens`, owner, { body: { name: 'docs', scopes: ['read'], paths: ['docs/'] } });
  const restricted = await search({ token: minted.body.token }, 'token_needle');
  expect(restricted.status).toBe(403);
  expect(JSON.stringify(restricted.body)).not.toContain('token_needle');
});

it('refuses a caller with no account', async () => {
  const answer = await search({}, 'anything');
  expect(answer.status).toBe(401);
});

it('loses the filter, never the search, when a directory is down', async () => {
  const owner = { cookie: await signup('search_down') };
  const id = await repoWith(owner, 'kept', 'kept_needle\n');
  await derive(id);
  const real = on.WORKSPACES;
  const asked: string[] = [];
  const down = {
    ...on,
    WORKSPACES: {
      get: (target: DurableObjectId) => real.get(target),
      idFromName(name: string) {
        if (name.startsWith('search:')) {
          asked.push(name);
          throw new Error('directory unavailable');
        }
        return real.idFromName(name);
      },
    },
  } as unknown as Env;
  const answer = await search(owner, 'kept_needle', '', down);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(names(answer.body)).toEqual(['kept']);
  expect(asked).toHaveLength(1);
  // A query with a trigram the summary doesn't hold still reaches the repository, which says no.
  expect((await search(owner, 'absent_needle', '&groups=code', down)).body).toMatchObject({ results: [], searched: 1 });
  expect((await search(owner, 'absent_needle', '&groups=code')).body).toMatchObject({ results: [], searched: 0 });
});

it('stops starting repositories at the page limit and reports those still running', async () => {
  const task = (id: string) => ({ row: { id } as any, groups: ['code'] });
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map(task);
  const started: string[] = [];
  const { settled, started: count } = await runAll(
    tasks,
    ({ row }) => {
      started.push(row.id);
      return new Promise(() => {});
    },
    20,
  );
  expect(count).toBe(4);
  expect(started).toEqual(['a', 'b', 'c', 'd']);
  expect(settled.map((o) => o?.error)).toEqual(Array(4).fill('This repository took too long to search'));
});

it('leaves an unchanged fork out, and searches it once it has landed', async () => {
  const local = { ...on, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('search_forks') };
  const parent = await repoWith(owner, 'parent', 'fork_needle\n', { visibility: 'public' }, local);
  await derive(parent, 'main', local);
  const forker = { cookie: await signup('search_forker') };
  const forked = await api(`/repos/${parent}/fork`, forker, { body: { name: 'mine', policy: solo } }, local);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const fork = forked.body.id as string;
  expect(await row('search_forker', fork)).toMatchObject({ fork: true });
  expect((await search(forker, 'fork_needle', '&groups=code', local)).body).toMatchObject({ results: [], searched: 0 });

  const landed = await api(`/repos/${fork}/commits`, forker, { body: { ref: 'main', changes: [file('own.txt', 'own_needle\n')], message: 'Own', author } }, local);
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  expect((await api(`/repos/${fork}/land`, forker, { body: { ref: 'main', commit: landed.body.commit } }, local)).body.landed).toBe(true);
  await derive(fork, 'main', local);
  expect((await row('search_forker', fork)).fork).toBeUndefined();
  expect((await search(forker, 'own_needle', '&groups=code', local)).body.results.map((r: any) => r.repo)).toEqual([fork]);
  expect((await search(forker, 'fork_needle', '&groups=code', local)).body.results.map((r: any) => r.repo)).toEqual([fork]);
});

it('asks a stranger’s repository nothing, whatever its owner’s summary holds', async () => {
  const owner = { cookie: await signup('search_owner') };
  const id = await repoWith(owner, 'private', 'private_needle\n');
  await derive(id);
  const stranger = { cookie: await signup('search_stranger') };
  expect((await search(stranger, 'private_needle')).body.results).toEqual([]);
  await api(`/repos/${id}/members`, owner, { body: { account: 'search_stranger', role: 'read' } });
  const member = await search(stranger, 'private_needle');
  expect(member.body.results.map((r: any) => r.repo)).toEqual([id]);
});

it('removes the row on delete and purge, and voids it on quarantine and visibility', async () => {
  const owner = { cookie: await signup('search_purge') };
  const quarantined = await repoWith(owner, 'quarantined', 'held_needle\n');
  const visible = await repoWith(owner, 'visible', 'seen_needle\n');
  const deleted = await repoWith(owner, 'deleted', 'gone_needle\n');
  await Promise.all([derive(quarantined), derive(visible), derive(deleted)]);
  const account = await ownerOf(deleted);
  expect((await row(account, quarantined)).bits).toEqual(expect.any(String));

  const held = await api(`/repos/${quarantined}/quarantine`, owner, { body: { path: 'src/main.txt', reason: 'test' } }, on);
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  expect((await row(account, quarantined)).bits).toBeUndefined();

  const shown = await api(`/repos/${visible}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, on);
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  expect((await row(account, visible)).bits).toBeUndefined();

  const gone = await api(`/repos/${deleted}?confirm=deleted`, owner, { method: 'DELETE' }, on);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect(await row(account, deleted)).toBeNull();
  expect((await search(owner, 'gone_needle')).body.results).toEqual([]);

  // A derive job that outran the delete leaves a row behind; the purge takes it.
  await runInDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`search:${account}`)), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO workspace_records(id,payload) VALUES(?,'{}')", `search:${deleted}`);
  });
  const purging = { ...on, ARTIFACTS: { ...on.ARTIFACTS, delete: async () => {} } } as unknown as Env;
  await purgeJob(purging, { v: 1, kind: 'platform_purge', repo_id: deleted, job_id: 'test' } as any);
  expect(await row(account, deleted)).toBeNull();
});

it('does not let a slow derive job bring back a summary that was voided after it read', async () => {
  const owner = { cookie: await signup('search_race') };
  const id = await repoWith(owner, 'race', 'race_needle\n');
  await derive(id);
  const account = await ownerOf(id);
  await api(`/repos/${id}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, on);
  const voided = await row(account, id);
  const stale = await bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`search:${account}`)).fetch('http://workspace/command', {
    method: 'POST',
    body: JSON.stringify({ op: 'search_put', repo: id, at: voided.at - 1, commit: 'c', saturated: true }),
  });
  expect(stale.status).toBe(200);
  expect(await row(account, id)).toEqual(voided);
});

it('backfills one owner, operator only, a page of repositories at a time', async () => {
  const operator = { cookie: await signup('operator_search') };
  const owner = { cookie: await signup('search_backfill') };
  const id = await repoWith(owner, 'old', 'backfilled_needle\n');
  const account = await ownerOf(id);
  const body = { owner: account };
  expect((await api('/admin/search-backfill', owner, { body }, on)).status).toBe(403);
  const dry = await api('/admin/search-backfill', operator, { body: { ...body, dry_run: true } }, on);
  expect(dry.body).toMatchObject({ queued: 0, repos: 1, next: null });
  queued.length = 0;
  const asked = await api('/admin/search-backfill', operator, { body }, on);
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  expect(asked.body).toMatchObject({ queued: 1, next: null });
  const [job] = queued.filter((m) => m.repo_id === id);
  expect(job).toMatchObject({ kind: 'platform_search_summary' });
  await platformJob(on, { body: job, ack() {}, retry() {}, attempts: 1 } as any);
  expect((await row(account, id)).commit).toEqual(expect.any(String));
  expect(names((await search(owner, 'backfilled_needle')).body)).toEqual(['old']);
});

it('serves the MCP tool only while the switch is on', async () => {
  const owner = { cookie: await signup('search_mcp') };
  const id = await repoWith(owner, 'tooled', 'mcp_needle\n');
  await derive(id);
  const issued = await api('/tokens', owner, { body: { name: 'agent', scopes: ['repo:read'] } });
  const rpc = async (method: string, params: object, target: Env) => {
    const { platformFetch } = await import('../../cloudflare/worker/platform-routes');
    const response = await platformFetch(
      new Request('https://yoneda/api/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.body.token}`, 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      target,
    );
    return (await response.json<any>()).result;
  };
  const listed = async (target: Env) => (await rpc('tools/list', {}, target)).tools.map((t: any) => t.name);
  expect(await listed(scoped)).not.toContain('search_repos');
  expect(await listed(on)).toContain('search_repos');
  const called = await rpc('tools/call', { name: 'search_repos', arguments: { query: 'mcp_needle' } }, on);
  expect(called.isError).toBeFalsy();
  expect(called.structuredContent.results[0].repo).toBe(id);
});
