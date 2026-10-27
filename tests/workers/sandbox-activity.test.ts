// Claude Code stream-json into the activity log, and the sandbox egress policy.
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TEXT_LIMIT,
  completeLines,
  parseActivity,
  redact,
  resultOutcome,
} from '../../cloudflare/worker/sandbox-activity';
import {
  type OutboundProps,
  outboundDecision,
  refsAllowed,
} from '../../cloudflare/worker/sandbox-outbound';

const j = (value: unknown) => JSON.stringify(value);

describe('stream-json activity', () => {
  it('turns init, text, tool calls, tool errors and the result into short lines', () => {
    expect(parseActivity(j({ type: 'system', subtype: 'init', model: 'glm-5.3-flash' }))).toEqual([
      { kind: 'init', text: 'Agent started (glm-5.3-flash)' },
    ]);
    const assistant = j({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'I will add the function.\n' },
          { type: 'tool_use', name: 'Write', input: { file_path: 'src/math.js', content: 'x' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'node --test' } },
        ],
      },
    });
    expect(parseActivity(assistant)).toEqual([
      { kind: 'text', text: 'I will add the function.' },
      { kind: 'tool', text: 'Write src/math.js' },
      { kind: 'tool', text: 'Bash node --test' },
    ]);
    const results = j({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'ok', is_error: false },
          { type: 'tool_result', content: [{ type: 'text', text: 'test failed' }], is_error: true },
        ],
      },
    });
    expect(parseActivity(results)).toEqual([{ kind: 'tool_error', text: 'test failed' }]);
    const done = j({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 4,
      total_cost_usd: 0.0021,
      usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 250 },
      result: 'Added add(a,b)',
    });
    expect(parseActivity(done)).toEqual([
      {
        kind: 'result',
        text: 'Agent finished (4 turns, 1000 input / 250 output tokens): Added add(a,b)',
      },
    ]);
    expect(resultOutcome(done)).toEqual({ ok: true, result: 'Added add(a,b)' });
    const failed = j({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(resultOutcome(failed)).toEqual({ ok: false, error: 'error_during_execution' });
  });

  it('keeps unknown events out, plain text bounded and secrets redacted', () => {
    expect(parseActivity(j({ type: 'stream_event', event: {} }))).toEqual([]);
    // As Claude Code 2.1.306 printed it with its endpoint unreachable.
    const retry = j({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 559,
      error_status: 401,
      error: 'unknown',
    });
    expect(parseActivity(retry)).toEqual([
      { kind: 'error', text: 'Model request retry 1/10 (HTTP 401): unknown' },
    ]);
    expect(parseActivity('')).toEqual([]);
    const noisy = parseActivity(`not json ${'x'.repeat(1000)}`);
    expect(noisy[0].kind).toBe('error');
    expect(noisy[0].text.length).toBe(ACTIVITY_TEXT_LIMIT);
    const leaked = j({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'token yrp_abcdefghijklmnop and Bearer sk-abcdefghijklmnopq' }],
      },
    });
    expect(parseActivity(leaked)[0].text).not.toMatch(/yrp_abc|sk-abc/);
    expect(redact('api_key=supersecretvalue')).toBe('[redacted]');
    expect(resultOutcome('{"type":"result"}')).toBeNull();
  });

  it('reads only complete lines unless one line fills the whole chunk', () => {
    const bytes = new TextEncoder().encode('{"a":1}\n{"b":');
    expect(completeLines(bytes, false)).toEqual({ consumed: 8, lines: ['{"a":1}'] });
    const huge = new TextEncoder().encode('y'.repeat(16));
    expect(completeLines(huge, false)).toEqual({ consumed: 0, lines: [] });
    expect(completeLines(huge, true).consumed).toBe(16);
  });
});

describe('sandbox egress', () => {
  const props: OutboundProps = {
    project: 'proj',
    owner: 'owner',
    platformRepo: 'r0123456789abcdef0123',
    platformOrigin: 'https://dev.yonedarepo.com',
    ref: 'refs/heads/attempts/run-1/1',
    provider: 'zai',
    model: 'glm-5.3-flash',
    modelBase: 'https://api.z.ai/api/anthropic',
  };
  const decide = (url: string, method = 'GET') => outboundDecision(new URL(url), method, props);
  const repo = 'https://dev.yonedarepo.com/api/v1/repos/r0123456789abcdef0123';

  it('opens only the model endpoint and this repository, over HTTPS', () => {
    expect(decide('https://api.z.ai/api/anthropic/v1/messages', 'POST')).toEqual({
      route: 'model',
    });
    expect(decide('http://api.z.ai/api/anthropic/v1/messages', 'POST')).toHaveProperty('deny');
    expect(decide('https://api.z.ai/api/paas/v4/chat', 'POST')).toHaveProperty('deny');
    expect(decide('https://registry.npmjs.org/left-pad')).toHaveProperty('deny');
    expect(decide(`${repo}/refs`)).toEqual({ route: 'platform', refs: false });
    expect(decide(`${repo}/objects`, 'POST')).toEqual({ route: 'platform', refs: false });
    expect(decide(`${repo}/branches`, 'POST')).toEqual({ route: 'platform', refs: true });
    expect(decide(`${repo}/refs/batch`, 'POST')).toEqual({ route: 'platform', refs: true });
    expect(
      decide('https://dev.yonedarepo.com/api/v1/repos/r9999999999999999999/refs'),
    ).toHaveProperty('deny');
  });

  it('never lets the agent land, review, post checks or mint tokens', () => {
    for (const path of ['/land', '/commits/abc/reviews', '/checks', '/tokens', '/policy'])
      expect(decide(`${repo}${path}`, 'POST')).toHaveProperty('deny');
    expect(decide(`${repo}/tokens/x`, 'DELETE')).toHaveProperty('deny');
  });

  it("moves only the attempt's own branch", () => {
    expect(refsAllowed({ ref: 'refs/heads/attempts/run-1/1', commit: 'a' }, props.ref)).toBe(true);
    expect(refsAllowed({ ref: 'attempts/run-1/1' }, props.ref)).toBe(true);
    expect(refsAllowed({ ref: 'refs/heads/main' }, props.ref)).toBe(false);
    expect(refsAllowed({ ref: 'refs/heads/attempts/run-2/1' }, props.ref)).toBe(false);
    expect(refsAllowed({ ref: 'refs/heads/attempts/run-1/' }, props.ref)).toBe(false);
    expect(
      refsAllowed({ updates: [{ ref: 'attempts/run-1/1' }, { ref: 'refs/heads/main' }] }, props.ref),
    ).toBe(false);
    expect(refsAllowed({ updates: [] }, props.ref)).toBe(false);
    expect(refsAllowed(null, props.ref)).toBe(false);
  });

  it("never moves another agent's branch of the same run", () => {
    for (const ref of [
      'refs/heads/attempts/run-1/2',
      'attempts/run-1/2',
      'refs/heads/attempts/run-1/team',
      'refs/heads/attempts/run-1/1/x',
      'attempts/run-1/1/x',
      'refs/heads/attempts/run-1/10',
    ]) {
      expect(refsAllowed({ ref }, props.ref)).toBe(false);
      expect(refsAllowed({ updates: [{ ref: props.ref }, { ref }] }, props.ref)).toBe(false);
    }
  });
});
