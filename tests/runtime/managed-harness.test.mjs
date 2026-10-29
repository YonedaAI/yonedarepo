// The managed agents' harness commands (cloudflare/containers/harness/commands.mjs): each CLI's
// argv, environment and config, pointed at the gateway with placeholders only, plus result
// extraction and prompt composition. No CLI or model runs here.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommand,
  composePrompt,
  extractResult,
  finalMessage,
  PLACEHOLDER_KEY,
  providerBase,
} from '../../cloudflare/containers/harness/commands.mjs';

const gateway = {
  base: 'http://gateway.internal/v1/acct/yonedarepo-dev-managed-agents',
  slugs: { claude: 'anthropic', codex: 'openai', zai: 'custom-zai', mimo: 'custom-mimo' },
};
const spec = (over) => ({ reasoning: 'medium', prompt: 'review this', gateway, ...over });

test('provider base URLs follow the gateway slugs and each API path', () => {
  assert.equal(providerBase(gateway, 'claude'), `${gateway.base}/anthropic`);
  assert.equal(providerBase(gateway, 'zai'), `${gateway.base}/custom-zai/api/anthropic`);
  assert.equal(providerBase(gateway, 'mimo'), `${gateway.base}/custom-mimo/anthropic`);
  assert.equal(providerBase(gateway, 'codex'), `${gateway.base}/openai`);
  assert.throws(() => providerBase({ base: gateway.base, slugs: {} }, 'zai'));
});

test('Claude Code runs read-only tools against the gateway with a placeholder key', () => {
  const c = buildCommand(spec({ harness: 'claude-code', provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' }));
  assert.equal(c.argv[0], 'claude');
  assert.ok(c.argv.includes('-p'));
  assert.equal(c.argv[c.argv.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.match(c.argv[c.argv.indexOf('--disallowedTools') + 1], /Edit Write/);
  assert.equal(c.env.ANTHROPIC_BASE_URL, `${gateway.base}/anthropic`);
  assert.equal(c.env.ANTHROPIC_API_KEY, PLACEHOLDER_KEY);
  assert.equal(c.env.MAX_THINKING_TOKENS, '24000');
  assert.equal(c.stdin, 'review this');
  assert.throws(() => buildCommand(spec({ harness: 'claude-code', provider: 'codex', model: 'gpt-5.6-luna' })));
});

test('Codex runs in its read-only sandbox through a gateway provider', () => {
  const c = buildCommand(spec({ harness: 'codex', provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' }));
  assert.deepEqual(c.argv.slice(0, 5), ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.ok(c.argv.includes('model_reasoning_effort="low"'));
  assert.ok(c.argv.some((a) => a.includes(`base_url = "${gateway.base}/openai"`)));
  assert.equal(c.env.OPENAI_API_KEY, PLACEHOLDER_KEY);
  assert.equal(c.resultFile, '/tmp/yoneda-last-message.txt');
  assert.throws(() => buildCommand(spec({ harness: 'codex', provider: 'zai', model: 'glm-5.3-flash' })));
});

test('opencode gets a gateway provider config, edits and network denied', () => {
  const c = buildCommand(spec({ harness: 'opencode', provider: 'mimo', model: 'mimo-v2.6-flash', reasoning: 'low' }));
  assert.deepEqual(c.argv, ['opencode', 'run', '--model', 'yoneda/mimo-v2.6-flash']);
  const config = JSON.parse(c.files['.config/opencode/opencode.json']);
  assert.equal(config.provider.yoneda.options.baseURL, `${gateway.base}/custom-mimo/anthropic/v1`);
  assert.equal(config.provider.yoneda.options.apiKey, PLACEHOLDER_KEY);
  assert.deepEqual(config.provider.yoneda.models['mimo-v2.6-flash'], {});
  assert.equal(config.permission.edit, 'deny');
  assert.equal(config.permission.webfetch, 'deny');
  assert.equal(config.permission.bash['*'], 'deny');
  assert.throws(() => buildCommand(spec({ harness: 'opencode', provider: 'claude', model: 'claude-sonnet-5-5' })));
});

test('no command carries anything but placeholders, and bad input is refused', () => {
  for (const [harness, provider, model] of [
    ['claude-code', 'zai', 'glm-5.3-flash'],
    ['codex', 'codex', 'gpt-5.6-luna'],
    ['opencode', 'zai', 'glm-5.3-flash'],
  ]) {
    const text = JSON.stringify(buildCommand(spec({ harness, provider, model })));
    assert.doesNotMatch(text, /yrp_[a-z0-9]{8}|sk-|ghp_/);
  }
  assert.throws(() => buildCommand(spec({ harness: 'opencode', provider: 'zai', model: 'glm; rm -rf /' })));
  assert.throws(() => buildCommand(spec({ harness: 'opencode', provider: 'zai', model: 'glm-5.3-flash', reasoning: 'max' })));
});

test('the result is the last JSON object with findings, inside any wrapping', () => {
  const answer = 'Thinking {not json} ... {"summary":"ok","findings":[{"path":"a.js","line":2}]}\nbye';
  assert.deepEqual(extractResult(answer), { summary: 'ok', findings: [{ path: 'a.js', line: 2 }] });
  assert.equal(extractResult('no result here {"a":1}'), null);
  const envelope = JSON.stringify({ type: 'result', result: '{"summary":"s","findings":[]}' });
  assert.equal(finalMessage('claude-code', `log line\n${envelope}`, null), '{"summary":"s","findings":[]}');
  assert.equal(finalMessage('codex', 'stdout', 'file text'), 'file text');
});

test('the prompt carries instructions, the review context, the repository rules and the contract', () => {
  const prompt = composePrompt({
    instructions: 'Check correctness.',
    contract: 'Reply with JSON.',
    context: { change: 7, title: 'Fix', branch: 'fix', base: 'b'.repeat(40), head: 'h'.repeat(40), files: ['a.js'] },
    rules: [{ path: 'AGENTS.md', text: 'Functions stay under 50 lines.' }, { path: 'REVIEW.md', text: '' }],
  });
  assert.ok(prompt.startsWith('Check correctness.'));
  assert.match(prompt, /change: #7 "Fix"/);
  assert.match(prompt, /--- AGENTS\.md \(at the diff base\) ---\nFunctions stay under 50 lines\./);
  assert.doesNotMatch(prompt, /REVIEW\.md \(at/);
  assert.ok(prompt.trimEnd().endsWith('Reply with JSON.'));
});
