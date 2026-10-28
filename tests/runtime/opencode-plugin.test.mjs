// The opencode plugin (plugins/opencode/yoneda/index.ts) against a fake opencode context and
// a fake `yoneda` that records each hook call: the session context is fetched once per
// session and added to every model call, reads go to opencode-read, a refused push throws,
// and a session's record is made when its run ends and again (idempotently) at cleanup.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeOpencode, modelCall } from '../../tools/staging/opencode-fake.mjs';

const plugin = await import('../../plugins/opencode/yoneda/index.ts');

/** A `yoneda` stand-in: logs `<event> <stdin>` and answers start and shell calls. */
function fakeYoneda(dir) {
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'yoneda');
  writeFileSync(
    bin,
    `#!/bin/sh
input=$(cat)
printf '%s %s\\n' "$2" "$input" >> '${log}'
case "$2" in
  opencode-start) echo "CONTEXT for $(printf '%s' "$input" | sed 's/.*"sessionID":"\\([^"]*\\)".*/\\1/')" ;;
  opencode-shell) case "$input" in *"git push"*) echo "use yoneda push" ;; esac ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => ({ event: l.split(' ')[0], payload: JSON.parse(l.slice(l.indexOf(' ') + 1)) })) };
}

const until = async (probe) => {
  for (let i = 0; i < 100; i++) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out');
};

test('summarises a session from its messages', () => {
  const seen = plugin.summarise([
    { type: 'user', text: 'Add jitter' },
    { type: 'assistant', model: { providerID: 'zai-coding-plan', id: 'glm-5.3' }, content: [{ type: 'text', text: 'Looking.' }, { type: 'tool', text: 'x' }] },
    { info: { type: 'assistant', model: { providerID: 'zai-coding-plan', id: 'glm-5.3' }, content: [{ type: 'text', text: 'Added jitter and pushed.' }] } },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hm' }] },
  ]);
  assert.deepEqual(seen, { model: 'zai-coding-plan/glm-5.3', summary: 'Added jitter and pushed.', prompts: ['Add jitter'] });
  assert.deepEqual(plugin.summarise([]), { model: undefined, summary: undefined, prompts: [] });
});

test('wires context, reads, push refusal and session records through yoneda hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-opencode-'));
  const fake = fakeYoneda(dir);
  const saved = process.env.YONEDA_BIN;
  process.env.YONEDA_BIN = fake.bin;
  try {
    const messages = [{ type: 'assistant', model: { providerID: 'zai-coding-plan', id: 'glm-5.3' }, content: [{ type: 'text', text: 'Did it.' }] }];
    const { hooks, emit, ctx } = fakeOpencode(dir, messages);
    const cleanup = await plugin.default.setup(ctx);

    const first = modelCall('s1');
    await hooks['session.context'](first);
    const again = modelCall('s1');
    await hooks['session.context'](again);
    const other = modelCall('s2');
    await hooks['session.context'](other);
    assert.deepEqual(first.system, [{ type: 'text', text: 'CONTEXT for s1' }]);
    assert.deepEqual(again.system, first.system, 'every model call of the session gets it');
    assert.equal(other.system[0].text, 'CONTEXT for s2');
    assert.equal(fake.calls().filter((c) => c.event === 'opencode-start').length, 2, 'fetched once per session');

    await hooks['tool.execute.after']({ tool: 'read', sessionID: 's1', input: { path: 'src/a.ts' }, status: 'completed', result: { output: 'x' } });
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 's1', input: { path: 'src/a.ts' }, status: 'completed' });
    await hooks['tool.execute.after']({ tool: 'grep', sessionID: 's1', input: {}, status: 'error' });
    const reads = fake.calls().filter((c) => c.event === 'opencode-read');
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].payload, { tool: 'read', input: { path: 'src/a.ts' }, result: { output: 'x' }, sessionID: 's1', cwd: dir });

    await assert.rejects(hooks['tool.execute.before']({ tool: 'shell', sessionID: 's1', input: { command: 'git push origin main' } }), /use yoneda push/);
    await hooks['tool.execute.before']({ tool: 'shell', sessionID: 's1', input: { command: 'git status' } });
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 's1', input: { path: 'x' } });
    assert.equal(fake.calls().filter((c) => c.event === 'opencode-shell').length, 2, 'only shell calls are checked');

    emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await until(() => fake.calls().some((c) => c.event === 'opencode-stop'));
    const stop = fake.calls().find((c) => c.event === 'opencode-stop').payload;
    assert.deepEqual(stop, { sessionID: 's1', cwd: dir, model: 'zai-coding-plan/glm-5.3', summary: 'Did it.', prompts: [] });

    await cleanup();
    const stops = fake.calls().filter((c) => c.event === 'opencode-stop').map((c) => c.payload.sessionID);
    assert.deepEqual(stops.sort(), ['s1', 's1', 's2'], 'cleanup records every session it saw');
  } finally {
    if (saved === undefined) delete process.env.YONEDA_BIN;
    else process.env.YONEDA_BIN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does nothing without the yoneda CLI', async () => {
  const saved = process.env.YONEDA_BIN;
  process.env.YONEDA_BIN = '/nonexistent/yoneda';
  try {
    assert.equal(await plugin.runHook('opencode-start', { sessionID: 's' }), '');
  } finally {
    if (saved === undefined) delete process.env.YONEDA_BIN;
    else process.env.YONEDA_BIN = saved;
  }
});
