#!/usr/bin/env node
// A scripted stand-in for `opencode run` (no model), for kit item 29's plumbing in
// tests/agents/e2e.mjs --fake-agents: it loads the yoneda plugin named in
// OPENCODE_CONFIG_CONTENT with a stand-in opencode context, starts a session (the plugin
// fetches its context), "reads" the two files, does the task the prompt states (one function
// in src/util.js, one CHANGELOG line), commits and pushes with OPENCODE_SESSION_ID as opencode
// would, and on a refusal pulls with rebase, keeps both sides of each conflict and pushes
// again. It ends the session (the plugin records it) and prints JSON events with a cost.
// Like `opencode run`, it works in $PWD, not in the process's working directory (the cause of
// the 2026-10-28 escape: agents spawned with only `cwd` set worked in the operator's checkout).
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeOpencode, modelCall } from '../../tools/staging/opencode-fake.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-opencode 0.0.0');
  process.exit(0);
}
const text = args.at(-1);
const agent = text.match(/Task (\w+):/)[1];
const fn = text.match(/Name it (\w+)\./)[1];
const line = text.match(/end of CHANGELOG\.md: (.+)/)[1].trim();
const cwd = process.env.PWD || process.cwd();
const sessionID = `ses_fake_${agent}_${Date.now().toString(36)}`;
const event = (value) => console.log(JSON.stringify(value));

const git = (...argv) => spawnSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, OPENCODE_SESSION_ID: sessionID } });
const must = (...argv) => {
  const done = git(...argv);
  if (done.status !== 0) throw new Error(`git ${argv.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};
/** Keeps both sides of every conflict block (ours, then theirs). */
const union = (path) => {
  const kept = readFileSync(join(cwd, path), 'utf8')
    .split('\n')
    .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l));
  writeFileSync(join(cwd, path), kept.join('\n'));
};

// The plugin the run was configured with, else this checkout's (installed globally).
const configured = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').plugins?.[0]?.package;
const pluginDir = configured ?? fileURLToPath(new URL('../../plugins/opencode/yoneda', import.meta.url));
const plugin = (await import(join(pluginDir, 'index.ts'))).default;
const summary = `Added ${fn}() to src/util.js and "${line}" to CHANGELOG.md (${agent}).`;
const oc = fakeOpencode(cwd, [
  { type: 'user', text },
  { type: 'assistant', model: { providerID: 'fake', id: 'scripted' }, content: [{ type: 'text', text: summary }] },
]);
const cleanup = await plugin.setup(oc.ctx);
// opencode 2.2 sets each plugin up twice per run (seen in the agent sandbox: two setup calls
// for one `opencode run`), and both instances hear the session end. The twin never sees a
// model call; its record pass runs at the same time as the first instance's.
const twin = fakeOpencode(cwd, oc.messages);
const twinCleanup = await plugin.setup(twin.ctx);
const call = modelCall(sessionID, { providerID: 'fake', id: 'scripted' });
await oc.hooks['session.context'](call);
event({ type: 'session.context', data: { sessionID, bytes: call.system[0]?.text.length ?? 0 } });
for (const path of ['src/util.js', 'CHANGELOG.md'])
  await oc.hooks['tool.execute.after']({ tool: 'read', sessionID, input: { path }, status: 'completed', result: { output: '' } });

appendFileSync(join(cwd, 'src/util.js'), `\nexport function ${fn}(...args) {\n  return args;\n}\n`);
appendFileSync(join(cwd, 'CHANGELOG.md'), `${line}\n`);
must('add', '-A');
must('commit', '-q', '-m', `${agent}: add ${fn}`);
let pushes = 0;
for (;;) {
  await oc.hooks['tool.execute.before']({ tool: 'shell', sessionID, input: { command: 'git push origin main' } });
  pushes++;
  if (git('push', '-q', 'origin', 'main').status === 0) break;
  if (pushes > 10) throw new Error(`${agent}: still refused after ${pushes} pushes`);
  if (git('pull', '-q', '--rebase', 'origin', 'main').status !== 0) {
    for (const path of must('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
      union(path);
      must('add', path);
    }
    must('-c', 'core.editor=true', 'rebase', '--continue');
  }
}
event({ type: 'message.updated', data: { message: { id: `${sessionID}-m1`, type: 'assistant', cost: 0.0001, pushes } } });
// As in opencode 2.2: the twin's record pass starts first, the first instance's a moment
// later, and the process exits as soon as both cleanups resolve (in the sandbox the
// container stop then kills any hook still running).
twin.emit({ type: 'session.execution.succeeded', data: { sessionID } });
await new Promise((r) => setTimeout(r, 20));
oc.emit({ type: 'session.execution.succeeded', data: { sessionID } });
await Promise.all([cleanup(), twinCleanup()]);
event({ type: 'session.done', data: { sessionID, pushes } });
process.exit(0);
