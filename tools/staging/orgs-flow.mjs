// Organizations and teams live gate (kit item 24): the kit account creates an organization
// with team "devs" and an org-owned repository granted to `team:<org>/devs` at write. The
// second kit account (`<kit username>_m`, as the members gate signs it up) joins the org
// (no repository access from that alone) and then the team, and pushes a branch with stock
// Git through a personal token limited to the org. Removing it from the team must refuse
// its next push within the access bound (ACCESS_MS, 1 s): a push may still pass only if it
// starts inside the bound, and one started after it must be refused. Team changes reach
// other isolates within the same bound (cloudflare/worker/platform-org-access.ts), so the
// listing after joining is polled up to it, the clone starts once it has passed, and the
// REST read after removal starts past it too. The token reaches Git
// only through the environment (http.extraHeader), never an argument; it is revoked, the
// repository deleted and then the org (refused while it still owns the repository; its name
// is retired for good).
//
// Usage: node tools/staging-realworld.mjs --orgs [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64, secondAccount, sleep, until } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
/** The published access bound (cloudflare/worker/repo-head.ts ACCESS_MS). */
const ACCESS_MS = 1000;

export async function orgsFlow({ origin, api, kit, platform }, metrics) {
  const { name: memberName, session: member } = await secondAccount(origin, kit);
  const org = `kit_org_${Date.now().toString(36)}`;
  const name = `kit-orgs-${Date.now()}`;
  const status = async (session, method, url, body) => (await session.raw(method, url, body)).status;
  metrics.org = org;

  await platform.post('/orgs', { name: org });
  await platform.post(`/orgs/${org}/teams`, { name: 'devs' });
  const repo = await platform.post('/repos', { name, owner: org, policy: { required_checks: [], approvals: 1 }, files: [{ path: 'README.md', content_b64: b64('# Orgs\n') }], author });
  const path = `/repos/${repo.id}`;
  metrics.repo = repo.id;
  let pat;
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-orgs-'));
  try {
    assert.equal((await member.get('/repos')).repos.some((r) => r.id === repo.id), false, 'not listed for a stranger');
    await platform.post(`${path}/members`, { account: `team:${org}/devs`, role: 'write' });
    await platform.post(`/orgs/${org}/members`, { account: memberName, role: 'member' });
    assert.equal(await status(member, 'GET', `${path}/refs`), 403, 'org membership alone grants no repository access');
    pat = await member.post('/tokens', { name: `kit-orgs-${Date.now()}`, scopes: ['repo:read', 'repo:write'], org, expires_days: 1 });

    await platform.post(`/orgs/${org}/teams/devs/members`, { account: memberName });
    const added = performance.now();
    const shown = await member.get(`/orgs/${org}`);
    assert.equal(shown.role, 'member', 'the member sees the org');
    assert.deepEqual(shown.teams.find((t) => t.name === 'devs')?.members, [memberName], 'team membership shows');
    const listed = await until(async () => (await member.get('/repos')).repos.find((r) => r.id === repo.id), {
      timeoutMs: Math.max(0, added + ACCESS_MS + 250 - performance.now()),
      intervalMs: 250,
      what: `the org repository listed through the team within ${ACCESS_MS} ms`,
    });
    metrics.team_listed_ms = Math.round(performance.now() - added);
    assert.equal(listed.owner, org, 'the org repository is listed through the team');
    // Another isolate may still decide on its copy from before the team: past the bound, none does.
    const settle = added + ACCESS_MS - performance.now();
    if (settle > 0) await sleep(settle);

    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${pat.token}`,
    };
    writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Staging kit member\n\temail = member@yonedarepo.invalid\n');
    const git = (args, cwd = dir) => {
      try {
        return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
      } catch (e) {
        return { ok: false, out: String(e.stderr ?? e.message).slice(-400) };
      }
    };
    const cloned = git(['clone', '-q', `${api}/git/${repo.id}.git`, 'work']);
    assert.ok(cloned.ok, `clone through the team: ${cloned.out}`);
    const work = join(dir, 'work');
    /** A fresh commit pushed to its own branch. */
    const push = (label) => {
      writeFileSync(join(work, `${label}.txt`), `${label}\n`);
      git(['add', '-A'], work);
      git(['commit', '-q', '-m', label], work);
      return git(['push', '-q', 'origin', `HEAD:refs/heads/kit-${label}`], work);
    };
    const pushed = push('team');
    assert.ok(pushed.ok, `push through the team: ${pushed.out}`);
    assert.equal((await member.get(`${path}/refs`)).refs['refs/heads/kit-team'], git(['rev-parse', 'HEAD'], work).out);

    // Removal from the team: a push started after the bound must be refused.
    await platform.call('DELETE', `/orgs/${org}/teams/devs/members/${memberName}`);
    const removed = performance.now();
    const attempts = [];
    for (const startAt of [0, ACCESS_MS + 100, ACCESS_MS + 500]) {
      const wait = removed + startAt - performance.now();
      if (wait > 0) await sleep(wait);
      const started = Math.round(performance.now() - removed);
      const result = push(`after-${attempts.length}`);
      attempts.push({ started_ms: started, refused: !result.ok, ...(result.ok ? {} : { refusal: result.out.slice(-160) }) });
      if (!result.ok) {
        assert.match(result.out, /403|FORBIDDEN|another workspace|not allowed|member/i, `refused for access: ${result.out}`);
        metrics.revoke_ms = Math.round(performance.now() - removed);
        break;
      }
      assert.ok(started < ACCESS_MS, `a push started ${started} ms after removal (past the ${ACCESS_MS} ms bound) landed`);
    }
    metrics.attempts = attempts;
    assert.ok(attempts.at(-1).refused, `never refused after removal: ${JSON.stringify(attempts)}`);
    // A push refused at once may have reached the isolate that served the removal; a REST
    // read elsewhere may pass until the bound, and must be refused from then on.
    const past = removed + ACCESS_MS - performance.now();
    if (past > 0) await sleep(past);
    metrics.rest_started_ms = Math.round(performance.now() - removed);
    assert.equal(await status(member, 'GET', `${path}/refs`), 403, 'REST refused after removal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (pat) await member.raw('DELETE', `/tokens/${pat.id}`);
    await platform.raw('DELETE', `/orgs/${org}/members/${memberName}`);
    const owning = await platform.raw('DELETE', `/orgs/${org}?confirm=${org}`);
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
    const deleted = await platform.raw('DELETE', `/orgs/${org}?confirm=${org}`);
    metrics.org_delete = { while_owning: owning.status, after: deleted.status };
  }
  assert.equal(metrics.org_delete.while_owning, 409, 'an org that owns a repository is not deleted');
  assert.equal(metrics.org_delete.after, 200, `the org is deleted: ${metrics.org_delete.after}`);
  assert.equal((await platform.raw('GET', `/orgs/${org}`)).status, 404, 'a deleted org is gone');
}
