// Kit item 48: organizations, `setup` for each agent and SSH keys, all in the throwaway HOME. No
// agent starts: `setup` only writes files, and those are read back. What SSH keys the account held
// before is what it holds after.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile } from './cli-walk-kit.mjs';

async function orgRows(w, me, kitName) {
  // The platform's org names have no hyphens.
  const org = `cli_walk_${w.ts}`;
  const orgs = async () => (await me.j(['org', 'list'])).orgs.map((o) => o.org ?? o.name);
  let made = false;
  let repo;
  await w.row('org create', async () => {
    await me.j(['org', 'create', org]);
    made = true;
    w.orgs.push(org);
    assert.equal((await me.api.get(`/orgs/${org}`)).role, 'owner');
  });
  await w.rowOf('org list', made, 'org create', async () => {
    assert.ok((await orgs()).includes(org), 'the org is not listed');
  });
  await w.rowOf('repo create --owner', made, 'org create', async () => {
    const name = w.name('org-repo');
    const out = await me.j(['repo', 'create', name, '--owner', org]);
    repo = { id: out.id, name };
    w.repos.unshift(repo);
    assert.equal(out.owner, org);
  });
  await w.rowOf('org repos', repo, 'repo create --owner', async () => {
    assert.ok((await me.j(['org', 'repos', org])).repos.some((r) => r.id === repo.id), 'the repository is not listed');
    assert.ok((await me.ok(['org', 'repos', org])).stdout.includes(repo.name));
  });
  await w.rowOf('repo fork --owner', repo, 'repo create --owner', async () => {
    const base = await me.j(['repo', 'import', me.path('import-me'), '--name', w.name('fork-source')]);
    w.repos.push({ id: base.id, name: w.name('fork-source') });
    const name = w.name('org-fork');
    const fork = await me.j(['repo', 'fork', base.id, '--name', name, '--owner', org]);
    w.repos.unshift({ id: fork.id, name });
    assert.ok((await me.j(['org', 'repos', org])).repos.some((r) => r.id === fork.id), 'the org does not own the fork');
  });
  await w.rowOf('org member add --role, org show', made, 'org create', async () => {
    await me.j(['org', 'member', 'add', org, kitName]);
    const role = async () => (await me.j(['org', 'show', org])).members.find((m) => m.account === kitName)?.role;
    assert.equal(await role(), 'member');
    await me.j(['org', 'member', 'add', org, kitName, '--role', 'owner']);
    assert.equal(await role(), 'owner', '--role did not change it');
    assert.match((await me.ok(['org', 'show', org])).stdout, new RegExp(`^  ${kitName}  owner$`, 'm'));
    await me.refused(['org', 'member', 'add', org, kitName, '--role', 'admin'], 64, /owner or member/);
  });
  await w.rowOf('org team create, add', made, 'org create', async () => {
    await me.j(['org', 'team', 'create', org, 'devs']);
    await me.j(['org', 'team', 'add', org, 'devs', kitName]);
    const team = (await me.j(['org', 'show', org])).teams.find((t) => t.name === 'devs');
    assert.deepEqual(team?.members, [kitName]);
  });
  await w.rowOf('org team remove, delete', made, 'org create', async () => {
    await me.j(['org', 'team', 'remove', org, 'devs', kitName]);
    assert.deepEqual((await me.j(['org', 'show', org])).teams.find((t) => t.name === 'devs')?.members, []);
    await me.j(['org', 'team', 'delete', org, 'devs']);
    assert.ok(!(await me.j(['org', 'show', org])).teams.some((t) => t.name === 'devs'), 'the team is still there');
  });
  await w.rowOf('org member remove', made, 'org create', async () => {
    await me.j(['org', 'member', 'remove', org, kitName]);
    assert.ok(!(await me.j(['org', 'show', org])).members.some((m) => m.account === kitName), 'still a member');
  });
  await w.rowOf('org delete --confirm', made, 'org create', async () => {
    await me.refused(['org', 'delete', org], 64, /needs --confirm/);
    await me.refused(['org', 'delete', org, '--confirm', org], 1, /owns \d+ repositories/);
    for (const owned of (await me.j(['org', 'repos', org])).repos) {
      await me.j(['repo', 'delete', owned.id, '--confirm', owned.name]);
      w.repos = w.repos.filter((r) => r.id !== owned.id);
    }
    await me.refused(['org', 'delete', org, '--confirm', 'wrong'], 1, /confirm|name|match/i);
    await me.j(['org', 'delete', org, '--confirm', org]);
    w.orgs = [];
    assert.ok(!(await orgs()).includes(org), 'still listed');
    assert.equal((await me.api.raw('GET', `/orgs/${org}`)).status, 404, 'it still answers');
    await me.refused(['org', 'create', org], 1, /taken|retired|exists|in use/i);
  });
}

async function setupRows(w, me) {
  const project = me.path('agent-project');
  mkdirSync(project, { recursive: true });
  const mcp = `${w.api}/api/v1/mcp`;
  const noToken = (paths) => {
    for (const path of paths) assert.ok(!readFileSync(path, 'utf8').includes(me.token), `${path} holds the token`);
  };
  await w.row('setup claude', async () => {
    writeFile(join(project, '.mcp.json'), '{"mcpServers":{"other":{"url":"https://keep.example"}}}\n');
    const out = await me.j(['setup', 'claude'], { cwd: project });
    const config = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
    assert.equal(config.mcpServers.yoneda.url, mcp);
    assert.equal(config.mcpServers.yoneda.headers.Authorization, 'Bearer ${YONEDA_TOKEN}');
    assert.equal(config.mcpServers.other.url, 'https://keep.example', 'another server was lost');
    noToken(out.written);
    assert.match((await me.ok(['setup', 'claude'], { cwd: project })).stdout, /\/plugin marketplace add .*\/downloads\/claude\/marketplace\.json/);
  });
  await w.row('setup codex', async () => {
    writeFile(me.path('.codex', 'config.toml'), 'model = "keep"\n');
    const out = await me.j(['setup', 'codex']);
    await me.j(['setup', 'codex']);
    const config = readFileSync(me.path('.codex', 'config.toml'), 'utf8');
    assert.match(config, /^model = "keep"$/m, 'the existing line was lost');
    assert.equal(config.match(/\[mcp_servers\.yoneda\]/g).length, 1, 'set up twice');
    assert.ok(config.includes(`url = "${mcp}"`) && config.includes('bearer_token_env_var = "YONEDA_TOKEN"'));
    assert.ok(existsSync(me.path('.agents', 'skills', 'yoneda', 'SKILL.md')), 'no skill');
    noToken(out.written);
  });
  await w.row('setup gemini', async () => {
    const out = await me.j(['setup', 'gemini']);
    assert.equal(JSON.parse(readFileSync(me.path('.gemini', 'settings.json'), 'utf8')).mcpServers.yoneda.httpUrl, mcp);
    assert.ok(existsSync(me.path('.gemini', 'extensions', 'yoneda', 'GEMINI.md')), 'no extension');
    noToken(out.written);
  });
  await w.row('setup opencode', async () => {
    const out = await me.j(['setup', 'opencode']);
    assert.ok(existsSync(me.path('.config', 'opencode', 'plugins', 'yoneda', 'index.ts')), 'no plugin');
    assert.ok(readFileSync(me.path('.config', 'opencode', 'opencode.json'), 'utf8').includes(mcp));
    noToken(out.written);
  });
  await w.row('setup --origin', async () => {
    const out = await me.j(['setup', 'gemini', '--origin', 'https://api.other.example']);
    assert.equal(out.mcp_url, 'https://api.other.example/api/v1/mcp');
    await me.j(['setup', 'gemini']);
    await me.refused(['setup', 'vim'], 64, /unknown agent/);
  });
}

function keygen(me, name) {
  const dir = me.path('keys');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `walk-${name}`, '-f', path]);
  return `${path}.pub`;
}

async function sshKeyRows(w, me) {
  const account = async () => (await me.api.get('/ssh-keys')).keys;
  const listed = async () => (await me.j(['ssh-key', 'list'])).keys.map((k) => k.id);
  const before = (await account()).map((k) => k.id);
  let one;
  let two;
  await w.row('ssh-key add <file> --title', async () => {
    const out = await me.j(['ssh-key', 'add', '--title', 'walk one', keygen(me, 'one')]);
    one = out.id;
    w.keys.push(out.id);
    const read = (await account()).find((k) => k.id === one);
    assert.equal(read?.title, 'walk one');
    assert.equal(read?.fingerprint, out.fingerprint);
  });
  await w.row('ssh-key add - (stdin)', async () => {
    const out = await me.j(['ssh-key', 'add', '-'], { input: readFileSync(keygen(me, 'two'), 'utf8') });
    two = out.id;
    w.keys.push(out.id);
    assert.ok((await account()).some((k) => k.id === two), 'not on the account');
    await me.refused(['ssh-key', 'add', '-'], 1, /key/i, { input: 'not a key\n' });
    await me.refused(['ssh-key', 'add', me.path('no-such.pub')], 1, /no-such\.pub/);
  });
  await w.rowOf('ssh-key list, ls', one && two, 'ssh-key add', async () => {
    const ids = await listed();
    assert.ok(ids.includes(one) && ids.includes(two), 'a key is missing');
    assert.match((await me.ok(['ssh-key', 'ls'])).stdout, /walk one/);
  });
  await w.rowOf('ssh-key rm', one, 'ssh-key add', async () => {
    await me.j(['ssh-key', 'rm', one]);
    assert.ok(!(await account()).some((k) => k.id === one), 'still on the account');
    w.keys = w.keys.filter((k) => k !== one);
  });
  await w.rowOf('ssh-key remove', two, 'ssh-key add', async () => {
    await me.j(['ssh-key', 'remove', two]);
    w.keys = w.keys.filter((k) => k !== two);
    assert.deepEqual((await account()).map((k) => k.id).filter((id) => before.includes(id)), before, 'another key went');
    await me.refused(['ssh-key', 'rm', 'ssh_nobody'], 1, /NOT_FOUND|not found|invalid/i);
  });
}

async function sshSetupRows(w, me, tree) {
  const route = me.path('.ssh', 'config');
  await w.row('ssh setup --origin', async () => {
    const out = await me.j(['ssh', 'setup', '--origin', w.api]);
    w.keys.push(out.fingerprint);
    assert.equal(out.generated, true, 'no key was made');
    assert.ok(existsSync(out.key_path) && out.key_path.startsWith(me.home), 'the key is outside HOME');
    assert.equal(out.check_passed, true, `ssh -T: ${out.check_output}`);
    assert.ok(readFileSync(route, 'utf8').includes(out.ssh_host), 'not routed');
    assert.ok(readFileSync(me.path('clipboard'), 'utf8').includes('ssh-ed25519'), 'not on the clipboard');
    assert.ok((await me.api.get('/ssh-keys')).keys.some((k) => k.fingerprint === out.fingerprint), 'not on the account');
    const again = await me.j(['ssh', 'setup']);
    assert.deepEqual([again.generated, again.already_added, again.config_changed], [false, true, false], 'a second setup changed something');
    await me.gitOk(me.home, 'clone', '-q', `ssh://git@${out.ssh_host}/${tree.id}.git`, 'ssh-copy');
    assert.ok(existsSync(me.path('ssh-copy', 'README.md')), 'the clone is empty');
    const head = await me.commit(me.path('ssh-copy'), { 'ssh.txt': 'over ssh\n' }, 'Over SSH');
    await me.gitOk(me.path('ssh-copy'), 'push', '-q', 'origin', 'main');
    assert.equal((await me.api.get(`/repos/${tree.id}/refs`)).refs['refs/heads/main'], head);
  });
}

export async function toolRowsAll(w, me, tree, kitName) {
  await orgRows(w, me, kitName);
  await setupRows(w, me);
  await sshKeyRows(w, me);
  await sshSetupRows(w, me, tree);
}
