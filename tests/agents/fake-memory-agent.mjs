#!/usr/bin/env node
// A scripted stand-in for `opencode run` (no model), for the memory test's dry run
// (tests/agents/e2e.mjs --memory-stub). It behaves the way the test assumes an agent does: left
// alone it takes the task's natural answer and falls into the trap, and it keeps the rule only
// if the rule reached it through the session's context. With the yoneda plugin configured it
// starts a session the way opencode does, "reads" the trap's file and looks at the system
// text it was given; on the plain arm there is no plugin and so no rule. It prints opencode's
// JSON event shapes, so the run's tokens and reads are parsed as a real run's are.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeOpencode, modelCall } from '../../tools/staging/opencode-fake.mjs';

/** Per trap: the file it reads, the words of the rule, and each answer as `[path, text]`. */
const SCRIPT = {
  'frozen-file': {
    read: 'command.go',
    rule: 'patch queue',
    fell: ['command.go', '\nfunc (c *Command) VisibleCommandNames() []string {\n\treturn nil\n}\n'],
    kept: ['command_visible.go', 'package cobra\n\nfunc (c *Command) VisibleCommandNames() []string {\n\treturn nil\n}\n'],
  },
  'env-prefix': {
    read: 'lib/help.js',
    rule: 'CMDR_',
    fell: ['lib/help.js', '\nconst showHidden = () => Boolean(process.env.COMMANDER_SHOW_HIDDEN);\n'],
    kept: ['lib/help.js', '\nconst showHidden = () => Boolean(process.env.CMDR_SHOW_HIDDEN);\n'],
  },
  'exit-code': {
    read: 'src/click/exceptions.py',
    rule: 'EX_CONFIG',
    fell: ['src/click/exceptions.py', '\nclass ConfigFileError(ClickException):\n    pass\n'],
    kept: ['src/click/exceptions.py', '\nclass ConfigFileError(ClickException):\n    exit_code = 78\n'],
  },
};

const text = process.argv.at(-1);
const branch = text.match(/on the branch (\S+)\./)[1];
const script = SCRIPT[branch.split('/')[1].replace(/-\d+$/, '')];
const message = text.match(/commit with the message "([^"]+)"/)[1];
const cwd = process.env.PWD || process.cwd();
const sessionID = `ses_stub_${Date.now().toString(36)}`;
const summary = `${message} on ${branch}.`;
const usage = { input: 900, output: 40, reasoning: 10, cache: { read: 4800, write: 0 } };
let step = 0;
const event = (type, part) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID, part: { sessionID, ...part } }));
const finishStep = () => event('step_finish', { id: `prt_stub_${++step}`, type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: usage });
const git = (...args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, OPENCODE_SESSION_ID: sessionID } });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
};

const configured = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').plugins?.[0]?.package;
const oc = fakeOpencode(cwd, [
  { type: 'user', text },
  { type: 'assistant', model: { providerID: 'fake', id: 'scripted' }, content: [{ type: 'text', text: summary }] },
]);
const cleanup = configured ? await (await import(join(configured, 'index.ts'))).default.setup(oc.ctx) : async () => {};
/** What one model call would be told. */
async function modelSees() {
  const call = modelCall(sessionID, { providerID: 'fake', id: 'scripted' });
  await oc.hooks['session.context']?.(call);
  return call.system.map((s) => s.text).join('\n');
}

let context = await modelSees();
await oc.hooks['tool.execute.after']?.({ tool: 'read', sessionID, input: { path: script.read }, status: 'completed', result: { output: '' } });
event('tool_use', { partID: 'prt_stub_read', id: 'call_stub_read', type: 'tool', tool: 'read', state: { status: 'completed', input: { path: `${cwd}/${script.read}` }, output: `Read file ${cwd}/${script.read}, lines 1-1\n1: x` } });
finishStep();
context += await modelSees();

const [path, addition] = context.includes(script.rule) ? script.kept : script.fell;
appendFileSync(join(cwd, path), addition);
writeFileSync(join(cwd, '.git/stub-saw-rule'), String(context.includes(script.rule)));
git('add', '-A');
git('commit', '-q', '-m', message);
await oc.hooks['tool.execute.before']?.({ tool: 'shell', sessionID, input: { command: `git push origin ${branch}` } });
git('push', '-q', 'origin', branch);
finishStep();
console.log(JSON.stringify({ type: 'text', sessionID, part: { sessionID, type: 'text', text: summary } }));
oc.emit({ type: 'session.execution.succeeded', data: { sessionID } });
await cleanup();
process.exit(0);
