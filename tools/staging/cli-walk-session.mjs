// Kit item 48: what a coding session leaves behind: memories, flight plans, session records, the
// context a new session is shown, declared reads, and every agent hook with no agent running.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branch, flowRepo } from './cli-walk-land.mjs';

const NET = 'pub fn retry() {\n    // tries\n}\n';

async function memoryRows(w, me, repo) {
  const repoArgs = ['--repo', repo.id];
  const list = async (...args) => (await me.j(['memory', 'list', ...args, ...repoArgs])).memories.map((m) => m.id);
  let first;
  let second;
  await w.row('memory add <kind> -m --anchors', async () => {
    const out = await me.j(['memory', 'add', 'gotcha', '-m', 'retry must stay idempotent', '--anchors', 'src/net.rs#retry,docs/'], { cwd: repo.dir });
    first = out.memory;
    assert.equal(out.kind, 'gotcha');
    const { memory } = await me.api.get(`/repos/${repo.id}/memories/${first}`);
    assert.equal(memory.text, 'retry must stay idempotent');
    assert.deepEqual(memory.anchors.map((a) => [a.path, a.symbol_path ?? null]).sort(), [['docs/', null], ['src/net.rs', 'retry']], 'the anchors are not what was given');
  });
  await w.rowOf('memory add --commit --supersedes', first, 'memory add', async () => {
    const out = await me.j(['memory', 'add', 'decision', '-m', 'retry three times', '--commit', repo.head, '--supersedes', String(first), ...repoArgs]);
    second = out.memory;
    assert.equal(out.commit, repo.head, 'not recorded at that commit');
    const { memory } = await me.api.get(`/repos/${repo.id}/memories/${first}`);
    assert.equal(memory.superseded_by, second, 'the older memory does not name the newer');
    await me.refused(['memory', 'add', 'gotcha'], 64, /needs -m/);
  });
  await w.rowOf('memory list --path --kind --status', second, 'memory add', async () => {
    assert.deepEqual(await list('--kind', 'decision'), [second]);
    const superseded = await list('--status', 'superseded');
    assert.ok(superseded.includes(first), `superseded: ${superseded}`);
    assert.ok(!(await list()).includes(first), 'the default list shows the superseded memory');
    const third = (await me.j(['memory', 'add', 'howto', '-m', 'on the file', '--anchors', 'src/net.rs', ...repoArgs])).memory;
    assert.deepEqual(await list('--path', 'src/net.rs'), [third], 'the path filter');
    assert.match((await me.ok(['memory', 'list', ...repoArgs])).stdout, new RegExp(`^#${third} howto on the file \\(src/net\\.rs\\)`, 'm'));
  });
  await w.rowOf('memory show', second, 'memory add', async () => {
    const ran = await me.ok(['memory', 'show', String(second), ...repoArgs]);
    assert.match(ran.stdout, /retry three times/);
    assert.match(ran.stdout, new RegExp(`commit ${repo.head}`));
    assert.equal((await me.j(['memory', 'show', String(second), ...repoArgs])).memory.id, second);
    await me.refused(['memory', 'show', 'x'], 64, /memory show <id>/);
    await me.refused(['memory', 'show', '999999', ...repoArgs], 1, /NOT_FOUND|not found/i);
  });
  await w.rowOf('memory retire -m', second, 'memory add', async () => {
    assert.equal((await me.j(['memory', 'retire', String(second), '-m', 'No longer true', ...repoArgs])).already, false);
    assert.equal((await me.api.get(`/repos/${repo.id}/memories/${second}`)).memory.status, 'retired');
    assert.equal((await me.j(['memory', 'retire', String(second), ...repoArgs])).already, true, 'a second retire did something');
    assert.ok((await list('--status', 'retired')).includes(second), 'not listed as retired');
  });
}

async function flightRows(w, me, repo) {
  await w.row('flight-plan -m --scope --session-id (the clone\'s branch)', async () => {
    await me.gitOk(repo.dir, 'checkout', '-q', '-B', 'planned', 'origin/main');
    const out = await me.j(['flight-plan', '-m', 'Retry twice', '--scope', 'src/ only', '--session-id', 'walk-session'], { cwd: repo.dir });
    await me.gitOk(repo.dir, 'checkout', '-q', 'main');
    assert.equal(out.plan.goal, 'Retry twice');
    assert.equal(out.plan.branch, 'planned');
    assert.equal(out.plan.scope, 'src/ only');
    assert.equal(out.plan.session_id, 'walk-session');
  });
  await w.row('flight-plan --branch --change: the landing shows it', async () => {
    await branch(me, repo, 'planned', { 'src/net.rs': `${NET}// planned\n` }, 'Planned work');
    const n = (await me.j(['change', 'create', 'planned', '--repo', repo.id])).change.number;
    await me.j(['flight-plan', '-m', 'Second goal', '--branch', 'planned', '--change', String(n), '--repo', repo.id]);
    assert.equal((await me.api.get(`/repos/${repo.id}/changes/${n}`)).flight_plan?.goal, 'Second goal');
    assert.match((await me.ok(['change', 'show', String(n), '--repo', repo.id])).stdout, /flight plan: Second goal/);
    await me.refused(['flight-plan'], 64, /needs -m/);
    await me.ok(['change', 'close', String(n), '--repo', repo.id]);
  });
}

async function sessionRows(w, me, repo) {
  const transcript = me.path('session.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Make retry back off' } },
    { type: 'assistant', message: { model: 'walk-model', content: [{ type: 'text', text: 'Done, it backs off' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await w.row('session record --cli --summary', async () => {
    const out = await me.j(['session', 'record', '--cli', 'codex', '--summary', 'Plain record'], { cwd: repo.dir });
    assert.equal(out.commit, repo.head, 'not recorded on HEAD');
    const { sessions } = await me.api.get(`/repos/${repo.id}/commits/${repo.head}/sessions`);
    assert.deepEqual(sessions.map((s) => [s.cli, s.summary]), [['codex', 'Plain record']]);
  });
  await w.row('session record <sha> --model --transcript-ref --session-id --transcript', async () => {
    await me.j(['session', 'record', repo.head, '--cli', 'claude-code', '--summary', 'Full record', '--model', 'walk-model', '--transcript-ref', 'run-7', '--session-id', 'claude-code:walk', '--transcript', transcript, '--repo', repo.id]);
    const { sessions } = await me.api.get(`/repos/${repo.id}/commits/${repo.head}/sessions`);
    const full = sessions.find((s) => s.summary === 'Full record');
    assert.deepEqual([full?.model, full?.session_id, full?.transcript_ref], ['walk-model', 'claude-code:walk', 'run-7'], JSON.stringify(full));
    assert.ok(full?.transcript ?? full?.has_transcript, `the transcript did not arrive: ${JSON.stringify(full).slice(0, 200)}`);
    await me.refused(['session', 'record', '--cli', 'x'], 64, /--summary/);
  });
  await w.row('session list [<sha>]', async () => {
    const here = await me.j(['session', 'list'], { cwd: repo.dir });
    assert.equal(here.sessions.length, 2, 'not the two on HEAD');
    const there = await me.ok(['session', 'list', repo.head, '--repo', repo.id]);
    assert.ok(there.stdout.includes('Full record') && there.stdout.includes('Plain record'), there.stdout);
  });
  await w.row('context --max-bytes', async () => {
    const full = await me.ok(['context'], { cwd: repo.dir });
    assert.ok(full.stdout.includes('Full record'), `no session in: ${full.stdout.slice(0, 300)}`);
    const bytes = Buffer.byteLength(full.stdout);
    const capped = await me.ok(['context', '--max-bytes', '256'], { cwd: repo.dir });
    assert.ok(Buffer.byteLength(capped.stdout) <= 256 && Buffer.byteLength(capped.stdout) < bytes, `${Buffer.byteLength(capped.stdout)} of ${bytes}`);
    await me.refused(['context', '--max-bytes', '10'], 64, /256-65536/, { cwd: repo.dir });
    assert.ok(Object.keys(await me.j(['context', '--max-bytes', '1024'], { cwd: repo.dir })).length > 0);
    await me.refused(['context'], 64, /no repository/, { cwd: '/' });
    return `${bytes} bytes, capped to ${Buffer.byteLength(capped.stdout)}`;
  });
}

async function readRows(w, me, repo) {
  const dir = repo.dir;
  await w.row('reads add, reads list', async () => {
    const out = await me.j(['reads', 'add', 'src/net.rs', 'README.md'], { cwd: dir });
    assert.deepEqual([out.added, out.total], [2, 2]);
    assert.equal((await me.j(['reads', 'add', 'README.md'], { cwd: dir })).added, 0, 'a read counted twice');
    assert.deepEqual((await me.j(['reads', 'list'], { cwd: dir })).reads.sort(), ['README.md', 'src/net.rs']);
    await me.refused(['reads', 'add', '/etc/passwd'], 64, /not inside this repository/, { cwd: dir });
  });
  await w.row('reads clear', async () => {
    assert.equal((await me.j(['reads', 'clear'], { cwd: dir })).cleared, 2);
    assert.deepEqual((await me.j(['reads', 'list'], { cwd: dir })).reads, []);
  });
  await w.row('push: the helper declares the reads', async () => {
    await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
    await me.ok(['reads', 'add', 'README.md'], { cwd: dir });
    const head = await me.commit(dir, { 'read.txt': 'declared\n' }, 'Declared a read');
    await me.ok(['push', 'origin', 'main'], { cwd: dir });
    assert.deepEqual((await me.api.get(`/repos/${repo.id}/commits/${head}`)).read_set, ['README.md'], 'the read was not declared');
    assert.deepEqual((await me.j(['reads', 'list'], { cwd: dir })).reads, [], 'the reads were not cleared');
  });
  await w.row('push: smart HTTP, -o yoneda.reads', async () => {
    const http = me.path('http-clone');
    const env = me.env({ GIT_ASKPASS: me.path('bin', 'askpass'), WALK_TOKEN: me.token });
    writeFileSync(me.path('bin', 'askpass'), '#!/bin/sh\ncase "$1" in Username*) echo token;; *) printf %s "$WALK_TOKEN";; esac\n', { mode: 0o755 });
    await me.exec('git', ['clone', '-q', `${w.api}/git/${repo.id}.git`, http], { env });
    await me.ok(['reads', 'add', 'README.md'], { cwd: http, env });
    const head = await me.commit(http, { 'http.txt': 'over http\n' }, 'Over HTTP');
    const ran = await me.y(['push', 'origin', 'main'], { cwd: http, env });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stderr, /the push declared 1 read\(s\); cleared/);
    assert.deepEqual((await me.api.get(`/repos/${repo.id}/commits/${head}`)).read_set, ['README.md']);
  });
  await w.row('push: a failed push keeps the reads, a foreign remote is refused', async () => {
    const plain = me.path('foreign');
    await me.gitOk(me.home, 'init', '-q', '--bare', 'foreign.git');
    await me.gitOk(me.home, 'clone', '-q', 'foreign.git', plain);
    await me.ok(['reads', 'add', 'a.txt'], { cwd: plain });
    await me.commit(plain, { 'a.txt': 'a\n' }, 'A');
    await me.refused(['push', 'origin', 'main'], 64, /declared reads go only to the platform/, { cwd: plain });
    assert.equal((await me.j(['reads', 'list'], { cwd: plain })).reads.length, 1, 'the reads went');
  });
}

async function hookRows(w, me, repo) {
  const dir = repo.dir;
  await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
  const hook = async (event, payload, env) => {
    const ran = await me.y(['hook', event], { input: JSON.stringify(payload), cwd: dir, env });
    assert.equal(ran.code, 0, `hook ${event}: ${ran.stderr}`);
    assert.doesNotMatch(ran.stderr, /^yoneda hook:/m, `hook ${event}: ${ran.stderr}`);
    return ran;
  };
  const claude = { session_id: 'walk-claude', cwd: dir };
  const opencode = { sessionID: 'walk-oc', cwd: dir };
  const reads = async () => (await me.j(['reads', 'list'], { cwd: dir })).reads;
  const read = { ...claude, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/net.rs') }, tool_response: {} };
  await w.row('hook claude-start', async () => {
    const envFile = me.path('claude-env');
    writeFileSync(envFile, '');
    const ran = await hook('claude-start', { ...claude, hook_event_name: 'SessionStart', source: 'startup' }, me.env({ CLAUDE_ENV_FILE: envFile }));
    const context = JSON.parse(ran.stdout).hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /Full record/, `no context: ${context.slice(0, 200)}`);
    assert.match(readFileSync(envFile, 'utf8'), /YONEDA_SESSION_ID='claude-code:walk-claude'/);
  });
  await w.row('hook claude-read', async () => {
    await me.ok(['reads', 'clear'], { cwd: dir });
    await hook('claude-read', read);
    assert.deepEqual(await reads(), ['src/net.rs']);
  });
  await w.row('hook claude-prompt', async () => {
    await me.api.post(`/repos/${repo.id}/memories`, { kind: 'howto', text: 'The ceiling is thirty seconds' });
    const ran = await hook('claude-prompt', { ...claude, hook_event_name: 'UserPromptSubmit', prompt: 'What is the ceiling here?' });
    assert.match(JSON.parse(ran.stdout || '{}').hookSpecificOutput?.additionalContext ?? '', /thirty seconds/);
  });
  await w.row('hook claude-memory', async () => {
    await hook('claude-memory', { ...claude, hook_event_name: 'PostToolUse', tool_name: 'mcp__yoneda__git_memory_add' });
    return 'read back at claude-stop: the summary is offered as a draft memory';
  });
  await w.row('hook claude-bash', async () => {
    assert.equal((await hook('claude-bash', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: dir })).stdout, '', 'a yoneda:: push was denied');
    const http = me.path('http-clone');
    await me.ok(['reads', 'add', 'README.md'], { cwd: http });
    const denied = await hook('claude-bash', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: http });
    assert.equal(JSON.parse(denied.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', `a stock push with pending reads went through: ${denied.stdout}`);
  });
  await w.row('hook claude-stop', async () => {
    const head = await me.commit(dir, { 'claude.txt': 'c\n' }, 'Claude work');
    await me.exec('git', ['push', '-q', 'origin', 'main'], { cwd: dir, env: me.env({ YONEDA_SESSION_ID: 'claude-code:walk-claude' }) });
    const transcript = me.path('stop.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { model: 'walk-model', content: [{ type: 'text', text: 'Claude finished' }] } })}\n`);
    await hook('claude-stop', { ...claude, transcript_path: transcript, hook_event_name: 'Stop' });
    const { sessions } = await me.api.get(`/repos/${repo.id}/commits/${head}/sessions`);
    assert.deepEqual(sessions.map((s) => [s.cli, s.session_id, s.summary]), [['claude-code', 'claude-code:walk-claude', 'Claude finished']]);
    const drafts = (await me.api.get(`/repos/${repo.id}/memories?status=draft`)).memories;
    assert.deepEqual(drafts.map((m) => m.text), ['Claude finished'], "the session's summary is not offered as a draft");
  });
  await w.row('hook opencode-start', async () => {
    assert.match((await hook('opencode-start', opencode)).stdout, /Claude finished/, 'no context');
  });
  await w.row('hook opencode-read', async () => {
    await me.ok(['reads', 'clear'], { cwd: dir });
    await hook('opencode-read', { ...opencode, tool: 'read', input: { path: 'README.md' }, result: { output: 'x' } });
    assert.deepEqual(await reads(), ['README.md']);
  });
  await w.row('hook opencode-prompt', async () => {
    await me.api.post(`/repos/${repo.id}/memories`, { kind: 'howto', text: 'Gateway timeout is ninety seconds' });
    assert.match((await hook('opencode-prompt', { ...opencode, prompt: 'What is the gateway timeout?' })).stdout, /ninety seconds/);
  });
  await w.row('hook opencode-memory', async () => {
    await hook('opencode-memory', opencode);
    return 'read back at opencode-stop: the summary is offered as a draft memory';
  });
  await w.row('hook opencode-shell', async () => {
    const push = { tool: 'shell', input: { command: 'git push origin main' } };
    assert.equal((await hook('opencode-shell', { ...opencode, ...push })).stdout, '', 'a yoneda:: push was refused');
    const refused = await hook('opencode-shell', { ...opencode, cwd: me.path('http-clone'), ...push });
    assert.ok(refused.stdout.length > 0, 'a stock push with pending reads went through');
  });
  await w.row('hook opencode-stop', async () => {
    await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
    const head = await me.commit(dir, { 'oc.txt': 'o\n' }, 'opencode work');
    await me.exec('git', ['push', '-q', 'origin', 'main'], { cwd: dir, env: me.env({ OPENCODE_SESSION_ID: 'walk-oc' }) });
    await hook('opencode-stop', { ...opencode, model: 'walk-oc-model', summary: 'opencode finished', prompts: ['Go'] });
    const { sessions } = await me.api.get(`/repos/${repo.id}/commits/${head}/sessions`);
    assert.deepEqual(sessions.map((s) => [s.cli, s.model, s.summary]), [['opencode', 'walk-oc-model', 'opencode finished']]);
    const drafts = (await me.api.get(`/repos/${repo.id}/memories?status=draft`)).memories;
    assert.ok(drafts.some((m) => m.text === 'opencode finished'), "the session's summary is not offered as a draft");
  });
  await w.row('hook refuses an unknown event, keeps quiet outside a clone', async () => {
    await me.refused(['hook', 'vim'], 64, /unknown hook/);
    const outside = await me.y(['hook', 'claude-start'], { input: JSON.stringify({ session_id: 'x', cwd: '/' }), cwd: '/' });
    assert.equal(outside.code, 0, 'a hook failed an agent\'s session outside a clone');
    assert.equal(outside.stdout, '', 'it spoke');
  });
}

export async function sessionRowsAll(w, me) {
  const repo = await flowRepo(w, me, 'session', { 'README.md': 'Session repo\n', 'src/net.rs': NET, 'docs/notes.md': '# Notes\n' });
  await memoryRows(w, me, repo);
  await flightRows(w, me, repo);
  await sessionRows(w, me, repo);
  await readRows(w, me, repo);
  await hookRows(w, me, repo);
}
